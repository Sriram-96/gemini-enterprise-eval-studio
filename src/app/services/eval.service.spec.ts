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
import {ScoreResult, Scorer, ScoringRequest} from '../scoring/scorer';
import {SCORERS} from '../scoring/scorer.registry';
import {AUTO_RATER_SCORER_ID} from '../scoring/scorers/auto-rater.scorer';
import {MockEvalBackendService} from '../testing/mocks';

import {EvalBackendService} from './eval-backend.service';
import {EvalService} from './eval.service';
import {StateService} from './state.service';

const CONFIG: AppConfig = {
  projectId: 'project',
  region: 'global',
  selectedEngine: 'engine',
  selectedModel: 'model',
  autoRaterModel: 'gemini-3.5-flash',
  autoRaterInstruction: 'instructions',
  selectedDataStores: [],
  enableWebSearch: false
};

/** A scorer whose behaviour and golden requirement the test controls. */
class FakeScorer extends Scorer {
  override readonly requiresGolden: boolean;
  readonly requests: ScoringRequest[] = [];

  constructor(
      readonly id: string, readonly displayName: string,
      private readonly behavior: () => Promise<ScoreResult>,
      requiresGolden = false) {
    super();
    this.requiresGolden = requiresGolden;
  }

  async score(request: ScoringRequest): Promise<ScoreResult> {
    this.requests.push(request);
    return this.behavior();
  }
}

