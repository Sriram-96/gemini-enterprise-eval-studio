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
import {ChangeDetectorRef, Component} from '@angular/core';

import {resolveConcurrency} from '../../models/app-config.model';
import {CsvService} from '../../services/csv.service';
import {EvalService} from '../../services/eval.service';
import {StateService} from '../../services/state.service';
import {ConfigFormComponent} from '../shared/config-form/config-form.component';
import {ColumnDef, CsvTableComponent} from '../shared/csv-table/csv-table.component';
import {ExcludedRow, FileUploadComponent, UploadedQueryset} from '../shared/file-upload/file-upload.component';
import {ProgressBarComponent} from '../shared/progress-bar/progress-bar.component';

/**
 * Shortest gap between two refreshes of the growing response table, in
 * milliseconds. Re-rendering on every completed row makes a large run spend
 * more time in change detection than in the API calls it is waiting on.
 */
const RESULTS_REFRESH_INTERVAL_MS = 400;

/** Accounting for one run: every uploaded row lands in exactly one bucket. */
export interface QueryRunSummary {
  uploaded: number;
  ran: number;
  succeeded: number;
  failed: number;
  notRun: number;
  excluded: number;
}

/** A generated response, as shown in the table. */
interface ResponseRow {
  query: string;
  response: string;
  errorCode?: string;
  ttft: number;
  ttfa: number;
  ttlt: number;
  tpot: number;
  assistToken?: string;
  projectId?: string;
  region?: string;
  engineId?: string;
}

/**
 * Component for running queries and generating responses.
 * It handles file upload, processing, and exporting results.
 */
@Component({
  selector: 'app-run-queries',
  standalone: true,
  imports: [
    CommonModule, ConfigFormComponent, FileUploadComponent,
    CsvTableComponent, ProgressBarComponent
  ],
  templateUrl: './run-queries.component.html'
})
export class RunQueriesComponent {
  step = 1;
  columns: ColumnDef[] = [
    {header: 'Query', key: 'query', truncate: true}, {
      header: 'Response',
      key: 'response',
      type: 'markdown',
      truncate: true
    },
    {header: 'TTFT (s)', key: 'ttft', type: 'number'},
    {header: 'TTFA (s)', key: 'ttfa', type: 'number'},
    {header: 'TTLT (s)', key: 'ttlt', type: 'number'},
    {header: 'TPOT (ms/token)', key: 'tpot', type: 'number'}
  ];
  responseFile: File|null = null;
  responseCsvRows: Array<Record<string, string>> = [];
  responseResults: ResponseRow[] = [];
  isProcessingResponse = false;
  responseProgress = 0;
  totalRows = 0;
  completedRows = 0;
  /**
   * Accounting for the last run, so a tester can reconcile the table against
   * the file they uploaded. Null before the first run.
   */
  runSummary: QueryRunSummary|null = null;
  private currentRunId = 0;
  /** Rows set aside at upload, carried into the run's accounting. */
  private excludedRows: ExcludedRow[] = [];
  /** When the table was last refreshed, for coalescing. */
  private lastRefreshMs = 0;

  constructor(
      private csvService: CsvService, private evalService: EvalService,
      private stateService: StateService,
      private cdr: ChangeDetectorRef) {}

  isConfigValid(): boolean {
    const config = this.stateService.getCurrentConfig();
    const engines = this.stateService.getEngines();
    const hasValidEngine = engines.some(e => e.name === config.selectedEngine);
    return !!(config.projectId &&
        config.selectedEngine && config.selectedModel &&
        hasValidEngine);
  }

  isStepSelectable(targetStep: number): boolean {
    if (targetStep === 1) {
      return true;
    }
    if (targetStep === 2) {
      return this.isConfigValid();
    }
    if (targetStep === 3) {
      return this.responseResults.length > 0 || this.isProcessingResponse;
    }
    return false;
  }

  goToStep(targetStep: number) {
    if (this.isStepSelectable(targetStep)) {
      this.step = targetStep;
      this.cdr.detectChanges();
    }
  }

  nextStep() {
    if (this.step < 3) {
      this.step++;
    }
  }

  prevStep() {
    if (this.step > 1) {
      this.step--;
    }
  }

  startResponseGeneration(event: UploadedQueryset|
                          {file: File, rows: Array<Record<string, string>>}) {
    this.responseFile = event.file;
    this.responseCsvRows = event.rows;
    this.excludedRows = ('excluded' in event && event.excluded) || [];
    this.runResponseGeneration();
  }

