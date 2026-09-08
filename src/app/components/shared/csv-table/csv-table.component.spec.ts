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

import {ComponentFixture, TestBed} from '@angular/core/testing';

import {ColumnDef, CsvTableComponent} from './csv-table.component';

describe('CsvTableComponent', () => {
  let fixture: ComponentFixture<CsvTableComponent>;
  let component: CsvTableComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({imports: [CsvTableComponent]})
        .compileComponents();
    fixture = TestBed.createComponent(CsvTableComponent);
    component = fixture.componentInstance;
  });

  describe('warning marker', () => {
    const columns: ColumnDef[] = [{
      header: 'Query',
      key: 'query',
      warnKey: 'latencyExceededBy',
      warnTooltip: 'Latency exceeded the 45s budget by {value}s',
    }];

    function warnSpan(rowIndex: number): HTMLElement|null {
      const cells =
          fixture.nativeElement.querySelectorAll('tbody tr td:first-child');
      return cells[rowIndex]?.querySelector('span.text-yellow-500') ?? null;
    }

    it('shows the marker with a substituted tooltip only for flagged rows',
       () => {
         component.columns = columns;
         component.data = [
           {query: 'slow one', latencyExceededBy: 4.2},
           {query: 'fast one'},
         ];
         fixture.detectChanges();

         const flagged = warnSpan(0);
         expect(flagged?.textContent?.trim()).toBe('⚠️');
         expect(flagged?.getAttribute('title'))
             .toBe('Latency exceeded the 45s budget by 4.2s');

         // The slot is still present (reserved width) but empty and untitled.
         const unflagged = warnSpan(1);
         expect(unflagged?.textContent?.trim()).toBe('');
         expect(unflagged?.getAttribute('title')).toBe('');
       });

    it('renders no marker slot for columns without a warnKey', () => {
      component.columns = [{header: 'Query', key: 'query'}];
      component.data = [{query: 'anything', latencyExceededBy: 9}];
      fixture.detectChanges();

      expect(warnSpan(0)).toBeNull();
    });
  });

  describe('row highlight', () => {
    function rowClass(rowIndex: number): string {
      const rows = fixture.nativeElement.querySelectorAll('tbody tr');
      return (rows[rowIndex] as HTMLElement).className;
    }

    beforeEach(() => {
      component.columns = [{header: 'Query', key: 'query'}];
      component.rowErrorKey = 'errorCode';
      component.rowWarnKey = 'latencyExceededBy';
    });

    it('tints a latency-exceeded row amber', () => {
      component.data = [{query: 'slow', errorCode: '', latencyExceededBy: 4.2}];
      fixture.detectChanges();

      expect(rowClass(0)).toContain('bg-amber-50');
      expect(rowClass(0)).toContain('border-amber-400');
    });

    it('lets a red error row win over the amber warning', () => {
      component.data =
          [{query: 'boom', errorCode: 'ERROR', latencyExceededBy: 4.2}];
      fixture.detectChanges();

      expect(rowClass(0)).toContain('bg-red-50');
      expect(rowClass(0)).not.toContain('bg-amber-50');
    });

    it('leaves an unflagged row un-highlighted', () => {
      component.data = [{query: 'fine', errorCode: ''}];
      fixture.detectChanges();

      expect(rowClass(0)).not.toContain('bg-amber-50');
      expect(rowClass(0)).not.toContain('bg-red-50');
    });
  });
});
