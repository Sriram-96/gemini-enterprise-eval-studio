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

import {ScorerRunResult} from '../scoring/scorer';

/**
 * Represents a row in the evaluation results.
 */
export interface ResultRow {
  query: string;
  golden: string;
  fetched: string;
  /**
   * The model's thinking trace: the text of every reply marked
   * `content.thought`, one thought per line, in the order the stream produced
   * them. Exported to CSV but deliberately not shown in the results table.
   *
   * Always set by `EvalService.processRow`, empty when the model emitted no
   * thoughts, because the CSV export derives its header from the first row
   * alone and a key missing there drops the column from the whole file.
   * Models differ: the Gemini 2.5 family emits thoughts, 3.5 does not.
   */
  thoughts?: string;
  /** Time to First Token in seconds (s). */
  ttft: number;
  /** Time to First Answer Token in seconds (s). */
  ttfa: number;
  /** Time to Last Token in seconds (s). */
  ttlt: number;
  /**
   * Score of the primary scorer, meaning the first one in the configured
   * selection. Always present so the results table and the Compare tab have a
   * single score to work with, however many scorers ran.
   */
  score: number;
  /** Identifier of the scorer that produced `score`. */
  scorerId?: string;
  /**
   * One entry per scorer that ran, in run order. `scorerResults[0]` is the
   * primary scorer mirrored by `score` and `scorerId`.
   */
  scorerResults?: ScorerRunResult[];
  assistToken?: string;
  projectId?: string;
  region?: string;
  engineId?: string;
  /** Error message of the first scorer that failed, if any. */
  scoreError?: string;
  /** Conversation grouping id from the input CSV, present only for multi-turn rows. */
  conversationId?: string;
  /** 1-based turn number within the conversation. */
  turn?: number;
  /** Discovery Engine session resource name used for/returned by this turn. */
  session?: string;
  /** Turn id returned by the Assistant API for this turn. */
  turnId?: string;
}
