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

import {Router, Request, Response} from 'express';
import {Config} from './config';
import {createAuthenticateMiddleware} from './auth';
import {google} from 'googleapis';
import {RefreshTokenStore} from './store';

const ENGINE_PATH_REGEX = /^projects\/([^/]+)\/locations\/([^/]+)\/collections\/([^/]+)\/engines\/([^/]+)$/;
const REGION_REGEX = /^[a-z0-9-]+$/;
const ENGINE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PROJECT_ID_REGEX = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Largest page ListAgents accepts; see the frontend counterpart. */
const MAX_AGENT_PAGE_SIZE = 1000;

/**
 * Expands an `engineId` query parameter into a full engine resource name.
 *
 * The client sends either a full `projects/.../engines/{id}` path or a bare
 * engine id. Both are validated rather than merely normalized, because the
 * result is interpolated into a request URL: an unvetted value could reach a
 * different resource than the one named.
 * @returns The engine resource name, or null when the input is not a valid
 *     engine reference.
 */
export function resolveEnginePath(
    projectId: string, region: string, engineId: string): string|null {
  if (engineId.startsWith('projects/')) {
    return ENGINE_PATH_REGEX.test(engineId) ? engineId : null;
  }
  if (!ENGINE_ID_REGEX.test(engineId)) {
    return null;
  }
  return `projects/${projectId}/locations/${region}/collections/default_collection/engines/${engineId}`;
}

/**
 * Creates the Express router for proxying requests to Discovery Engine and Vertex AI.
 */
