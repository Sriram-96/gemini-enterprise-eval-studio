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
import {ChangeDetectorRef, Component, OnDestroy, OnInit} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Subject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';

import {AppConfig, resolveConcurrency} from '../../models/app-config.model';
import {CSVRow} from '../../models/csv-row.model';
import {ResultRow} from '../../models/result-row.model';
import {Scorer, ScorerRunResult, summarizeScorerResults} from '../../scoring/scorer';
import {ScorerRegistry} from '../../scoring/scorer.registry';
import {CsvService} from '../../services/csv.service';
import {EvalService} from '../../services/eval.service';
import {StateService} from '../../services/state.service';
import {ConfigFormComponent} from '../shared/config-form/config-form.component';
import {ColumnDef, CsvTableComponent} from '../shared/csv-table/csv-table.component';
import {ExcludedRow, FileUploadComponent, UploadedQueryset} from '../shared/file-upload/file-upload.component';
import {ProgressBarComponent} from '../shared/progress-bar/progress-bar.component';
import {TracePanelComponent} from '../shared/trace-panel/trace-panel.component';

/**
 * Shortest gap between two publications of the growing result set, in
 * milliseconds.
 *
 * Publishing goes through `StateService.setResults`, which deep-clones the
 * whole array — traces included. Doing that once per completed row is O(n^2)
 * over the run and freezes the browser on a large queryset, so publications
 * are coalesced. The final publication is always forced, so the table and the
 * export never miss a row.
 */
const RESULTS_PUBLISH_INTERVAL_MS = 400;

/** Accounting for one run: every uploaded row ends up in exactly one bucket. */
export interface RunSummary {
  /** Rows in the uploaded file, runnable or not. */
  uploaded: number;
  /** Runnable rows that were attempted. */
  ran: number;
  /** Attempted rows that produced an answer. */
  succeeded: number;
  /** Attempted rows that came back as an error or a skip. */
  failed: number;
  /** Runnable rows never attempted, because the run was stopped. */
  notRun: number;
  /** Rows set aside at upload, e.g. for a blank query. */
  excluded: number;
}

/** One uploaded row together with its position in the file. */
interface IndexedRow {
  row: CSVRow;
  /** 0-based index into the uploaded rows, and into the result slots. */
  index: number;
}

/** The columns shown before the scores, whichever scorers ran. */
const BASE_COLUMNS: readonly ColumnDef[] = [
  {header: 'Query', key: 'query', truncate: true},
  {header: 'Golden', key: 'golden', truncate: true},
  {header: 'Fetched', key: 'fetched', type: 'markdown', truncate: true},
  {header: 'Sources', key: 'citedSources', truncate: true},
  {header: 'Connectors', key: 'citedConnectors', truncate: true},
  {header: 'Conversation', key: 'conversationId', truncate: true},
  {header: 'Turn', key: 'turn', type: 'number'},
  {header: 'TTFT (s)', key: 'ttft', type: 'number'},
  {header: 'TTFA (s)', key: 'ttfa', type: 'number'},
  {header: 'TTLT (s)', key: 'ttlt', type: 'number'},
  {header: 'TPOT (ms/token)', key: 'tpot', type: 'number'},
];

/** The column shown when a single scorer ran. */
const SINGLE_SCORE_COLUMN: ColumnDef = {
  header: 'Score',
  key: 'score',
  type: 'score'
};

/** Column key holding a given scorer's score on a displayed row. */
function scoreKey(scorerId: string): string {
  return `score_${scorerId}`;
}

/** Column key holding a given scorer's error on a displayed row. */
function scoreErrorKey(scorerId: string): string {
  return `scoreError_${scorerId}`;
}

/**
 * Container component for the Run Evaluation tab, managing steps and evaluation
 * process.
 */
