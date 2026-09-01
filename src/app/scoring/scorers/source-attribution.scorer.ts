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

import {CitedSource} from '../../models/trace.model';
import {ScoreResult, Scorer, ScoringRequest} from '../scorer';

/** Identifier of the source attribution scorer. */
export const SOURCE_ATTRIBUTION_SCORER_ID = 'source-attribution';

/** Separates the matchers within one `expected_sources` cell. */
const MATCHER_SEPARATOR = ';';

/**
 * Checks that the agent actually consulted the documents it was supposed to.
 *
 * Where the auto rater judges what the answer said, this judges where the
 * answer came from: a fluent response grounded in the wrong document, or in
 * nothing at all, fails here even when it reads perfectly. That makes source
 * attribution a regression metric rather than something a tester has to
 * eyeball case by case.
 *
 * Each `;`-separated matcher in the row's `expected_sources` is satisfied when
 * it names a cited data store or connector outright, or appears anywhere in a
 * cited document's uri, resource name or title.
 */
@Injectable({providedIn: 'root'})
export class SourceAttributionScorer extends Scorer {
  readonly id = SOURCE_ATTRIBUTION_SCORER_ID;
  readonly displayName = 'Source Attribution';
  override readonly description =
      'Checks the answer cited the documents, data stores or connectors named in the query set\'s expected_sources column.';
  // Judges the citations, not the wording, so a golden answer is irrelevant.
  override readonly requiresGolden = false;

  async score({trace, expectedSources}: ScoringRequest): Promise<ScoreResult> {
    const expected = (expectedSources ?? '')
                         .split(MATCHER_SEPARATOR)
                         .map(matcher => matcher.trim())
                         .filter(matcher => !!matcher);

    const sources = trace?.sources ?? [];
    const actual = sources.map(source => this.describe(source));

    if (expected.length === 0) {
      // Nothing was asked of this row, so scoring it either way would be a
      // verdict the query set never requested.
      return {score: 0, skipped: true, details: {actual}};
    }

    const matched: string[] = [];
    const missing: string[] = [];
    for (const matcher of expected) {
      const hit = sources.some(source => this.matches(source, matcher));
      (hit ? matched : missing).push(matcher);
    }

    return {
      score: matched.length / expected.length,
      details: {matched, missing, actual},
    };
  }

  /**
   * Decides whether one cited source satisfies one expectation.
   *
   * Data stores and connectors match exactly, because they are identifiers a
   * tester types in full and a substring rule there would let `sales` pass for
   * `salesforce`. Documents match on substring, because a tester should be
   * able to name a page by its title or a path fragment without pasting a
   * full resource name.
   * @param source A document the answer cited.
   * @param matcher One entry from `expected_sources`.
   * @returns Whether the source is what the matcher asked for.
   */
  private matches(source: CitedSource, matcher: string): boolean {
    const needle = matcher.toLowerCase();

    if (source.dataStoreId?.toLowerCase() === needle ||
        source.connector?.toLowerCase() === needle) {
      return true;
    }

    return [source.uri, source.document, source.title].some(
        field => !!field && field.toLowerCase().includes(needle));
  }

  /** Names a cited source in the terms a tester would write an expectation in. */
  private describe(source: CitedSource): string {
    return source.dataStoreId || source.uri || source.title ||
        source.document || '(unidentified)';
  }
}
