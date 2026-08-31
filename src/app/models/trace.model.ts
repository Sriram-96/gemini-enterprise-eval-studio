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
 * The evidence trail behind one assisted answer: which documents the agent
 * cited, which connectors they came from, and which tools it ran on the way.
 *
 * Everything here is read out of the `streamAssist` response, whose shape is
 * defined by `AssistAnswer` in
 * google/cloud/discoveryengine/v1/assist_answer.proto. Each reply is an
 * `AssistantGroundedContent` with two independent halves: `content` (the text,
 * thoughts and code the model produced) and `textGroundingMetadata` (the
 * documents backing that text). A reply may carry either, or both.
 */

/** A document the agent cited, with the connector it came from. */
export interface CitedSource {
  /**
   * Document resource name, of the form
   * `projects/…/dataStores/{dataStore}/branches/…/documents/{document}`.
   */
  document?: string;
  /** URI for the document; may redirect to the real site. */
  uri?: string;
  title?: string;
  /** Page within the document, for paginated sources such as PDFs. */
  pageIdentifier?: string;
  /** Domain of the site `uri` ultimately resolves to. */
  domain?: string;
  /** Data store id parsed out of `document`. */
  dataStoreId?: string;
  /** Connector display name inferred from `dataStoreId`, e.g. `Confluence`. */
  connector?: string;
  /**
   * Highest grounding score of any answer segment citing this source. Absent
   * when no segment referenced it, which happens when the API returns
   * references without segment-level attribution.
   */
  groundingScore?: number;
  /** The excerpt of the document the answer was grounded in. */
  snippet?: string;
}

/** A tool the agent invoked, or the result of one. */
export interface ToolCall {
  kind: 'executableCode'|'codeExecutionResult';
  /** The generated code, for `executableCode`. Currently always Python. */
  code?: string;
  /** `OUTCOME_OK`, `OUTCOME_FAILED`, … for `codeExecutionResult`. */
  outcome?: string;
  /** stdout on success, stderr or a description otherwise. */
  output?: string;
}

/** A span of the answer, tied to the sources backing it. */
export interface GroundedSegment {
  /** The answer text this segment covers. */
  text: string;
  /**
   * Keys into `AssistTrace.sources` of the documents backing this span.
   *
   * Resolved at parse time rather than stored as the raw `referenceIndices`,
   * because those index the *containing reply's* `references` array. A stream
   * carries many replies, each with its own array, so index `0` means a
   * different document in each one.
   */
  sourceKeys: string[];
  /** The API's confidence that this span is supported by its sources. */
  groundingScore?: number;
}

/** The full request/tool-call journey behind one answer. */
export interface AssistTrace {
  /** Every distinct document cited, in first-seen order. */
  sources: CitedSource[];
  /** Per-span attribution, in the order the stream produced it. */
  segments: GroundedSegment[];
  /** Tool invocations and their results, in call order. */
  toolCalls: ToolCall[];
  /**
   * The verbatim `StreamAssistResponse` items, in arrival order. Exported as
   * JSONL rather than CSV so an auditor can replay the exact stream, including
   * any field this model does not yet extract.
   */
  raw: unknown[];
}

/**
 * Identifies a source across replies, so the same document cited by several
 * replies is recorded once.
 *
 * Prefers the document resource name, which is stable and unique; falls back
 * to the uri and then the title for web-grounded results, which carry no
 * resource name, and finally to the excerpt itself so a reference that
 * identifies nothing is still recorded rather than silently dropped.
 * @param source The cited source to key.
 * @returns The key, or the empty string when the source is wholly anonymous.
 */
export function sourceKey(source: CitedSource): string {
  return source.document || source.uri || source.title || source.snippet || '';
}

/** The flat, spreadsheet-friendly view of a trace carried on a result row. */
export interface TraceSummary {
  citedSources: string;
  citedDataStores: string;
  citedConnectors: string;
  toolCalls: string;
  maxGroundingScore: number;
}

/** Renders one cited source as a single line of the `citedSources` column. */
function describeSource(source: CitedSource): string {
  const label = source.title || source.uri || source.document || '(untitled)';
  const parts = [label];
  if (source.uri && source.uri !== label) {
    parts.push(source.uri);
  }
  if (source.pageIdentifier) {
    parts.push(`p. ${source.pageIdentifier}`);
  }
  return parts.join(' — ');
}

/** Renders one tool call as a single line of the `toolCalls` column. */
function describeToolCall(call: ToolCall): string {
  if (call.kind === 'executableCode') {
    return `executableCode: ${(call.code ?? '').replace(/\s+/g, ' ').trim()}`;
  }
  const outcome = call.outcome ?? 'OUTCOME_UNSPECIFIED';
  const output = (call.output ?? '').replace(/\s+/g, ' ').trim();
  return `codeExecutionResult: ${outcome}${output ? ` — ${output}` : ''}`;
}

/**
 * Flattens a trace into the string columns a result row exports.
 *
 * Every key is always set, empty rather than absent, because the CSV export
 * derives its header from the first row alone: a key missing there drops the
 * column from the whole file. See `ResultRow.thoughts`.
 * @param trace The gathered evidence, or undefined when none was captured.
 * @returns One value per trace column.
 */
export function summarizeTrace(trace?: AssistTrace): TraceSummary {
  const sources = trace?.sources ?? [];
  const distinct = (values: Array<string|undefined>) =>
      [...new Set(values.filter((value): value is string => !!value))].join(', ');

  const scores = sources.map(source => source.groundingScore)
                     .filter((score): score is number => score !== undefined);

  return {
    citedSources: sources.map(describeSource).join('\n'),
    citedDataStores: distinct(sources.map(source => source.dataStoreId)),
    citedConnectors: distinct(sources.map(source => source.connector)),
    toolCalls: (trace?.toolCalls ?? []).map(describeToolCall).join('\n'),
    maxGroundingScore: scores.length ? Math.max(...scores) : 0,
  };
}
