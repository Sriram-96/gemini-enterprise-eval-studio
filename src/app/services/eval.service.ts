/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Injectable} from '@angular/core';

import {CSVRow} from '../models/csv-row.model';
import {ResultRow} from '../models/result-row.model';
import {ScorerRunResult, ScoringRequest, summarizeScorerResults} from '../scoring/scorer';
import {ScorerRegistry} from '../scoring/scorer.registry';

import {EvalBackendService} from './eval-backend.service';
import {StateService} from './state.service';



interface AssistRequestBody {
  query: {text: string};
  session?: string;
  generationSpec?: {modelId: string};
  toolsSpec?: {
    vertexAiSearchSpec?: {
      dataStoreSpecs?: Array<{dataStore: string}>;
    };
    webGroundingSpec?: {};
  };
}

/**
 * Threads a multi-turn conversation across processRow calls.
 */
export interface SessionContext {
  /** Session resource name to continue. Omit for the first turn or for a standalone, non-conversational query. */
  session?: string;
}

/**
 * Service for evaluation operations calling real APIs.
 */
@Injectable({providedIn: 'root'})
export class EvalService {
  constructor(
      private readonly stateService: StateService,
      private readonly evalBackendService: EvalBackendService,
      private readonly scorerRegistry: ScorerRegistry
  ) {}