  /**
   * Runs the response generation process for all rows.
   *
   * There is no cap on how many rows a run may contain. Each row gets its own
   * slot up front and every slot is filled before the run ends — with a
   * response, with the failure that stopped it, or with an explicit `NOT_RUN`
   * marker — so no query can vanish between the uploaded file and the table.
   */
  async runResponseGeneration() {
    if (this.isProcessingResponse) return;
    const runId = ++this.currentRunId;
    const rows = this.responseCsvRows;
    this.isProcessingResponse = true;
    this.responseResults = [];
    this.responseProgress = 0;
    this.totalRows = rows.length;
    this.completedRows = 0;
    this.runSummary = null;
    this.lastRefreshMs = 0;
    this.step = 3;
    this.cdr.detectChanges();

    // Filled in place so the table keeps the file's own order however the
    // workers interleave, and so an empty slot at the end is provably a row
    // that never ran.
    const slots: Array<ResponseRow|undefined> = new Array(rows.length);

    const tasks = rows.map((row, index) => async () => {
      // Checked before the call, not after: a response that already came back
      // is kept even if Stop was pressed while it was in flight.
      if (runId !== this.currentRunId || !this.isProcessingResponse) return;

      const csvRow = {query: row['query'], golden: ''};
      let slot: ResponseRow;
      try {
        const result = await this.evalService.processRow(csvRow);
        slot = {
          query: result.query,
          response: result.fetched,
          errorCode: result.errorCode,
          ttft: result.ttft,
          ttfa: result.ttfa,
          ttlt: result.ttlt,
          tpot: result.tpot,
          assistToken: result.assistToken,
          projectId: result.projectId,
          region: result.region,
          engineId: result.engineId
        };
      } catch (error) {
        // A rejection here would otherwise escape Promise.all and abandon
        // every row still queued, without a trace of any of them.
        console.error('Unhandled error generating a response:', error);
        slot = this.failedRow(
            csvRow.query,
            error instanceof Error ? error.message : String(error));
      }
      if (runId !== this.currentRunId) return;

      slots[index] = slot;
      this.completedRows++;
      this.responseProgress =
          Math.round((this.completedRows / this.totalRows) * 100);
      this.refresh(slots, false);
    });

    let index = 0;
    const worker = async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        await tasks[currentIndex]();
      }
    };

    const concurrency =
        resolveConcurrency(this.stateService.getCurrentConfig());
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (runId !== this.currentRunId) return;

    // Rows the run never reached are written out explicitly rather than left
    // as gaps, so the table and the CSV export cover the whole uploaded file.
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i]) {
        slots[i] = this.failedRow(
            rows[i]?.['query'] ?? '',
            'Not run: response generation was stopped before this row.',
            'NOT_RUN');
      }
    }

    if (this.isProcessingResponse) {
      this.responseProgress = 100;
    }
    this.isProcessingResponse = false;
    this.runSummary = this.summarize(slots);
    this.refresh(slots, true);
  }

  /**
   * Refreshes the table from the slots gathered so far.
   * @param slots The per-row slots, some possibly still empty.
   * @param force Whether to refresh regardless of how recently it last
   *     happened.
   */
  private refresh(slots: Array<ResponseRow|undefined>, force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastRefreshMs < RESULTS_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastRefreshMs = now;
    this.responseResults = slots.filter((row): row is ResponseRow => !!row);
    this.cdr.detectChanges();
  }

  /** Builds the placeholder row recorded for a query that produced no answer. */
  private failedRow(query: string, message: string, errorCode = 'ERROR'):
      ResponseRow {
    return {
      query,
      response: message,
      errorCode,
      ttft: 0,
      ttfa: 0,
      ttlt: 0,
      tpot: 0
    };
  }

  /** Reconciles the finished run against the uploaded file. */
  private summarize(slots: Array<ResponseRow|undefined>): QueryRunSummary {
    let succeeded = 0;
    let failed = 0;
    let notRun = 0;
    for (const row of slots) {
      if (!row || row.errorCode === 'NOT_RUN') {
        notRun++;
      } else if (row.errorCode) {
        failed++;
      } else {
        succeeded++;
      }
    }
    return {
      uploaded: slots.length + this.excludedRows.length,
      ran: succeeded + failed,
      succeeded,
      failed,
      notRun,
      excluded: this.excludedRows.length
    };
  }

  /** Whether the last run left any row unanswered. */
  hasUnfinishedRows(): boolean {
    return !!this.runSummary &&
        (this.runSummary.failed > 0 || this.runSummary.notRun > 0 ||
         this.runSummary.excluded > 0);
  }

  stopResponseGeneration() {
    this.isProcessingResponse = false;
    this.cdr.detectChanges();
  }
}
