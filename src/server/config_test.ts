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

import { google } from 'googleapis';

import { loadConfig } from './config';

describe('config parser', () => {
  beforeEach(() => {});

  it('should parse a valid config file directly without initializing Secret Manager if no URIs present', async () => {
    const mockConfig = {
      session_config: {
        encryption_key_secret: 'resolved-session-key',
      },
      auth_providers: [
        {
          id: 'google-workspace',
          type: 'google_identity',
          display_name: 'Sign in with Google',
          client_id: 'my-client-id',
          client_secret_secret: 'resolved-oauth-secret',
        },
      ],
    };

    const readSpy = jasmine.createSpy('readFileSync').and.returnValue(JSON.stringify(mockConfig));
    const getClientSpy = spyOn(google.auth.GoogleAuth.prototype, 'getClient');

    const config = await loadConfig('/dummy/path/config.json', readSpy);

    expect(readSpy).toHaveBeenCalledWith('/dummy/path/config.json', 'utf8');
    expect(getClientSpy).not.toHaveBeenCalled();
    expect(config.session_config.encryption_key_secret).toBe('resolved-session-key');
    expect(config.auth_providers[0].client_secret_secret).toBe('resolved-oauth-secret');
    expect(config.auth_providers[0].client_id).toBe('my-client-id');
  });

  it('should resolve Secret Manager URIs in the config', async () => {
    const mockConfigWithSecrets = {
      session_config: {
        encryption_key_secret: 'projects/my-project/secrets/session-key/versions/1',
      },
      auth_providers: [
        {
          id: 'google-workspace',
          type: 'google_identity',
          display_name: 'Sign in with Google',
          client_id: 'my-client-id',
          client_secret_secret: 'projects/my-project/secrets/oauth-secret/versions/latest',
        },
      ],
    };

    const readSpy = jasmine.createSpy('readFileSync').and.returnValue(JSON.stringify(mockConfigWithSecrets));

    const mockAccess = jasmine.createSpy('access').and.callFake((params: { name: string }) => {
      const name = params.name;
      if (name === 'projects/my-project/secrets/session-key/versions/1') {
        return Promise.resolve({
          data: {
            payload: {
              data: Buffer.from('resolved-session-key-from-sm').toString('base64'),
            },
          },
        });
      }
      if (name === 'projects/my-project/secrets/oauth-secret/versions/latest') {
        return Promise.resolve({
          data: {
            payload: {
              data: Buffer.from('resolved-oauth-secret-from-sm').toString('base64'),
            },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected secret name: ${name}`));
    });

    const mockSecretManager = {
      projects: {
        secrets: {
          versions: {
            access: mockAccess,
          },
        },
      },
    };

    spyOn(google, 'secretmanager').and.returnValue(mockSecretManager as any);

    const config = await loadConfig('/dummy/path/config.json', readSpy);

    expect(readSpy).toHaveBeenCalledWith('/dummy/path/config.json', 'utf8');
    expect(mockAccess).toHaveBeenCalledTimes(2);
    expect(config.session_config.encryption_key_secret).toBe('resolved-session-key-from-sm');
    expect(config.auth_providers[0].client_secret_secret).toBe('resolved-oauth-secret-from-sm');
    expect(config.auth_providers[0].client_id).toBe('my-client-id'); // remains unchanged
  });

  it('should throw error when file reading fails', async () => {
    const readSpy = jasmine.createSpy('readFileSync').and.throwError('File not found');

    await expectAsync(loadConfig('/dummy/path/config.json', readSpy)).toBeRejectedWithError(
      /Failed to load config at \/dummy\/path\/config\.json: File not found/
    );
  });
});