describe('EvalService', () => {
  let mockBackendService: MockEvalBackendService;

  /**
   * Builds the injector, optionally replacing the registered scorers.
   * @param scorers The scorers to register, or none to keep the built-ins.
   */
  function setUp(scorers?: Scorer[]): EvalService {
    mockBackendService = new MockEvalBackendService();
    TestBed.configureTestingModule({
      providers: [
        EvalService,
        StateService,
        {provide: EvalBackendService, useValue: mockBackendService},
        ...(scorers ? [{provide: SCORERS, useValue: scorers}] : []),
      ]
    });
    return TestBed.inject(EvalService);
  }

  describe('scoreAll', () => {
    it('should run every selected scorer and report them in run order',
       async () => {
         const first = new FakeScorer('first', 'First', async () => ({
                                                          score: 0.25
                                                        }));
         const second = new FakeScorer('second', 'Second', async () => ({
                                                             score: 0.75
                                                           }));
         const service = setUp([first, second]);

         const results = await service.scoreAll({
           query: 'q',
           response: 'r',
           golden: 'g',
           config: {...CONFIG, selectedScorers: ['first', 'second']}
         });

         expect(results).toEqual([
           {scorerId: 'first', displayName: 'First', score: 0.25},
           {scorerId: 'second', displayName: 'Second', score: 0.75},
         ]);
       });

    it('should run the scorers one after another rather than concurrently',
       async () => {
         const events: string[] = [];
         const trace = (id: string) => async () => {
           events.push(`start:${id}`);
           await new Promise(resolve => setTimeout(resolve, 0));
           events.push(`end:${id}`);
           return {score: 1};
         };
         const service = setUp([
           new FakeScorer('first', 'First', trace('first')),
           new FakeScorer('second', 'Second', trace('second')),
         ]);

         await service.scoreAll({
           query: 'q',
           response: 'r',
           golden: 'g',
           config: {...CONFIG, selectedScorers: ['first', 'second']}
         });

         expect(events).toEqual(
             ['start:first', 'end:first', 'start:second', 'end:second']);
       });

    it('should keep running the remaining scorers after one throws',
       async () => {
         const service = setUp([
           new FakeScorer(
               'broken', 'Broken',
               async () => {
                 throw new Error('scorer exploded');
               }),
           new FakeScorer('working', 'Working', async () => ({score: 0.5})),
         ]);

         const results = await service.scoreAll({
           query: 'q',
           response: 'r',
           golden: 'g',
           config: {...CONFIG, selectedScorers: ['broken', 'working']}
         });

         expect(results[0].error).toBe('scorer exploded');
         expect(results[0].score).toBe(0);
         expect(results[1].score).toBe(0.5);
         expect(results[1].error).toBeUndefined();
       });

    it('should skip a scorer that needs a golden answer when there is none',
       async () => {
         const needsGolden = new FakeScorer(
             'needs-golden', 'Needs Golden', async () => ({score: 1}), true);
         const referenceFree =
             new FakeScorer('free', 'Reference Free', async () => ({
                                                        score: 0.4
                                                      }));
         const service = setUp([needsGolden, referenceFree]);

         const results = await service.scoreAll({
           query: 'q',
           response: 'r',
           config: {...CONFIG, selectedScorers: ['needs-golden', 'free']}
         });

         expect(results[0].skipped).toBeTrue();
         expect(results[0].score).toBe(0);
         expect(needsGolden.requests).toEqual([]);
         expect(results[1].score).toBe(0.4);
         expect(referenceFree.requests.length).toBe(1);
       });

    it('should fall back to the default scorer when none is selected',
       async () => {
         const first = new FakeScorer('first', 'First', async () => ({
                                                          score: 0.1
                                                        }));
         const service =
             setUp([first, new FakeScorer('second', 'Second', async () => ({
                                                                score: 0.2
                                                              }))]);

         const results = await service.scoreAll(
             {query: 'q', response: 'r', golden: 'g', config: CONFIG});

         expect(results.map(result => result.scorerId)).toEqual(['first']);
       });

    it('should ignore unknown scorer ids', async () => {
      const service =
          setUp([new FakeScorer('first', 'First', async () => ({score: 0.1}))]);

      const results = await service.scoreAll({
        query: 'q',
        response: 'r',
        golden: 'g',
        config: {...CONFIG, selectedScorers: ['nope', 'first']}
      });

      expect(results.map(result => result.scorerId)).toEqual(['first']);
    });
  });

  describe('processRow', () => {
    /** A streamed assist response carrying a single reply. */
    function fetched(text: string): Promise<Response> {
      return Promise.resolve(new Response(JSON.stringify(
          [{answer: {replies: [{groundedContent: {content: {text}}}]}}])));
    }

    it('should preserve the fetched text if scoring throws an error',
       async () => {
         const service = setUp();
         mockBackendService.callAssistSpy.and.returnValue(
             fetched('Fetched response text'));
         mockBackendService.callScoreSpy.and.returnValue(Promise.resolve(
             new Response('', {status: 500, statusText: 'Internal Server Error'})));
         spyOn(service['stateService'], 'getCurrentConfig')
             .and.returnValue(CONFIG);

         const result =
             await service.processRow({query: 'my query', golden: 'my golden'});

         expect(result.fetched).toBe('Fetched response text');
         expect(result.score).toBe(0);
         expect(result.scorerId).toBe(AUTO_RATER_SCORER_ID);
         expect(result.scoreError).toContain('HTTP error! status: 500');
       });

    it('should record every scorer on the row and mirror the first one',
       async () => {
         const service = setUp([
           new FakeScorer('first', 'First', async () => ({score: 0.25})),
           new FakeScorer('second', 'Second', async () => ({score: 0.75})),
         ]);
         mockBackendService.callAssistSpy.and.returnValue(fetched('answer'));
         spyOn(service['stateService'], 'getCurrentConfig')
             .and.returnValue({...CONFIG, selectedScorers: ['first', 'second']});

         const result = await service.processRow({query: 'q', golden: 'g'});

         expect(result.score).toBe(0.25);
         expect(result.scorerId).toBe('first');
         expect(result.scoreError).toBeUndefined();
         expect(result.scorerResults).toEqual([
           {scorerId: 'first', displayName: 'First', score: 0.25},
           {scorerId: 'second', displayName: 'Second', score: 0.75},
         ]);
       });

    it('should name the failing scorer when several ran', async () => {
      const service = setUp([
        new FakeScorer('first', 'First', async () => ({score: 0.25})),
        new FakeScorer(
            'second', 'Second',
            async () => {
              throw new Error('quota exceeded');
            }),
      ]);
      mockBackendService.callAssistSpy.and.returnValue(fetched('answer'));
      spyOn(service['stateService'], 'getCurrentConfig')
          .and.returnValue({...CONFIG, selectedScorers: ['first', 'second']});

      const result = await service.processRow({query: 'q', golden: 'g'});

      // The primary scorer still succeeded, so its score stands.
      expect(result.score).toBe(0.25);
      expect(result.scoreError).toBe('Second: quota exceeded');
    });
  });

  describe('processRow session handling', () => {
    let service: EvalService;

    beforeEach(() => {
      service = setUp();
      spyOn(service['stateService'], 'getCurrentConfig').and.returnValue(CONFIG);
    });

    it('should omit the session field entirely for a standalone query (no sessionContext)', async () => {
      mockBackendService.callAssistSpy.and.returnValue(Promise.resolve(new Response(JSON.stringify([{
        answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}
      }]))));

      await service.processRow({query: 'q', golden: ''});

      const request = mockBackendService.callAssistSpy.calls.mostRecent().args[0];
      expect(request.body.session).toBeUndefined();
      // isSessionLess is not recognized by the v1 streamAssist REST surface
      // ("Unknown name \"isSessionLess\"": 400) and must never be sent.
      expect(request.body.isSessionLess).toBeUndefined();
    });

    it('should thread a given session into the request', async () => {
      mockBackendService.callAssistSpy.and.returnValue(Promise.resolve(new Response(JSON.stringify([{
        answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}
      }]))));

      await service.processRow(
          {query: 'q', golden: ''}, undefined,
          {session: 'projects/p/locations/global/collections/default_collection/engines/e/sessions/123'});

      const request = mockBackendService.callAssistSpy.calls.mostRecent().args[0];
      expect(request.body.session).toBe(
          'projects/p/locations/global/collections/default_collection/engines/e/sessions/123');
    });

    it('should capture sessionInfo from the response so the caller can continue the conversation', async () => {
      mockBackendService.callAssistSpy.and.returnValue(Promise.resolve(new Response(JSON.stringify([{
        answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]},
        sessionInfo: {
          session: 'projects/p/locations/global/collections/default_collection/engines/e/sessions/123',
          turnId: 'turn-1'
        }
      }]))));

      const result = await service.processRow({query: 'q', golden: ''});

      expect(result.session).toBe(
          'projects/p/locations/global/collections/default_collection/engines/e/sessions/123');
      expect(result.turnId).toBe('turn-1');
    });
  });
});