@Component({
  selector: 'app-run-evaluation',
  standalone: true,
  imports: [
    CommonModule, ConfigFormComponent, FileUploadComponent, CsvTableComponent,
    ProgressBarComponent, TracePanelComponent, FormsModule
  ],
  templateUrl: './run-evaluation.component.html'
})
export class RunEvaluationComponent implements OnInit, OnDestroy {
  step = 1;
  isProcessing = false;
  progress = 0;
  results: ResultRow[] = [];
  uploadedFile: File|null = null;
  uploadedRows: any[] = [];
  totalRows = 0;
  completedRows = 0;
  showReRateModal = false;
  reRateInstruction = '';
  /** The row whose trace is open in the inspector, if any. */
  inspectedRow: ResultRow|null = null;
  errorMessage: string | null = null;
  /**
   * Accounting for the last run, so a tester can reconcile the results against
   * the file they uploaded. Null before the first run.
   */
  runSummary: RunSummary|null = null;
  private readonly destroy$ = new Subject<void>();
  private currentRunId = 0;
  /** When the growing result set was last published, for coalescing. */
  private lastPublishMs = 0;

  columns: ColumnDef[] = [...BASE_COLUMNS, SINGLE_SCORE_COLUMN];

  /**
   * `results` flattened for the table and the CSV export: one column per
   * scorer instead of the nested `scorerResults` array.
   */
  displayResults: Array<Record<string, unknown>> = [];

  constructor(
      private stateService: StateService, private evalService: EvalService,
      private scorerRegistry: ScorerRegistry, private csvService: CsvService,
      private cdr: ChangeDetectorRef) {}

  /**
   * Opens the trace inspector for a row of the results table.
   *
   * `displayResults` is built one-for-one from `results`, so the table's row
   * index selects the untrimmed row that still carries the trace.
   * @param index Index of the clicked row.
   */
  inspectTrace(index: number) {
    this.inspectedRow = this.results[index] ?? null;
    this.cdr.detectChanges();
  }

  /** Whether any row captured a trace worth downloading. */
  hasTraces(): boolean {
    return this.results.some(row => !!row.trace?.raw.length);
  }

  /**
   * Downloads the verbatim assist stream of every row as JSONL.
   *
   * Kept out of the CSV deliberately: the raw stream is what an auditor
   * replays, and folding it into a spreadsheet cell would make both artifacts
   * worse.
   */
  exportTraces() {
    const formattedDate =
        formatDate(new Date(), 'yyyy-MM-dd_HH-mm-ss', 'en-US');
    this.csvService.exportJSONL(
        this.results.map(row => ({
                           query: row.query,
                           conversationId: row.conversationId,
                           turn: row.turn,
                           assistToken: row.assistToken,
                           session: row.session,
                           turnId: row.turnId,
                           raw: row.trace?.raw ?? []
                         })),
        `eval_traces_${formattedDate}.jsonl`);
  }

  ngOnInit() {
    this.stateService.results$.pipe(takeUntil(this.destroy$)).subscribe(r => {
      this.results = r;
      this.refreshResultsView();
    });
  }

  /**
   * Rebuilds the table columns and rows from the current results. The columns
   * follow the scorers actually present in the data, so a run stays readable
   * after the configuration changes underneath it.
   */
  private refreshResultsView() {
    const scorers = this.scorersInResults();

    if (scorers.length > 1) {
      const anyError = this.results.some(
          row => row.scorerResults?.some(result => !!result.error));
      this.columns = [
        ...BASE_COLUMNS,
        ...scorers.map(
            scorer => ({
              header: scorer.displayName,
              key: scoreKey(scorer.scorerId),
              type: 'score' as const
            })),
      ];
      this.displayResults = this.results.map(row => {
        // `trace` is dropped alongside `scorerResults`: both are structured
        // objects that would serialize into an unreadable CSV cell. The trace
        // reaches the user through the inspector and the JSONL export instead.
        const {scorerResults, trace, ...rest} = row;
        const flat: Record<string, unknown> = {...rest};
        for (const scorer of scorers) {
          const result =
              scorerResults?.find(r => r.scorerId === scorer.scorerId);
          // A skipped scorer had nothing to judge, which is not the same as
          // judging the row worthless. Reporting its placeholder zero would
          // drag the column's average down and read as a failure.
          flat[scoreKey(scorer.scorerId)] =
              result && !result.skipped ? result.score : '';
          if (anyError) {
            flat[scoreErrorKey(scorer.scorerId)] = result?.error ?? '';
          }
        }
        return flat;
      });
      return;
    }

    this.columns = [...BASE_COLUMNS, SINGLE_SCORE_COLUMN];
    this.displayResults = this.results.map(row => {
      const {scorerResults, trace, ...rest} = row;
      return rest as Record<string, unknown>;
    });
  }