  /**
   * Processes a row for evaluation by calling streamAssist API.
   * @param row The CSV row to process.
   * @param onProgress Optional callback for progress updates.
   * @returns A promise that resolves to the ResultRow.
   */
  async processRow(
      row: CSVRow, onProgress?: (step: 'fetch'|'score') => void,
      sessionContext?: SessionContext): Promise<ResultRow> {
    const config = this.stateService.getCurrentConfig();


    const toolsSpec: NonNullable<AssistRequestBody['toolsSpec']> = {};

    if (config.selectedDataStores && config.selectedDataStores.length > 0) {
      toolsSpec.vertexAiSearchSpec = {
        dataStoreSpecs: config.selectedDataStores.map(
            ds => ({
              dataStore: `projects/${config.projectId}/locations/${
                  config.region}/collections/default_collection/dataStores/${
                  ds}`
            }))
      };
    } else if (!config.enableWebSearch) {
      toolsSpec.vertexAiSearchSpec = {};
    }

    if (config.enableWebSearch) {
      toolsSpec.webGroundingSpec = {};
    }

    const body: AssistRequestBody = {
      query: {text: row.query},
      toolsSpec,
    };

    // Note: the `isSessionLess` proto field is not recognized by the v1
    // streamAssist REST surface ("Unknown name \"isSessionLess\"": 400), so
    // a standalone (non-conversational) query simply omits `session`
    // instead, matching pre-multi-turn behavior.
    if (sessionContext?.session) {
      body.session = sessionContext.session;
    }

    if (config.selectedModel !== 'auto') {
      body.generationSpec = {modelId: config.selectedModel};
    }

    const projectId = config.projectId;
    const region = config.region;
    const engineId = config.selectedEngine;

    const startTime = Date.now();
    let ttft = 0;
    let ttfa = 0;
    let fullText = '';
    let assistToken = '';
    let isFirstChunk = true;
    let isFirstUserChunk = true;
    let sessionInfo: {session?: string; turnId?: string}|undefined;

    try {
      onProgress?.('fetch');
      const response = await this.evalBackendService.callAssist({
        selectedEngine: config.selectedEngine,
        region: config.region,
        body
      });

      if (!response.ok) {
        if (response.status === 429) {
          const errorData = await response.json();
          assistToken = errorData.details?.[0]?.assistToken || 'unknown';
          const reason =
              errorData.details?.[0]?.reason || 'Rate limit exceeded';
          throw new Error(`Rate limited: ${reason}`);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';
      let processedItemsCount = 0;

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, {stream: true});
        accumulatedText += chunk;

        try {
          let parsedData;
          try {
            parsedData = JSON.parse(accumulatedText);
          } catch (e) {
            if (accumulatedText.startsWith('[')) {
              try {
                const cleanedText = accumulatedText.trim().replace(/,\s*$/, '');
                parsedData = JSON.parse(cleanedText + ']');
              } catch (e2) {
                continue;
              }
            } else {
              continue;
            }
          }

          if (parsedData && Array.isArray(parsedData)) {
            for (let i = processedItemsCount; i < parsedData.length; i++) {
              const item = parsedData[i];
              processedItemsCount++;

              if (item.assistToken) {
                assistToken = item.assistToken;
              }

              if (item.sessionInfo?.session) {
                sessionInfo = item.sessionInfo;
              }

              if (item.answer?.state === 'SKIPPED') {
                const reason =
                    item.answer?.assistSkippedReasons?.[0] || 'Unknown reason';
                fullText = `SKIPPED: ${reason}`;
                break;
              }
              const replies = item.answer?.replies || [];
              for (const reply of replies) {
                const content = reply.groundedContent?.content;
                if (content) {
                  const text = content.text;
                  const thought = content.thought;

                  if (text || thought) {
                    if (isFirstChunk) {
                      ttft = Date.now() - startTime;
                      isFirstChunk = false;
                    }

                    if (!thought && text && isFirstUserChunk) {
                      ttfa = Date.now() - startTime;
                      isFirstUserChunk = false;
                    }

                    if (text && !thought) {
                      fullText += text;
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('Error processing chunk:', e);
        }
      }

      const ttlt = Date.now() - startTime;

      onProgress?.('score');
      const scorerResults = await this.scoreAll(
          {query: row.query, response: fullText, golden: row.golden, config});

      return {
        query: row.query,
        golden: row.golden || '',
        fetched: fullText,
        ttft: Number((ttft / 1000).toFixed(2)),
        ttfa: Number((ttfa / 1000).toFixed(2)),
        ttlt: Number((ttlt / 1000).toFixed(2)),
        ...summarizeScorerResults(scorerResults),
        assistToken,
        projectId,
        region,
        engineId,
        session: sessionInfo?.session,
        turnId: sessionInfo?.turnId
      };

    } catch (error) {
      console.error('Error processing row:', error);
      return {
        query: row.query,
        golden: row.golden || '',
        fetched: 'Error: ' + error,
        ttft: 0,
        ttfa: 0,
        ttlt: 0,
        score: 0,
        scorerId: this.scorerRegistry.resolveAll(config.selectedScorers)[0].id,
        assistToken,
        projectId,
        region,
        engineId,
        session: sessionInfo?.session,
        turnId: sessionInfo?.turnId
      };
    }
  }

  /**
   * Runs every scorer named by the configuration against a single response.
   *
   * The scorers run one after another rather than concurrently, so a run
   * spreads its load over time instead of firing every scorer's backend call
   * at once. A scorer that throws does not stop the others: its failure is
   * recorded on its own entry.
   *
   * @param request The query, response, golden answer and active config.
   * @returns One entry per configured scorer, in run order. Never empty.
   */
  async scoreAll(request: ScoringRequest): Promise<ScorerRunResult[]> {
    const scorers = this.scorerRegistry.resolveAll(request.config.selectedScorers);
    const results: ScorerRunResult[] = [];

    for (const scorer of scorers) {
      const entry: ScorerRunResult = {
        scorerId: scorer.id,
        displayName: scorer.displayName,
        score: 0
      };

      if (scorer.requiresGolden && !request.golden) {
        entry.skipped = true;
        results.push(entry);
        continue;
      }

      try {
        const result = await scorer.score(request);
        entry.score = result.score;
        if (result.details) {
          entry.details = result.details;
        }
      } catch (error) {
        console.error(
            `Error scoring response with '${scorer.id}' during evaluation:`,
            error);
        entry.error = (error as Error).message;
      }
      results.push(entry);
    }

    return results;
  }
}
