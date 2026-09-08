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

import {Injectable, NgZone} from '@angular/core';

import * as Papa from 'papaparse';

/**
 * How much of the file Papa reads per chunk, in bytes.
 *
 * The file is parsed in chunks rather than in one pass so that a large
 * queryset does not lock the main thread for the whole parse: the browser gets
 * to paint the row counter between chunks. 1 MiB is large enough that the
 * per-chunk overhead stays negligible.
 */
const PARSE_CHUNK_SIZE_BYTES = 1024 * 1024;

/** How many individual parse errors are quoted back to the user. */
const MAX_REPORTED_PARSE_ERRORS = 5;

/**
 * The outcome of parsing a queryset.
 *
 * Every row Papa produced is returned — the parser imposes no row limit, so a
 * caller can trust that `rows` is the whole file. Rows the parser could not
 * make sense of are reported in `parseErrors` rather than dropped in silence,
 * so an unusable line is always visible to the tester.
 */
export interface ParsedCsv {
  /** Every data row in the file, in file order. */
  rows: Array<Record<string, string>>;
  /**
   * Human-readable descriptions of the lines Papa could not parse cleanly, at
   * most `MAX_REPORTED_PARSE_ERRORS` of them.
   */
  parseErrors: string[];
  /** Total number of parse errors, including those beyond the quoted few. */
  parseErrorCount: number;
}

/**
 * Service for parsing and exporting CSV files.
 */
@Injectable({providedIn: 'root'})
export class CsvService {
  constructor(private ngZone: NgZone) {}

  /**
   * Parses a CSV file in full.
   *
   * There is deliberately no row cap: a queryset of any size is parsed
   * end to end, because a tester has to be able to trust that the rows the
   * app runs are the rows they uploaded.
   *
   * @param file The file to parse.
   * @param callback Called once with every parsed row and any parse errors.
   * @param onError Called instead of `callback` when the file cannot be read
   *     at all.
   * @param onProgress Called between chunks with the number of rows parsed so
   *     far, so a long parse can show progress.
   */
  parseCSV(
      file: File, callback: (result: ParsedCsv) => void,
      onError: (error: string) => void,
      onProgress?: (rowsParsed: number) => void) {
    const rows: Array<Record<string, string>> = [];
    const parseErrors: string[] = [];
    let parseErrorCount = 0;

    const collectErrors = (errors: Papa.ParseError[]|undefined) => {
      for (const error of errors ?? []) {
        parseErrorCount++;
        if (parseErrors.length < MAX_REPORTED_PARSE_ERRORS) {
          // Papa's `row` is a 0-based index into the data rows; report the
          // spreadsheet line number the tester can actually go and look at,
          // which also counts the header.
          const line = typeof error.row === 'number' ? error.row + 2 : undefined;
          parseErrors.push(
              line ? `Line ${line}: ${error.message}` : error.message);
        }
      }
    };

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      chunkSize: PARSE_CHUNK_SIZE_BYTES,
      chunk: (results) => {
        // Pushed in place rather than concatenated: a spread per chunk would
        // copy the whole accumulated queryset on every chunk.
        for (const row of results.data) {
          rows.push(row);
        }
        collectErrors(results.errors);
        if (onProgress) {
          const parsed = rows.length;
          this.ngZone.run(() => {
            onProgress(parsed);
          });
        }
      },
      complete: () => {
        this.ngZone.run(() => {
          callback({rows, parseErrors, parseErrorCount});
        });
      },
      error: (error: {message: string}) => {
        this.ngZone.run(() => {
          onError('Error parsing CSV: ' + error.message);
        });
      }
    });
  }

  /**
   * Exports data to a CSV file.
   * @param data The data to export.
   * @param filename The name of the file to create.
   */
  exportCSV(data: Array<object>, filename: string) {
    // Excel and most spreadsheet apps decode a CSV in the system locale unless
    // it opens with a UTF-8 byte order mark. Without it every em dash and
    // emoji the agent produced -- and every citation, which joins its title
    // and uri with one -- arrives as mojibake.
    this.download(
        `\uFEFF${Papa.unparse(data)}`, filename, 'text/csv;charset=utf-8');
  }

  /**
   * Exports data as newline-delimited JSON, one object per line.
   *
   * Used for evidence too nested to survive a spreadsheet cell, such as the
   * verbatim assist stream behind each row: a reader can stream the file
   * record by record instead of parsing one enormous array.
   * @param data The objects to export, one per line.
   * @param filename The name of the file to create.
   */
  exportJSONL(data: Array<object>, filename: string) {
    // Deliberately no byte order mark: a parser reading the file line by line
    // would take one as part of the first record and fail to parse it.
    const jsonl = data.map(entry => JSON.stringify(entry)).join('\n');
    this.download(jsonl, filename, 'application/x-ndjson;charset=utf-8');
  }

  /**
   * Prompts the browser to save text as a file.
   * @param content The file's contents.
   * @param filename The name of the file to create.
   * @param type The blob's MIME type.
   */
  private download(
      content: string, filename: string,
      type = 'application/octet-stream') {
    const blob = new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
