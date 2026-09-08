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

import {CsvService, ParsedCsv} from './csv.service';

describe('CsvService', () => {
  let service: CsvService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CsvService);
  });

  /** Parses a CSV string as an uploaded file. */
  function parse(csv: string, onProgress?: (rows: number) => void):
      Promise<ParsedCsv> {
    const file = new File([csv], 'queryset.csv', {type: 'text/csv'});
    return new Promise<ParsedCsv>((resolve, reject) => {
      service.parseCSV(file, resolve, reject, onProgress);
    });
  }

  /** Builds a queryset of `count` rows. */
  function queryset(count: number): string {
    const rows = Array.from(
        {length: count}, (_, i) => `question ${i},answer ${i}`);
    return ['query,golden', ...rows].join('\n');
  }

  it('should parse every row of a queryset well past 100 rows', async () => {
    // The old parser truncated at 100. A tester has to be able to trust that
    // the rows the app runs are the rows they uploaded, at any size.
    const parsed = await parse(queryset(2500));

    expect(parsed.rows.length).toBe(2500);
    expect(parsed.rows[0]['query']).toBe('question 0');
    expect(parsed.rows[2499]['query']).toBe('question 2499');
    expect(parsed.parseErrorCount).toBe(0);
  });

  it('should keep the rows in file order', async () => {
    const parsed = await parse(queryset(300));

    expect(parsed.rows.map(row => row['query'])).toEqual(
        Array.from({length: 300}, (_, i) => `question ${i}`));
  });

  it('should report lines it could not parse instead of dropping them quietly',
     async () => {
       // A row with more fields than the header is a malformed line, not a
       // reason to say nothing.
       const parsed = await parse(
           'query,golden\ngood,answer\nbad,answer,stray extra field\n');

       expect(parsed.parseErrorCount).toBeGreaterThan(0);
       expect(parsed.parseErrors[0]).toContain('Line 3');
     });

  it('should report progress while parsing', async () => {
    const seen: number[] = [];
    const parsed = await parse(queryset(500), rows => void seen.push(rows));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(parsed.rows.length);
  });

  it('should return no rows for a header-only file', async () => {
    const parsed = await parse('query,golden\n');

    expect(parsed.rows).toEqual([]);
  });
});
