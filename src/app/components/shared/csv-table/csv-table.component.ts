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

import {CommonModule, formatDate} from '@angular/common';
import {Component, EventEmitter, Input, OnChanges, Output} from '@angular/core';

import {CsvService} from '../../../services/csv.service';

declare var marked: any;

/**
 * Defines the structure of a column in the CSV table.
 */
export interface ColumnDef {
  header: string;
  key: string;
  type?: 'text'|'markdown'|'number'|'score'|'delta';
  truncate?: boolean;
  width?: string;
  /**
   * Row field whose non-null value shows a leading warning marker on this
   * cell (a fixed-width slot is reserved either way so text stays aligned).
   * Only text-type columns honour it.
   */
  warnKey?: string;
  /** Hover text for the warning marker; `{value}` is replaced with row[warnKey]. */
  warnTooltip?: string;
}

@Component({
  selector: 'app-csv-table',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './csv-table.component.html'
})
/**
 * Component for displaying CSV data in a table.
 * Supports markdown rendering, truncation, and expansion of cells.
 */
export class CsvTableComponent implements OnChanges {
  @Input() data: any[] = [];
  @Input() columns: ColumnDef[] = [];
  @Input() title = '';
  @Input() exportFileName: string = 'eval_results';
  /**
   * Label of an optional per-row button, rendered in a trailing column. Left
   * unset, no such column appears, so tables that have nothing to offer per
   * row are unaffected.
   */
  @Input() rowActionLabel?: string;
  /**
   * Key on each row whose truthy value marks the row as an error. When set, such
   * rows are highlighted (light-red fill + red outline) so failures stand out.
   * Left unset, no row is highlighted, so other tables are unaffected.
   */
  @Input() rowErrorKey?: string;
  /**
   * Key on each row whose non-null value marks the row as a warning. When set,
   * such rows get a light-amber fill + amber outline, distinct from (and lower
   * priority than) the red error highlight. Left unset, no row is highlighted.
   */
  @Input() rowWarnKey?: string;
  /** Emits the index of the row whose action button was clicked. */
  @Output() rowAction = new EventEmitter<number>();

  hasTruncated = false;

  constructor(private csvService: CsvService) {}

  ngOnChanges() {
    this.hasTruncated = this.columns.some(col => col.truncate);
  }

  /**
   * Builds the warning marker's hover text for a cell, substituting the row's
   * value into the column's `warnTooltip` template.
   * @param col The column definition carrying `warnKey`/`warnTooltip`.
   * @param row The row being rendered.
   * @returns The tooltip text, or '' when the column has no template.
   */
  warnTitle(col: ColumnDef, row: any): string {
    return (col.warnTooltip ?? '').replace('{value}', row[col.warnKey!]);
  }

  /**
   * Exports the table data to a CSV file.
   */
  exportResults() {
    const formattedDate =
        formatDate(new Date(), 'yyyy-MM-dd_HH-mm-ss', 'en-US');

    this.csvService.exportCSV(
        this.data, `${this.exportFileName}_${formattedDate}.csv`);
  }

  expandedCells: Map<string, boolean> = new Map();

  /**
   * Renders markdown text to HTML using marked library.
   * @param text The markdown text to render.
   * @returns The rendered HTML string.
   */
  renderMarkdown(text: string): string {
    if (!text) return '';
    if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
      try {
        return marked.parse(text);
      } catch (e) {
        console.error('Failed to parse markdown with marked:', e);
      }
    }
    // Fallback to raw text with basic escaping and line breaks
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
  }

  /**
   * Tracks table rows by position.
   *
   * A running evaluation hands this table a freshly built array after every
   * finished row. Without a track function each of those updates throws away
   * and re-creates every `<tr>`, which on a long queryset costs more than the
   * evaluation itself; by position the existing rows are updated in place and
   * only the new one is added.
   * @param index The row's position in the table.
   * @returns The identity to track the row by.
   */
  trackByIndex(index: number): number {
    return index;
  }

  /**
   * Truncates text to a specified limit.
   * @param text The text to truncate.
   * @param limit The maximum length of the text.
   * @returns The truncated text.
   */
  truncate(text: string, limit: number = 100): string {
    if (!text) return '';
    return text.length > limit ? text.substring(0, limit) + '...' : text;
  }

  /**
   * Toggles the expansion state of a specific cell.
   * @param rowIndex The index of the row.
   * @param key The column key.
   */
  toggleExpand(rowIndex: number, key: string) {
    const cellKey = `${rowIndex}-${key}`;
    this.expandedCells.set(cellKey, !this.expandedCells.get(cellKey));
  }

  /**
   * Checks if a specific cell is expanded.
   * @param rowIndex The index of the row.
   * @param key The column key.
   * @returns True if the cell is expanded, false otherwise.
   */
  isExpanded(rowIndex: number, key: string): boolean {
    return this.expandedCells.get(`${rowIndex}-${key}`) || false;
  }
}
