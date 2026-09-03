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

import {CSVRow} from './csv-row.model';
import {validateAgentColumn} from './csv-row.util';

describe('validateAgentColumn', () => {
  it('should accept a query set with no agent column at all', () => {
    // Every query set written before custom agents existed.
    const rows: CSVRow[] = [{query: 'q1', golden: 'g1'}, {query: 'q2', golden: 'g2'}];

    expect(validateAgentColumn(rows)).toBeNull();
  });

  it('should accept an empty agent cell as the default assistant', () => {
    const rows: CSVRow[] = [
      {query: 'q1', golden: 'g1', agent: ''},
      {query: 'q2', golden: 'g2', agent: '   '},
      {query: 'q3', golden: 'g3', agent: 'dc-triage'},
    ];

    expect(validateAgentColumn(rows)).toBeNull();
  });

  it('should accept the id shapes real engines actually use', () => {
    const rows: CSVRow[] = [
      {query: 'q', golden: 'g', agent: 'a'},
      {query: 'q', golden: 'g', agent: 'agent-1'},
      // A managed agent, whose underscore the RFC-1034 rule in the discovery
      // document would have wrongly refused.
      {query: 'q', golden: 'g', agent: 'deep_research'},
      // A console-created agent, identified by a bare number.
      {query: 'q', golden: 'g', agent: '7988451370136689726'},
      {query: 'q', golden: 'g', agent: 'a'.repeat(63)},
    ];

    expect(validateAgentColumn(rows)).toBeNull();
  });

  it('should reject an id longer than 63 characters', () => {
    const rows: CSVRow[] = [{query: 'q', golden: 'g', agent: 'a'.repeat(64)}];

    expect(validateAgentColumn(rows)).toContain('63 characters');
  });

  it('should reject a value that could not name an agent', () => {
    for (const agent of ['dc triage', 'dc.triage', 'dc:triage', '-triage']) {
      const rows: CSVRow[] = [{query: 'q', golden: 'g', agent}];

      expect(validateAgentColumn(rows)).toContain(agent);
    }
  });

  it('should point a pasted resource name at its last segment', () => {
    // The likeliest mistake by far, and one the user can act on directly.
    const rows: CSVRow[] = [{
      query: 'q',
      golden: 'g',
      agent:
          'projects/p/locations/global/collections/default_collection/engines/e/assistants/default_assistant/agents/dc-triage'
    }];

    const error = validateAgentColumn(rows);

    expect(error).toContain('not its full resource name');
    expect(error).toContain(`Use 'dc-triage'`);
  });

  it('should number the offending row as a spreadsheet does', () => {
    // Row 1 is the header, so the second data row is row 3 on screen.
    const rows: CSVRow[] = [
      {query: 'q1', golden: 'g1', agent: 'fine'},
      {query: 'q2', golden: 'g2', agent: 'NOT FINE'},
    ];

    expect(validateAgentColumn(rows)).toContain('Row 3');
  });

  it('should reject a conversation whose turns name different agents', () => {
    const rows: CSVRow[] = [
      {query: 't1', golden: 'g', conversation_id: 'conv-a', agent: 'first'},
      {query: 't2', golden: 'g', conversation_id: 'conv-a', agent: 'second'},
    ];

    const error = validateAgentColumn(rows);

    expect(error).toContain('conv-a');
    expect(error).toContain('first');
    expect(error).toContain('second');
  });

  it('should reject a conversation that only sometimes names an agent', () => {
    // Half the turns would go to the custom agent and half to the default
    // assistant, over one shared session.
    const rows: CSVRow[] = [
      {query: 't1', golden: 'g', conversation_id: 'conv-a', agent: 'dc-triage'},
      {query: 't2', golden: 'g', conversation_id: 'conv-a'},
    ];

    expect(validateAgentColumn(rows)).toContain('the default assistant');
  });

  it('should accept a conversation whose turns all name the same agent', () => {
    const rows: CSVRow[] = [
      {query: 't1', golden: 'g', conversation_id: 'conv-a', agent: 'dc-triage'},
      {query: 't2', golden: 'g', conversation_id: 'conv-a', agent: ' dc-triage '},
    ];

    expect(validateAgentColumn(rows)).toBeNull();
  });

  it('should let different conversations use different agents', () => {
    const rows: CSVRow[] = [
      {query: 'a1', golden: 'g', conversation_id: 'conv-a', agent: 'first'},
      {query: 'b1', golden: 'g', conversation_id: 'conv-b', agent: 'second'},
      {query: 'a2', golden: 'g', conversation_id: 'conv-a', agent: 'first'},
      {query: 'standalone', golden: 'g', agent: 'third'},
    ];

    expect(validateAgentColumn(rows)).toBeNull();
  });

  it('should report a malformed id even when it appears after a good one', () => {
    const rows: CSVRow[] = [
      {query: 'q1', golden: 'g1', agent: 'dc-triage'},
      {query: 'q2', golden: 'g2'},
      {query: 'q3', golden: 'g3', agent: 'bad id'},
    ];

    expect(validateAgentColumn(rows)).toContain('Row 4');
  });
});
