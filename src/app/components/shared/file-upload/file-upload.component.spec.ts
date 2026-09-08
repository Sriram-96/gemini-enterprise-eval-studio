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

import {UploadedQueryset} from './file-upload.component';
import {FileUploadComponent} from './file-upload.component';

describe('FileUploadComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [FileUploadComponent]})
        .compileComponents();
  });

  /** Builds a component that requires the given columns. */
  function build(requiredColumns: string[] = ['query', 'golden']) {
    const fixture = TestBed.createComponent(FileUploadComponent);
    fixture.componentInstance.requiredColumns = requiredColumns;
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  /** Feeds a CSV string through the component and waits for the parse. */
  async function upload(component: FileUploadComponent, csv: string) {
    const done = new Promise<void>(resolve => {
      component.csvRowsChange.subscribe(() => void resolve());
    });
    component.handleFile(new File([csv], 'queryset.csv', {type: 'text/csv'}));
    await done;
  }

  it('should accept a queryset far larger than the old 100 row cap',
     async () => {
       const component = build();
       const rows = Array.from({length: 1200}, (_, i) => `q${i},g${i}`);
       await upload(component, ['query,golden', ...rows].join('\n'));

       expect(component.csvRows.length).toBe(1200);
       expect(component.uploadError).toBe('');
       expect(component.excludedRows).toEqual([]);
     });

  it('should set aside rows with a blank query and report their line numbers',
     async () => {
       const component = build();
       await upload(
           component,
           'query,golden\nq1,g1\n   ,g2\nq3,g3\n,g4\n');

       // The blank rows cannot be sent anywhere, but they are named rather
       // than dropped behind the tester's back. Line 1 is the header, so the
       // blank rows sit on file lines 3 and 5.
       expect(component.csvRows.map(row => row['query'])).toEqual(['q1', 'q3']);
       expect(component.excludedRows).toEqual([
         {line: 3, reason: 'blank query'},
         {line: 5, reason: 'blank query'},
       ]);
       expect(component.excludedSummary()).toContain('lines 3, 5');
     });

  it('should carry the excluded rows to the run so the counts reconcile',
     async () => {
       const component = build();
       await upload(component, 'query,golden\nq1,g1\n,g2\n');

       let emitted: UploadedQueryset|undefined;
       component.run.subscribe(event => void (emitted = event));
       component.onRun();

       expect(emitted?.rows.length).toBe(1);
       expect(emitted?.excluded.length).toBe(1);
     });

  it('should reject a file whose rows all have a blank query', async () => {
    const component = build();
    const done = new Promise<void>(resolve => {
      component.csvRowsChange.subscribe(() => void resolve());
    });
    component.handleFile(
        new File(['query,golden\n,g1\n,g2\n'], 'q.csv', {type: 'text/csv'}));
    await done;

    expect(component.uploadError).toContain('blank query');
    expect(component.csvRows).toEqual([]);
  });

  it('should still reject a file missing a required column', async () => {
    const component = build();
    const done = new Promise<void>(resolve => {
      component.csvRowsChange.subscribe(() => void resolve());
    });
    component.handleFile(
        new File(['query\nq1\n'], 'q.csv', {type: 'text/csv'}));
    await done;

    expect(component.uploadError).toContain('golden');
    expect(component.csvRows).toEqual([]);
  });

  it('should warn about lines that did not parse cleanly', async () => {
    const component = build();
    await upload(component, 'query,golden\nq1,g1\nq2,g2,stray\n');

    expect(component.parseWarning).toContain('did not parse cleanly');
  });
});