  /**
   * The distinct scorers present in the current results, in run order.
   * @returns The scorer id and display name of each, empty when no row has
   *     been scored by the multi-scorer pipeline.
   */
  private scorersInResults(): Array<{scorerId: string, displayName: string}> {
    const seen = new Map<string, string>();
    for (const row of this.results) {
      for (const result of row.scorerResults ?? []) {
        if (!seen.has(result.scorerId)) {
          seen.set(result.scorerId, result.displayName);
        }
      }
    }
    return [...seen].map(([scorerId, displayName]) => ({
                          scorerId,
                          displayName
                        }));
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  isConfigValid(): boolean {
    const config = this.stateService.getCurrentConfig();
    const engines = this.stateService.getEngines();
    const hasValidEngine = engines.some(e => e.name === config.selectedEngine);
    return !!(config.projectId &&
        config.selectedEngine && config.selectedModel &&
        hasValidEngine);
  }

  /** Determines if a specific step in the evaluation wizard is accessible. */
  isStepSelectable(targetStep: number): boolean {
    if (targetStep === 1) {
      return true;
    }
    if (targetStep === 2) {
      return this.isConfigValid();
    }
    if (targetStep === 3) {
      return this.results.length > 0 || this.isProcessing;
    }
    return false;
  }

  goToStep(targetStep: number) {
    if (this.isStepSelectable(targetStep)) {
      this.step = targetStep;
      this.cdr.detectChanges();
    }
  }

  /** Moves to the next step in the wizard. */
  nextStep() {
    if (this.step < 3) this.step++;
  }

  /** Moves to the previous step in the wizard. */
  prevStep() {
    if (this.step > 1) this.step--;
  }

  /**
   * Starts the evaluation process for the uploaded CSV rows.
   *
   * There is no cap on how many rows a run may contain. Every runnable row
   * gets its own slot up front and every slot is filled before the run ends:
   * with the answer, with the failure that stopped it, or with an explicit
   * `NOT_RUN` marker if the tester stopped the run first. A row can therefore
   * never disappear between the uploaded file and the results table.
   *
   * @param event The uploaded file, its runnable rows, and the rows set aside
   *     at upload.
   */
  async startEvaluation(event: UploadedQueryset|{file: File, rows: CSVRow[]}) {
    if (this.isProcessing) return;
    const rows = event.rows as CSVRow[];
    const excluded: ExcludedRow[] = ('excluded' in event && event.excluded) || [];
    const runId = ++this.currentRunId;
    this.errorMessage = null;
    this.isProcessing = true;
    this.progress = 0;
    this.totalRows = rows.length;
    this.completedRows = 0;
    this.step = 3;
    this.stateService.setResults([]);
    this.lastPublishMs = 0;
    this.runSummary = null;
    this.cdr.detectChanges();

    // One slot per uploaded row, filled in place. Slots keep the results in
    // the file's own order however the workers interleave, and a slot still
    // empty at the end is a row that demonstrably did not run.
    const slots: Array<ResultRow|undefined> = new Array(rows.length);

    if (this.totalRows === 0) {
      this.isProcessing = false;
      this.runSummary = this.summarize(slots, excluded);
      this.cdr.detectChanges();
      return;
    }

    // Rows sharing a conversation_id are turns of one multi-turn
    // conversation and must run sequentially against the same Assistant
    // session (concurrent calls against one session race on context
    // visibility). Rows without a conversation_id are independent
    // single-turn queries, each its own one-row "conversation" below, and
    // continue to run freely across the worker pool as before.
    const conversations = this.groupIntoConversations(rows);

    const tasks = conversations.map(turns => async () => {
      const isMultiTurn = turns.length > 1;
      let session: string|undefined;

      for (let i = 0; i < turns.length; i++) {
        // Checked before starting a turn, never after finishing one: a row
        // whose answer already came back is recorded even if the tester
        // pressed Stop while it was in flight. Throwing away completed work
        // would be exactly the silent skip this accounting exists to prevent.
        if (runId !== this.currentRunId || !this.isProcessing) return;
        const {row, index} = turns[i];

        let result: ResultRow;
        try {
          result = await this.evalService.processRow(row, undefined, {session});
        } catch (error) {
          // processRow is meant to turn every failure into a row, but a bug or
          // an out-of-memory in one row must not take the rest of the run down
          // with it: without this the rejection would escape Promise.all and
          // leave every remaining row unrun and unreported.
          console.error('Unhandled error evaluating row:', error);
          result = this.failedRow(
              row, error instanceof Error ? error.message : String(error));
        }
        session = result.session;
        // A newer run now owns the results; writing into it would corrupt it.
        if (runId !== this.currentRunId) return;

        if (result.scoreError && !this.errorMessage) {
          this.errorMessage =
              `Scoring failed for some rows: ${result.scoreError}`;
        }

        slots[index] = {
          ...result,
          conversationId: isMultiTurn ? row.conversation_id : undefined,
          turn: isMultiTurn ? (Number(row.turn) || i + 1) : undefined,
        };
        this.completedRows++;
        this.progress =
            Math.round((this.completedRows / this.totalRows) * 100);
        this.publish(slots, false);
      }
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

    // Any slot still empty belongs to a row the run never reached. It is
    // written out as an explicit NOT_RUN row rather than left as a gap, so the
    // table and the CSV export both account for the whole uploaded file.
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i]) {
        slots[i] = this.failedRow(
            rows[i], 'Not run: the evaluation was stopped before this row.',
            'NOT_RUN');
      }
    }

    if (this.isProcessing) {
      this.progress = 100;
    }
    this.isProcessing = false;
    this.runSummary = this.summarize(slots, excluded);
    this.publish(slots, true);
  }

