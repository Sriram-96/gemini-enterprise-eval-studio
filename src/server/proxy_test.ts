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

import {AddressInfo} from 'net';

import express = require('express');

import {cookieParserMiddleware, encryptSession, getCookieName} from './auth';
import {Config} from './config';
import {createProxyRouter} from './proxy';
import {SessionData} from './types';

const ENCRYPTION_KEY = 'my-super-secret-key-123456789012';
const ENGINE =
    'projects/p/locations/global/collections/default_collection/engines/e';

const CONFIG = {
  session_config: {encryption_key_secret: ENCRYPTION_KEY},
  auth_providers: [{
    id: 'google',
    type: 'google_identity',
    display_name: 'Google',
    client_id: 'client',
    client_secret_secret: 'secret',
  }],
} as unknown as Config;

/**
 * Drives the assist proxy the way the browser does: over real HTTP, through
 * the real auth middleware, with the upstream Discovery Engine call captured
 * rather than made.
 */
describe('proxy assist endpoint', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  let cookie: string;
  let upstream: {url: string; init: RequestInit}|undefined;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    const app = express();
    app.use(
        (express as unknown as {json: (options?: unknown) => express.RequestHandler})
            .json());
    app.use(cookieParserMiddleware);
    app.use(createProxyRouter(CONFIG));

    await new Promise<void>(resolve => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const session: SessionData = {
      providerId: 'google',
      user: {id: '1', email: 'tester@example.com', name: 'Tester'},
      token: {access_token: 'upstream-token', expiry_date: Date.now() + 3600_000},
    };
    cookie = `${getCookieName()}=${encryptSession(session, ENCRYPTION_KEY)}`;

    upstream = undefined;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      upstream = {url: String(url), init};
      return new Response(
          JSON.stringify(
              [{answer: {replies: [{groundedContent: {content: {text: 'hi'}}}]}}]),
          {headers: {'Content-Type': 'application/json'}});
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  /** POSTs an assist request the way ProxyEvalBackendService does. */
  async function callAssist(body: unknown): Promise<Response> {
    return realFetch(`${baseUrl}/api/v1/assist`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Cookie': cookie},
      body: JSON.stringify({selectedEngine: ENGINE, region: 'global', body}),
    });
  }

  it('should forward agentsSpec to Discovery Engine untouched', async () => {
    const body = {
      query: {text: 'triage INC-4471'},
      agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
    };

    const response = await callAssist(body);

    expect(response.status).toBe(200);
    expect(JSON.parse(String(upstream!.init.body))).toEqual(body);
  });

  it('should keep addressing the default assistant when an agent is named',
     async () => {
       // A custom agent is selected by the request body, not by the URL.
       // Rewriting the path to the agent resource would 404.
       await callAssist({
         query: {text: 'q'},
         agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
       });

       expect(upstream!.url)
           .toBe(
               `https://discoveryengine.googleapis.com/v1/${ENGINE}/assistants/default_assistant:streamAssist`);
     });

  it('should call the same URL with and without an agent', async () => {
    await callAssist({query: {text: 'q'}});
    const withoutAgent = upstream!.url;

    await callAssist({
      query: {text: 'q'},
      agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
    });

    expect(upstream!.url).toBe(withoutAgent);
  });

  it('should stream the agent\'s answer back to the caller', async () => {
    const response = await callAssist({
      query: {text: 'q'},
      agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
    });

    const text = await response.text();
    expect(JSON.parse(text)[0].answer.replies[0].groundedContent.content.text)
        .toBe('hi');
  });

  it('should still require a session for an agent request', async () => {
    const response = await realFetch(`${baseUrl}/api/v1/assist`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        selectedEngine: ENGINE,
        region: 'global',
        body: {
          query: {text: 'q'},
          agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(upstream).toBeUndefined();
  });

  it('should still reject a malformed engine path when an agent is named',
     async () => {
       const response = await realFetch(`${baseUrl}/api/v1/assist`, {
         method: 'POST',
         headers: {'Content-Type': 'application/json', 'Cookie': cookie},
         body: JSON.stringify({
           selectedEngine: 'not-an-engine-path',
           region: 'global',
           body: {
             query: {text: 'q'},
             agentsSpec: {agentSpecs: [{agentId: 'dc-triage'}]},
           },
         }),
       });

       expect(response.status).toBe(400);
       expect(upstream).toBeUndefined();
     });
});
