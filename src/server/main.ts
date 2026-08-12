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

import * as fs from 'fs';
import * as path from 'path';

import express = require('express');

import {createAuthRouter, cookieParserMiddleware} from './auth';
import {createProxyRouter} from './proxy';
import {loadConfig} from './config';
import {logger} from './logger';

async function startServer() {
  const app = express();

  // Trust proxy to receive correct request protocols behind GCP load balancers
  app.set('trust proxy', true);

  // Determine configuration file path
  let configPath = process.env['CONFIG_PATH'];
  for (const arg of process.argv) {
    if (arg.startsWith('--config=')) {
      configPath = arg.split('=')[1];
    }
  }

  if (!configPath) {
    logger.error('Critical: Configuration path not provided.');
    logger.error('Please set CONFIG_PATH environment variable or pass --config=<path> argument.');
    process.exit(1);
  }

  if (!path.isAbsolute(configPath)) {
    configPath = path.resolve(configPath);
  }



  logger.info(`Loading configuration from: ${configPath}`);

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    logger.error('Critical: Failed to load configuration on startup:', err);
    process.exit(1);
  }

  // Register common middlewares
  app.use((express as unknown as { json: (options?: unknown) => express.RequestHandler }).json());
  app.use((express as unknown as { urlencoded: (options?: unknown) => express.RequestHandler }).urlencoded({ extended: true }));
  app.use(cookieParserMiddleware);

  // Health check endpoint for Hexa
  app.get('/healthz', (req: express.Request, res: express.Response) => {
    res.status(200).send('ok');
  });

  // Register authentication endpoints
  app.use(createAuthRouter(config));

  // Register proxy endpoints
  app.use(createProxyRouter(config));

  // Determine path to client static assets
  let staticPath = process.env['STATIC_ASSETS_PATH'];
  for (const arg of process.argv) {
    if (arg.startsWith('--static-assets-path=')) {
      staticPath = arg.split('=')[1];
    }
  }
  if (!staticPath) {
    staticPath = path.join(__dirname, '../../dist/gemini-enterprise-eval-studio/browser');
  } else {
    staticPath = path.resolve(staticPath);
  }

  if (fs.existsSync(path.join(staticPath, 'index.html'))) {
    logger.info(`Serving static files from: ${staticPath}`);
    app.use(express.static(staticPath));

    // Catch-all route for Angular client-side SPA routing
    app.get('*', (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (
        req.path === '/api' || req.path.startsWith('/api/') ||
        req.path === '/auth' || req.path.startsWith('/auth/')
      ) {
        return next();
      }
      res.sendFile(path.join(staticPath, 'index.html'));
    });
  } else {
    logger.info(`Static assets not found at ${staticPath}. Skipping static file serving in Express.`);
  }

  const DEFAULT_PORT = 3000;
  let port: string | number = process.env['PORT'] || DEFAULT_PORT;
  for (const arg of process.argv) {
    if (arg.startsWith('--port=')) {
      port = Number(arg.split('=')[1]);
    }
  }
  app.listen(port, () => {
    logger.info(`Server successfully started on port ${port}`);
  });
}

startServer().catch(err => {
  logger.error('Unexpected server crash:', err);
  process.exit(1);
});