export function createProxyRouter(config: Config, refreshTokenStore?: RefreshTokenStore): Router {
  const router = Router();
  const authMiddleware = createAuthenticateMiddleware(config, refreshTokenStore);

  // Apply auth middleware to protect these proxy endpoints
  router.use('/api/v1/*', authMiddleware);

  // 1. POST /api/v1/assist (Discovery Engine streamAssist proxy)
  router.post('/api/v1/assist', async (req: Request, res: Response) => {
    const {selectedEngine, region, body} = req.body as {
      selectedEngine: string;
      region: string;
      body: unknown;
    };

    if (!selectedEngine || !ENGINE_PATH_REGEX.test(selectedEngine)) {
      res.status(400).send('Invalid or missing selectedEngine parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    const baseUrl = region === 'global'
      ? 'discoveryengine.googleapis.com'
      : `${region}-discoveryengine.googleapis.com`;

    const url = `https://${baseUrl}/v1/${selectedEngine}/assistants/default_assistant:streamAssist`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${req.session?.token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        res.status(response.status).send(errorText);
        return;
      }

      res.setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json');
      if (response.headers.has('Transfer-Encoding')) {
        res.setHeader('Transfer-Encoding', response.headers.get('Transfer-Encoding')!);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        res.status(500).send('Response body is not readable.');
        return;
      }

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      res.status(500).send(`Proxy request failed: ${(err as Error).message}`);
    }
  });

  // 2. POST /api/v1/score (Vertex AI generateContent proxy)
  router.post('/api/v1/score', async (req: Request, res: Response) => {
    const {projectId, region, model, body} = req.body as {
      projectId: string;
      region: string;
      model: string;
      body: any;
    };

    if (!projectId) {
      res.status(400).send('Missing projectId parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    if (!model) {
      res.status(400).send('Missing model parameter.');
      return;
    }

    try {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: req.session?.token.access_token || '' });

      const aiplatform = google.aiplatform({ version: 'v1', auth });
      const response = await aiplatform.projects.locations.publishers.models.generateContent({
        model: `projects/${projectId}/locations/${region}/publishers/google/models/${model}`,
        requestBody: body,
      });

      res.json(response.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).send(`Proxy request failed: ${err.message}`);
    }
  });

  // 2b. POST /api/v1/count-tokens (Vertex AI countTokens proxy)
  router.post('/api/v1/count-tokens', async (req: Request, res: Response) => {
    const {projectId, region, model, body} = req.body as {
      projectId: string;
      region: string;
      model: string;
      body: any;
    };

    if (!projectId) {
      res.status(400).send('Missing projectId parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    if (!model) {
      res.status(400).send('Missing model parameter.');
      return;
    }

    try {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: req.session?.token.access_token || '' });

      const aiplatform = google.aiplatform({ version: 'v1', auth });
      const response = await aiplatform.projects.locations.publishers.models.countTokens({
        endpoint: `projects/${projectId}/locations/${region}/publishers/google/models/${model}`,
        requestBody: body,
      });

      res.json(response.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).send(`Proxy request failed: ${err.message}`);
    }
  });

  // 3. GET /api/v1/engines (Discovery Engine list engines proxy)
  router.get('/api/v1/engines', async (req: Request, res: Response) => {
    const projectId = req.query['projectId'] as string;
    const region = req.query['region'] as string;

    if (!projectId) {
      res.status(400).send('Missing projectId parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    try {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: req.session?.token.access_token || '' });

      const discoveryengine = google.discoveryengine({ version: 'v1alpha', auth });

      const response = await discoveryengine.projects.locations.collections.engines.list({
        parent: `projects/${projectId}/locations/${region}/collections/default_collection`,
      }, {
        headers: {
          'x-goog-user-project': projectId
        }
      });

      res.json(response.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).send(`Proxy request failed: ${err.message}`);
    }
  });

  // 4. GET /api/v1/widget-config (Discovery Engine widget config proxy)
  router.get('/api/v1/widget-config', async (req: Request, res: Response) => {
    const projectId = req.query['projectId'] as string;
    const region = req.query['region'] as string;
    const engineId = req.query['engineId'] as string;

    if (!projectId) {
      res.status(400).send('Missing projectId parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    if (!engineId) {
      res.status(400).send('Missing engineId parameter.');
      return;
    }

    try {
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: req.session?.token.access_token || '' });

      const discoveryengine = google.discoveryengine({ version: 'v1alpha', auth });
      const enginePath = engineId.startsWith('projects/')
        ? engineId
        : `projects/${projectId}/locations/${region}/collections/default_collection/engines/${engineId}`;
      const name = `${enginePath}/widgetConfigs/default_search_widget_config`;

      const response = await discoveryengine.projects.locations.collections.engines.widgetConfigs.get({
        name,
      }, {
        headers: {
          'x-goog-user-project': projectId
        }
      });

      res.json(response.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).send(`Proxy request failed: ${err.message}`);
    }
  });

  // 5. GET /api/v1/agents (Discovery Engine list agents proxy)
  //
  // Uses a raw fetch rather than the generated `googleapis` client: the pinned
  // client does not yet expose the `engines.assistants.agents` resource.
  router.get('/api/v1/agents', async (req: Request, res: Response) => {
    const projectId = req.query['projectId'] as string;
    const region = req.query['region'] as string;
    const engineId = req.query['engineId'] as string;

    if (!projectId || !PROJECT_ID_REGEX.test(projectId)) {
      res.status(400).send('Invalid or missing projectId parameter.');
      return;
    }

    if (!region || !REGION_REGEX.test(region)) {
      res.status(400).send('Invalid or missing region parameter.');
      return;
    }

    if (!engineId) {
      res.status(400).send('Missing engineId parameter.');
      return;
    }

    const enginePath = resolveEnginePath(projectId, region, engineId);
    if (!enginePath) {
      res.status(400).send('Invalid engineId parameter.');
      return;
    }

    const baseUrl = region === 'global'
      ? 'discoveryengine.googleapis.com'
      : `${region}-discoveryengine.googleapis.com`;
    const url = `https://${baseUrl}/v1alpha/${enginePath}/assistants/default_assistant/agents?pageSize=${MAX_AGENT_PAGE_SIZE}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${req.session?.token.access_token}`,
          'x-goog-user-project': projectId,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        res.status(response.status).send(errorText);
        return;
      }

      res.json(await response.json());
    } catch (err) {
      res.status(500).send(`Proxy request failed: ${(err as Error).message}`);
    }
  });

  return router;
}


