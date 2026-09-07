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

import {AppConfig} from '../../models/app-config.model';
import {CSVRow} from '../../models/csv-row.model';
import {DEFAULT_MEMORY_SETTLE_MS, MemorySupport, isSeedConversation, memoryPhaseOf, validateMemoryRows} from '../../models/memory.model';
import {ResultRow} from '../../models/result-row.model';
import {Scorer, ScorerRunResult, summarizeScorerResults} from '../../scoring/scorer';
import {ScorerRegistry} from '../../scoring/scorer.registry';
import {CsvService} from '../../services/csv.service';
import {EvalService} from '../../services/eval.service';
import {StateService} from '../../services/state.service';
import {ConfigFormComponent} from '../shared/config-form/config-form.component';
import {ColumnDef, CsvTableComponent} from '../shared/csv-table/csv-table.component';
import {FileUploadComponent} from '../shared/file-upload/file-upload.component';
import {ProgressBarComponent} from '../shared/progress-bar/progress-bar.component';
import {TracePanelComponent} from '../shared/trace-panel/trace-panel.component';

const MAX_CONCURRENT_REQUESTS_FOR_EVALUATION = 5;

/** The columns shown before the scores, whichever scorers ran. */
const BASE_COLUMNS: readonly ColumnDef[] = [
  {header: 'Query', key: 'query', truncate: true},
  {header: 'Golden', key: 'golden', truncate: true},
  {header: 'Fetched', key: 'fetched', type: 'markdown', truncate: true},
  {header: 'Sources', key: 'citedSources', truncate: true},
  {header: 'Connectors', key: 'citedConnectors', truncate: true},
  {header: 'Conversation', key: 'conversationId', truncate: true},
  {header: 'Turn', key: 'turn', type: 'number'},
  {header: 'Phase', key: 'memoryPhase'},
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
  /** The selected engine's saved-memory feature state, as last detected. */
  memorySupport: MemorySupport = 'unknown';
  /** Whether the run is paused between the seed phase and the rest. */
  isSettlingMemories = false;
  showMemoryConsentModal = false;
  /** The seed queries awaiting confirmation, listed in the consent modal. */
  pendingSeedQueries: string[] = [];
  /**
   * The seed queries of the finished run, listed in the teardown notice.
   *
   * There is no API to delete a memory the assistant saved, so the only honest
   * thing the studio can do is tell the tester exactly what it left behind.
   */
  seededQueries: string[] = [];
  private readonly destroy$ = new Subject<void>();
  private currentRunId = 0;
  private pendingMemoryRun: {file: File, rows: CSVRow[]}|null = null;
  private memoryRunConfirmed = false;

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

    this.stateService.memorySupport$.pipe(takeUntil(this.destroy$))
        .subscribe(memorySupport => {
          this.memorySupport = memorySupport;
        });
  }

  /** Label under the progress bar, which changes during the settle pause. */
  get progressText(): string {
    return this.isSettlingMemories ?
        'Waiting for saved memories to settle...' :
        `Evaluating... (${this.completedRows} / ${this.totalRows})`;
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
   * @param event The event containing the file and parsed rows.
   */
  async startEvaluation(event: {file: File, rows: CSVRow[]}) {
    if (this.isProcessing) return;

    // Checked on every file, not just files with seed rows: a misspelt phase
    // value is precisely the case where the run would otherwise succeed while
    // silently testing something the author did not write.
    const memoryError = validateMemoryRows(event.rows);
    if (memoryError) {
      this.errorMessage = memoryError;
      this.cdr.detectChanges();
      return;
    }

    // Rows sharing a conversation_id are turns of one multi-turn
    // conversation and must run sequentially against the same Assistant
    // session (concurrent calls against one session race on context
    // visibility). Rows without a conversation_id are independent
    // single-turn queries, each its own one-row "conversation" below, and
    // continue to run freely across the worker pool as before.
    const conversations = this.groupIntoConversations(event.rows);
    const seedConversations = conversations.filter(isSeedConversation);
    const mainConversations =
        conversations.filter(turns => !isSeedConversation(turns));

    if (seedConversations.length > 0 &&
        !this.approveMemoryRun(event, seedConversations)) {
      return;
    }

    const runId = ++this.currentRunId;
    const memorySupport = this.memorySupport;
    this.errorMessage = null;
    this.isProcessing = true;
    this.progress = 0;
    this.totalRows = event.rows.length;
    this.completedRows = 0;
    this.seededQueries = [];
    this.step = 3;
    this.stateService.setResults([]);
    this.cdr.detectChanges();
    const results: ResultRow[] = [];

    if (this.totalRows === 0) return;

    const runConversation = (turns: CSVRow[]) => async () => {
      const isMultiTurn = turns.length > 1;
      let session: string|undefined;

      for (let i = 0; i < turns.length; i++) {
        if (runId !== this.currentRunId || !this.isProcessing) return;
        const row = turns[i];

        const result = await this.evalService.processRow(row, undefined, {session});
        session = result.session;
        if (runId !== this.currentRunId || !this.isProcessing) return;

        if (result.scoreError && !this.errorMessage) {
          this.errorMessage =
              `Scoring failed for some rows: ${result.scoreError}`;
        }

        const memoryPhase = memoryPhaseOf(row);
        results.push({
          ...result,
          conversationId: isMultiTurn ? row.conversation_id : undefined,
          turn: isMultiTurn ? (Number(row.turn) || i + 1) : undefined,
          memoryPhase,
          memorySupport: memoryPhase ? memorySupport : undefined,
        });
        this.stateService.setResults(results);
        this.completedRows++;
        this.progress =
            Math.round((this.completedRows / this.totalRows) * 100);
        this.cdr.detectChanges();
      }
    };

    // Seed rows run first, one at a time, and every one of them finishes
    // before any other row starts. Saved memories are account-wide state
    // rather than per-session context, so seeding concurrently with the rows
    // that read it would make each run depend on which request happened to
    // land first.
    //
    // The whole phase is skipped when nothing seeds, rather than awaited on an
    // empty list, so that an ordinary file still dispatches its first requests
    // synchronously within this call as it did before phases existed.
    if (seedConversations.length > 0) {
      await this.runPool(seedConversations.map(runConversation), 1);

      if (mainConversations.length > 0 && runId === this.currentRunId &&
          this.isProcessing) {
        await this.settleMemories();
      }
    }

    if (runId === this.currentRunId && this.isProcessing) {
      await this.runPool(
          mainConversations.map(runConversation),
          MAX_CONCURRENT_REQUESTS_FOR_EVALUATION);
    }

    if (this.isProcessing) {
      this.progress = 100;
    }
    if (runId === this.currentRunId) {
      this.seededQueries =
          results.filter(row => row.memoryPhase === 'seed')
              .map(row => row.query);
      this.isProcessing = false;
      this.cdr.detectChanges();
    }
  }

  /**
   * Decides whether a run that writes saved memories may start.
   *
   * Unlike every other run, this one changes state that outlives it on the
   * authenticated account, so it asks first. Confirmation is remembered for
   * the rest of the session: the teardown notice after each run is what keeps
   * the tester informed from then on.
   * @param event The upload being run, held for replay after confirmation.
   * @param seedConversations The conversations that will seed memories.
   * @returns True to start now, false when refused or awaiting confirmation.
   */
  private approveMemoryRun(
      event: {file: File, rows: CSVRow[]},
      seedConversations: CSVRow[][]): boolean {
    if (this.memorySupport === 'off') {
      this.errorMessage =
          'This engine reports saved memories (personalization-memory) as ' +
          'disabled. Seed rows would save nothing and recall rows would be ' +
          'scored against an empty memory, so the run is refused. Enable the ' +
          'feature on the engine, or remove the phase column from the file.';
      this.cdr.detectChanges();
      return false;
    }

    if (this.memoryRunConfirmed) {
      return true;
    }

    this.pendingMemoryRun = event;
    this.pendingSeedQueries = seedConversations.flat().map(row => row.query);
    this.showMemoryConsentModal = true;
    this.cdr.detectChanges();
    return false;
  }

  /** Accepts the seeding warning and starts the run that was held back. */
  confirmMemoryRun() {
    const event = this.pendingMemoryRun;
    this.showMemoryConsentModal = false;
    this.pendingMemoryRun = null;
    if (!event) return;
    this.memoryRunConfirmed = true;
    this.startEvaluation(event);
  }

  /** Declines the seeding warning, leaving the account untouched. */
  cancelMemoryRun() {
    this.showMemoryConsentModal = false;
    this.pendingMemoryRun = null;
    this.pendingSeedQueries = [];
    this.cdr.detectChanges();
  }

  /** Dismisses the post-run teardown notice. */
  dismissTeardownNotice() {
    this.seededQueries = [];
    this.cdr.detectChanges();
  }

  /**
   * Runs tasks with a bounded number of them in flight.
   * @param tasks The work, each item independent of the others.
   * @param concurrency How many may run at once.
   */
  private async runPool(
      tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
    let index = 0;
    const worker = async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        await tasks[currentIndex]();
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  /**
   * Pauses between the seed phase and the rest of the run.
   *
   * A memory is saved asynchronously, after the turn that produced it has
   * finished streaming. A recall query sent the instant the seed turn returns
   * can miss a memory that was in fact saved correctly, which would show up as
   * a product failure rather than as a race in the harness.
   */
  private settleMemories(): Promise<void> {
    const delay =
        this.stateService.getCurrentConfig().memorySettleMs ??
        DEFAULT_MEMORY_SETTLE_MS;
    if (delay <= 0) {
      return Promise.resolve();
    }

    this.isSettlingMemories = true;
    this.cdr.detectChanges();
    return new Promise<void>(resolve => {
      setTimeout(() => {
        this.isSettlingMemories = false;
        this.cdr.detectChanges();
        resolve();
      }, delay);
    });
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
   */
  private groupIntoConversations(rows: CSVRow[]): CSVRow[][] {
    const order: string[] = [];
    const groups = new Map<string, CSVRow[]>();
    let singletonIndex = 0;

    for (const row of rows) {
      const id = row.conversation_id?.trim();
      if (!id) {
        const key = `__single_${singletonIndex++}`;
        order.push(key);
        groups.set(key, [row]);
        continue;
      }
      if (!groups.has(id)) {
        order.push(id);
        groups.set(id, []);
      }
      groups.get(id)!.push(row);
    }

    for (const [id, groupRows] of groups) {
      if (!id.startsWith('__single_')) {
        groupRows.sort((a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0));
      }
    }

    return order.map(id => groups.get(id)!);
  }
}
