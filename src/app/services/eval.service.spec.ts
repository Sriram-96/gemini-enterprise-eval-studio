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

    /**
     * A streamed assist response carrying one reply per given content, so a
     * test can interleave thought and answer fragments the way the API does.
     */
    function streamed(...contents: Array<Record<string, unknown>>):
        Promise<Response> {
      return Promise.resolve(new Response(JSON.stringify(contents.map(
          content => ({answer: {replies: [{groundedContent: {content}}]}})))));
    }

    it('should collect the thinking trace one thought per line, keeping it out of the fetched answer',
       async () => {
         const service = setUp();
         mockBackendService.callAssistSpy.and.returnValue(streamed(
             {text: '**Calculating Server Costs**\n', thought: true},
             {text: '**Summing Server Rates**\n', thought: true},
             {text: 'The total is '},
             {text: '$1093.50.'},
             ));
         spyOn(service['stateService'], 'getCurrentConfig')
             .and.returnValue(CONFIG);

         const result = await service.processRow({query: 'q', golden: 'g'});

         expect(result.thoughts)
             .toBe('**Calculating Server Costs**\n**Summing Server Rates**');
         expect(result.fetched).toBe('The total is $1093.50.');
       });

    it('should keep thoughts on their own line when they arrive after answer text',
       async () => {
         // The API documents no ordering between thought and answer replies,
         // so the trace must not depend on thoughts arriving first.
         const service = setUp();
         mockBackendService.callAssistSpy.and.returnValue(streamed(
             {text: 'first ', thought: true},
             {text: 'answer'},
             {text: 'second\nwrapped', thought: true},
             ));
         spyOn(service['stateService'], 'getCurrentConfig')
             .and.returnValue(CONFIG);

         const result = await service.processRow({query: 'q', golden: 'g'});

         expect(result.thoughts).toBe('first\nsecond wrapped');
         expect(result.fetched).toBe('answer');
       });

    it('should set an empty thinking trace when the model emits no thoughts',
       async () => {
         // Required so the CSV export, whose header comes from the first row
         // alone, still emits the column for a run on a non-thinking model.
         const service = setUp();
         mockBackendService.callAssistSpy.and.returnValue(fetched('answer'));
         spyOn(service['stateService'], 'getCurrentConfig')
             .and.returnValue(CONFIG);

         const result = await service.processRow({query: 'q', golden: 'g'});

         expect(result.thoughts).toBe('');
       });

    it('should keep the thinking trace collected before a failure', async () => {
      const service = setUp();
      mockBackendService.callAssistSpy.and.returnValue(
          Promise.resolve(new Response('', {status: 500})));
      spyOn(service['stateService'], 'getCurrentConfig')
          .and.returnValue(CONFIG);

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.thoughts).toBe('');
      expect(result.fetched).toContain('Error:');
    });

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

  describe('processRow trace capture', () => {
    let service: EvalService;

    const DOCUMENT =
        'projects/p/locations/global/collections/default_collection/dataStores/confluence-wiki/branches/0/documents/d1';

    beforeEach(() => {
      service = setUp();
      spyOn(service['stateService'], 'getCurrentConfig').and.returnValue(CONFIG);
    });

    /**
     * Rebuilds the injector around the given scorers, discarding the one the
     * `beforeEach` above already instantiated.
     * @param scorers The scorers to register.
     */
    function useScorers(scorers: Scorer[]) {
      TestBed.resetTestingModule();
      service = setUp(scorers);
      spyOn(service['stateService'], 'getCurrentConfig').and.returnValue(CONFIG);
    }

    /** A streamed response made of the given raw items. */
    function stream(...items: Array<Record<string, unknown>>) {
      return Promise.resolve(new Response(JSON.stringify(items)));
    }

    it('should capture the documents behind an answer as columns', async () => {
      mockBackendService.callAssistSpy.and.returnValue(stream(
          {answer: {replies: [{groundedContent: {content: {text: 'Restart the pod.'}}}]}},
          {
            answer: {
              replies: [{
                groundedContent: {
                  textGroundingMetadata: {
                    references: [{
                      content: 'To restart, run kubectl…',
                      documentMetadata: {
                        document: DOCUMENT,
                        title: 'Incident Runbook',
                        uri: 'https://wiki/runbook'
                      }
                    }],
                    segments: [{
                      text: 'Restart the pod.',
                      referenceIndices: [0],
                      groundingScore: 0.92
                    }]
                  }
                }
              }]
            }
          }));

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.fetched).toBe('Restart the pod.');
      expect(result.citedSources)
          .toBe('Incident Runbook — https://wiki/runbook');
      expect(result.citedDataStores).toBe('confluence-wiki');
      expect(result.citedConnectors).toBe('Confluence');
      expect(result.maxGroundingScore).toBe(0.92);
      expect(result.trace!.sources.length).toBe(1);
      expect(result.trace!.segments[0].sourceKeys).toEqual([DOCUMENT]);
    });

    it('should keep the raw stream so the journey can be replayed', async () => {
      const items = [
        {assistToken: 'token-1'},
        {answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}},
      ];
      mockBackendService.callAssistSpy.and.returnValue(stream(...items));

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.trace!.raw).toEqual(items);
    });

    it('should record tool calls the agent made', async () => {
      mockBackendService.callAssistSpy.and.returnValue(stream({
        answer: {
          replies: [
            {groundedContent: {content: {executableCode: {code: 'sum([1,2])'}}}},
            {
              groundedContent: {
                content:
                    {codeExecutionResult: {outcome: 'OUTCOME_OK', output: '3'}}
              }
            },
          ]
        }
      }));

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.toolCalls)
          .toBe('executableCode: sum([1,2])\ncodeExecutionResult: OUTCOME_OK — 3');
    });

    it('should set every trace column even when nothing was cited', async () => {
      // The CSV header is derived from the first row alone, so an absent key
      // would drop the column from the whole export.
      mockBackendService.callAssistSpy.and.returnValue(
          stream({answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}}));

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.citedSources).toBe('');
      expect(result.citedDataStores).toBe('');
      expect(result.citedConnectors).toBe('');
      expect(result.toolCalls).toBe('');
      expect(result.maxGroundingScore).toBe(0);
    });

    it('should still report the trace columns when the call fails', async () => {
      mockBackendService.callAssistSpy.and.returnValue(
          Promise.resolve(new Response('', {status: 500})));

      const result = await service.processRow({query: 'q', golden: 'g'});

      expect(result.fetched).toContain('Error');
      expect(result.citedSources).toBe('');
      expect(result.toolCalls).toBe('');
      expect(result.maxGroundingScore).toBe(0);
    });

    it('should pass the trace and expected sources to the scorers', async () => {
      const spy = new FakeScorer('spy', 'Spy', async () => ({score: 1}));
      useScorers([spy]);
      mockBackendService.callAssistSpy.and.returnValue(
          stream({answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}}));

      await service.processRow(
          {query: 'q', golden: 'g', expected_sources: 'confluence-wiki'});

      expect(spy.requests[0].expectedSources).toBe('confluence-wiki');
      expect(spy.requests[0].trace).toBeDefined();
    });

    it('should carry expected_sources onto the row so re-rating can use it',
       async () => {
         mockBackendService.callAssistSpy.and.returnValue(stream(
             {answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}}));

         const result = await service.processRow(
             {query: 'q', golden: 'g', expected_sources: 'jira-prod'});

         expect(result.expectedSources).toBe('jira-prod');
       });
  });
});
