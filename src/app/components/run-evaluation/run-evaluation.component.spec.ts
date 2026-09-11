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

import {HttpClientTestingModule} from '@angular/common/http/testing';
import {TestBed, fakeAsync, tick} from '@angular/core/testing';
import {BehaviorSubject, of} from 'rxjs';

import {AppConfig} from '../../models/app-config.model';
import {MEMORY_SETTLE_MS, MemorySupport} from '../../models/memory.model';
import {ResultRow} from '../../models/result-row.model';
import {ScorerRunResult} from '../../scoring/scorer';
import {AuthService} from '../../services/auth.service';
import {EvalBackendService} from '../../services/eval-backend.service';
import {EvalService} from '../../services/eval.service';
import {StateService} from '../../services/state.service';
import {MockAuthService, MockEvalBackendService} from '../../testing/mocks';

import {RunEvaluationComponent} from './run-evaluation.component';

describe('RunEvaluationComponent', () => {
  let mockStateService: jasmine.SpyObj<StateService>;
  let mockEvalService: jasmine.SpyObj<EvalService>;
  let mockAuthService: MockAuthService;
  let mockEvalBackendService: MockEvalBackendService;
  let resultsSubject: BehaviorSubject<ResultRow[]>;
  let configSubject: BehaviorSubject<AppConfig>;
  let memorySupportSubject: BehaviorSubject<MemorySupport>;

  beforeEach(async () => {
    resultsSubject = new BehaviorSubject<ResultRow[]>([]);
    configSubject = new BehaviorSubject<AppConfig>({
      gCloudToken: 'token',
      projectId: 'project',
      region: 'global',
      selectedEngine: 'engine',
      selectedModel: 'model',
      autoRaterModel: 'gemini-3.5-flash',
      autoRaterInstruction: '',
      selectedDataStores: [],
      enableWebSearch: false
    });

    memorySupportSubject = new BehaviorSubject<MemorySupport>('unknown');

    mockStateService = jasmine.createSpyObj(
        'StateService',
        [
          'getCurrentConfig',
          'getEngines',
          'setResults',
          'appendResult',
          'setConfig',
          'setEngines',
          'setErrorMessage',
          'setMemorySupport',
          'getMemorySupport',
        ],
        {
          results$: resultsSubject.asObservable(),
          config$: configSubject.asObservable(),
          engines$: of([]),
          errorMessage$: of(''),
          memorySupport$: memorySupportSubject.asObservable(),
        });
    mockStateService.getMemorySupport.and.callFake(
        () => memorySupportSubject.value);
    mockStateService.getCurrentConfig.and.callFake(() => configSubject.value);
    mockStateService.getEngines.and.returnValue([{name: 'engine', displayName: 'Engine', modelConfigs: {}}]);
    mockStateService.setResults.and.callFake((rows: ResultRow[]) => {
      resultsSubject.next(rows);
    });
    mockStateService.appendResult.and.callFake((row: ResultRow) => {
      resultsSubject.next([...resultsSubject.value, row]);
    });

    mockEvalService =
        jasmine.createSpyObj('EvalService', ['processRow', 'scoreAll']);
    mockAuthService = new MockAuthService();
    mockEvalBackendService = new MockEvalBackendService();

    await TestBed
        .configureTestingModule({
          imports: [RunEvaluationComponent, HttpClientTestingModule],
          providers: [
            {provide: StateService, useValue: mockStateService},
            {provide: EvalService, useValue: mockEvalService},
            {provide: AuthService, useValue: mockAuthService},
            {provide: EvalBackendService, useValue: mockEvalBackendService}
          ]
        })
        .compileComponents();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(RunEvaluationComponent);
    const component = fixture.componentInstance;
    expect(component).toBeTruthy();
  });

  it('should build results dynamically one row at a time in startEvaluation', fakeAsync(() => {
    const fixture = TestBed.createComponent(RunEvaluationComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const sampleRows = [
      {query: 'q1', golden: 'g1'},
      {query: 'q2', golden: 'g2'}
    ];

    mockEvalService.processRow.and.callFake(async (row, progressCb) => {
      return {
        query: row.query,
        golden: row.golden,
        fetched: `fetched-${row.query}`,
        ttft: 10,
        ttfa: 20,
        ttlt: 30,
        tpot: 0,
        score: 0.9
      };
    });

    component.startEvaluation({file: new File([], 'test.csv'), rows: sampleRows});
    tick();

    expect(component.step).toBe(3);
    expect(mockStateService.setResults).toHaveBeenCalled();
    expect(component.completedRows).toBe(2);
    expect(component.isProcessing).toBeFalse();
  }));

  it('should stop evaluation mid-way when stopEvaluation is called', fakeAsync(() => {
    const fixture = TestBed.createComponent(RunEvaluationComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const sampleRows = [
      {query: 'q1', golden: 'g1'},
      {query: 'q2', golden: 'g2'}
    ];

    let rowCount = 0;
    mockEvalService.processRow.and.callFake(async (row, progressCb) => {
      rowCount++;
      if (rowCount === 2) {
        component.stopEvaluation();
      }
      return {
        query: row.query,
        golden: row.golden,
        fetched: `fetched-${row.query}`,
        ttft: 10,
        ttfa: 20,
        ttlt: 30,
        tpot: 0,
        score: 0.9
      };
    });

    component.startEvaluation({file: new File([], 'test.csv'), rows: sampleRows});
    tick();

    expect(component.completedRows).toBe(0);
    expect(component.isProcessing).toBeFalse();
  }));

  it('should not run evaluation concurrently if called again while processing',
     fakeAsync(() => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const sampleRows =
           [{query: 'q1', golden: 'g1'}, {query: 'q2', golden: 'g2'}];

       mockEvalService.processRow.and.callFake(async (row, progressCb) => {
         return {
           query: row.query,
           golden: row.golden,
           fetched: `fetched-${row.query}`,
           ttft: 10,
           ttfa: 20,
           ttlt: 30,
           tpot: 0,
           score: 0.9
         };
       });

       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});
       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});
       tick();

       expect(mockEvalService.processRow).toHaveBeenCalledTimes(2);
       expect(component.completedRows).toBe(2);
     }));

  it('should process rows again after restarting evaluation', fakeAsync(() => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const sampleRows =
           [{query: 'q1', golden: 'g1'}, {query: 'q2', golden: 'g2'}];

       let resolveFirstRow: (value: ResultRow) => void;
       const firstRowPromise = new Promise<ResultRow>((resolve) => {
         resolveFirstRow = resolve;
       });

       let rowCount = 0;
       mockEvalService.processRow.and.callFake(async (row, progressCb) => {
         rowCount++;
         if (rowCount === 1) {
           return firstRowPromise;
         }
         return {
           query: row.query,
           golden: row.golden,
           fetched: `fetched-${row.query}`,
           ttft: 10,
           ttfa: 20,
           ttlt: 30,
           tpot: 0,
           score: 0.9
         };
       });

       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});
       component.stopEvaluation();
       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});

       resolveFirstRow!({
         query: 'q1',
         golden: 'g1',
         fetched: 'fetched-q1',
         ttft: 10,
         ttfa: 20,
         ttlt: 30,
         tpot: 0,
         score: 0.9
       });

       tick();

       expect(mockEvalService.processRow).toHaveBeenCalledTimes(4);
     }));

  it('should omit the session field for independent single-turn rows', fakeAsync(() => {
    const fixture = TestBed.createComponent(RunEvaluationComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    let capturedContext: any;
    mockEvalService.processRow.and.callFake(async (row, _progressCb, sessionContext) => {
      capturedContext = sessionContext;
      return {
        query: row.query,
        golden: row.golden,
        fetched: `fetched-${row.query}`,
        ttft: 10,
        ttfa: 20,
        ttlt: 30,
        tpot: 0,
        score: 0.9
      };
    });

    component.startEvaluation(
        {file: new File([], 'test.csv'), rows: [{query: 'q1', golden: 'g1'}]});
    tick();

    expect(capturedContext).toEqual({session: undefined});
    expect(resultsSubject.value[0].conversationId).toBeUndefined();
    expect(resultsSubject.value[0].turn).toBeUndefined();
  }));

  it('should run same-conversation turns sequentially, threading the returned session, and tag results with conversationId/turn',
     fakeAsync(() => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const sampleRows = [
         {query: 'turn1', golden: 'g1', conversation_id: 'conv-a', turn: '1'},
         {query: 'turn2', golden: 'g2', conversation_id: 'conv-a', turn: '2'},
       ];

       const calls: any[] = [];
       mockEvalService.processRow.and.callFake(
           async (row, _progressCb, sessionContext) => {
             calls.push({query: row.query, sessionContext});
             return {
               query: row.query,
               golden: row.golden,
               fetched: `fetched-${row.query}`,
               ttft: 10,
               ttfa: 20,
               ttlt: 30,
               tpot: 0,
               score: 0.9,
               session: `session-after-${row.query}`,
             };
           });

       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});
       tick();

       // Both turns ran, in order, and turn 2 was given the session turn 1
       // returned rather than starting a fresh/unrelated session.
       expect(calls.map(c => c.query)).toEqual(['turn1', 'turn2']);
       expect(calls[0].sessionContext).toEqual({session: undefined});
       expect(calls[1].sessionContext).toEqual({session: 'session-after-turn1'});

       const results = resultsSubject.value;
       expect(results[0].conversationId).toBe('conv-a');
       expect(results[0].turn).toBe(1);
       expect(results[1].conversationId).toBe('conv-a');
       expect(results[1].turn).toBe(2);
     }));

  it('should run independent conversations concurrently while keeping each internally sequential',
     fakeAsync(() => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       // Two 2-turn conversations. Turn 2 of each conversation must never
       // start before turn 1 of that *same* conversation has resolved, but
       // the two conversations themselves may interleave freely.
       const sampleRows = [
         {query: 'a1', golden: 'g', conversation_id: 'conv-a', turn: '1'},
         {query: 'b1', golden: 'g', conversation_id: 'conv-b', turn: '1'},
         {query: 'a2', golden: 'g', conversation_id: 'conv-a', turn: '2'},
         {query: 'b2', golden: 'g', conversation_id: 'conv-b', turn: '2'},
       ];

       const startedBeforeFinished: Record<string, string[]> = {a2: [], b2: []};
       const finished = new Set<string>();

       mockEvalService.processRow.and.callFake(
           async (row, _progressCb, sessionContext) => {
             if (row.query === 'a2' || row.query === 'b2') {
               startedBeforeFinished[row.query] = [...finished];
             }
             await Promise.resolve();
             finished.add(row.query);
             return {
               query: row.query,
               golden: row.golden,
               fetched: `fetched-${row.query}`,
               ttft: 10,
               ttfa: 20,
               ttlt: 30,
               tpot: 0,
               score: 0.9,
               session: `session-after-${row.query}`,
             };
           });

       component.startEvaluation(
           {file: new File([], 'test.csv'), rows: sampleRows});
       tick();

       // By the time turn 2 of a conversation starts, turn 1 of that SAME
       // conversation must have already finished.
       expect(startedBeforeFinished['a2']).toContain('a1');
       expect(startedBeforeFinished['b2']).toContain('b1');
     }));

  describe('memory phases', () => {
    /** Builds the component with the given saved-memory feature state. */
    function setUp(memorySupport: MemorySupport = 'on') {
      memorySupportSubject.next(memorySupport);
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();
      return component;
    }

    /** Records the order rows are dispatched in and which had finished. */
    function recordOrder() {
      const started: string[] = [];
      const finishedWhenStarted: Record<string, string[]> = {};
      const finished: string[] = [];

      mockEvalService.processRow.and.callFake(
          async (row, _progressCb, sessionContext) => {
            started.push(row.query);
            finishedWhenStarted[row.query] = [...finished];
            await Promise.resolve();
            finished.push(row.query);
            return {
              query: row.query,
              golden: row.golden,
              fetched: `fetched-${row.query}`,
              ttft: 10,
              ttfa: 20,
              ttlt: 30,
              score: 0.9,
              session: `session-after-${row.query}`,
              sessionContext,
            } as any;
          });

      return {started, finishedWhenStarted};
    }

    it('should start a seeding run without asking the tester first', fakeAsync(() => {
         const component = setUp();
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [{query: 'remember X', golden: 'ok', phase: 'seed'}]
         });
         tick();

         // Seeding writes state that outlives the run, but the file is what
         // states the intent: uploading one that seeds is the decision.
         expect(mockEvalService.processRow).toHaveBeenCalledTimes(1);
         expect(component.isProcessing).toBeFalse();
       }));

    it('should run every seed row, one at a time, before any other row and only after the settle delay',
       fakeAsync(() => {
         const component = setUp();
         const {started, finishedWhenStarted} = recordOrder();

         // The recall row is deliberately first in the file: the barrier has
         // to reorder it behind the seed rows, not merely preserve the order
         // the author happened to write.
         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'recall', golden: 'metric', phase: 'recall'},
             {query: 'seed1', golden: 'ok', phase: 'seed'},
             {query: 'seed2', golden: 'ok', phase: 'seed'},
           ]
         });
         tick();
         tick();

         // Both seed rows have run, sequentially, and the recall row is still
         // waiting behind the settle pause.
         expect(started).toEqual(['seed1', 'seed2']);
         expect(finishedWhenStarted['seed2']).toContain('seed1');
         expect(component.isSettlingMemories).toBeTrue();
         expect(component.progressText)
             .toBe('Waiting for saved memories to settle...');

         tick(MEMORY_SETTLE_MS);

         expect(started).toEqual(['seed1', 'seed2', 'recall']);
         expect(component.isSettlingMemories).toBeFalse();
         expect(component.isProcessing).toBeFalse();
       }));

    it('should clear memories before seeding them, with a settle pause after each phase',
       fakeAsync(() => {
         const component = setUp();
         const {started} = recordOrder();

         // Written in the order an author would read the file back in, which
         // is the reverse of the order the phases have to run in.
         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'recall', golden: 'm', phase: 'recall'},
             {query: 'seed1', golden: 'ok', phase: 'seed'},
             {query: 'forget everything', golden: 'ok', phase: 'reset'},
           ]
         });
         tick();
         tick();

         // A seed row that overlapped the deletion could be deleted by it, so
         // the reset phase gets its own barrier rather than sharing the seed's.
         expect(started).toEqual(['forget everything']);
         expect(component.isSettlingMemories).toBeTrue();

         tick(MEMORY_SETTLE_MS);

         expect(started).toEqual(['forget everything', 'seed1']);
         expect(component.isSettlingMemories).toBeTrue();

         tick(MEMORY_SETTLE_MS);

         expect(started).toEqual(['forget everything', 'seed1', 'recall']);
         expect(component.isSettlingMemories).toBeFalse();
         expect(component.isProcessing).toBeFalse();
       }));

    it('should run reset rows one at a time and record the phase on their results',
       fakeAsync(() => {
         const component = setUp('on');
         const {started, finishedWhenStarted} = recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'forget everything', golden: 'ok', phase: 'reset'},
             {query: 'list what you saved', golden: 'nothing', phase: 'reset'},
             {query: 'plain', golden: 'g'},
           ]
         });
         tick();
         tick();

         // The verification row only means anything after the deletion it
         // checks has actually been sent.
         expect(started).toEqual(['forget everything', 'list what you saved']);
         expect(finishedWhenStarted['list what you saved'])
             .toContain('forget everything');

         tick(MEMORY_SETTLE_MS);

         const byQuery = new Map(resultsSubject.value.map(r => [r.query, r]));
         expect(byQuery.get('forget everything')!.memoryPhase).toBe('reset');
         expect(byQuery.get('forget everything')!.memorySupport).toBe('on');
       }));

    it('should send a reset row without asking the tester first', fakeAsync(() => {
         const component = setUp();
         const {started} = recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'forget everything', golden: 'ok', phase: 'reset'},
             {query: 'seed1', golden: 'ok', phase: 'seed'},
           ]
         });
         tick();

         expect(started).toEqual(['forget everything']);
       }));

    it('should settle after a reset-only file before its ordinary rows run',
       fakeAsync(() => {
         const component = setUp();
         const {started} = recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'forget everything', golden: 'ok', phase: 'reset'},
             {query: 'plain', golden: 'g'},
           ]
         });
         tick();
         tick();

         // With no seed phase in between, the ordinary rows are what has to
         // wait for the deletion to land.
         expect(started).toEqual(['forget everything']);
         expect(component.isSettlingMemories).toBeTrue();

         tick(MEMORY_SETTLE_MS);

         expect(started).toEqual(['forget everything', 'plain']);
         expect(component.isProcessing).toBeFalse();
       }));

    it('should not pause after the last phase when nothing follows it',
       fakeAsync(() => {
         const component = setUp();
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [{query: 'forget everything', golden: 'ok', phase: 'reset'}]
         });
         tick();
         tick();

         // Nothing is waiting on the write, so the run has no reason to hold
         // the tester for five seconds before reporting.
         expect(component.isSettlingMemories).toBeFalse();
         expect(component.isProcessing).toBeFalse();
         expect(component.completedRows).toBe(1);
       }));

    it('should start the recall row in a fresh session rather than the seed row\'s',
       fakeAsync(() => {
         const component = setUp();
         const contexts: Array<{query: string, sessionContext: unknown}> = [];
         mockEvalService.processRow.and.callFake(
             async (row, _progressCb, sessionContext) => {
               contexts.push({query: row.query, sessionContext});
               return {
                 query: row.query,
                 golden: row.golden,
                 fetched: `fetched-${row.query}`,
                 ttft: 10,
                 ttfa: 20,
                 ttlt: 30,
                 tpot: 0,
                 score: 0.9,
                 session: `session-after-${row.query}`,
               };
             });

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'seed1', golden: 'ok', phase: 'seed'},
             {query: 'recall', golden: 'metric', phase: 'recall'},
           ]
         });
         tick();
         tick();
         tick(MEMORY_SETTLE_MS);

         // A recall row answered from the seed row's own session would prove
         // nothing about saved memories, only about within-session context.
         const recall = contexts.find(c => c.query === 'recall');
         expect(recall!.sessionContext).toEqual({session: undefined});
       }));

    it('should record the phase and the feature state on the results', fakeAsync(() => {
         const component = setUp('on');
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'seed1', golden: 'ok', phase: 'seed'},
             {query: 'recall', golden: 'metric', phase: 'recall'},
             {query: 'plain', golden: 'g'},
           ]
         });
         tick();
         tick();
         tick(MEMORY_SETTLE_MS);

         const byQuery = new Map(resultsSubject.value.map(r => [r.query, r]));
         expect(byQuery.get('seed1')!.memoryPhase).toBe('seed');
         expect(byQuery.get('seed1')!.memorySupport).toBe('on');
         expect(byQuery.get('recall')!.memoryPhase).toBe('recall');
         expect(byQuery.get('recall')!.memorySupport).toBe('on');
         // An ordinary row is not part of a memory evaluation, so it carries
         // neither field and the columns stay meaningful.
         expect(byQuery.get('plain')!.memoryPhase).toBeUndefined();
         expect(byQuery.get('plain')!.memorySupport).toBeUndefined();
       }));

    it('should refuse to seed against an engine that reports memories as off',
       fakeAsync(() => {
         const component = setUp('off');
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [{query: 'remember X', golden: 'ok', phase: 'seed'}]
         });
         tick();

         expect(component.errorMessage).toContain('personalization-memory');
         expect(mockEvalService.processRow).not.toHaveBeenCalled();
         expect(component.isProcessing).toBeFalse();
       }));

    it('should still seed when the engine does not report the feature', fakeAsync(() => {
         const component = setUp('unknown');
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [{query: 'remember X', golden: 'ok', phase: 'seed'}]
         });
         tick();
         tick();

         expect(component.errorMessage).toBeNull();
         expect(mockEvalService.processRow).toHaveBeenCalledTimes(1);
       }));

    it('should reject an invalid query set without sending anything', fakeAsync(() => {
         const component = setUp();
         recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'seed1', golden: 'ok', phase: 'seed', conversation_id: 'c', turn: '1'},
             {query: 'recall', golden: 'm', phase: 'recall', conversation_id: 'c', turn: '2'},
           ]
         });
         tick();

         expect(component.errorMessage).toContain('new chat');
         expect(mockEvalService.processRow).not.toHaveBeenCalled();
         expect(component.step).not.toBe(3);
       }));

    it('should not let a stopped run\'s settle timer clear the label of the run that replaced it',
       fakeAsync(() => {
         const component = setUp();
         recordOrder();
         const seedThenRecall = [
           {query: 'seed1', golden: 'ok', phase: 'seed'},
           {query: 'recall', golden: 'm', phase: 'recall'},
         ];

         // Run A reaches its settle pause and is then stopped. Its timer is
         // still pending and will fire long after the run is gone.
         component.startEvaluation(
             {file: new File([], 'a.csv'), rows: seedThenRecall});
         tick();
         tick();
         expect(component.isSettlingMemories).toBeTrue();
         component.stopEvaluation();

         // The tester takes a moment before restarting, so run B's pause is
         // the same length but ends later than run A's pending timer.
         const restartGap = 1000;
         tick(restartGap);
         component.startEvaluation(
             {file: new File([], 'b.csv'), rows: seedThenRecall});
         tick();
         expect(component.isSettlingMemories).toBeTrue();

         // Run A's timer fires here. It no longer owns the label, so run B
         // must still read as settling.
         tick(MEMORY_SETTLE_MS - restartGap);
         expect(component.isSettlingMemories).toBeTrue();
         expect(component.progressText)
             .toBe('Waiting for saved memories to settle...');

         // Run B's own timer then clears it and the run finishes normally.
         tick(restartGap);
         expect(component.isSettlingMemories).toBeFalse();
         expect(component.isProcessing).toBeFalse();
       }));

    it('should leave a file without a phase column entirely unaffected', fakeAsync(() => {
         const component = setUp();
         const {started} = recordOrder();

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [{query: 'q1', golden: 'g1'}, {query: 'q2', golden: 'g2'}]
         });
         tick();

         expect(started).toEqual(['q1', 'q2']);
         expect(component.completedRows).toBe(2);
       }));
  });

  describe('score columns', () => {
    /** Builds a scored row carrying the given per-scorer outcomes. */
    function rowWith(scorerResults: ScorerRunResult[]): ResultRow {
      return {
        query: 'q',
        golden: 'g',
        fetched: 'f',
        ttft: 1,
        ttfa: 2,
        ttlt: 3,
        tpot: 0,
        score: scorerResults[0]?.score ?? 0,
        scorerId: scorerResults[0]?.scorerId,
        scorerResults
      };
    }

    it('should keep a single Score column when one scorer ran', () => {
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();

      resultsSubject.next([rowWith(
          [{scorerId: 'only', displayName: 'Only Scorer', score: 0.5}])]);

      expect(component.columns.map(c => c.header)).toContain('Score');
      expect(component.columns.map(c => c.header)).not.toContain('Only Scorer');
      expect(component.displayResults[0]['score']).toBe(0.5);
      expect(component.displayResults[0]['scorerResults']).toBeUndefined();
    });

    it('should render one column per scorer when several ran', () => {
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();

      resultsSubject.next([rowWith([
        {scorerId: 'first', displayName: 'First', score: 0.25},
        {scorerId: 'second', displayName: 'Second', score: 0.75},
      ])]);

      const headers = component.columns.map(c => c.header);
      expect(headers).toContain('First');
      expect(headers).toContain('Second');
      expect(headers).not.toContain('Score');
      expect(component.displayResults[0]['score_first']).toBe(0.25);
      expect(component.displayResults[0]['score_second']).toBe(0.75);
      // Nested results are flattened away so the CSV export stays tabular.
      expect(component.displayResults[0]['scorerResults']).toBeUndefined();
    });

    it('should leave a skipped scorer\'s cell empty rather than zero', () => {
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();

      resultsSubject.next([rowWith([
        {scorerId: 'first', displayName: 'First', score: 0.25},
        // Nothing to judge: reporting the placeholder zero would read as a
        // failing row and drag the column's average down.
        {scorerId: 'second', displayName: 'Second', score: 0, skipped: true},
      ])]);

      expect(component.displayResults[0]['score_second']).toBe('');
      expect(component.displayResults[0]['score_first']).toBe(0.25);
    });

    it('should add per-scorer error columns only when a scorer failed', () => {
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();

      resultsSubject.next([rowWith([
        {scorerId: 'first', displayName: 'First', score: 0.25},
        {scorerId: 'second', displayName: 'Second', score: 0, error: 'boom'},
      ])]);

      expect(component.displayResults[0]['scoreError_second']).toBe('boom');
      expect(component.displayResults[0]['scoreError_first']).toBe('');
    });

    it('should give every row the same score columns', () => {
      const fixture = TestBed.createComponent(RunEvaluationComponent);
      const component = fixture.componentInstance;
      fixture.detectChanges();

      resultsSubject.next([
        rowWith([
          {scorerId: 'first', displayName: 'First', score: 0.25},
          {scorerId: 'second', displayName: 'Second', score: 0.75},
        ]),
        // A row scored before 'second' was selected still needs both keys, or
        // the CSV export would misalign its columns.
        rowWith([{scorerId: 'first', displayName: 'First', score: 0.5}]),
      ]);

      expect(Object.keys(component.displayResults[0]))
          .toEqual(Object.keys(component.displayResults[1]));
      expect(component.displayResults[1]['score_second']).toBe('');
    });

    it('should keep the conversation columns alongside the per-scorer columns',
       fakeAsync(() => {
         const fixture = TestBed.createComponent(RunEvaluationComponent);
         const component = fixture.componentInstance;
         fixture.detectChanges();

         mockEvalService.processRow.and.callFake(async (row) => ({
                                                   query: row.query,
                                                   golden: row.golden,
                                                   fetched: `fetched-${
                                                       row.query}`,
                                                   ttft: 10,
                                                   ttfa: 20,
                                                   ttlt: 30,
                                                   tpot: 0,
                                                   score: 0.25,
                                                   scorerId: 'first',
                                                   scorerResults: [
                                                     {
                                                       scorerId: 'first',
                                                       displayName: 'First',
                                                       score: 0.25
                                                     },
                                                     {
                                                       scorerId: 'second',
                                                       displayName: 'Second',
                                                       score: 0.75
                                                     },
                                                   ],
                                                   session: `session-after-${
                                                       row.query}`,
                                                 }));

         component.startEvaluation({
           file: new File([], 'test.csv'),
           rows: [
             {query: 'turn1', golden: 'g1', conversation_id: 'conv-a', turn: '1'},
             {query: 'turn2', golden: 'g2', conversation_id: 'conv-a', turn: '2'},
           ]
         });
         tick();

         const headers = component.columns.map(c => c.header);
         expect(headers).toContain('Conversation');
         expect(headers).toContain('Turn');
         expect(headers).toContain('First');
         expect(headers).toContain('Second');
         expect(headers).not.toContain('Score');

         // A multi-turn row keeps its conversation tagging while the nested
         // scorer results are flattened into one column per scorer, so the
         // table and the CSV export show both at once.
         expect(component.displayResults[1]['conversationId']).toBe('conv-a');
         expect(component.displayResults[1]['turn']).toBe(2);
         expect(component.displayResults[1]['score_first']).toBe(0.25);
         expect(component.displayResults[1]['score_second']).toBe(0.75);
         expect(component.displayResults[1]['scorerResults']).toBeUndefined();
       }));
  });

  describe('startReRate', () => {
    it('should re-score every row with all selected scorers', fakeAsync(() => {
         const fixture = TestBed.createComponent(RunEvaluationComponent);
         const component = fixture.componentInstance;
         fixture.detectChanges();

         resultsSubject.next([
           {query: 'q1', golden: 'g1', fetched: 'f1', ttft: 1, ttfa: 2, ttlt: 3,
           tpot: 0,
           score: 0.1},
           {query: 'q2', golden: 'g2', fetched: 'f2', ttft: 1, ttfa: 2, ttlt: 3,
           tpot: 0,
           score: 0.2},
         ]);
         mockEvalService.scoreAll.and.callFake(async () => [
           {scorerId: 'first', displayName: 'First', score: 0.9},
           {scorerId: 'second', displayName: 'Second', score: 0.8},
         ]);

         component.startReRate();
         tick();

         expect(mockEvalService.scoreAll).toHaveBeenCalledTimes(2);
         const rescored = resultsSubject.value;
         expect(rescored.map(row => row.score)).toEqual([0.9, 0.9]);
         expect(rescored[0].scorerId).toBe('first');
         expect(rescored[0].scorerResults?.length).toBe(2);
         expect(component.errorMessage).toBeNull();
       }));

    it('should stop at the first failing row and keep the rest unchanged',
       fakeAsync(() => {
         const fixture = TestBed.createComponent(RunEvaluationComponent);
         const component = fixture.componentInstance;
         fixture.detectChanges();

         resultsSubject.next([
           {query: 'q1', golden: 'g1', fetched: 'f1', ttft: 1, ttfa: 2, ttlt: 3,
           tpot: 0,
           score: 0.1},
           {query: 'q2', golden: 'g2', fetched: 'f2', ttft: 1, ttfa: 2, ttlt: 3,
           tpot: 0,
           score: 0.2},
         ]);
         mockEvalService.scoreAll.and.callFake(async () => [{
           scorerId: 'first',
           displayName: 'First',
           score: 0,
           error: 'quota exceeded'
         }]);

         component.startReRate();
         tick();

         expect(mockEvalService.scoreAll).toHaveBeenCalledTimes(1);
         expect(component.errorMessage).toContain('quota exceeded');
         expect(resultsSubject.value.map(row => row.score)).toEqual([0.1, 0.2]);
       }));

    it('should skip scoring a row that was never fetched', fakeAsync(() => {
         const fixture = TestBed.createComponent(RunEvaluationComponent);
         const component = fixture.componentInstance;
         fixture.detectChanges();

         resultsSubject.next([{
           query: 'q1', golden: 'g1', fetched: '', ttft: 0, ttfa: 0, ttlt: 0,
           tpot: 0,
           score: 0
         }]);

         component.startReRate();
         tick();

         expect(mockEvalService.scoreAll).not.toHaveBeenCalled();
         expect(resultsSubject.value[0].scorerResults?.[0].skipped).toBeTrue();
       }));
  });
});

