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

import {AppConfig} from '../../models/app-config.model';
import {AssistTrace, CitedSource} from '../../models/trace.model';
import {ScoringRequest} from '../scorer';

import {SourceAttributionScorer} from './source-attribution.scorer';

const CONFIG: AppConfig = {
  projectId: 'project',
  region: 'global',
  selectedEngine: 'engine',
  selectedModel: 'model',
  autoRaterModel: 'gemini-2.5-flash',
  autoRaterInstruction: '',
  selectedDataStores: [],
  enableWebSearch: false
};

/** A trace citing the given sources and nothing else. */
function tracing(...sources: CitedSource[]): AssistTrace {
  return {sources, segments: [], toolCalls: [], raw: []};
}

/** A scoring request for the given expectation and citations. */
function request(expectedSources: string, trace?: AssistTrace): ScoringRequest {
  return {
    query: 'q',
    response: 'a plausible sounding answer',
    config: CONFIG,
    expectedSources,
    trace
  };
}

describe('SourceAttributionScorer', () => {
  let scorer: SourceAttributionScorer;

  beforeEach(() => {
    scorer = new SourceAttributionScorer();
  });

  it('should not require a golden answer', () => {
    expect(scorer.requiresGolden).toBeFalse();
  });

  it('should score 1 when the expected data store was cited', async () => {
    const result = await scorer.score(request(
        'jira-prod', tracing({dataStoreId: 'jira-prod', title: 'Ticket'})));

    expect(result.score).toBe(1);
    expect(result.details!['missing']).toEqual([]);
  });

  it('should score 0 when a plausible answer cited nothing at all', async () => {
    // The point of the scorer: a fluent, ungrounded answer must not pass.
    const result = await scorer.score(request('jira-prod', tracing()));

    expect(result.score).toBe(0);
    expect(result.details!['missing']).toEqual(['jira-prod']);
    expect(result.details!['actual']).toEqual([]);
  });

  it('should score 0 when the answer came from the wrong data store',
     async () => {
       const result = await scorer.score(request(
           'jira-prod', tracing({dataStoreId: 'confluence-wiki'})));

       expect(result.score).toBe(0);
     });

  it('should score the fraction of expectations that were met', async () => {
    const result = await scorer.score(request(
        'jira-prod; confluence-wiki; gcs-archive',
        tracing({dataStoreId: 'jira-prod'}, {dataStoreId: 'gcs-archive'})));

    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.details!['matched']).toEqual(['jira-prod', 'gcs-archive']);
    expect(result.details!['missing']).toEqual(['confluence-wiki']);
  });

  it('should match a document by a fragment of its uri or title', async () => {
    const trace = tracing(
        {uri: 'https://wiki.example.com/incident-runbook', title: 'Runbook'});

    expect((await scorer.score(request('incident-runbook', trace))).score)
        .toBe(1);
    expect((await scorer.score(request('runbook', trace))).score).toBe(1);
  });

  it('should match a connector by name, case insensitively', async () => {
    const result = await scorer.score(
        request('confluence', tracing({connector: 'Confluence'})));

    expect(result.score).toBe(1);
  });

  it('should not let a partial identifier pass for a data store', async () => {
    // Data stores match exactly, so `sales` must not satisfy `salesforce-crm`.
    const result = await scorer.score(
        request('sales', tracing({dataStoreId: 'salesforce-crm'})));

    expect(result.score).toBe(0);
  });

  it('should skip a row that names no expected sources', async () => {
    const result = await scorer.score(
        request('  ', tracing({dataStoreId: 'jira-prod'})));

    expect(result.skipped).toBeTrue();
    expect(result.score).toBe(0);
  });

  it('should report what was actually cited, so a failure explains itself',
     async () => {
       const result = await scorer.score(request(
           'jira-prod',
           tracing({dataStoreId: 'confluence-wiki'}, {uri: 'https://web/page'})));

       expect(result.details!['actual']).toEqual([
         'confluence-wiki', 'https://web/page'
       ]);
     });

  it('should score 0 when the row was never traced', async () => {
    const result = await scorer.score(request('jira-prod', undefined));

    expect(result.score).toBe(0);
    expect(result.skipped).toBeFalsy();
  });
});
