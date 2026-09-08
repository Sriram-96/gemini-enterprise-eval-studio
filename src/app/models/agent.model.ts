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
 * The lifecycle state an agent reports. Mirrors `Agent.state` on the Discovery
 * Engine v1alpha resource; unknown values are tolerated because the enum grows.
 */
export type AgentState = 'STATE_UNSPECIFIED'|'CONFIGURED'|'DEPLOYING'|
    'DISABLED'|'DEPLOYMENT_FAILED'|'PRIVATE'|'ENABLED'|'SUSPENDED'|'CREATING'|
    'CREATION_FAILED';

/**
 * An agent published under an engine's assistant, as returned by ListAgents.
 * Only the fields the studio needs to offer a choice are modelled.
 */
export interface Agent {
  /**
   * Resource name, of the form
   * `projects/{p}/locations/{l}/collections/{c}/engines/{e}/assistants/{a}/agents/{agent}`.
   */
  name: string;
  displayName?: string;
  description?: string;
  state?: AgentState;
}

/** Response of `engines.assistants.agents.list`. */
export interface ListAgentsResponse {
  agents?: Agent[];
  nextPageToken?: string;
}

/**
 * States in which an agent cannot answer a query: it is still being built, its
 * build failed, or it has been taken out of service. Offering one of these
 * would put an option in the dropdown that fails every row of the run.
 *
 * `PRIVATE` and `DISABLED` are deliberately absent — they narrow *who* may use
 * the agent rather than break it, and ListAgents already limits the response to
 * agents visible to the caller.
 */
const UNRUNNABLE_AGENT_STATES: ReadonlySet<string> = new Set([
  'CREATING',
  'CREATION_FAILED',
  'DEPLOYING',
  'DEPLOYMENT_FAILED',
  'SUSPENDED',
]);

/**
 * Whether an agent can serve a query, and so belongs in the picker.
 * An absent or unrecognized state is treated as runnable: the API has not said
 * otherwise, and hiding an agent the user can see in the console is worse than
 * surfacing the run's real error.
 */
export function isRunnableAgent(agent: Agent): boolean {
  return !!agent.name && !UNRUNNABLE_AGENT_STATES.has(agent.state ?? '');
}

/**
 * Extracts the bare agent id that `StreamAssistRequest.agentsSpec` expects from
 * a full agent resource name. A value that is already a bare id is returned
 * unchanged, so a hand-edited config still works.
 * @param resourceName The agent resource name, or a bare agent id.
 * @returns The trailing path segment, or the empty string when there is none.
 */
export function agentIdFromResourceName(resourceName: string|undefined): string {
  if (!resourceName) {
    return '';
  }
  const segments = resourceName.split('/').filter(segment => segment !== '');
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/** The label shown for an agent, falling back to its id when it has no name. */
export function agentDisplayName(agent: Agent): string {
  return agent.displayName || agentIdFromResourceName(agent.name);
}
