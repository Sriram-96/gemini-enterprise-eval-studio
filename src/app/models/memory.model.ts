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

import {WidgetConfigResponse} from './app-config.model';
import {CSVRow} from './csv-row.model';

/**
 * Support for evaluating Gemini Enterprise's saved memories ("Memories").
 *
 * The `default_assistant` has no memory API: there is no endpoint to create,
 * list or delete a memory, and `streamAssist` takes no memory parameter. The
 * only way to put a memory in place is to hold the conversation that saves it,
 * the only way to read one back is to ask in a *new* session, since a memory
 * recalled inside the session that wrote it proves nothing, and the only way
 * to remove one is to ask the assistant to forget it.
 *
 * That shapes the whole design here: a memory evaluation is phases of ordinary
 * rows separated by barriers, not fixture steps with an API behind them — see
 * the guidance in README.md.
 */

/**
 * Engine feature key gating saved memories. Reported in `Engine.features` and
 * mirrored into the widget config's read-only `uiSettings.features`.
 */
export const PERSONALIZATION_MEMORY_FEATURE = 'personalization-memory';

/** Whether the engine under test can save and recall memories at all. */
export type MemorySupport = 'on'|'off'|'unknown';

/**
 * The part a row plays in a memory evaluation.
 *
 * `reset` rows run first of all, sequentially, and are expected to clear what
 * earlier runs left on the account. `seed` rows run next, also sequentially,
 * and are expected to make the assistant save something. `recall` rows run
 * afterwards in fresh sessions and carry the assertions. A row with none of
 * these is an ordinary row and behaves exactly as it did before this column
 * existed.
 */
export type MemoryPhase = 'reset'|'seed'|'recall';

/** Phases that run sequentially ahead of the main pool, in the order they run. */
const ORDERED_PHASES: readonly MemoryPhase[] = ['reset', 'seed'];

/**
 * Pause between the seed phase and the rest of the run, in milliseconds.
 *
 * Gemini Enterprise saves a memory asynchronously after the turn that produced
 * it, so a recall query issued immediately can miss it. There is no API to poll
 * for the write having landed, which is why this is a fixed wait rather than a
 * condition: five seconds is long enough to cover the lag in practice and short
 * enough not to dominate a run, and it is not worth asking an author to guess a
 * number for a delay they cannot observe.
 */
export const MEMORY_SETTLE_MS = 5000;

/**
 * Reads the engine's saved-memory feature state off a widget config response.
 * @param widgetConfig The response from `fetchWidgetConfig`, possibly null when
 *     the call failed or the caller lacks permission.
 * @returns 'on' or 'off' when the API states it, 'unknown' otherwise. An engine
 *     that does not report the key is not thereby off, so callers must treat
 *     'unknown' as "proceed, but say so" rather than as a failure.
 */
export function readMemorySupport(widgetConfig: WidgetConfigResponse|null|
                                  undefined): MemorySupport {
  const state = widgetConfig?.uiSettings?.features?.[PERSONALIZATION_MEMORY_FEATURE];
  if (state === 'FEATURE_STATE_ON') return 'on';
  if (state === 'FEATURE_STATE_OFF') return 'off';
  return 'unknown';
}

/**
 * The declared phase of a CSV row.
 * @param row A parsed input row.
 * @returns The phase, or undefined for an ordinary row. Values are matched
 *     case-insensitively and trimmed, matching how the upload path already
 *     normalizes headers.
 */
export function memoryPhaseOf(row: CSVRow): MemoryPhase|undefined {
  const value = (row.phase ?? '').trim().toLowerCase();
  return value === 'reset' || value === 'seed' || value === 'recall' ?
      value :
      undefined;
}

/**
 * The sequential phase a conversation belongs to, if any.
 * @param turns The turns of one conversation, or a single-row group.
 * @returns 'reset' or 'seed' when any turn declares it, undefined when the
 *     conversation belongs to the main pool. Turns of one conversation are
 *     already required to share a phase, so the first match decides.
 */
export function orderedPhaseOf(turns: CSVRow[]): MemoryPhase|undefined {
  return ORDERED_PHASES.find(
      phase => turns.some(row => memoryPhaseOf(row) === phase));
}

/** Whether a conversation's turns seed memories rather than assert on them. */
export function isSeedConversation(turns: CSVRow[]): boolean {
  return orderedPhaseOf(turns) === 'seed';
}

/**
 * Checks the memory-specific invariants of an uploaded query set.
 *
 * Rejecting the file outright is deliberate. Each of these mistakes produces a
 * run that completes and reports scores while testing something other than
 * what the author wrote, which is worse than not running at all.
 * @param rows The parsed rows, in upload order.
 * @returns The first problem found, phrased for the error banner, or null when
 *     the set is consistent.
 */
export function validateMemoryRows(rows: CSVRow[]): string|null {
  const phasesByConversation = new Map<string, Set<string>>();

  for (const row of rows) {
    const declared = (row.phase ?? '').trim();
    const phase = declared.toLowerCase();
    if (declared && !memoryPhaseOf(row)) {
      return `Unknown phase '${declared}' on query "${row.query}". Use ` +
          `'reset', 'seed', 'recall', or leave the phase column empty.`;
    }

    const conversationId = row.conversation_id?.trim();

    // A recall row has to open a new chat: threading it onto the seed turn's
    // session would test within-session context, which is a different feature
    // and the one that already works.
    if (phase === 'recall' && conversationId) {
      return `Recall row "${row.query}" has conversation_id ` +
          `'${conversationId}'. A recall row must start a new chat, so it ` +
          `cannot be a turn of an existing conversation.`;
    }

    if (conversationId) {
      const phases =
          phasesByConversation.get(conversationId) ?? new Set<string>();
      phases.add(phase);
      phasesByConversation.set(conversationId, phases);
    }
  }

  for (const [conversationId, phases] of phasesByConversation) {
    if (phases.size > 1) {
      const listed =
          [...phases].map(phase => phase || '(empty)').sort().join(', ');
      return `Conversation '${conversationId}' mixes phases (${listed}). ` +
          `All turns of a conversation run in one session, so they must ` +
          `share a phase.`;
    }
  }

  return null;
}
