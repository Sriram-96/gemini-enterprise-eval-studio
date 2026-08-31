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
 * Naming a connector from whatever the API gives us.
 *
 * Shared by the configuration form, which labels the connectors a user can
 * select, and by the trace extractor, which labels the connectors an answer
 * actually cited. Both go through here so a data store is named the same way
 * whether it is being chosen or being reported on.
 */

/** How one connector is recognized and displayed. */
interface ConnectorRule {
  readonly key: string;
  readonly displayName: string;
  readonly dataSource: string;
  /** Lowercase fragments that identify this connector in an id or name. */
  readonly matchers: readonly string[];
}

/** Normalized connector metadata inferred from a component or an id. */
export interface ConnectorMetadata {
  key: string;
  displayName: string;
  dataSource?: string;
}

/** The connectors recognized by name, in no particular order. */
export const CONNECTOR_RULES: readonly ConnectorRule[] = [
  {
    key: 'NOTION',
    displayName: 'Notion',
    dataSource: 'NOTION',
    matchers: ['notion']
  },
  {key: 'JIRA', displayName: 'Jira', dataSource: 'JIRA', matchers: ['jira']},
  {
    key: 'CONFLUENCE',
    displayName: 'Confluence',
    dataSource: 'CONFLUENCE',
    matchers: ['confluence']
  },
  {
    key: 'SALESFORCE',
    displayName: 'Salesforce',
    dataSource: 'SALESFORCE',
    matchers: ['salesforce']
  },
  {
    key: 'SHAREPOINT',
    displayName: 'SharePoint',
    dataSource: 'SHAREPOINT',
    matchers: ['sharepoint']
  },
  {
    key: 'SERVICENOW',
    displayName: 'ServiceNow',
    dataSource: 'SERVICENOW',
    matchers: ['servicenow', 'service-now', 'service now']
  },
  {
    key: 'BIG_QUERY',
    displayName: 'BigQuery',
    dataSource: 'BIG_QUERY',
    matchers: ['bigquery', 'bq-']
  },
  {
    key: 'GCS',
    displayName: 'Cloud Storage',
    dataSource: 'GCS',
    matchers: ['gcs', 'cloud-storage', 'cloud storage']
  },
];

/** Display name for each known `dataSource` value. */
export const DATA_SOURCE_DISPLAY_NAMES: Record<string, string> =
    Object.fromEntries(CONNECTOR_RULES.map(r => [r.dataSource, r.displayName]));

/**
 * Infers normalized connector metadata (key, display name, and data source)
 * from a component or ID string.
 * @param componentOrId A collection component, or a bare data store id.
 * @returns The connector's key and display name, plus its data source when one
 *     could be determined.
 */
export function inferConnectorMetadata(
    componentOrId: {id?: string, displayName?: string, dataSource?: string}|
    string): ConnectorMetadata {
  if (typeof componentOrId === 'object') {
    if (componentOrId.dataSource) {
      let name = componentOrId.displayName || componentOrId.dataSource;
      if (!componentOrId.displayName ||
          componentOrId.displayName === componentOrId.dataSource) {
        name = DATA_SOURCE_DISPLAY_NAMES[componentOrId.dataSource] || name;
      }
      return {
        key: componentOrId.dataSource,
        displayName: name,
        dataSource: componentOrId.dataSource
      };
    }
    const lowerId = (componentOrId.id || '').toLowerCase();
    const lowerName = (componentOrId.displayName || '').toLowerCase();
    const matchedRule = CONNECTOR_RULES.find(
        rule =>
            rule.matchers.some(m => lowerId.includes(m) || lowerName.includes(m)));
    if (matchedRule) {
      return {
        key: matchedRule.key,
        displayName: matchedRule.displayName,
        dataSource: matchedRule.dataSource
      };
    }
    return {
      key: componentOrId.id || 'unknown',
      displayName: componentOrId.displayName || componentOrId.id || 'Connector'
    };
  } else {
    const lower = componentOrId.toLowerCase();
    const matchedRule =
        CONNECTOR_RULES.find(rule => rule.matchers.some(m => lower.includes(m)));
    if (matchedRule) {
      return {
        key: matchedRule.key,
        displayName: matchedRule.displayName,
        dataSource: matchedRule.dataSource
      };
    }
    return {key: componentOrId, displayName: componentOrId};
  }
}

/**
 * Extracts the data store id from a Document resource name.
 *
 * Cited documents identify their origin only through this resource name, so
 * it is the one link between an answer and the connector that supplied it.
 * @param document A name of the form
 *     `projects/…/collections/…/dataStores/{id}/branches/…/documents/…`.
 * @returns The data store id, or undefined when the name has no data store
 *     segment (as with web-grounded results).
 */
export function dataStoreIdFromDocument(document?: string): string|undefined {
  if (!document) {
    return undefined;
  }
  return /\/dataStores\/([^/]+)/.exec(document)?.[1];
}
