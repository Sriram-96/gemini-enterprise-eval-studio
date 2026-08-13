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

import {GoogleAuth} from 'google-auth-library';
import {firestore_v1, google} from 'googleapis';

import {logger} from './logger';

/**
 * Interface for storing and retrieving refresh tokens.
 */
export interface RefreshTokenStore {
  getRefreshToken(userId: string): Promise<string | null>;
  saveRefreshToken(userId: string, refreshToken: string, ttlSeconds: number): Promise<void>;
  deleteRefreshToken(userId: string): Promise<void>;
}

/**
 * Firestore implementation of RefreshTokenStore using googleapis.
 */
export class FirestoreRefreshTokenStore implements RefreshTokenStore {
  private readonly client: firestore_v1.Firestore;
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly collectionId: string;

  constructor(
      projectId: string, databaseId: string, collectionId: string,
      clientOverride?: firestore_v1.Firestore) {
    if (!projectId || !databaseId || !collectionId) {
      throw new Error(
          'FirestoreRefreshTokenStore requires valid projectId, databaseId, and collectionId.');
    }
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.collectionId = collectionId;

    if (clientOverride) {
      this.client = clientOverride;
    } else {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      this.client = google.firestore({version: 'v1', auth});
    }
  }

  private documentName(userId: string): string {
    const encodedUserId = encodeURIComponent(userId);
    return `projects/${this.projectId}/databases/${this.databaseId}/documents/${this.collectionId}/${encodedUserId}`;
  }

  /**
   * Sets a TTL policy on the 'expiresAt' field in Firestore.
   * Logs a warning if the service account lacks admin permissions or if it fails.
   */
  async setTtlPolicy(): Promise<void> {
    try {
      const fieldName = `projects/${this.projectId}/databases/${this.databaseId}/collectionGroups/${this.collectionId}/fields/expiresAt`;
      await this.client.projects.databases.collectionGroups.fields.patch({
        name: fieldName,
        updateMask: 'ttlConfig',
        requestBody: {
          ttlConfig: { state: 'ACTIVE' },
        },
      });
      logger.info(`Successfully ensured Firestore TTL policy for field 'expiresAt' on collection group '${this.collectionId}'.`);
    } catch (err) {
      logger.warn(`Could not set Firestore TTL policy on 'expiresAt' field (requires Firestore Admin permission): ${(err as Error).message}`);
    }
  }

  async getRefreshToken(userId: string): Promise<string | null> {
    try {
      const name = this.documentName(userId);
      const res = await this.client.projects.databases.documents.get({ name });
      const fields = res?.data?.fields;
      if (!fields) {
        return null;
      }

      const refreshToken = fields['refreshToken']?.stringValue;
      const expiresAtStr = fields['expiresAt']?.timestampValue;

      if (!refreshToken) {
        return null;
      }

      if (expiresAtStr && new Date(expiresAtStr) < new Date()) {
        await this.deleteRefreshToken(userId);
        return null;
      }

      return refreshToken;
    } catch (err: unknown) {
      const errorObj = err as {code?: number; status?: number; response?: {status?: number}};
      if (errorObj.code === 404 || errorObj.status === 404 || errorObj.response?.status === 404) {
        return null;
      }
      logger.error(`Error fetching refresh token from Firestore for user ${userId}:`, err);
      await this.deleteRefreshToken(userId).catch(() => {});
      throw err;
    }
  }

  async saveRefreshToken(userId: string, refreshToken: string, ttlSeconds: number): Promise<void> {
    const name = this.documentName(userId);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const updatedAt = new Date().toISOString();

    await this.client.projects.databases.documents.patch({
      name,
      requestBody: {
        fields: {
          refreshToken: { stringValue: refreshToken },
          expiresAt: { timestampValue: expiresAt },
          updatedAt: { timestampValue: updatedAt },
        },
      },
    });
  }

  async deleteRefreshToken(userId: string): Promise<void> {
    try {
      const name = this.documentName(userId);
      await this.client.projects.databases.documents.delete({ name });
    } catch (err: unknown) {
      const errorObj = err as {code?: number; status?: number; response?: {status?: number}};
      if (errorObj.code !== 404 && errorObj.status !== 404 && errorObj.response?.status !== 404) {
        throw err;
      }
    }
  }
}
