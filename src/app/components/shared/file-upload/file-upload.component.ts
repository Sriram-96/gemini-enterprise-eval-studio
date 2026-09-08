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

import {CommonModule} from '@angular/common';
import {ChangeDetectorRef, Component, EventEmitter, Input, Output} from '@angular/core';

import {CsvService} from '../../../services/csv.service';

/** How many excluded lines are named individually in the warning. */
const MAX_LISTED_EXCLUDED_LINES = 10;

/**
 * A row of the uploaded file that cannot be run, and why.
 *
 * Such a row is never dropped quietly: it is reported to the tester before the
 * run starts and carried into the run's final accounting, so the uploaded row
 * count always reconciles against what actually ran.
 */
export interface ExcludedRow {
  /** 1-based line number in the uploaded file, counting the header. */
  line: number;
  /** Why the row cannot be run. */
  reason: string;
}

/** What the upload hands to the tab that runs it. */
export interface UploadedQueryset {
  file: File;
  /** The runnable rows, in file order. */
  rows: Array<Record<string, string>>;
  /** Rows that were parsed but cannot be run. */
  excluded: ExcludedRow[];
}

/**
 * Component for uploading and parsing CSV files.
 * Validates required columns and emits events for navigation and execution.
 */
@Component({
  selector: 'app-file-upload',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './file-upload.component.html'
})
export class FileUploadComponent {
  @Output() prev = new EventEmitter<void>();
  @Output() run = new EventEmitter<UploadedQueryset>();
  @Input() instruction = '';
  @Input() buttonText = 'Upload';
  @Input() requiredColumns: string[] = [];

  @Input() file: File|null = null;
  @Output() readonly fileChange = new EventEmitter<File|null>();
  @Input() csvRows: any[] = [];
  @Output() readonly csvRowsChange = new EventEmitter<any[]>();

  uploadError = '';
  isParsing = false;
  /** Rows parsed so far, shown while a large file is still being read. */
  parsedSoFar = 0;
  /** Rows that parsed but cannot be run, reported before the run starts. */
  excludedRows: ExcludedRow[] = [];
  /** Warning about lines the parser itself could not read, if any. */
  parseWarning = '';

  constructor(private csvService: CsvService, private cdr: ChangeDetectorRef) {}

  /** Prevents default drag behavior to allow drop. */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  /** Handles the drop event for the file. */
  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
  }

  /** Handles the file selection event. */
  onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
    target.value = '';
  }

  /**
   * Handles the selected file, validates it, and parses CSV.
   * @param file The CSV file to handle.
   */
  handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      this.reject('Please upload a valid CSV file.');
      return;
    }
    this.file = file;
    this.fileChange.emit(file);
    this.uploadError = '';
    this.parseWarning = '';
    this.excludedRows = [];
    this.parsedSoFar = 0;
    this.isParsing = true;
    this.csvService.parseCSV(file, (parsed) => {
      const rows = parsed.rows.map((row) => {
        const normalizedRow: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) {
          const normalizedKey = key.trim().replace(/^\ufeff/, '').toLowerCase();
          normalizedRow[normalizedKey] = value;
        }
        return normalizedRow;
      });
      this.isParsing = false;

      if (rows.length === 0) {
        this.reject('CSV file is empty or contains no data rows.');
        this.cdr.detectChanges();
        return;
      }

      const headers = Object.keys(rows[0]);
      // Normalize requiredColumns to lowercase to match the normalized headers.
      const lowerCaseRequiredColumns =
          this.requiredColumns.map(col => col.toLowerCase());
      const missingColumns =
          lowerCaseRequiredColumns.filter(col => !headers.includes(col));
      if (missingColumns.length > 0) {
        this.reject(`CSV must contain columns: ${
            this.requiredColumns.join(', ')}. Missing: ${
            missingColumns.join(', ')}`);
        this.cdr.detectChanges();
        return;
      }

      // A row with no query text cannot be sent anywhere. Rather than running
      // it as an empty query or dropping it behind the tester's back, it is
      // set aside and reported, and the run's accounting counts it.
      const runnable: Array<Record<string, string>> = [];
      const excluded: ExcludedRow[] = [];
      rows.forEach((row, index) => {
        if (row['query']?.trim()) {
          runnable.push(row);
        } else {
          // +2 maps a data row back to its file line: 1 for the header, 1 for
          // the 1-based count. Wholly empty lines are skipped during the parse,
          // so a file padded with those shifts the number reported here; the
          // count of excluded rows stays exact either way.
          excluded.push({line: index + 2, reason: 'blank query'});
        }
      });

      this.excludedRows = excluded;
      if (parsed.parseErrorCount > 0) {
        const shown = parsed.parseErrors.join('; ');
        const rest = parsed.parseErrorCount - parsed.parseErrors.length;
        this.parseWarning = `${parsed.parseErrorCount} line${
            parsed.parseErrorCount === 1 ? '' : 's'} did not parse cleanly: ${
            shown}${rest > 0 ? `; and ${rest} more` : ''}.`;
      }

      if (runnable.length === 0) {
        this.reject(
            'No runnable rows: every row in the file has a blank query.');
        this.cdr.detectChanges();
        return;
      }

      this.csvRows = runnable;
      this.csvRowsChange.emit(this.csvRows);
      this.cdr.detectChanges();
    }, (err) => {
      this.isParsing = false;
      this.reject(err);
      this.cdr.detectChanges();
    }, (rowsParsed) => {
      this.parsedSoFar = rowsParsed;
      this.cdr.detectChanges();
    });
  }

  /** Clears the selection and reports why the file cannot be used. */
  private reject(message: string) {
    this.uploadError = message;
    this.file = null;
    this.fileChange.emit(null);
    this.csvRows = [];
    this.csvRowsChange.emit([]);
    this.excludedRows = [];
  }

  /** Summarizes the excluded rows for the warning banner. */
  excludedSummary(): string {
    const lines = this.excludedRows.slice(0, MAX_LISTED_EXCLUDED_LINES)
                      .map(row => row.line)
                      .join(', ');
    const rest = this.excludedRows.length - MAX_LISTED_EXCLUDED_LINES;
    return `${this.excludedRows.length} row${
        this.excludedRows.length === 1 ? '' : 's'} will not be run (blank
        query) \u2014 line${this.excludedRows.length === 1 ? '' : 's'} ${lines}${
        rest > 0 ? `, and ${rest} more` : ''}.`
        .replace(/\s+/g, ' ');
  }

  /** Emits the prev event to go to the previous step. */
  onPrev() {
    this.prev.emit();
  }

  /** Emits the run event with the file, the runnable rows and the excluded ones. */
  onRun() {
    if (this.file) {
      this.run.emit(
          {file: this.file, rows: this.csvRows, excluded: this.excludedRows});
    }
  }
}
