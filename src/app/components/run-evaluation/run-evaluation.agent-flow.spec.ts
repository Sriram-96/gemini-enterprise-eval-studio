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
import {TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import * as Papa from 'papaparse';

import {AppConfig} from '../../models/app-config.model';
import {CSVRow} from '../../models/csv-row.model';
import {DETERMINISTIC_SCORER_ID} from '../../scoring/scorers/deterministic.scorer';
import {AuthService} from '../../services/auth.service';
import {CsvService} from '../../services/csv.service';
import {EvalBackendService} from '../../services/eval-backend.service';
import {StateService} from '../../services/state.service';
import {MockAuthService, MockEvalBackendService} from '../../testing/mocks';
import {CsvTableComponent} from '../shared/csv-table/csv-table.component';
import {FileUploadComponent} from '../shared/file-upload/file-upload.component';

import {RunEvaluationComponent} from './run-evaluation.component';

const CONFIG: AppConfig = {
  projectId: 'project',
  region: 'global',
  selectedEngine:
      'projects/project/locations/global/collections/default_collection/engines/engine',
  // 'auto' keeps generationSpec out of the request, isolating the agent.
  selectedModel: 'auto',
  // Offline and deterministic, so the run needs no scoring backend.
  selectedScorers: [DETERMINISTIC_SCORER_ID],
  autoRaterModel: 'gemini-3.5-flash',
  autoRaterInstruction: '',
  selectedDataStores: [],
  enableWebSearch: false,
};

/**
 * Drives a custom-agent evaluation the way a tester does: a real CSV file
 * carrying an `agent` column, parsed by the real upload component, run by the
 * real EvalService, and exported by the real CSV service. Only the network
 * boundary is a mock, and every streamAssist body it receives is asserted.
 */
describe('custom agent end to end', () => {
  let backend: MockEvalBackendService;
  let requests: any[];

  beforeEach(async () => {
    backend = new MockEvalBackendService();
    requests = [];
    backend.callAssistSpy.and.callFake(async (request: any) => {
      requests.push(request);
      const agent = request.body.agentsSpec?.agentSpecs?.[0]?.agentId;
      return new Response(JSON.stringify([{
        answer: {
          replies: [{
            groundedContent:
                {content: {text: `answered by ${agent ?? 'default_assistant'}`}}
          }]
        },
        sessionInfo: {
          session: `session-for-${request.body.query.text}`,
          turnId: 'turn-1'
        }
      }]));
    });

    await TestBed
        .configureTestingModule({
          imports: [RunEvaluationComponent, HttpClientTestingModule],
          providers: [
            {provide: AuthService, useValue: new MockAuthService()},
            {provide: EvalBackendService, useValue: backend},
          ]
        })
        .compileComponents();

    TestBed.inject(StateService).setConfig(CONFIG);
  });

  /**
   * Parses CSV text through the real upload component, so the run sees rows
   * shaped exactly as an uploaded file produces them.
   * @param csv The verbatim contents of the file a tester would upload.
   */
  async function upload(csv: string): Promise<CSVRow[]> {
    const fixture = TestBed.createComponent(FileUploadComponent);
    const uploader = fixture.componentInstance;
    uploader.requiredColumns = ['query', 'golden'];
    fixture.detectChanges();

    const parsed = new Promise<CSVRow[]>((resolve, reject) => {
      uploader.csvRowsChange.subscribe((rows: CSVRow[]) => {
        if (uploader.uploadError) {
          reject(new Error(uploader.uploadError));
          return;
        }
        resolve(rows);
      });
    });

    uploader.handleFile(new File([csv], 'queryset.csv', {type: 'text/csv'}));
    return parsed;
  }

  /** The streamAssist body sent for a given query. */
  function bodyFor(query: string): any {
    return requests.find(request => request.body.query.text === query)?.body;
  }

  it('should route each row to the agent its column names', async () => {
    const fixture = TestBed.createComponent(RunEvaluationComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    // A header spelled the way a spreadsheet exports it, with a BOM, mixed
    // case and a padded cell, on a file that mixes both kinds of row.
    const rows = await upload(
        '﻿Query,Golden,Agent\n' +
        '"What is the per diem?","65 USD",\n' +
        '"Triage INC-4471","Page the on-call"," dc-triage "\n');

    expect(rows.map(row => row.agent)).toEqual(['', ' dc-triage ']);

    await component.startEvaluation(
        {file: new File([], 'queryset.csv'), rows});

    // The row with no agent goes to the engine's default assistant, keeping
    // its implicit search over everything the engine knows.
    expect(bodyFor('What is the per diem?').agentsSpec).toBeUndefined();
    expect(bodyFor('What is the per diem?').toolsSpec).toEqual({
      vertexAiSearchSpec: {}
    });

    // The row that names an agent reaches it by bare, trimmed id, and is left
    // to the agent's own tools.
    expect(bodyFor('Triage INC-4471').agentsSpec).toEqual({
      agentSpecs: [{agentId: 'dc-triage'}]
    });
    expect(bodyFor('Triage INC-4471').toolsSpec).toBeUndefined();

    // Both rows still went to the engine, not to an agent-specific endpoint.
    for (const request of requests) {
      expect(request.selectedEngine).toBe(CONFIG.selectedEngine);
    }
  });

  it('should carry the agent through scoring into the results table and the exported CSV',
     async () => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const rows = await upload(
           'query,golden,agent\n' +
           '"What is the per diem?","answered by default_assistant",\n' +
           '"Triage INC-4471","answered by dc-triage",dc-triage\n');

       await component.startEvaluation(
           {file: new File([], 'queryset.csv'), rows});
       fixture.detectChanges();

       // The answers matched the goldens, so the run scored and the agent
       // survived the whole pipeline rather than being dropped at scoring.
       const scored = (query: string) =>
           component.results.find(row => row.query === query)!;
       expect(scored('What is the per diem?').agentId).toBe('');
       expect(scored('Triage INC-4471').agentId).toBe('dc-triage');
       expect(component.results.every(row => row.score === 1)).toBe(true);

       const csvService = TestBed.inject(CsvService);
       const downloaded: string[] = [];
       spyOn(csvService as any, 'download')
           .and.callFake((content: string) => {
             downloaded.push(content);
           });

       const table = fixture.debugElement.query(By.directive(CsvTableComponent))
                         .componentInstance as CsvTableComponent;
       table.exportResults();

       const exported = Papa.parse<Record<string, string>>(
                            downloaded[0].replace(/^﻿/, ''),
                            {header: true, skipEmptyLines: true})
                            .data;
       // The header comes from the first row's keys alone, so the column has
       // to survive a first row that used the default assistant.
       expect(Object.keys(exported[0])).toContain('agentId');
       const exportedFor = (query: string) =>
           exported.find(row => row['query'] === query)!;
       expect(exportedFor('What is the per diem?')['agentId']).toBe('');
       expect(exportedFor('Triage INC-4471')['agentId']).toBe('dc-triage');
     });

  it('should keep every turn of a conversation on the same agent and session',
     async () => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const rows = await upload(
           'query,golden,conversation_id,turn,agent\n' +
           '"first turn","g",conv-a,1,dc-triage\n' +
           '"second turn","g",conv-a,2,dc-triage\n');

       await component.startEvaluation(
           {file: new File([], 'queryset.csv'), rows});

       expect(bodyFor('first turn').agentsSpec).toEqual({
         agentSpecs: [{agentId: 'dc-triage'}]
       });
       expect(bodyFor('second turn').agentsSpec).toEqual({
         agentSpecs: [{agentId: 'dc-triage'}]
       });
       // Turn 2 continued turn 1's session rather than opening a new one.
       expect(bodyFor('first turn').session).toBeUndefined();
       expect(bodyFor('second turn').session).toBe('session-for-first turn');
     });

  it('should refuse a conversation that switches agents without sending anything',
     async () => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const rows = await upload(
           'query,golden,conversation_id,turn,agent\n' +
           '"first turn","g",conv-a,1,dc-triage\n' +
           '"second turn","g",conv-a,2,other-agent\n');

       await component.startEvaluation(
           {file: new File([], 'queryset.csv'), rows});

       expect(requests).toEqual([]);
       expect(component.errorMessage).toContain('conv-a');
     });

  it('should refuse a pasted resource name without sending anything',
     async () => {
       const fixture = TestBed.createComponent(RunEvaluationComponent);
       const component = fixture.componentInstance;
       fixture.detectChanges();

       const rows = await upload(
           'query,golden,agent\n' +
           '"q","g","projects/p/locations/global/collections/default_collection/engines/e/assistants/default_assistant/agents/dc-triage"\n');

       await component.startEvaluation(
           {file: new File([], 'queryset.csv'), rows});

       expect(requests).toEqual([]);
       expect(component.errorMessage).toContain(`Use 'dc-triage'`);
     });
});
