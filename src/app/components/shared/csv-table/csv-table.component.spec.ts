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

import {CsvService} from '../../../services/csv.service';

import {ColumnDef, CsvTableComponent} from './csv-table.component';

describe('CsvTableComponent', () => {
  let fixture: ComponentFixture<CsvTableComponent>;
  let component: CsvTableComponent;
  let mockCsvService: jasmine.SpyObj<CsvService>;

  const COLUMNS: ColumnDef[] = [
    {header: 'Query', key: 'query', truncate: true},
    {header: 'Score', key: 'score', type: 'score'},
  ];

  beforeEach(async () => {
    mockCsvService =
        jasmine.createSpyObj('CsvService', ['exportCSV', 'exportJSONL']);
    await TestBed
        .configureTestingModule({
          imports: [CsvTableComponent],
          providers: [{provide: CsvService, useValue: mockCsvService}]
        })
        .compileComponents();
    fixture = TestBed.createComponent(CsvTableComponent);
    component = fixture.componentInstance;
    component.columns = COLUMNS;
  });

  /**
   * Fills the table with `count` rows. Calls `ngOnChanges` by hand because
   * Angular only fires it for template-bound inputs, and the parents rebind
   * `[data]` with a fresh array on every publication.
   */
  function withRows(count: number) {
    component.data = Array.from(
        {length: count}, (_, i) => ({query: `q${i}`, score: 0.5}));
    component.ngOnChanges();
    fixture.detectChanges();
  }

  it('should render only the first page of a large result set', () => {
    withRows(1000);

    expect(component.pageSize).toBe(50);
    expect(component.pagedData.length).toBe(50);
    expect(component.pageCount).toBe(20);
    expect(component.pagedData[0]['query']).toBe('q0');
    expect(component.pagedData[49]['query']).toBe('q49');
  });

  it('should page through the whole result set', () => {
    withRows(1000);

    component.goToPage(3);

    expect(component.pageStart).toBe(150);
    expect(component.pagedData[0]['query']).toBe('q150');

    component.goToPage(component.pageCount - 1);

    expect(component.pagedData[component.pagedData.length - 1]['query'])
        .toBe('q999');
  });

  it('should ignore a page outside the range', () => {
    withRows(100);

    component.goToPage(-1);
    expect(component.page).toBe(0);

    component.goToPage(99);
    expect(component.page).toBe(0);
  });

  it('should render every row when the page size is All', () => {
    withRows(300);

    component.setPageSize(0);

    expect(component.pageCount).toBe(1);
    expect(component.pagedData.length).toBe(300);
  });

  it('should keep the first visible row in view when the page size changes',
     () => {
       withRows(1000);
       component.goToPage(4);  // rows 200-249

       component.setPageSize(100);

       expect(component.pageStart).toBe(200);
       expect(component.pagedData[0]['query']).toBe('q200');
     });

  it('should clamp the page when the data shrinks underneath it', () => {
    withRows(1000);
    component.goToPage(19);

    // A new run starting empties the table while the view sits on a page that
    // no longer exists.
    withRows(10);

    expect(component.page).toBe(0);
    expect(component.pagedData.length).toBe(10);
  });

  it('should report row indices absolute to the whole result set', () => {
    withRows(1000);
    component.goToPage(2);  // rows 100-149

    const emitted: number[] = [];
    component.rowAction.subscribe(index => void emitted.push(index));
    // The template emits pageStart + i; row 7 of this page is row 107 overall.
    component.rowAction.emit(component.pageStart + 7);

    expect(emitted).toEqual([107]);
    expect(component.trackByIndex(7)).toBe(107);
  });

  it('should key expansion state by the absolute row index', () => {
    withRows(1000);
    component.goToPage(1);

    component.toggleExpand(component.pageStart + 3, 'query');

    expect(component.isExpanded(53, 'query')).toBeTrue();
    // The row at the same position on another page is untouched.
    expect(component.isExpanded(3, 'query')).toBeFalse();
  });

  it('should export every row, not just the visible page', () => {
    withRows(1000);
    component.goToPage(5);

    component.exportResults();

    const exported = mockCsvService.exportCSV.calls.mostRecent().args[0];
    expect(exported.length).toBe(1000);
  });

  it('should memoize rendered markdown', () => {
    const first = component.renderMarkdown('**bold**');
    const second = component.renderMarkdown('**bold**');

    expect(second).toBe(first);
    expect(component.renderMarkdown('')).toBe('');
  });
});
