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

import {AppConfig} from '../models/app-config.model';
import {EvalBackendService} from '../services/eval-backend.service';
import {MockEvalBackendService} from '../testing/mocks';

import {ScoreResult, Scorer, ScoringRequest} from './scorer';
import {SCORERS, ScorerRegistry} from './scorer.registry';
import {AUTO_RATER_SCORER_ID} from './scorers/auto-rater.scorer';

/** Minimal scorer used to verify the registry stays strategy agnostic. */
class FakeScorer extends Scorer {
  override readonly requiresGolden = false;

  constructor(
      readonly id = 'fake', readonly displayName = 'Fake Scorer') {
    super();
  }

  async score(request: ScoringRequest): Promise<ScoreResult> {
    return {score: 1};
  }
}

describe('ScorerRegistry', () => {
  describe('with the built-in scorers', () => {
    let registry: ScorerRegistry;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          {provide: EvalBackendService, useValue: new MockEvalBackendService()}
        ]
      });
      registry = TestBed.inject(ScorerRegistry);
    });

    it('should register the auto rater', () => {
      expect(registry.list().map(s => s.id)).toContain(AUTO_RATER_SCORER_ID);
    });

    it('should default to the first registered scorer', () => {
      expect(registry.defaultId).toBe(registry.list()[0].id);
    });

    it('should resolve a scorer by id', () => {
      expect(registry.resolve(AUTO_RATER_SCORER_ID).id)
          .toBe(AUTO_RATER_SCORER_ID);
    });

    it('should fall back to the default scorer for an unknown id', () => {
      expect(registry.resolve('does-not-exist').id).toBe(registry.defaultId);
    });

    it('should fall back to the default scorer when no id is configured', () => {
      expect(registry.resolve(undefined).id).toBe(registry.defaultId);
    });

    it('should require a golden answer for the auto rater', () => {
      expect(registry.resolve(AUTO_RATER_SCORER_ID).requiresGolden).toBeTrue();
    });

    it('should reject an auto rater config without a model', () => {
      const config = {autoRaterModel: ''} as AppConfig;
      expect(registry.resolve(AUTO_RATER_SCORER_ID).validate(config))
          .toBeTruthy();
      expect(registry.resolve(AUTO_RATER_SCORER_ID)
                 .validate({...config, autoRaterModel: 'gemini-3.5-flash'}))
          .toBeNull();
    });

    it('should default to a selection holding the default scorer', () => {
      expect(registry.defaultIds).toEqual([registry.defaultId]);
    });
  });

  describe('resolveAll', () => {
    /** Registers the given ids as scorers and returns the registry. */
    function registryOf(...ids: string[]): ScorerRegistry {
      TestBed.configureTestingModule({
        providers: [{
          provide: SCORERS,
          useValue: ids.map(id => new FakeScorer(id, id.toUpperCase()))
        }]
      });
      return TestBed.inject(ScorerRegistry);
    }

    it('should resolve every selected scorer', () => {
      const registry = registryOf('a', 'b', 'c');

      expect(registry.resolveAll(['a', 'c']).map(s => s.id)).toEqual(['a', 'c']);
    });

    it('should return the scorers in registry order, not selection order',
       () => {
         const registry = registryOf('a', 'b', 'c');

         expect(registry.resolveAll(['c', 'a']).map(s => s.id)).toEqual([
           'a', 'c'
         ]);
       });

    it('should drop duplicate ids', () => {
      const registry = registryOf('a', 'b');

      expect(registry.resolveAll(['a', 'a', 'b']).map(s => s.id)).toEqual([
        'a', 'b'
      ]);
    });

    it('should drop unknown ids', () => {
      const registry = registryOf('a', 'b');

      expect(registry.resolveAll(['a', 'nope']).map(s => s.id)).toEqual(['a']);
    });

    it('should fall back to the default scorer for an empty selection', () => {
      const registry = registryOf('a', 'b');

      expect(registry.resolveAll([]).map(s => s.id)).toEqual(['a']);
      expect(registry.resolveAll(undefined).map(s => s.id)).toEqual(['a']);
    });

    it('should fall back to the default scorer when every id is unknown', () => {
      const registry = registryOf('a', 'b');

      expect(registry.resolveAll(['nope', 'also-nope']).map(s => s.id))
          .toEqual(['a']);
    });
  });

  describe('with custom scorers', () => {
    it('should expose scorers registered through the SCORERS token', () => {
      const fake = new FakeScorer();
      TestBed.configureTestingModule(
          {providers: [{provide: SCORERS, useValue: [fake]}]});

      const registry = TestBed.inject(ScorerRegistry);

      expect(registry.list()).toEqual([fake]);
      expect(registry.defaultId).toBe('fake');
      expect(registry.resolve('fake')).toBe(fake);
    });

    it('should throw when no scorer is registered', () => {
      TestBed.configureTestingModule(
          {providers: [{provide: SCORERS, useValue: []}]});

      expect(() => TestBed.inject(ScorerRegistry)).toThrowError(/No scorers/);
    });
  });
});
