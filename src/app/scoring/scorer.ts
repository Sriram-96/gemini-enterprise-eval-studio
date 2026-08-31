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

import {AppConfig} from '../models/app-config.model';
import {AssistTrace} from '../models/trace.model';

/**
 * Everything a scorer receives about a single evaluated row.
 */
export interface ScoringRequest {
  /** The original query sent to the agent. */
  query: string;
  /** The response the agent produced for the query. */
  response: string;
  /** The expected answer, when the uploaded dataset provides one. */
  golden?: string;
  /** The active application configuration. */
  config: AppConfig;
  /**
   * The citations and tool calls behind the response, letting a scorer judge
   * how the agent reached its answer rather than only what it said. Absent
   * when the row predates trace capture or the call failed before any reply.
   */
  trace?: AssistTrace;
  /**
   * The row's `expected_sources` column: the documents, data stores or
   * connectors the agent was supposed to consult, separated by `;`.
   */
  expectedSources?: string;
}

/**
 * The outcome a scorer produces for a single evaluated row.
 */
export interface ScoreResult {
  /** Normalized score, where 0.0 is the worst and 1.0 the best. */
  score: number;
  /**
   * Set when the scorer had nothing to judge, so the row is recorded as a skip
   * rather than as a zero that would drag an average down. Use this for input
   * the `requiresGolden` check cannot express, such as a row that names no
   * expected sources.
   */
  skipped?: boolean;
  /**
   * Optional scorer specific breakdown, such as a rationale or per-criterion
   * sub-scores. Not surfaced in the UI today.
   */
  details?: Record<string, unknown>;
}

/**
 * The outcome of running one scorer against one row, including the failures
 * and skips that a bare `ScoreResult` cannot express.
 */
export interface ScorerRunResult {
  /** Identifier of the scorer that produced this entry. */
  scorerId: string;
  /** Display name of the scorer, so results stay readable once exported. */
  displayName: string;
  /** Normalized score. Zero when the scorer failed or was skipped. */
  score: number;
  /** The scorer's error message, when it threw. */
  error?: string;
  /**
   * Whether the scorer was skipped because it requires a golden answer and
   * the row has none.
   */
  skipped?: boolean;
  /** Optional scorer specific breakdown; see `ScoreResult.details`. */
  details?: Record<string, unknown>;
}

/**
 * The single-score view of a multi-scorer run, as stored on a result row.
 */
export interface ScoreSummary {
  /** Score of the primary scorer, meaning the first one that ran. */
  score: number;
  /** Identifier of the primary scorer. */
  scorerId?: string;
  /** Message of the first scorer that failed, if any. */
  scoreError?: string;
  /** Every scorer's outcome, in run order. */
  scorerResults: ScorerRunResult[];
}

/**
 * Collapses a multi-scorer run into the flat fields a result row carries, so
 * consumers that only understand one score keep working.
 * @param results The per-scorer outcomes, in run order.
 * @returns The primary score plus the full set of outcomes.
 */
export function summarizeScorerResults(results: ScorerRunResult[]):
    ScoreSummary {
  const primary = results[0];
  const failed = results.find(result => result.error);
  const summary: ScoreSummary = {
    score: primary ? primary.score : 0,
    scorerResults: results
  };
  if (primary) {
    summary.scorerId = primary.scorerId;
  }
  if (failed) {
    // Name the scorer only when several ran, so a single-scorer run keeps
    // reporting the scorer's own message unchanged.
    summary.scoreError = results.length > 1 ?
        `${failed.displayName}: ${failed.error}` :
        failed.error;
  }
  return summary;
}

/**
 * A strategy for scoring a single agent response.
 *
 * Implementations are Angular services registered in the `SCORERS` token; see
 * `scorer.registry.ts` and `README.md` in this directory for how to add one.
 */
export abstract class Scorer {
  /** Stable identifier, persisted in the app config and exported results. */
  abstract readonly id: string;

  /** Human readable name shown in the configuration form. */
  abstract readonly displayName: string;

  /** Short explanation shown alongside the name in the configuration form. */
  readonly description: string = '';

  /**
   * Whether this scorer needs a golden answer to work. Rows without one are
   * left unscored when this is true.
   */
  readonly requiresGolden: boolean = true;

  /**
   * The `AppConfig` keys this scorer reads. The configuration form renders
   * only the inputs belonging to the currently selected scorers.
   */
  readonly configKeys: readonly (keyof AppConfig)[] = [];

  /**
   * Scores a single response.
   * @param request The query, response, golden answer and active config.
   * @returns A promise resolving to the score.
   * @throws An `Error` with a user facing message when scoring fails.
   */
  abstract score(request: ScoringRequest): Promise<ScoreResult>;

  /**
   * Validates the scorer specific parts of the configuration.
   * @param config The active application configuration.
   * @returns An error message, or null when the configuration is usable.
   */
  validate(config: AppConfig): string|null {
    return null;
  }
}
