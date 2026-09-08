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

/**
 * Configuration for the evaluation application.
 */
export interface AppConfig {
  projectId: string;
  region: string;
  selectedEngine: string;
  selectedModel: string;
  /**
   * Identifiers of the scoring strategies to run against every row, in the
   * order they are applied. Falls back to the first registered scorer when
   * empty or unset. See scoring/scorer.registry.ts.
   */
  selectedScorers?: string[];
  autoRaterModel: string;
  autoRaterInstruction: string;
  selectedDataStores: string[];
  enableWebSearch: boolean;
  /**
   * How many rows (or independent conversations) are sent to the Assistant at
   * once. Raising it shortens a large run; lowering it keeps a run under a
   * tight quota. Clamped to [MIN_CONCURRENT_REQUESTS,
   * MAX_CONCURRENT_REQUESTS]; unset means DEFAULT_CONCURRENT_REQUESTS.
   */
  maxConcurrentRequests?: number;
  // Restored for no-auth mode
  gCloudToken?: string;
}

/** Fewest rows that may be in flight at once. */
export const MIN_CONCURRENT_REQUESTS = 1;

/**
 * Most rows that may be in flight at once. The ceiling is a guard against a
 * tester accidentally aiming a thousand simultaneous requests at their own
 * quota, not a limit on how many rows a run may contain.
 */
export const MAX_CONCURRENT_REQUESTS = 50;

/** Rows in flight at once when the configuration does not say. */
export const DEFAULT_CONCURRENT_REQUESTS = 5;

/**
 * Resolves the configured concurrency into a usable worker count.
 * @param config The active configuration.
 * @returns The configured value clamped to the supported range, or the default
 *     when it is unset or not a number.
 */
export function resolveConcurrency(config: Pick<AppConfig, 'maxConcurrentRequests'>):
    number {
  const configured = Number(config.maxConcurrentRequests);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CONCURRENT_REQUESTS;
  }
  return Math.min(
      MAX_CONCURRENT_REQUESTS,
      Math.max(MIN_CONCURRENT_REQUESTS, Math.floor(configured)));
}

/**
 * Represents an evaluation engine.
 */
export interface Engine {
  name: string;
  displayName: string;
  modelConfigs?: {[key: string]: string};
  dataStoreIds?: string[];
}

export interface DataStoreComponent {
  id?: string;
  displayName?: string;
}

export interface CollectionComponent {
  id?: string;
  displayName?: string;
  dataSource?: string;
  connectorAuthState?: any;
  federatedSearchConnectorAuthUri?: string;
  dataStoreComponents?: DataStoreComponent[];
}

export interface WidgetConfigResponse {
  collectionComponents?: CollectionComponent[];
}

