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

import {Injectable} from '@angular/core';
import {BehaviorSubject, Subject} from 'rxjs';
import {debounceTime, map} from 'rxjs/operators';

import {AppConfig, Engine} from '../models/app-config.model';
import {MemorySupport} from '../models/memory.model';
import {ResultRow} from '../models/result-row.model';

/**
 * Service for managing application state.
 */
@Injectable({providedIn: 'root'})
export class StateService {
  private currentTabSubject = new BehaviorSubject<string>('queries');
  /** Observable of the current active tab. */
  currentTab$ = this.currentTabSubject.asObservable();

  private readonly STORAGE_KEY = 'ge_eval_studio_config';
  private storageWrite$ = new Subject<any>();

  constructor() {
    // Debounce localStorage writes to prevent I/O blocking during rapid user
    // input
    this.storageWrite$.pipe(debounceTime(300)).subscribe(localConfig => {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(this.STORAGE_KEY, JSON.stringify(localConfig));
        } catch (e) {
          console.warn('localStorage write failed:', e);
        }
      }
    });


  }

  private loadInitialConfig(): AppConfig {
    const defaultConfig: AppConfig = {
      projectId: '',
      region: 'global',
      selectedEngine: '',
      selectedModel: '',
      selectedAgent: '',
      autoRaterModel: '',
      autoRaterInstruction:
          'You are an expert evaluator. Compare the fetched response to the golden response for the given query. Calculate a semantic similarity score between 0.0 and 1.0...',
      selectedDataStores: [],
      enableWebSearch: false
    };

    let savedConfig: Partial<AppConfig> = {};

    if (typeof localStorage !== 'undefined') {
      try {
        const localData = localStorage.getItem(this.STORAGE_KEY);
        if (localData) {
          savedConfig = JSON.parse(localData) as Partial<AppConfig>;
        }
      } catch (e) {
        console.warn(
            'localStorage is available but could not be read (maybe blocked by sandbox/policy):',
            e);
      }
    }

    const {gCloudToken, selectedEngine, selectedModel, selectedAgent,
           ...safeConfig} = savedConfig;

    return {
      ...defaultConfig,
      ...safeConfig,
      gCloudToken: '',
      selectedEngine: '',
      selectedModel: '',
      selectedAgent: '',
    };
  }

  private configSubject =
      new BehaviorSubject<AppConfig>(this.loadInitialConfig());
  /** Observable of the application configuration. */
  config$ =
      this.configSubject.asObservable().pipe(map(c => structuredClone(c)));

  private resultsSubject = new BehaviorSubject<ResultRow[]>([]);
  /**
   * Observable of the evaluation results.
   *
   * The array is copied so a subscriber cannot splice rows into the stored
   * run, but the rows themselves are shared rather than deep-cloned: a run
   * emits once per finished row, so deep-copying every row collected so far
   * on each emission made a long queryset quadratic -- a thousand-row file
   * spent minutes cloning instead of evaluating. Rows are written once and
   * replaced wholesale when re-rated, never mutated in place, so sharing them
   * is safe.
   */
  results$ = this.resultsSubject.asObservable().pipe(map(r => [...r]));

  private enginesSubject = new BehaviorSubject<Engine[]>([]);
  /** Observable of the fetched engines. */
  engines$ =
      this.enginesSubject.asObservable().pipe(map(e => structuredClone(e)));

  private errorMessageSubject = new BehaviorSubject<string>('');
  /** Observable of the error message. */
  errorMessage$ = this.errorMessageSubject.asObservable();

  private memorySupportSubject = new BehaviorSubject<MemorySupport>('unknown');
  /**
   * Observable of the selected engine's saved-memory feature state.
   *
   * Detected per engine rather than chosen by the user, so it lives here beside
   * the fetched engines instead of in AppConfig, which is persisted: a stale
   * value restored from localStorage could block or wave through the wrong run.
   */
  memorySupport$ = this.memorySupportSubject.asObservable();

  /** Sets the current active tab. */
  setTab(tab: string) {
    this.currentTabSubject.next(tab);
  }

  /** Sets the application configuration. */
  setConfig(config: AppConfig) {
    const clonedConfig = structuredClone(config);
    this.configSubject.next(clonedConfig);

    // The engine-scoped choices are deliberately not persisted: restoring an
    // agent that belongs to an engine the user has not re-selected would point
    // the next run at something they never chose.
    const {gCloudToken, selectedEngine, selectedModel, selectedAgent,
           ...localConfig} = clonedConfig;

    this.storageWrite$.next(localConfig);
  }

  /** Gets the current application configuration. */
  getCurrentConfig(): AppConfig {
    return structuredClone(this.configSubject.value);
  }

  /** Sets the evaluation results. */
  setResults(results: ResultRow[]) {
    this.resultsSubject.next(structuredClone(results));
  }

  /**
   * Appends one finished row to the evaluation results.
   *
   * A run calls this every time a row lands, so only the new row is cloned:
   * handing the whole accumulated array back through `setResults` copied every
   * earlier row again, which is what kept large querysets from finishing.
   * @param result The row to append.
   */
  appendResult(result: ResultRow) {
    this.resultsSubject.next(
        [...this.resultsSubject.value, structuredClone(result)]);
  }

  setErrorMessage(errorMessage: string) {
    this.errorMessageSubject.next(errorMessage);
  }

  /** Sets the fetched engines. */
  setEngines(engines: Engine[]) {
    this.enginesSubject.next(structuredClone(engines));
  }

  /** Gets the currently fetched engines. */
  getEngines(): Engine[] {
    return structuredClone(this.enginesSubject.value);
  }

  /** Records the selected engine's saved-memory feature state. */
  setMemorySupport(memorySupport: MemorySupport) {
    this.memorySupportSubject.next(memorySupport);
  }

  /** Gets the selected engine's saved-memory feature state. */
  getMemorySupport(): MemorySupport {
    return this.memorySupportSubject.value;
  }
}

