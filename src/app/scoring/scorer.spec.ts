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

import {ScorerRunResult, summarizeScorerResults} from './scorer';

/** Builds a scorer outcome with the given overrides. */
function run(partial: Partial<ScorerRunResult>&{scorerId: string}):
    ScorerRunResult {
  return {
    displayName: partial.scorerId.toUpperCase(),
    score: 0,
    ...partial
  };
}

describe('summarizeScorerResults', () => {
  it('should mirror the first scorer as the primary score', () => {
    const summary = summarizeScorerResults([
      run({scorerId: 'first', score: 0.25}),
      run({scorerId: 'second', score: 0.75}),
    ]);

    expect(summary.score).toBe(0.25);
    expect(summary.scorerId).toBe('first');
    expect(summary.scoreError).toBeUndefined();
    expect(summary.scorerResults.length).toBe(2);
  });

  it('should report a lone scorer error unchanged', () => {
    const summary = summarizeScorerResults(
        [run({scorerId: 'only', displayName: 'Only', error: 'boom'})]);

    expect(summary.scoreError).toBe('boom');
  });

  it('should name the failing scorer when several ran', () => {
    const summary = summarizeScorerResults([
      run({scorerId: 'first', score: 0.5}),
      run({scorerId: 'second', displayName: 'Second', error: 'boom'}),
    ]);

    // The primary scorer succeeded, so its score survives the failure.
    expect(summary.score).toBe(0.5);
    expect(summary.scoreError).toBe('Second: boom');
  });

  it('should report the first failure when several scorers fail', () => {
    const summary = summarizeScorerResults([
      run({scorerId: 'first', displayName: 'First', error: 'first boom'}),
      run({scorerId: 'second', displayName: 'Second', error: 'second boom'}),
    ]);

    expect(summary.scoreError).toBe('First: first boom');
  });

  it('should tolerate an empty run', () => {
    const summary = summarizeScorerResults([]);

    expect(summary.score).toBe(0);
    expect(summary.scorerId).toBeUndefined();
    expect(summary.scorerResults).toEqual([]);
  });
});
