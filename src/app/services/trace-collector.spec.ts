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

import {summarizeTrace} from '../models/trace.model';

import {dataStoreIdFromDocument} from '../components/shared/connector.util';
import {TraceCollector} from './trace-collector';

/** A Document resource name in the given data store. */
function documentName(dataStore: string, id: string): string {
  return `projects/p/locations/global/collections/default_collection/dataStores/${
      dataStore}/branches/0/documents/${id}`;
}

/** A grounding reference for the given document. */
function reference(
    dataStore: string, id: string, title: string, uri?: string) {
  return {
    content: `snippet of ${id}`,
    documentMetadata: {document: documentName(dataStore, id), title, uri}
  };
}

describe('dataStoreIdFromDocument', () => {
  it('should extract the data store from a document resource name', () => {
    expect(dataStoreIdFromDocument(documentName('jira-prod', 'doc-1')))
        .toBe('jira-prod');
  });

  it('should return undefined for a name with no data store segment', () => {
    expect(dataStoreIdFromDocument('https://example.com/page')).toBeUndefined();
    expect(dataStoreIdFromDocument(undefined)).toBeUndefined();
  });
});

describe('TraceCollector', () => {
  it('should collect references from a reply that carries no content', () => {
    // The API sends grounding for text it already streamed, so the reply
    // holding the citations often has no `content` of its own.
    const collector = new TraceCollector();
    collector.addGroundedContent({
      textGroundingMetadata:
          {references: [reference('confluence-wiki', 'd1', 'Runbook')]}
    });

    const trace = collector.build();
    expect(trace.sources.length).toBe(1);
    expect(trace.sources[0].title).toBe('Runbook');
    expect(trace.sources[0].dataStoreId).toBe('confluence-wiki');
    expect(trace.sources[0].connector).toBe('Confluence');
  });

  it('should resolve reference indices against the reply that carries them',
     () => {
       // Index 0 means a different document in each reply. Resolving the
       // indices only after merging both replies' references would attribute
       // the second claim to the first document.
       const collector = new TraceCollector();
       collector.addGroundedContent({
         textGroundingMetadata: {
           references: [reference('jira-prod', 'first', 'First Doc')],
           segments: [{text: 'claim one', referenceIndices: [0]}]
         }
       });
       collector.addGroundedContent({
         textGroundingMetadata: {
           references: [reference('gcs-archive', 'second', 'Second Doc')],
           segments: [{text: 'claim two', referenceIndices: [0]}]
         }
       });

       const trace = collector.build();
       expect(trace.segments.map(s => s.text)).toEqual([
         'claim one', 'claim two'
       ]);
       expect(trace.segments[0].sourceKeys).toEqual([
         documentName('jira-prod', 'first')
       ]);
       expect(trace.segments[1].sourceKeys).toEqual([
         documentName('gcs-archive', 'second')
       ]);
     });

  it('should record a document once however many replies cite it', () => {
    const collector = new TraceCollector();
    for (const score of [0.4, 0.9, 0.7]) {
      collector.addGroundedContent({
        textGroundingMetadata: {
          references: [reference('jira-prod', 'd1', 'Runbook')],
          segments: [{text: 'a claim', referenceIndices: [0], groundingScore: score}]
        }
      });
    }

    const trace = collector.build();
    expect(trace.sources.length).toBe(1);
    // The strongest attribution is the interesting one; keeping the last would
    // understate how well the answer was grounded.
    expect(trace.sources[0].groundingScore).toBe(0.9);
  });

  it('should fill in fields a later reply supplies for a known document', () => {
    const collector = new TraceCollector();
    collector.addGroundedContent({
      textGroundingMetadata: {
        references: [{documentMetadata: {document: documentName('ds', 'd1')}}]
      }
    });
    collector.addGroundedContent({
      textGroundingMetadata: {
        references: [{
          documentMetadata: {
            document: documentName('ds', 'd1'),
            title: 'Late Title',
            uri: 'https://example.com/d1'
          }
        }]
      }
    });

    const trace = collector.build();
    expect(trace.sources.length).toBe(1);
    expect(trace.sources[0].title).toBe('Late Title');
    expect(trace.sources[0].uri).toBe('https://example.com/d1');
  });

  it('should collect executable code and its result as tool calls', () => {
    const collector = new TraceCollector();
    collector.addGroundedContent(
        {content: {executableCode: {code: 'print(1 + 1)'}}});
    collector.addGroundedContent({
      content: {codeExecutionResult: {outcome: 'OUTCOME_OK', output: '2'}}
    });

    expect(collector.build().toolCalls).toEqual([
      {kind: 'executableCode', code: 'print(1 + 1)'},
      {kind: 'codeExecutionResult', outcome: 'OUTCOME_OK', output: '2'},
    ]);
  });

  it('should keep the raw stream items verbatim and in order', () => {
    const collector = new TraceCollector();
    collector.addRawItem({assistToken: 'a'});
    collector.addRawItem({answer: {state: 'SUCCEEDED'}});

    expect(collector.build().raw).toEqual([
      {assistToken: 'a'},
      {answer: {state: 'SUCCEEDED'}},
    ]);
  });

  it('should ignore a reply with neither content nor grounding', () => {
    const collector = new TraceCollector();
    collector.addGroundedContent(undefined);
    collector.addGroundedContent({content: {text: 'plain answer text'}});

    const trace = collector.build();
    expect(trace.sources).toEqual([]);
    expect(trace.segments).toEqual([]);
    expect(trace.toolCalls).toEqual([]);
  });
});

describe('summarizeTrace', () => {
  it('should flatten the cited documents, data stores and connectors', () => {
    const collector = new TraceCollector();
    collector.addGroundedContent({
      textGroundingMetadata: {
        references: [
          reference('jira-prod', 'd1', 'Outage Ticket', 'https://jira/d1'),
          reference('confluence-wiki', 'd2', 'Runbook'),
        ],
        segments: [{text: 'a claim', referenceIndices: [0], groundingScore: 0.8}]
      }
    });

    const summary = summarizeTrace(collector.build());
    expect(summary.citedSources)
        .toBe('Outage Ticket — https://jira/d1\nRunbook');
    expect(summary.citedDataStores).toBe('jira-prod, confluence-wiki');
    expect(summary.citedConnectors).toBe('Jira, Confluence');
    expect(summary.maxGroundingScore).toBe(0.8);
  });

  it('should produce empty columns rather than absent ones for no trace', () => {
    // The CSV header comes from the first row alone, so a key missing there
    // would drop the column from the entire export.
    expect(summarizeTrace(undefined)).toEqual({
      citedSources: '',
      citedDataStores: '',
      citedConnectors: '',
      toolCalls: '',
      maxGroundingScore: 0,
    });
  });
});
