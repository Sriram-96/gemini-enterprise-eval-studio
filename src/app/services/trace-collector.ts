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

import {AssistTrace, CitedSource, GroundedSegment, ToolCall, sourceKey} from '../models/trace.model';

import {dataStoreIdFromDocument, inferConnectorMetadata} from '../components/shared/connector.util';

/**
 * Accumulates the citation and tool-call evidence scattered across the replies
 * of one `streamAssist` response.
 *
 * Kept apart from `EvalService` so the extraction can be tested against
 * fixture replies directly, without standing up a fake `ReadableStream`.
 *
 * Usage: call `addRawItem` once per parsed `StreamAssistResponse`, then
 * `addGroundedContent` once per reply within it, then `build`.
 */
export class TraceCollector {
  private readonly sources = new Map<string, CitedSource>();
  private readonly segments: GroundedSegment[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private readonly raw: unknown[] = [];

  /**
   * Records a whole stream item verbatim, so the raw journey survives export
   * even where this class does not interpret it.
   * @param item One parsed `StreamAssistResponse`.
   */
  addRawItem(item: unknown) {
    this.raw.push(item);
  }

  /**
   * Extracts the tool calls and grounding of a single reply.
   *
   * The reply's two halves are independent: a reply may carry grounding
   * metadata and no content at all, so neither may gate the other.
   * @param groundedContent The reply's `groundedContent`, if it has one.
   */
  addGroundedContent(groundedContent: any) {
    if (!groundedContent) {
      return;
    }

    const content = groundedContent.content;
    if (content?.executableCode) {
      this.toolCalls.push(
          {kind: 'executableCode', code: content.executableCode.code});
    }
    if (content?.codeExecutionResult) {
      this.toolCalls.push({
        kind: 'codeExecutionResult',
        outcome: content.codeExecutionResult.outcome,
        output: content.codeExecutionResult.output
      });
    }

    const metadata = groundedContent.textGroundingMetadata;
    if (!metadata) {
      return;
    }

    // `segment.referenceIndices` index this reply's own `references` array, so
    // they must be resolved to durable keys here, before the sources are
    // merged with those of every other reply. Index 0 means a different
    // document in each reply.
    const references = metadata.references ?? [];
    const keysByIndex: string[] =
        references.map((reference: any) => this.upsertSource(reference));

    for (const segment of metadata.segments ?? []) {
      const keys: string[] = (segment.referenceIndices ?? [])
                                 .map((index: number) => keysByIndex[index])
                                 .filter((key: string|undefined) => !!key);

      const entry: GroundedSegment = {
        text: segment.text ?? '',
        sourceKeys: keys,
      };
      if (typeof segment.groundingScore === 'number') {
        entry.groundingScore = segment.groundingScore;
        for (const key of keys) {
          const source = this.sources.get(key)!;
          if (source.groundingScore === undefined ||
              segment.groundingScore > source.groundingScore) {
            source.groundingScore = segment.groundingScore;
          }
        }
      }
      this.segments.push(entry);
    }
  }

  /** The evidence gathered so far. */
  build(): AssistTrace {
    return {
      sources: [...this.sources.values()],
      segments: this.segments,
      toolCalls: this.toolCalls,
      raw: this.raw
    };
  }

  /**
   * Merges one reference into the deduplicated source list.
   * @param reference A `TextGroundingMetadata.Reference`.
   * @returns Its key, or the empty string when it identifies nothing.
   */
  private upsertSource(reference: any): string {
    const metadata = reference?.documentMetadata ?? {};
    const source: CitedSource = {};

    if (metadata.document) source.document = metadata.document;
    if (metadata.uri) source.uri = metadata.uri;
    if (metadata.title) source.title = metadata.title;
    if (metadata.pageIdentifier) source.pageIdentifier = metadata.pageIdentifier;
    if (metadata.domain) source.domain = metadata.domain;
    if (reference?.content) source.snippet = reference.content;

    const dataStoreId = dataStoreIdFromDocument(metadata.document);
    if (dataStoreId) {
      source.dataStoreId = dataStoreId;
      source.connector = inferConnectorMetadata(dataStoreId).displayName;
    }

    const key = sourceKey(source);
    if (!key) {
      return '';
    }

    const existing = this.sources.get(key);
    if (!existing) {
      this.sources.set(key, source);
      return key;
    }

    // Later replies can carry fields an earlier one left out; fill the gaps
    // without overwriting what is already known.
    for (const [field, value] of Object.entries(source)) {
      if (value !== undefined &&
          existing[field as keyof CitedSource] === undefined) {
        (existing as any)[field] = value;
      }
    }
    return key;
  }
}
