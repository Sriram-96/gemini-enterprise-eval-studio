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

import {CSVRow} from './csv-row.model';

/**
 * What may appear in the `agent` column, kept deliberately permissive.
 *
 * The discovery document describes `agentId` as an RFC-1034 label, but real
 * engines do not honor that: a managed agent is called `deep_research`, with
 * an underscore, and a console-created one is a 19-digit number. Rejecting
 * either would block a legitimate run for the sake of a rule the service does
 * not enforce, so this only excludes what could never be an id -- a path, a
 * space, punctuation, or more than 63 characters.
 *
 * Being lax costs little here. streamAssist answers an unknown agent id with
 * HTTP 200 from the default assistant rather than an error, so a well-formed
 * id that names nothing gets through this check either way; see the warning in
 * README's "Evaluating a custom agent".
 */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/**
 * Checks the `agent` column of an uploaded query set before a run starts.
 *
 * There is no dropdown behind this column, so a typo would otherwise only
 * surface as a whole run of failed rows. Two things are rejected: a value that
 * cannot be an agent id at all, and a conversation whose turns name different
 * agents -- those turns share one Assistant session, and switching the serving
 * agent part-way through one is not a defined operation.
 *
 * A full resource name is called out separately from other malformed input:
 * pasting one is the mistake most likely to be made, and the fix is to keep
 * only its last segment.
 *
 * @param rows The parsed query set, with headers already lowercased.
 * @returns The first problem found, or null when the column is usable.
 */
export function validateAgentColumn(rows: CSVRow[]): string|null {
  const agentsByConversation = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const agent = row.agent?.trim() ?? '';
    // The header is a spreadsheet row further down than the index.
    const rowNumber = i + 2;

    if (agent && !AGENT_ID_PATTERN.test(agent)) {
      if (agent.includes('/')) {
        const id = agent.split('/').pop() || agent;
        return `Row ${rowNumber}: 'agent' must be the agent id, not its full ` +
            `resource name. Use '${id}' instead of '${agent}'.`;
      }
      return `Row ${rowNumber}: '${agent}' is not a valid agent id. Use ` +
          `letters, digits, hyphens and underscores, up to 63 characters, ` +
          `starting with a letter or digit.`;
    }

    const conversationId = row.conversation_id?.trim();
    if (!conversationId) {
      continue;
    }

    const seen = agentsByConversation.get(conversationId);
    if (seen === undefined) {
      agentsByConversation.set(conversationId, agent);
    } else if (seen !== agent) {
      const name = (value: string) => value || 'the default assistant';
      return `Conversation '${conversationId}' names more than one agent ` +
          `(${name(seen)} and ${name(agent)}). All turns of a conversation ` +
          `share one session and must use the same agent.`;
    }
  }

  return null;
}
