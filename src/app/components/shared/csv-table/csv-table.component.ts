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
import {FormsModule} from '@angular/forms';

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
}

/** Page sizes offered in the table footer. 0 means "every row". */
export const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100, 250, 0];

/**
 * Rows rendered per page by default.
 *
 * A run has no row limit, so the table cannot render the whole result set:
 * every visible cell re-renders on each change-detection pass, and markdown
 * cells re-parse. Paging keeps that cost flat no matter how large the run
 * grows. Export and the run accounting always cover every row, not just the
 * visible page.
 */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Most rendered markdown strings kept in the cache before it is dropped.
 *
 * Parsing markdown inside a template binding re-runs on every change-detection
 * pass, which a long-running evaluation triggers constantly. Caching the
 * rendered HTML makes that cost proportional to the number of distinct cells
 * shown rather than to the number of passes.
 */
const MARKDOWN_CACHE_LIMIT = 2000;

@Component({
  selector: 'app-csv-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  /** Emits the index of the row whose action button was clicked. */
  @Output() rowAction = new EventEmitter<number>();

  hasTruncated = false;

  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  /** Rows rendered per page; 0 renders every row. */
  pageSize = DEFAULT_PAGE_SIZE;
  /** 0-based index of the page on show. */
  page = 0;
  /** The slice of `data` currently rendered. */
  pagedData: any[] = [];

  private readonly markdownCache = new Map<string, string>();

  constructor(private csvService: CsvService) {}

  ngOnChanges() {
    this.hasTruncated = this.columns.some(col => col.truncate);
    this.updatePage();
  }

  /** Total number of pages, at least one even when there is no data. */
  get pageCount(): number {
    if (this.pageSize <= 0) {
      return 1;
    }
    return Math.max(1, Math.ceil(this.data.length / this.pageSize));
  }

  /** Index into `data` of the first row on the current page. */
  get pageStart(): number {
    return this.pageSize <= 0 ? 0 : this.page * this.pageSize;
  }

  /** Index into `data` just past the last row on the current page. */
  get pageEnd(): number {
    return this.pageSize <= 0 ? this.data.length :
                                Math.min(this.data.length,
                                         this.pageStart + this.pageSize);
  }

  /**
   * Recomputes the visible slice, clamping the page so that a result set
   * shrinking underneath the table (a new run starting, say) cannot strand the
   * view on a page that no longer exists.
   */
  private updatePage() {
    this.page = Math.min(Math.max(0, this.page), this.pageCount - 1);
    this.pagedData = this.pageSize <= 0 ?
        this.data :
        this.data.slice(this.pageStart, this.pageEnd);
  }

  /** Moves to a page by 0-based index, ignoring out-of-range requests. */
  goToPage(page: number) {
    if (page < 0 || page >= this.pageCount) {
      return;
    }
    this.page = page;
    this.updatePage();
  }

  /** Applies a new page size, keeping the first currently visible row in view. */
  setPageSize(size: number|string) {
    const next = Number(size);
    const firstVisible = this.pageStart;
    this.pageSize = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
    this.page = this.pageSize > 0 ? Math.floor(firstVisible / this.pageSize) : 0;
    this.updatePage();
  }

  /**
   * Identity for the rendered rows, so appending a row during a run patches
   * the table instead of rebuilding every row in it.
   */
  trackByIndex(index: number): number {
    return this.pageStart + index;
  }

  /**
   * Exports the table data to a CSV file.
   *
   * Always the whole result set, never just the page on show: the export is
   * the artifact a tester reconciles against their input file.
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
   *
   * Called from a template binding, so it runs on every change-detection pass
   * for every visible markdown cell. The result is memoized on the text
   * itself, which makes a long run's repeated passes cheap.
   *
   * @param text The markdown text to render.
   * @returns The rendered HTML string.
   */
  renderMarkdown(text: string): string {
    if (!text) return '';
    const cached = this.markdownCache.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const rendered = this.parseMarkdown(text);
    if (this.markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
      // Cheaper than tracking recency, and the cache refills from the visible
      // page within one change-detection pass.
      this.markdownCache.clear();
    }
    this.markdownCache.set(text, rendered);
    return rendered;
  }

  /** Renders one markdown string, falling back to escaped plain text. */
  private parseMarkdown(text: string): string {
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
