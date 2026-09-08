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
import {parseListCell, resolveRowConfig} from './row-config.util';

describe('row-config.util', () => {
  describe('parseListCell', () => {
    it('returns undefined for empty/absent cells', () => {
      expect(parseListCell(undefined)).toBeUndefined();
      expect(parseListCell('')).toBeUndefined();
    });

    it('parses a JSON array', () => {
      expect(parseListCell('["jira","sharepoint"]')).toEqual(['jira', 'sharepoint']);
    });

    it('parses an explicit empty JSON array as off', () => {
      expect(parseListCell('[]')).toEqual([]);
    });

    it('parses a semicolon-separated list', () => {
      expect(parseListCell('jira;sharepoint')).toEqual(['jira', 'sharepoint']);
    });

    it('parses a pipe-separated list', () => {
      expect(parseListCell('jira|sharepoint')).toEqual(['jira', 'sharepoint']);
    });

    it('preserves ids containing spaces and hyphens', () => {
      expect(parseListCell('["WW-GEDEV-DEV1-Google Calendar"]'))
          .toEqual(['WW-GEDEV-DEV1-Google Calendar']);
    });

    it('falls back to separator splitting on malformed JSON', () => {
      expect(parseListCell('[jira;sharepoint')).toEqual(['[jira', 'sharepoint']);
    });

    it('trims and drops empty entries', () => {
      expect(parseListCell(' jira ; ; sharepoint ')).toEqual(['jira', 'sharepoint']);
    });
  });

  describe('resolveRowConfig', () => {
    const config: AppConfig = {
      projectId: 'project',
      region: 'global',
      selectedEngine: 'engine',
      selectedModel: 'model',
      autoRaterModel: 'gemini-3.5-flash',
      autoRaterInstruction: 'instructions',
      selectedDataStores: ['global-ds'],
      enableWebSearch: true
    };

    const rowOf = (extra: Record<string, string>): CSVRow =>
        ({query: 'q', golden: 'g', ...extra});

    it('inherits global config when no data_stores column is present', () => {
      const eff = resolveRowConfig(rowOf({}), config);
      expect(eff.dataStores).toEqual(['global-ds']);
      expect(eff.enableWebSearch).toBe(true);
      expect(eff.dataStoresLabel).toBe('global-ds, Web Search');
    });

    it('binds only the listed data stores, web search off', () => {
      const eff = resolveRowConfig(rowOf({data_stores: '["jira"]'}), config);
      expect(eff.dataStores).toEqual(['jira']);
      expect(eff.enableWebSearch).toBe(false);
      expect(eff.dataStoresLabel).toBe('jira');
    });

    it('enables web search via the reserved token', () => {
      const eff = resolveRowConfig(rowOf({data_stores: '["web_search"]'}), config);
      expect(eff.dataStores).toEqual([]);
      expect(eff.enableWebSearch).toBe(true);
      expect(eff.dataStoresLabel).toBe('Web Search');
    });

    it('binds data stores and web search together from one list', () => {
      const eff = resolveRowConfig(
          rowOf({data_stores: 'jira;web_search'}), config);
      expect(eff.dataStores).toEqual(['jira']);
      expect(eff.enableWebSearch).toBe(true);
      expect(eff.dataStoresLabel).toBe('jira, Web Search');
    });

    it('matches the web_search token case-insensitively', () => {
      const eff = resolveRowConfig(rowOf({data_stores: 'Web_Search'}), config);
      expect(eff.dataStores).toEqual([]);
      expect(eff.enableWebSearch).toBe(true);
    });

    it('treats an explicit [] as every connector off', () => {
      const eff = resolveRowConfig(rowOf({data_stores: '[]'}), config);
      expect(eff.dataStores).toEqual([]);
      expect(eff.enableWebSearch).toBe(false);
      expect(eff.dataStoresLabel).toBe('(none)');
    });

    it('handles a missing global selectedDataStores gracefully', () => {
      const bareConfig = {...config, selectedDataStores: undefined as any};
      const eff = resolveRowConfig(rowOf({}), bareConfig);
      expect(eff.dataStores).toEqual([]);
    });
  });
});