  /**
   * Publishes the results gathered so far.
   *
   * Publication deep-clones the whole result set, so intermediate updates are
   * coalesced to keep a long run from spending all its time cloning. The final
   * publication is forced and therefore always complete.
   *
   * @param slots The per-row slots, some possibly still empty.
   * @param force Whether to publish regardless of how recently it last
   *     happened.
   */
  private publish(slots: Array<ResultRow|undefined>, force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastPublishMs < RESULTS_PUBLISH_INTERVAL_MS) {
      return;
    }
    this.lastPublishMs = now;
    this.stateService.setResults(
        slots.filter((row): row is ResultRow => !!row));
    this.cdr.detectChanges();
  }

  /**
   * Builds the placeholder row recorded for a query that produced no answer.
   * @param row The uploaded row.
   * @param message What went wrong, shown in the Fetched column.
   * @param errorCode Structured code for the failure.
   */
  private failedRow(row: CSVRow, message: string, errorCode = 'ERROR'):
      ResultRow {
    return {
      query: row?.query ?? '',
      golden: row?.golden ?? '',
      fetched: message,
      errorCode,
      thoughts: '',
      expectedSources: row?.['expected_sources'] ?? '',
      ttft: 0,
      ttfa: 0,
      ttlt: 0,
      tpot: 0,
      score: 0,
    };
  }

  /**
   * Reconciles the finished run against the uploaded file.
   * @param slots The per-row slots, all filled by the time this is called.
   * @param excluded Rows set aside at upload.
   */
  private summarize(
      slots: Array<ResultRow|undefined>,
      excluded: ExcludedRow[]): RunSummary {
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
      uploaded: slots.length + excluded.length,
      ran: succeeded + failed,
      succeeded,
      failed,
      notRun,
      excluded: excluded.length,
    };
  }

  /** Whether the last run left any row unanswered. */
  hasUnfinishedRows(): boolean {
    return !!this.runSummary &&
        (this.runSummary.failed > 0 || this.runSummary.notRun > 0 ||
         this.runSummary.excluded > 0);
  }

  /** Gets the scoring strategies selected in the configuration, in run order. */
  getSelectedScorers(): readonly Scorer[] {
    return this.scorerRegistry.resolveAll(
        this.stateService.getCurrentConfig().selectedScorers);
  }

  /** Names the selected scorers for the re-rate modal. */
  getSelectedScorersLabel(): string {
    return this.getSelectedScorers().map(scorer => scorer.displayName)
        .join(', ');
  }

  /**
   * Checks whether any selected scorer reads the given configuration key, so
   * that only the inputs the run needs are rendered in the re-rate modal.
   */
  usesConfigKey(key: keyof AppConfig): boolean {
    return this.getSelectedScorers().some(
        scorer => scorer.configKeys.includes(key));
  }

  /** Opens the re-rate modal and loads active instructions. */
  openReRateModal() {
    const config = this.stateService.getCurrentConfig();
    this.reRateInstruction = config.autoRaterInstruction || '';
    this.showReRateModal = true;
    this.cdr.detectChanges();
  }

  /** Re-scores the current results without re-fetching the responses. */
  async startReRate() {
    if (this.isProcessing) return;
    this.showReRateModal = false;
    this.isProcessing = true;
    this.progress = 0;
    this.totalRows = this.results.length;
    this.completedRows = 0;
    this.cdr.detectChanges();

    const config = this.stateService.getCurrentConfig();
    if (this.usesConfigKey('autoRaterInstruction')) {
      config.autoRaterInstruction = this.reRateInstruction;
      this.stateService.setConfig(config);
    }
    const scorers = this.getSelectedScorers();

    this.errorMessage = null;
    const newResults: ResultRow[] = [];

    for (let i = 0; i < this.results.length; i++) {
      if (!this.isProcessing) {
        for (let j = i; j < this.results.length; j++) {
          newResults.push(this.results[j]);
        }
        break;
      }
      const row = this.results[i];
      this.progress = Math.round((i / this.totalRows) * 100);
      this.cdr.detectChanges();

      // Every scorer runs, one after another, so an unfetched row still gets
      // an entry per scorer and the score columns stay aligned.
      // The trace and the expected sources ride along on the row precisely so
      // that re-rating, which never sees the uploaded CSV again, can still run
      // the scorers that judge citations rather than wording.
      const scorerResults: ScorerRunResult[] = row.fetched ?
          await this.evalService.scoreAll(
              {query: row.query, response: row.fetched, golden: row.golden,
               config, trace: row.trace,
               expectedSources: row.expectedSources}) :
          scorers.map(scorer => ({
                        scorerId: scorer.id,
                        displayName: scorer.displayName,
                        score: 0,
                        skipped: true
                      }));

      if (!this.isProcessing) {
        for (let j = i; j < this.results.length; j++) {
          newResults.push(this.results[j]);
        }
        break;
      }

      const summary = summarizeScorerResults(scorerResults);
      if (summary.scoreError) {
        // Stop on the first failure rather than replaying the same broken
        // credentials or quota against every remaining row.
        this.errorMessage = `Re-rating failed: ${summary.scoreError}`;
        for (let j = i; j < this.results.length; j++) {
          newResults.push(this.results[j]);
        }
        break;
      }
      newResults.push({...row, ...summary});

      this.completedRows++;
      this.cdr.detectChanges();
    }

    if (!this.errorMessage && this.isProcessing) {
      this.progress = 100;
    }
    this.stateService.setResults(newResults);
    this.isProcessing = false;
    this.cdr.detectChanges();
  }

  /** Stops the current evaluation or re-rating process mid-way. */
  stopEvaluation() {
    this.isProcessing = false;
    this.cdr.detectChanges();
  }

  /**
   * Groups rows by conversation_id, preserving each group's first-seen
   * position in the input. Rows within a group are sorted by their `turn`
   * value (ascending); rows without a `turn` keep their original relative
   * order. Rows with no conversation_id each become their own
   * single-row group, matching today's single-turn behavior.
   *
   * Each row keeps its index in the uploaded file, so that however the turns
   * are reordered or the conversations interleave, every result lands back in
   * the slot of the row it came from. A conversation may be arbitrarily long:
   * its turns simply run one after another within one task.
   */
  private groupIntoConversations(rows: CSVRow[]): IndexedRow[][] {
    const order: string[] = [];
    const groups = new Map<string, IndexedRow[]>();
    let singletonIndex = 0;

    rows.forEach((row, index) => {
      const id = row.conversation_id?.trim();
      if (!id) {
        const key = `__single_${singletonIndex++}`;
        order.push(key);
        groups.set(key, [{row, index}]);
        return;
      }
      if (!groups.has(id)) {
        order.push(id);
        groups.set(id, []);
      }
      groups.get(id)!.push({row, index});
    });

    for (const [id, groupRows] of groups) {
      if (!id.startsWith('__single_')) {
        // Stable by construction: entries with no `turn` compare equal and
        // Array.prototype.sort preserves their file order.
        groupRows.sort(
            (a, b) => (Number(a.row.turn) || 0) - (Number(b.row.turn) || 0));
      }
    }

    return order.map(id => groups.get(id)!);
  }
}
