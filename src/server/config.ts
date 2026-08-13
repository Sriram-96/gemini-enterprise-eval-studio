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

import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import { z } from 'zod';

import {logger} from './logger';

const GoogleIdentitySchema = z.object({
  id: z.string(),
  type: z.literal('google_identity'),
  display_name: z.string(),
  client_id: z.string(),
  client_secret_secret: z.string(),
}).passthrough();

const SamlSchema = z.object({
  id: z.string(),
  type: z.literal('3p_saml'),
  display_name: z.string(),
  idp_sso_url: z.string().url(),
  gcp_pool_id: z.string(),
  gcp_provider_id: z.string(),
}).passthrough();

const OidcSchema = z.object({
  id: z.string(),
  type: z.literal('3p_oidc'),
  display_name: z.string(),
  idp_issuer_url: z.string().url(),
  client_id: z.string(),
  client_secret_secret: z.string(),
  gcp_pool_id: z.string(),
  gcp_provider_id: z.string(),
}).passthrough();

const AuthProviderSchema = z.discriminatedUnion('type', [
  GoogleIdentitySchema,
  SamlSchema,
  OidcSchema,
]);

const FirestoreConfigSchema = z.object({
  projectId: z.string(),
  databaseId: z.string(),
  collectionId: z.string(),
  ttlSeconds: z.number().optional(),
}).passthrough();

export const SessionConfigSchema = z.object({
  encryption_key_secret: z.string(),
}).passthrough();

export const ConfigSchema = z.object({
  session_config: SessionConfigSchema,
  auth_providers: z.array(AuthProviderSchema),
  firestore_config: FirestoreConfigSchema.optional(),
  trusted_hosts: z.array(z.string()).optional(),
}).passthrough();

export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type FirestoreConfig = z.infer<typeof FirestoreConfigSchema>;
export type AuthProvider = z.infer<typeof AuthProviderSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// Regex to match GCP Secret Manager secret version resource names:
// - projects/PROJECT_ID/secrets/SECRET_ID/versions/VERSION_ID
// - projects/PROJECT_ID/locations/LOCATION/secrets/SECRET_ID/versions/VERSION_ID
const SECRET_URI_REGEX = /^projects\/[^/]+\/(?:locations\/[^/]+\/)?secrets\/[^/]+\/versions\/[^/]+$/;

let authInstance: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!authInstance) {
    authInstance = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authInstance;
}

async function resolveSecret(value: string): Promise<string> {
  if (!SECRET_URI_REGEX.test(value)) {
    return value;
  }
  try {
    logger.info(`Resolving secret URI: ${value}`);
    const auth = getAuth();
    const secretmanager = google.secretmanager({ version: 'v1', auth });
    const res = await secretmanager.projects.secrets.versions.access({
      name: value,
    });
    const payload = res.data.payload?.data;
    if (!payload) {
      throw new Error(`Secret ${value} has no payload data.`);
    }
    // Secret Manager API returns payload data as a base64-encoded string in JSON
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch (err) {
    throw new Error(`Failed to resolve secret ${value}: ${(err as Error).message}`);
  }
}

async function recursiveResolve(obj: unknown): Promise<unknown> {
  if (typeof obj === 'string') {
    return resolveSecret(obj);
  }
  if (Array.isArray(obj)) {
    const resolvedArray = [];
    for (const item of obj) {
      resolvedArray.push(await recursiveResolve(item));
    }
    return resolvedArray;
  }
  if (typeof obj === 'object' && obj !== null) {
    const record = obj as Record<string, unknown>;
    const resolvedRecord: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      resolvedRecord[key] = await recursiveResolve(record[key]);
    }
    return resolvedRecord;
  }
  return obj;
}

/** Resolves all Secret Manager URIs in the configuration. */
export async function resolveConfigSecrets(config: Config): Promise<Config> {
  return await recursiveResolve(config) as Config;
}

/**
 * Loads the config file and resolves any Secret Manager URIs.
 */
export async function loadConfig(
  configPath: string,
  readFn: (path: string, encoding: BufferEncoding) => string = fs.readFileSync
): Promise<Config> {
  try {
    const content = readFn(configPath, 'utf8');
    const rawJson = JSON.parse(content);
    const config = ConfigSchema.parse(rawJson) as Config;
    return await resolveConfigSecrets(config);
  } catch (err) {
    throw new Error(`Failed to load config at ${configPath}: ${(err as Error).message}`);
  }
}
