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

import {firestore_v1} from 'googleapis';

import {FirestoreRefreshTokenStore} from './store';

describe('FirestoreRefreshTokenStore (Mocked)', () => {
  let store: FirestoreRefreshTokenStore;
  let mockGet: jasmine.Spy;
  let mockPatch: jasmine.Spy;
  let mockDelete: jasmine.Spy;

  beforeEach(() => {
    mockGet = jasmine.createSpy('get');
    mockPatch = jasmine.createSpy('patch');
    mockDelete = jasmine.createSpy('delete');

    const mockClient = {
      projects: {
        databases: {
          documents: {
            get: mockGet,
            patch: mockPatch,
            delete: mockDelete,
          },
        },
      },
    } as unknown as firestore_v1.Firestore;

    mockGet.and.returnValue(Promise.resolve({data: {fields: {}}}));
    mockPatch.and.returnValue(Promise.resolve({data: {}}));
    mockDelete.and.returnValue(Promise.resolve({data: {}}));

    store = new FirestoreRefreshTokenStore('test_project', 'test_db', 'test_tokens', mockClient);
  });

  it('should save token with correct TTL and document path', async () => {
    jasmine.clock().install();
    const baseTime = new Date();
    jasmine.clock().mockDate(baseTime);
    try {
      await store.saveRefreshToken('user1', 'token123', 3600);

      const expectedName = 'projects/test_project/databases/test_db/documents/test_tokens/user1';
      expect(mockPatch).toHaveBeenCalledWith({
        name: expectedName,
        requestBody: {
          fields: {
            refreshToken: {stringValue: 'token123'},
            expiresAt: {timestampValue: new Date(baseTime.getTime() + 3600 * 1000).toISOString()},
            updatedAt: {timestampValue: baseTime.toISOString()},
          },
        },
      });
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('should retrieve token if not expired', async () => {
    mockGet.and.returnValue(Promise.resolve({
      data: {
        fields: {
          refreshToken: {stringValue: 'token123'},
          expiresAt: {timestampValue: new Date(Date.now() + 10000).toISOString()},
        },
      },
    }));

    const token = await store.getRefreshToken('user1');
    expect(token).toBe('token123');
    expect(mockGet).toHaveBeenCalled();
  });

  it('should return null and delete token if expired', async () => {
    mockGet.and.returnValue(Promise.resolve({
      data: {
        fields: {
          refreshToken: {stringValue: 'token123'},
          expiresAt: {timestampValue: new Date(Date.now() - 10000).toISOString()},
        },
      },
    }));

    const token = await store.getRefreshToken('user1');
    expect(token).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should return null if token document does not exist (404)', async () => {
    const error404 = {code: 404, message: 'Not found'};
    mockGet.and.returnValue(Promise.reject(error404));

    const token = await store.getRefreshToken('user1');
    expect(token).toBeNull();
  });

  it('should delete token', async () => {
    await store.deleteRefreshToken('user1');
    expect(mockDelete).toHaveBeenCalled();
  });
});
