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

import {AppConfig} from '../models/app-config.model';
import {CSVRow} from '../models/csv-row.model';

/**
 * The effective per-row connector configuration, resolved by layering optional
 * CSV override columns over the global run configuration.
 */
export interface ResolvedRowConfig {
  /** Data store IDs bound for this row (empty = no data stores). */
  dataStores: string[];
  /** Whether web-search grounding is enabled for this row. */
  enableWebSearch: boolean;
  /** Human-readable summary of the effective grounding for display/export. */
  dataStoresLabel: string;
}

/**
 * Reserved entry within the `data_stores` list that enables web-search
 * grounding. Any other entry is treated as a data store id. Matched
 * case-insensitively.
 */
export const WEB_SEARCH_TOKEN = 'web_search';

/**
 * Parses a list CSV cell. Accepts a JSON array (e.g. `["jira","sharepoint"]`)
 * or a `;`/`|`-separated list (comma is avoided to sidestep CSV field
 * separators). Malformed JSON falls back to separator splitting.
 * @param value The raw cell value.
 * @returns The parsed list, an empty array for an explicit empty list (`[]`),
 *     or `undefined` when the cell is empty/absent (inherit the global value).
 */
export function parseListCell(value: string|undefined): string[]|undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value.trim();
  if (raw === '') return undefined;

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item).trim()).filter(item => item !== '');
      }
    } catch (e) {
      // Fall through to separator-based parsing on malformed JSON.
    }
  }

  return raw.split(/[;|]/).map(item => item.trim()).filter(item => item !== '');
}

/**
 * Builds a human-readable label describing the effective grounding for a row.
 * @param dataStores The effective data store IDs.
 * @param enableWebSearch The effective web-search state.
 * @returns e.g. `"jira, sharepoint, Web Search"`, `"Web Search"`, or `"(none)"`.
 */
function buildLabel(dataStores: string[], enableWebSearch: boolean): string {
  const parts = [...dataStores];
  if (enableWebSearch) parts.push('Web Search');
  return parts.length > 0 ? parts.join(', ') : '(none)';
}

/**
 * Resolves the effective connector configuration for a single row from its
 * optional `data_stores` override column, falling back to the global run
 * configuration.
 *
 * The `data_stores` cell holds a single list that fully specifies this row's
 * grounding: the reserved `web_search` token enables web-search grounding and
 * every other entry is a data store id. A present cell overrides both
 * dimensions at once — an explicit `[]` means no connectors, and omitting
 * `web_search` from a non-empty list turns web search off. An empty/absent
 * cell inherits the global data stores and web-search state, so on-vs-off
 * pairing lives in the cell being present or not.
 * @param row The CSV row (may carry the override column via its index
 *     signature).
 * @param config The global application configuration.
 * @returns The resolved per-row configuration.
 */
export function resolveRowConfig(
    row: CSVRow, config: AppConfig): ResolvedRowConfig {
  const overrideList = parseListCell(row['data_stores']);

  let dataStores: string[];
  let enableWebSearch: boolean;
  if (overrideList !== undefined) {
    enableWebSearch = overrideList.some(
        entry => entry.toLowerCase() === WEB_SEARCH_TOKEN);
    dataStores = overrideList.filter(
        entry => entry.toLowerCase() !== WEB_SEARCH_TOKEN);
  } else {
    dataStores = config.selectedDataStores || [];
    enableWebSearch = config.enableWebSearch;
  }

  return {
    dataStores,
    enableWebSearch,
    dataStoresLabel: buildLabel(dataStores, enableWebSearch),
  };
}
