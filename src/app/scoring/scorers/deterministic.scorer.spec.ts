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

import {TestBed} from '@angular/core/testing';

import {AppConfig} from '../../models/app-config.model';

import {DETERMINISTIC_SCORER_ID, DeterministicScorer, MAX_TOKENS} from './deterministic.scorer';

const CONFIG: AppConfig = {
  projectId: 'project',
  region: 'global',
  selectedEngine: 'engine',
  selectedModel: 'model',
  autoRaterModel: '',
  autoRaterInstruction: '',
  selectedDataStores: [],
  enableWebSearch: false
};

/**
 * The golden answers used by the length-asymmetry cases, kept here because
 * their token counts are what the expected scores depend on.
 */
const TERSE_GOLDEN = 'the capital city of france is paris which is also the ' +
    'largest city in the country';
const VERBOSE_RESPONSE =
    'well, the answer to your question is that the capital city here is paris';

describe('DeterministicScorer', () => {
  let scorer: DeterministicScorer;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    scorer = TestBed.inject(DeterministicScorer);
  });

  /** Scores a golden/response pair and returns the F1 score alone. */
  async function score(golden: string, response: string): Promise<number> {
    const result =
        await scorer.score({query: 'query', response, golden, config: CONFIG});
    return result.score;
  }

  /** Scores a golden/response pair and returns its `details`. */
  async function detailsOf(golden: string, response: string):
      Promise<Record<string, unknown>> {
    const result =
        await scorer.score({query: 'query', response, golden, config: CONFIG});
    return result.details!;
  }

  describe('scorer surface', () => {
    it('should expose a stable id and display name', () => {
      expect(scorer.id).toBe(DETERMINISTIC_SCORER_ID);
      expect(scorer.displayName).toBe('Deterministic');
    });

    it('should require a golden answer', () => {
      expect(scorer.requiresGolden).toBeTrue();
    });

    it('should read no configuration keys', () => {
      expect(scorer.configKeys).toEqual([]);
    });

    it('should accept any configuration', () => {
      expect(scorer.validate(CONFIG)).toBeNull();
      expect(scorer.validate({...CONFIG, projectId: ''})).toBeNull();
    });
  });

  describe('exact and normalized matches', () => {
    it('should score identical text 1.0', async () => {
      expect(await score('hello world', 'hello world')).toBeCloseTo(1.0, 3);
    });

    it('should ignore case and punctuation', async () => {
      expect(await score('Hello, World!', 'hello world')).toBeCloseTo(1.0, 3);
    });

    it('should ignore diacritics', async () => {
      expect(await score('café résumé', 'cafe resume')).toBeCloseTo(1.0, 3);
    });

    it('should ignore surrounding whitespace and repeated separators',
       async () => {
         expect(await score('  hello   world  ', 'hello world'))
             .toBeCloseTo(1.0, 3);
       });
  });

  describe('word order', () => {
    it('should halve a two-token swap', async () => {
      expect(await score('hello world', 'world hello')).toBeCloseTo(0.5, 3);
    });

    it('should give partial credit for a legitimate reordering', async () => {
      expect(await score(
                 'paris is the capital of france',
                 'the capital of france is paris'))
          .toBe(0.67);
    });

    it('should heavily penalize a full reversal of a long sentence',
       async () => {
         expect(await score(
                    'machine learning model was trained successfully',
                    'successfully trained was model learning machine'))
             .toBe(0.17);
       });
  });

  describe('meaning reversal', () => {
    it('should score a reversed subject and object 0.6', async () => {
      expect(await score('the dog bit the man', 'the man bit the dog'))
          .toBeCloseTo(0.6, 3);
    });

    // This is the property the whole choice of an LCS measure rests on: a
    // sentence whose meaning was inverted must rank below a genuine rewording
    // of the same fact. Bag-of-words and character-positional metrics get this
    // backwards.
    it('should rank a meaning reversal below a legitimate reordering',
       async () => {
         const reversal = await score('the dog bit the man', 'the man bit the dog');
         const reorder = await score(
             'paris is the capital of france', 'the capital of france is paris');

         expect(reversal).toBeLessThan(reorder);
       });
  });

  describe('lexical limits', () => {
    it('should give a near paraphrase most of the credit', async () => {
      expect(await score(
                 'the model achieved 95% accuracy',
                 'the model reached 95% accuracy'))
          .toBeCloseTo(0.8, 3);
    });

    it('should only partly credit a change of inflection', async () => {
      expect(await score('the model was trained', 'the model is training'))
          .toBeCloseTo(0.5, 3);
    });

    it('should score a misspelled name 0.0, as lexical overlap must',
       async () => {
         expect(await score('john smith', 'jon smyth')).toBeCloseTo(0.0, 3);
      });

    it('should score unrelated text 0.0', async () => {
      expect(await score(
                 'the capital of france is paris',
                 'photosynthesis converts light into sugar'))
          .toBeCloseTo(0.0, 3);
    });

    it('should treat a spelled out number as a different token', async () => {
      expect(await score('95% accuracy rate', '95 percent accuracy'))
          .toBe(0.67);
    });
  });

  describe('length asymmetry', () => {
    it('should penalize a terse but correct answer through recall',
       async () => {
         expect(await score(TERSE_GOLDEN, 'paris is the capital of france'))
             .toBe(0.36);
       });

    it('should penalize a verbose but correct answer through precision',
       async () => {
         expect(await score('paris', VERBOSE_RESPONSE)).toBe(0.13);
       });
  });

  describe('rounding', () => {
    it('should report no more than two decimal places', async () => {
      const pairs: Array<[string, string]> = [
        ['paris is the capital of france', 'the capital of france is paris'],
        ['machine learning model was trained successfully',
         'successfully trained was model learning machine'],
        ['the dog bit the man', 'the man bit the dog'],
        [TERSE_GOLDEN, 'paris is the capital of france'],
        ['paris', VERBOSE_RESPONSE],
        ['the model achieved 95% accuracy', 'the model reached 95% accuracy'],
      ];

      for (const [golden, response] of pairs) {
        const value = await score(golden, response);

        // A float cannot hold 0.67 exactly, so the check is that scaling by
        // 100 lands on a whole number rather than that it equals one.
        expect(value * 100).toBeCloseTo(Math.round(value * 100), 9);
      }
    });

    it('should round a half upward', async () => {
      // F1 reduces to 2 * lcs / (goldenTokens + responseTokens), so one shared
      // token across sixteen is exactly 0.125 — the tie that separates
      // rounding half up from half down.
      const response = `${VERBOSE_RESPONSE} today`;

      expect((await detailsOf('paris', response))['responseTokens']).toBe(15);
      expect(await score('paris', response)).toBe(0.13);
    });

    it('should keep an exact score exact', async () => {
      expect(await score('hello world', 'hello world')).toBe(1);
      expect(await score('hello world', 'world hello')).toBe(0.5);
      expect(await score('paris', 'london')).toBe(0);
    });
  });

  describe('determinism', () => {
    it('should return a bit-identical value across repeated calls', async () => {
      const first = await score('john smith works in paris', 'jon smith in paris');
      for (let i = 0; i < 100; i++) {
        expect(await score('john smith works in paris', 'jon smith in paris'))
            .toBe(first);
      }
    });

    // The library the first attempt used returned a different value for the
    // same pair depending on what had been compared before it.
    it('should not be affected by unrelated comparisons in between',
       async () => {
         const isolated = await score('john smith', 'jon smyth');

         await score('the dog bit the man', 'the man bit the dog');
         await score('photosynthesis converts light', 'hello world');
         await score('a'.repeat(100), 'b'.repeat(100));

         expect(await score('john smith', 'jon smyth')).toBe(isolated);
       });

    it('should agree with a freshly constructed instance', async () => {
      const request = {
        query: 'query',
        response: 'the capital of france is paris',
        golden: 'paris is the capital of france',
        config: CONFIG
      };
      const reused = await scorer.score(request);
      const fresh = await new DeterministicScorer().score(request);

      expect(fresh.score).toBe(reused.score);
      expect(fresh.details).toEqual(reused.details);
    });
  });

  describe('edge cases', () => {
    it('should score an empty response 0.0', async () => {
      expect(await score('the capital of france is paris', '')).toBe(0);
    });

    it('should score a punctuation-only golden 0.0 without dividing by zero',
       async () => {
         expect(await score('!!! ... ???', 'paris')).toBe(0);
       });

    it('should score two empty strings 0.0', async () => {
      expect(await score('', '')).toBe(0);
    });

    it('should handle a missing golden as empty', async () => {
      const result = await scorer.score(
          {query: 'query', response: 'paris', config: CONFIG});

      expect(result.score).toBe(0);
    });

    it('should score matching single tokens 1.0', async () => {
      expect(await score('paris', 'paris')).toBeCloseTo(1.0, 3);
    });

    it('should score differing single tokens 0.0', async () => {
      expect(await score('paris', 'london')).toBeCloseTo(0.0, 3);
    });

    it('should keep every score within [0, 1]', async () => {
      const pairs: Array<[string, string]> = [
        ['hello world', 'hello world'],
        ['hello world', 'world hello'],
        ['john smith', 'jon smyth'],
        [TERSE_GOLDEN, 'paris is the capital of france'],
        ['paris', VERBOSE_RESPONSE],
        ['', 'paris'],
      ];

      for (const [golden, response] of pairs) {
        const value = await score(golden, response);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('truncation', () => {
    /** Builds `count` distinct tokens, so no two positions can match. */
    function distinctTokens(count: number, prefix: string): string {
      const tokens: string[] = [];
      for (let i = 0; i < count; i++) {
        tokens.push(`${prefix}${i}`);
      }
      return tokens.join(' ');
    }

    it('should not flag input at the cap', async () => {
      const text = distinctTokens(MAX_TOKENS, 'w');

      expect((await detailsOf(text, text))['truncated']).toBeFalse();
    });

    it('should flag and cap input beyond the token limit', async () => {
      const text = distinctTokens(MAX_TOKENS + 50, 'w');
      const details = await detailsOf(text, text);

      expect(details['truncated']).toBeTrue();
      expect(details['goldenTokens']).toBe(MAX_TOKENS);
      expect(details['responseTokens']).toBe(MAX_TOKENS);
    });

    it('should flag truncation when only one side is over the limit',
       async () => {
         const details = await detailsOf(
             distinctTokens(MAX_TOKENS + 1, 'w'), 'paris');

         expect(details['truncated']).toBeTrue();
       });

    it('should still score the truncated prefix', async () => {
      const text = distinctTokens(MAX_TOKENS + 50, 'w');

      expect(await score(text, text)).toBeCloseTo(1.0, 3);
    });
  });

  describe('details', () => {
    it('should report recall, precision and the LCS length', async () => {
      const details = await detailsOf(
          'paris is the capital of france', 'the capital of france is paris');

      expect(details['lcsLength']).toBe(4);
      expect(details['goldenTokens']).toBe(6);
      expect(details['responseTokens']).toBe(6);
      expect(details['recall'] as number).toBeCloseTo(0.667, 3);
      expect(details['precision'] as number).toBeCloseTo(0.667, 3);
      expect(details['truncated']).toBeFalse();
    });

    it('should report the asymmetric counts of a terse answer', async () => {
      const details = await detailsOf(TERSE_GOLDEN, 'paris is the capital of france');

      expect(details['lcsLength']).toBe(4);
      expect(details['goldenTokens']).toBe(16);
      expect(details['responseTokens']).toBe(6);
      expect(details['recall'] as number).toBeCloseTo(0.25, 3);
      expect(details['precision'] as number).toBeCloseTo(0.667, 3);
    });

    it('should report the asymmetric counts of a verbose answer', async () => {
      const details = await detailsOf('paris', VERBOSE_RESPONSE);

      expect(details['lcsLength']).toBe(1);
      expect(details['goldenTokens']).toBe(1);
      expect(details['responseTokens']).toBe(14);
      expect(details['recall'] as number).toBeCloseTo(1.0, 3);
      expect(details['precision'] as number).toBeCloseTo(0.071, 3);
    });

    it('should report a score consistent with its own recall and precision',
       async () => {
         const result = await scorer.score({
           query: 'query',
           response: 'the model reached 95% accuracy',
           golden: 'the model achieved 95% accuracy',
           config: CONFIG
         });
         const recall = result.details!['recall'] as number;
         const precision = result.details!['precision'] as number;
         const f1 = 2 * recall * precision / (recall + precision);

         // The score is the rounded F1 of the details, which stay exact.
         expect(result.score).toBe(Math.round(f1 * 100) / 100);
       });

    it('should report zeroed details for an empty comparison', async () => {
      const details = await detailsOf('paris', '');

      expect(details).toEqual({
        recall: 0,
        precision: 0,
        lcsLength: 0,
        goldenTokens: 1,
        responseTokens: 0,
        truncated: false
      });
    });
  });
});
