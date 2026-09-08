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
import {MEMORY_SETTLE_MS, MemorySupport, isSeedConversation, memoryPhaseOf, orderedPhaseOf, validateMemoryRows} from '../../models/memory.model';
import {ResultRow} from '../../models/result-row.model';
import {Scorer, ScorerRunResult, summarizeScorerResults} from '../../scoring/scorer';
import {ScorerRegistry} from '../../scoring/scorer.registry';
import {CsvService} from '../../services/csv.service';
import {DEFAULT_MAX_TTLT_SECONDS, EvalService} from '../../services/eval.service';
import {StateService} from '../../services/state.service';
import {ConfigFormComponent} from '../shared/config-form/config-form.component';
import {ColumnDef, CsvTableComponent} from '../shared/csv-table/csv-table.component';
import {FileUploadComponent} from '../shared/file-upload/file-upload.component';
import {ProgressBarComponent} from '../shared/progress-bar/progress-bar.component';
import {TracePanelComponent} from '../shared/trace-panel/trace-panel.component';

const MAX_CONCURRENT_REQUESTS_FOR_EVALUATION = 5;

/** The columns shown before the scores, whichever scorers ran. */
const BASE_COLUMNS: readonly ColumnDef[] = [
  {
    header: 'Query',
    key: 'query',
    truncate: true,
    warnKey: 'latencyExceededBy',
    warnTooltip:
        `Latency exceeded the ${DEFAULT_MAX_TTLT_SECONDS}s budget by {value}s`,
  },
  {header: 'Golden', key: 'golden', truncate: true},
  {header: 'Fetched', key: 'fetched', type: 'markdown', truncate: true},
  {header: 'Sources', key: 'citedSources', truncate: true},
  {header: 'Connectors', key: 'citedConnectors', truncate: true},
  {header: 'Requested Connectors', key: 'dataStoresUsed', truncate: true},
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
  private readonly destroy$ = new Subject<void>();
  private currentRunId = 0;

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
    const resetConversations =
        conversations.filter(turns => orderedPhaseOf(turns) === 'reset');
    const seedConversations = conversations.filter(isSeedConversation);
    const mainConversations =
        conversations.filter(turns => !orderedPhaseOf(turns));

    if ((resetConversations.length > 0 || seedConversations.length > 0) &&
        !this.canChangeMemories()) {
      return;
    }

    const runId = ++this.currentRunId;
    const memorySupport = this.memorySupport;
    this.errorMessage = null;
    this.isProcessing = true;
    this.progress = 0;
    this.totalRows = event.rows.length;
    this.completedRows = 0;
    // A run stopped mid-pause leaves this set until its timer fires.
    this.isSettlingMemories = false;
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

    // Reset rows run first and seed rows next, one at a time, and each phase
    // finishes before the next row starts. Saved memories are account-wide
    // state rather than per-session context, so clearing or seeding
    // concurrently with the rows that read them would make each run depend on
    // which request happened to land first.
    //
    // An empty phase is skipped rather than awaited on an empty list, so that
    // an ordinary file still dispatches its first requests synchronously
    // within this call as it did before phases existed.
    const orderedPhases = [resetConversations, seedConversations];
    for (let i = 0; i < orderedPhases.length; i++) {
      if (orderedPhases[i].length === 0) continue;
      if (runId !== this.currentRunId || !this.isProcessing) break;

      await this.runPool(orderedPhases[i].map(runConversation), 1);

      // Both a deletion and a save land asynchronously, so whatever runs next
      // has to wait for this phase's writes rather than race them.
      const remaining =
          [...orderedPhases.slice(i + 1), mainConversations].flat();
      if (remaining.length > 0 && runId === this.currentRunId &&
          this.isProcessing) {
        await this.settleMemories(runId);
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
      this.isProcessing = false;
      this.cdr.detectChanges();
    }
  }

  /**
   * Whether a run that clears or seeds saved memories may start.
   *
   * The run neither asks first nor reports afterwards. Reset and seed rows
   * change state that outlives the run on the authenticated account — a reset
   * row asks the assistant to delete what is already there, including memories
   * this tool never created — so a file carrying them is a file to read before
   * uploading. The `Phase` column of the results is the record of what ran.
   *
   * The one refusal left is not a question but a fact about the engine.
   * @returns True to start now, false when the engine cannot do this at all.
   */
  private canChangeMemories(): boolean {
    if (this.memorySupport === 'off') {
      this.errorMessage =
          'This engine reports saved memories (personalization-memory) as ' +
          'disabled. Seed rows would save nothing and recall rows would be ' +
          'scored against an empty memory, so the run is refused. Enable the ' +
          'feature on the engine, or remove the phase column from the file.';
      this.cdr.detectChanges();
      return false;
    }

    return true;
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
   * Pauses between a sequential phase and whatever runs after it.
   *
   * A memory is written asynchronously, after the turn that produced it has
   * finished streaming, and a deletion lands the same way. A query sent the
   * instant the phase returns can therefore miss a memory that was in fact
   * saved, or read one that was in fact deleted, which would show up as a
   * product failure rather than as a race in the harness.
   * @param runId The run being paused, so a stopped run's timer can tell that
   *     it no longer owns the progress label by the time it fires.
   */
  private settleMemories(runId: number): Promise<void> {
    this.isSettlingMemories = true;
    this.cdr.detectChanges();
    return new Promise<void>(resolve => {
      setTimeout(() => {
        // The timer of a stopped run outlives it, so it must not clear the
        // label of whichever run is settling by then.
        if (runId === this.currentRunId) {
          this.isSettlingMemories = false;
          this.cdr.detectChanges();
        }
        resolve();
      }, MEMORY_SETTLE_MS);
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
