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
   * How long to pause between the seed phase and the rest of a memory run, in
   * milliseconds. Gemini Enterprise saves a memory asynchronously after the
   * turn that produced it, so a recall query issued immediately can miss it.
   * Unset falls back to DEFAULT_MEMORY_SETTLE_MS. See models/memory.model.ts.
   */
  memorySettleMs?: number;
  // Restored for no-auth mode
  gCloudToken?: string;
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

/**
 * Whether an engine feature is turned on, as reported by the API. An absent
 * key and `FEATURE_STATE_UNSPECIFIED` both mean "not stated", which is not the
 * same as off.
 */
export type FeatureState =
    'FEATURE_STATE_UNSPECIFIED'|'FEATURE_STATE_ON'|'FEATURE_STATE_OFF';

/**
 * The read-only view of the engine's settings that the widget config exposes.
 * Its `features` map mirrors `Engine.features`, which is how the studio learns
 * whether an engine has features like saved memories enabled without needing
 * permission to read the engine resource itself.
 */
export interface WidgetConfigUiSettings {
  features?: {[key: string]: FeatureState};
}

export interface WidgetConfigResponse {
  collectionComponents?: CollectionComponent[];
  uiSettings?: WidgetConfigUiSettings;
}

