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

import {ScoreResult, Scorer, ScoringRequest} from '../scorer';

/** Identifier of the deterministic lexical overlap scorer. */
export const DETERMINISTIC_SCORER_ID = 'deterministic';

/**
 * Longest token sequence either side is compared over. The LCS dynamic program
 * is O(n*m), so an unbounded pair of long answers would cost a run hundreds of
 * milliseconds per row; 2000 tokens keeps the worst case near 90ms. A score
 * computed over truncated input reports `truncated: true` in its details.
 */
export const MAX_TOKENS = 2000;

/**
 * Splits text into comparable tokens.
 *
 * Decomposing to NFD and dropping the combining marks is what makes `café` and
 * `cafe` the same token; everything that is neither a letter nor a number then
 * becomes a separator, so punctuation and casing carry no weight.
 *
 * @param text The golden answer or the agent response.
 * @returns The tokens, in order, with empties removed.
 */
export function tokenize(text: string): string[] {
  return text.normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter(token => token.length > 0);
}

/**
 * Computes the length of the longest common subsequence of two token lists.
 *
 * Uses a rolling two-row dynamic program: O(n*m) time and O(min(n, m)) space,
 * with the shorter list on the inner axis so the rows stay small.
 *
 * @param a The first token list.
 * @param b The second token list.
 * @returns The number of tokens in the longest common subsequence.
 */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  const outer = a.length >= b.length ? a : b;
  const inner = a.length >= b.length ? b : a;
  if (inner.length === 0) {
    return 0;
  }

  let previous = new Uint32Array(inner.length + 1);
  let current = new Uint32Array(inner.length + 1);

  for (const token of outer) {
    for (let j = 0; j < inner.length; j++) {
      // Every cell of `current` past index 0 is written on each pass, so the
      // row reused from two iterations ago never leaks a stale value.
      current[j + 1] = token === inner[j] ?
          previous[j] + 1 :
          Math.max(previous[j + 1], current[j]);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[inner.length];
}

/**
 * Scores a response by the longest common subsequence it shares with the
 * golden answer, as an F1 measure. The measure is ROUGE-L.
 *
 * Deterministic and offline: the same pair of strings always produces the same
 * number, on every machine and in any order relative to other comparisons.
 *
 * It measures lexical overlap only and has no notion of meaning. A typo makes
 * a wholly different token (`john smith` against `jon smyth` scores 0.0), a
 * synonym contributes nothing, and a correct but verbose answer is penalized
 * by precision. It is a fast reproducible floor under the auto rater, not a
 * substitute for it.
 */
@Injectable({providedIn: 'root'})
export class DeterministicScorer extends Scorer {
  readonly id = DETERMINISTIC_SCORER_ID;
  readonly displayName = 'Deterministic';
  override readonly description =
      'Measures the longest shared word sequence between the fetched and golden responses. Deterministic and offline, but lexical only: synonyms and typos score low.';
  override readonly requiresGolden = true;

  async score({response, golden}: ScoringRequest): Promise<ScoreResult> {
    const goldenTokens = tokenize(golden ?? '');
    const responseTokens = tokenize(response ?? '');
    const truncated =
        goldenTokens.length > MAX_TOKENS || responseTokens.length > MAX_TOKENS;
    const g = truncated ? goldenTokens.slice(0, MAX_TOKENS) : goldenTokens;
    const r = truncated ? responseTokens.slice(0, MAX_TOKENS) : responseTokens;

    const details = {
      recall: 0,
      precision: 0,
      lcsLength: 0,
      goldenTokens: g.length,
      responseTokens: r.length,
      truncated
    };

    // A golden or response that is empty, or that is nothing but punctuation,
    // leaves no tokens to compare and would divide by zero.
    if (g.length === 0 || r.length === 0) {
      return {score: 0, details};
    }

    const lcs = lcsLength(g, r);
    const recall = lcs / g.length;
    const precision = lcs / r.length;
    const score = recall + precision === 0 ?
        0 :
        (2 * recall * precision) / (recall + precision);

    return {
      score,
      details: {...details, recall, precision, lcsLength: lcs}
    };
  }
}
