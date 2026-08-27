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

import {AppConfig} from '../../models/app-config.model';
import {EvalBackendService} from '../../services/eval-backend.service';
import {ScoreResult, Scorer, ScoringRequest} from '../scorer';

/** Identifier of the LLM-as-a-judge scorer. */
export const AUTO_RATER_SCORER_ID = 'auto-rater';

/**
 * Scores a response by asking a Gemini model to rate it against the golden
 * answer, following the rubric in `config.autoRaterInstruction`.
 */
@Injectable({providedIn: 'root'})
export class AutoRaterScorer extends Scorer {
  readonly id = AUTO_RATER_SCORER_ID;
  readonly displayName = 'Auto Rater (LLM as a judge)';
  override readonly description =
      'Asks a Gemini model to rate the fetched response against the golden response using your rubric.';
  override readonly requiresGolden = true;
  override readonly configKeys:
      readonly (keyof AppConfig)[] = ['autoRaterModel', 'autoRaterInstruction'];

  constructor(private readonly evalBackendService: EvalBackendService) {
    super();
  }

  override validate(config: AppConfig): string|null {
    return config.autoRaterModel ? null : 'Select an auto rater model.';
  }

  async score({query, response, golden, config}: ScoringRequest):
      Promise<ScoreResult> {
    const prompt = `${config.autoRaterInstruction}

    Query: ${query}
    Fetched Response: ${response}
    Golden Response: ${golden ?? ''}

    Provide only the score as a float between 0.0 and 1.0.`;

    const body = {contents: [{role: 'user', parts: [{text: prompt}]}]};

    const res = await this.evalBackendService.callScore({
      projectId: config.projectId,
      region: config.region,
      model: config.autoRaterModel,
      body
    });

    if (!res.ok) {
      throw new Error(await this.buildErrorMessage(res, config));
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return {score: this.parseScore(text)};
  }

  /** Derives a user facing message from a failed scoring response. */
  private async buildErrorMessage(res: Response, config: AppConfig):
      Promise<string> {
    try {
      const errorData = await res.json();
      return errorData.error?.message || `HTTP error! status: ${res.status}`;
    } catch (e) {
      if (res.status === 403 || res.status === 401) {
        return 'Permission denied. Please check your Google Cloud access token.';
      }
      if (res.status === 404) {
        return `Model '${config.autoRaterModel}' not found or not available.`;
      }
      if (res.status === 429) {
        return 'Rate limit exceeded. Please try again later.';
      }
      if (res.status === 503) {
        return 'Service temporarily unavailable. Please try again later.';
      }
      return `HTTP error! status: ${res.status}`;
    }
  }

  /**
   * Extracts a numeric score out of the rater's free form answer.
   * @param rawText The text returned by the auto rater model.
   * @returns The parsed score, or 0 when no number could be found.
   */
  private parseScore(rawText: string|undefined): number {
    if (!rawText) {
      return 0;
    }

    // 1. Remove markdown code block markers
    let text = rawText.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');

    // 2. Remove typical prefix strings like "Score: "
    text = text.replace(
        /^(?:Score|score|Rating|rating|Similarity Score|similarity score|Similarity score)\s*:\s*/g,
        '');

    // 3. Strip range and scale descriptors to avoid matching scale. Removed
    // strings like these because the scale is mentioned in the instruction.
    // Sample strings - endpoints (0.0, 1.0) between 0.0 and 1.0 / between
    // 0 and 1 0.0 to 1.0 / 0 to 1 / 0-1 [0.0, 1.0] / [0, 1] out of 1 / out
    // of 1.0 / 1 / / 1.0
    let cleanText =
        text.replace(/between\s+0?(?:\.0)?\s+(?:and|to)\s+1?(?:\.0)?/gi, '');
    cleanText = cleanText.replace(/0?(?:\.0)?\s*(?:-|to)\s*1?(?:\.0)?/g, '');
    cleanText = cleanText.replace(/\[\s*0?(?:\.0)?\s*,\s*1?(?:\.0)?\s*\]/g, '');
    cleanText = cleanText.replace(/out\s+of\s+1?(?:\.0)?/gi, '');
    cleanText = cleanText.replace(/\/\s*1?(?:\.0)?/g, '');

    cleanText = cleanText.trim();

    // 4. Try direct parseFloat first
    const score = Number(cleanText);
    if (!isNaN(score)) {
      return score;
    }

    // 5. Fallback: match all decimal numbers in the text and use the last one
    const matches = cleanText.match(/[0-9]+(?:\.[0-9]+)?/g);
    if (matches && matches.length > 0) {
      const lastScore = Number(matches[matches.length - 1]);
      return isNaN(lastScore) ? 0 : lastScore;
    }

    return 0;
  }
}
