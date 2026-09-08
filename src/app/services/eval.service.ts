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

import {AppConfig} from '../models/app-config.model';
import {CSVRow} from '../models/csv-row.model';
import {ResultRow} from '../models/result-row.model';
import {summarizeTrace} from '../models/trace.model';
import {ScorerRunResult, ScoringRequest, summarizeScorerResults} from '../scoring/scorer';
import {ScorerRegistry} from '../scoring/scorer.registry';

import {EvalBackendService} from './eval-backend.service';
import {resolveRowConfig} from './row-config.util';
import {StateService} from './state.service';
import {TraceCollector} from './trace-collector';



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
 * An error from the Assistant call that carries a structured `code`, so the
 * failure can be surfaced as data (`ResultRow.errorCode`) rather than being
 * flattened into a message string. `message` stays clean and human-readable for
 * the results table.
 */
export class AssistError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AssistError';
  }
}

/**
 * Reduces any caught error to the structured `{code, message}` a failed
 * `ResultRow` records. An `AssistError` already carries both; anything else
 * (network, stream, or parse failure) has no status to attribute, so it gets
 * the generic `ERROR` code and its own clean message — no `Error:` prefix.
 */
function describeError(error: unknown): {code: string; message: string} {
  if (error instanceof AssistError) {
    return {code: error.code, message: error.message};
  }
  const message = error instanceof Error ? error.message : String(error);
  return {code: 'ERROR', message};
}

/**
 * Slow-query threshold in seconds. A completed row whose TTLT exceeds this is
 * flagged via `ResultRow.latencyExceededBy`, surfacing a warning on the results
 * table. Tune this single value to change the budget; it is intentionally not
 * per-row or user-configurable for now.
 */
