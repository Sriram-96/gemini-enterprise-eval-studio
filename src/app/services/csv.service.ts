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
 * Service for parsing and exporting CSV files.
 */
@Injectable({providedIn: 'root'})
export class CsvService {
  constructor(private ngZone: NgZone) {}

  /**
   * Parses a CSV file.
   * @param file The file to parse.
   * @param callback Callback function called with parsed data.
   * @param onError Callback function called on error.
   */
  parseCSV(
      file: File, callback: (data: Array<Record<string, string>>) => void,
      onError: (error: string) => void) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: {data: Array<Record<string, string>>}) => {
        this.ngZone.run(() => {
          callback(results.data.slice(0, 100));
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