export const DEFAULT_MAX_TTLT_SECONDS = 30;

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

    // Resolve the per-row `data_stores` override, falling back to the global run
    // configuration when the cell is absent.
    const eff = resolveRowConfig(row, config);

    const toolsSpec: NonNullable<AssistRequestBody['toolsSpec']> = {};

    if (eff.dataStores.length > 0) {
      toolsSpec.vertexAiSearchSpec = {
        dataStoreSpecs: eff.dataStores.map(
            ds => ({
              dataStore: `projects/${config.projectId}/locations/${
                  config.region}/collections/default_collection/dataStores/${
                  ds}`
            }))
      };
    } else if (!eff.enableWebSearch) {
      toolsSpec.vertexAiSearchSpec = {};
    }

    if (eff.enableWebSearch) {
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
    const thoughts: string[] = [];
    const traceCollector = new TraceCollector();
    let assistToken = '';
    let isFirstChunk = true;
    let isFirstUserChunk = true;
    let sessionInfo: {session?: string; turnId?: string}|undefined;
    let skippedReason: string|undefined;

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
          throw new AssistError('RATE_LIMITED', `Rate limited: ${reason}`);
        }
        // The server's reason phrase (e.g. "Unauthorized") is included when it
        // sends one; it is often empty over HTTP/2, so fall back to the status
        // number alone rather than inventing a meaning for it.
        const reason = response.statusText?.trim();
        throw new AssistError(
            `HTTP ${response.status}`,
            reason ? `HTTP error ${response.status} (${reason})` :
                     `HTTP error ${response.status}`);
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

              traceCollector.addRawItem(item);

              if (item.answer?.state === 'SKIPPED') {
                const reason =
                    item.answer?.assistSkippedReasons?.[0] || 'Unknown reason';
                skippedReason = reason;
                fullText = `SKIPPED: ${reason}`;
                break;
              }
              const replies = item.answer?.replies || [];
              for (const reply of replies) {
                const groundedContent = reply.groundedContent;

                // A reply's content and its grounding metadata are
                // independent: one can carry the documents behind an earlier
                // reply's text and no content of its own, so the citations
                // must be collected outside the `content` check below.
                traceCollector.addGroundedContent(groundedContent);

                const content = groundedContent?.content;
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

                    if (text && thought) {
                      // One thought per line, so a reader can scan the trace
                      // as a list. Each streamed thought is its own reply, so
                      // internal newlines are folded away rather than being
                      // mistaken for extra thoughts.
                      const line = text.replace(/\s+/g, ' ').trim();
                      if (line) {
                        thoughts.push(line);
                      }
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
      const tpot = await this.computeTpot(fullText, thoughts, ttft, ttlt, config);

      const ttltSeconds = Number((ttlt / 1000).toFixed(2));
      const over = ttltSeconds - DEFAULT_MAX_TTLT_SECONDS;
      // Left undefined (not 0) when within budget so fast rows carry no flag and
      // the results table shows nothing for them.
      const latencyExceededBy =
          over > 0 ? Number(over.toFixed(2)) : undefined;

      const trace = traceCollector.build();
      const expectedSources = row['expected_sources'] || '';

      onProgress?.('score');
      const scorerResults = await this.scoreAll({
        query: row.query,
        response: fullText,
        golden: row.golden,
        config,
        trace,
        expectedSources
      });

      return {
        query: row.query,
        golden: row.golden || '',
        fetched: fullText,
        thoughts: thoughts.join('\n'),
        ...summarizeTrace(trace),
        trace,
        expectedSources,
        ttft: Number((ttft / 1000).toFixed(2)),
        ttfa: Number((ttfa / 1000).toFixed(2)),
        ttlt: ttltSeconds,
        tpot,
        latencyExceededBy,
        ...summarizeScorerResults(scorerResults),
        errorCode: skippedReason ? 'SKIPPED' : '',
        assistToken,
        projectId,
        region,
        engineId,
        session: sessionInfo?.session,
        turnId: sessionInfo?.turnId,
        dataStoresUsed: eff.dataStoresLabel
      };

    } catch (error) {
      console.error('Error processing row:', error);
      const {code, message} = describeError(error);
      const trace = traceCollector.build();
      return {
        query: row.query,
        golden: row.golden || '',
        fetched: message,
        errorCode: code,
        // Whatever the model managed to think and cite before the failure is
        // still worth keeping, and the keys must exist so the columns survive
        // export.
        thoughts: thoughts.join('\n'),
        ...summarizeTrace(trace),
        trace,
        expectedSources: row['expected_sources'] || '',
        ttft: 0,
        ttfa: 0,
        ttlt: 0,
        tpot: 0,
        score: 0,
        scorerId: this.scorerRegistry.resolveAll(config.selectedScorers)[0].id,
        assistToken,
        projectId,
        region,
        engineId,
        session: sessionInfo?.session,
        turnId: sessionInfo?.turnId,
        dataStoresUsed: eff.dataStoresLabel
      };
    }
  }

  /**
   * Computes Time Per Output Token (TPOT) in milliseconds per token.
   *
   * TPOT is the average time to generate each output token after the first:
   * `(ttlt - ttft) / (outputTokens - 1)`. streamAssist returns no token count,
   * so the output tokens are counted from the produced text (thoughts joined
   * with the answer) using Vertex `countTokens` on the same model the auto
   * rater runs on, which guarantees the method is available wherever the auto
   * rater is.
   *
   * Returns 0 rather than a misleading estimate whenever the count is
   * unavailable (no output, a failed or non-OK response, or a thrown error) or
   * when one token or fewer was produced, which would leave no interval to
   * divide.
   *
   * @param fullText The answer text, excluding thoughts.
   * @param thoughts The thinking-trace lines, if any.
   * @param ttftMs Time to first token, in milliseconds.
   * @param ttltMs Time to last token, in milliseconds.
   * @param config The active configuration, for the project, region and model.
   * @returns TPOT in ms/token, rounded to two decimals, or 0.
   */
  private async computeTpot(
      fullText: string, thoughts: string[], ttftMs: number, ttltMs: number,
      config: AppConfig): Promise<number> {
    const outputText = [...thoughts, fullText].join('\n').trim();
    if (!outputText) {
      return 0;
    }

    try {
      const response = await this.evalBackendService.callCountTokens({
        projectId: config.projectId,
        region: config.region,
        model: config.autoRaterModel,
        body: {contents: [{role: 'user', parts: [{text: outputText}]}]},
      });
      if (!response.ok) {
        return 0;
      }
      const data = await response.json();
      const tokens = Number(data.totalTokens) || 0;
      if (tokens <= 1) {
        return 0;
      }
      return Number(((ttltMs - ttftMs) / (tokens - 1)).toFixed(2));
    } catch (e) {
      console.error('Error counting output tokens for TPOT:', e);
      return 0;
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
        if (result.skipped) {
          entry.skipped = true;
        }
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
