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

import {Request, Response} from 'express';
import * as googleAuth from 'google-auth-library';
import * as zlib from 'zlib';

import {cookieParserMiddleware, createAuthenticateMiddleware, createAuthRouter, decryptSession, encryptSession} from './auth';
import {Config} from './config';
import {SessionData} from './types';

describe('auth module', () => {
  const mockEncryptionKey = 'my-super-secret-key-123456789012';
  let getTokenSpy: jasmine.Spy;
  let getAccessTokenSpy: jasmine.Spy;
  let setCredentialsSpy: jasmine.Spy;
  let onSpy: jasmine.Spy;

  describe('session encrypt/decrypt', () => {
    it('should encrypt and decrypt session successfully', () => {
      const sessionData: SessionData = {
        user: {id: '123', email: 'test@example.com', name: 'Test User'},
        token: {access_token: 'mock-access-token'},
      };
      const encrypted = encryptSession(sessionData, mockEncryptionKey);
      expect(encrypted).toContain(':');

      const decrypted = decryptSession(encrypted, mockEncryptionKey);
      expect(decrypted.user.id).toBe('123');
      expect(decrypted.user.email).toBe('test@example.com');
    });

    it('should fail to decrypt if session is tampered', () => {
      const sessionData: SessionData = {
        user: {id: '123', email: 'test@example.com', name: 'Test User'},
        token: {access_token: 'mock-access-token'},
      };
      const encrypted = encryptSession(sessionData, mockEncryptionKey);
      const lastChar = encrypted.slice(-1);
      const tamperedChar = lastChar === 'a' ? 'b' : 'a';
      const tampered = encrypted.slice(0, -1) + tamperedChar;
      expect(() => decryptSession(tampered, mockEncryptionKey)).toThrow();
    });

    it('should fail to decrypt with incorrect key', () => {
      const sessionData: SessionData = {
        user: {id: '123', email: 'test@example.com', name: 'Test User'},
        token: {access_token: 'mock-access-token'},
      };
      const encrypted = encryptSession(sessionData, mockEncryptionKey);
      expect(() => decryptSession(encrypted, 'wrong-key')).toThrow();
    });
  });

  describe('cookieParserMiddleware', () => {
    it('should parse cookie header', () => {
      const req = {
        headers: {
          cookie: 'foo=bar; baz=qux=value',
        },
      } as unknown as Request;
      const res = {} as unknown as Response;
      const next = jasmine.createSpy('next');

      cookieParserMiddleware(req, res, next);

      expect(req.cookies.foo).toBe('bar');
      expect(req.cookies.baz).toBe('qux=value');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('auth router', () => {
    let mockConfig: Config;

    beforeEach(() => {
      mockConfig = {
        session_config: {
          encryption_key_secret: mockEncryptionKey,
        },
        auth_providers: [
          {
            id: 'google-workspace',
            type: 'google_identity',
            display_name: 'Sign in with Google',
            client_id: 'my-client-id',
            client_secret_secret: 'my-client-secret',
          },
        ],
      };

      spyOn(googleAuth.OAuth2Client.prototype, 'generateAuthUrl')
          .and.returnValue('https://mock-auth-url');
      getTokenSpy = spyOn(googleAuth.OAuth2Client.prototype, 'getToken') as jasmine.Spy;
      getTokenSpy.and.returnValue(Promise.resolve({
            tokens: {
              access_token: 'mock-access-token',
              expiry_date: 123456789,
            },
          } as any));
      setCredentialsSpy = spyOn(googleAuth.OAuth2Client.prototype, 'setCredentials');
    });

    it('should return list of providers on GET /api/auth/providers', () => {
      const router = createAuthRouter(mockConfig);
      const route =
          router.stack.find(s => s.route?.path === '/api/auth/providers');
      expect(route).toBeDefined();

      const req = {} as Request;
      const res = {
        json: jasmine.createSpy('json'),
      } as unknown as Response;

      route!.route!.stack[0].handle(req, res, () => {});

      expect(res.json).toHaveBeenCalledWith([
        {
          id: 'google-workspace',
          type: 'google_identity',
          display_name: 'Sign in with Google',
          client_id: 'my-client-id',
          idp_issuer_url: undefined,
        },
      ]);
    });

    it('should redirect to auth URL on GET /auth/login', () => {
      const router = createAuthRouter(mockConfig);
      const route = router.stack.find(s => s.route?.path === '/auth/login');
      expect(route).toBeDefined();

      const req = {
        query: {provider: 'google-workspace'},
        protocol: 'http',
        get: (header: string) => header === 'host' ? 'localhost:3000' : '',
      } as unknown as Request;
      const res: any = {
        cookie: jasmine.createSpy('cookie'),
        status: jasmine.createSpy('status').and.callFake(() => res),
        setHeader: jasmine.createSpy('setHeader').and.callFake(() => res),
        end: jasmine.createSpy('end'),
      };

      route!.route!.stack[0].handle(req, res, () => {});

      expect(res.cookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(302);
      expect(res.setHeader).toHaveBeenCalledWith('Location', 'https://mock-auth-url');
      expect(res.end).toHaveBeenCalled();
    });

    it('should redirect to IdP with correct SAML AuthnRequest on GET /auth/login for SAML provider', () => {
      const samlProvider = {
        id: 'saml-provider',
        type: '3p_saml' as const,
        display_name: 'SAML Provider',
        idp_sso_url: 'https://example.com/sso',
        gcp_pool_id: 'test-pool',
        gcp_provider_id: 'test-provider',
      };
      mockConfig.auth_providers.push(samlProvider);

      const router = createAuthRouter(mockConfig);
      const route = router.stack.find(s => s.route?.path === '/auth/login');
      expect(route).toBeDefined();

      const req = {
        query: {provider: 'saml-provider'},
        protocol: 'http',
        get: (header: string) => header === 'host' ? 'localhost:3000' : '',
      } as unknown as Request;
      const res: any = {
        cookie: jasmine.createSpy('cookie'),
        status: jasmine.createSpy('status').and.callFake(() => res),
        setHeader: jasmine.createSpy('setHeader').and.callFake(() => res),
        end: jasmine.createSpy('end'),
      };

      route!.route!.stack[0].handle(req, res, () => {});

      expect(res.cookie).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(302);
      expect(res.setHeader).toHaveBeenCalled();
      const redirectUrl = res.setHeader.calls.mostRecent().args[1] as string;
      expect(redirectUrl).toContain('https://example.com/sso');

      const url = new URL(redirectUrl);
      const samlRequestBase64 = url.searchParams.get('SAMLRequest');
      expect(samlRequestBase64).toBeTruthy();

      const compressed = Buffer.from(samlRequestBase64!, 'base64');
      const decompressed = zlib.inflateRawSync(new Uint8Array(compressed)).toString('utf8');

      expect(decompressed).toContain('<saml:Issuer>https://iam.googleapis.com/locations/global/workforcePools/test-pool/providers/test-provider</saml:Issuer>');
      expect(decompressed).toContain('AssertionConsumerServiceURL="http://localhost:3000/auth/callback"');
    });

    it('should exchange code and set cookie on GET /auth/callback',
       async () => {
         const router = createAuthRouter(mockConfig);
         const route =
             router.stack.find(s => s.route?.path === '/auth/callback');
         expect(route).toBeDefined();

         const mockFetch = spyOn(globalThis as any, 'fetch').and.returnValue(
           Promise.resolve({
             ok: true,
             json: () => Promise.resolve({
               email: 'user@example.com',
               name: 'User Name',
               id: 'user-id-123',
             }),
           } as any)
         );

         const nonce = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
         const state = Buffer.from(JSON.stringify({providerId: 'google-workspace', nonce})).toString('base64url');

         const req = {
           query: {code: 'auth-code-123', state},
           cookies: {GeEvalState: nonce},
           protocol: 'http',
           get: (header: string) => header === 'host' ? 'localhost:3000' : '',
         } as unknown as Request;
         const res: any = {
           cookie: jasmine.createSpy('cookie'),
           clearCookie: jasmine.createSpy('clearCookie'),
           status: jasmine.createSpy('status').and.callFake(() => res),
           setHeader: jasmine.createSpy('setHeader').and.callFake(() => res),
           end: jasmine.createSpy('end'),
         };

         await route!.route!.stack[0].handle(req, res, () => {});

         expect(getTokenSpy).toHaveBeenCalledWith('auth-code-123');
         expect(mockFetch).toHaveBeenCalledWith(
           'https://www.googleapis.com/oauth2/v2/userinfo',
           jasmine.any(Object)
         );
         expect(res.cookie).toHaveBeenCalled();
         expect(res.status).toHaveBeenCalledWith(302);
         expect(res.setHeader).toHaveBeenCalledWith('Location', '/');
         expect(res.end).toHaveBeenCalled();
       });
  });

  describe('authenticate middleware', () => {
    let mockConfig: Config;
    let mockOAuth2Client: {
      setCredentials: jasmine.Spy; getAccessToken: jasmine.Spy; on: jasmine.Spy;
    };

    beforeEach(() => {
      mockConfig = {
        session_config: {
          encryption_key_secret: mockEncryptionKey,
        },
        auth_providers: [
          {
            id: 'google-workspace',
            type: 'google_identity',
            display_name: 'Sign in with Google',
            client_id: 'my-client-id',
            client_secret_secret: 'my-client-secret',
          },
        ],
      };

      setCredentialsSpy = spyOn(googleAuth.OAuth2Client.prototype, 'setCredentials');
      getAccessTokenSpy = spyOn(googleAuth.OAuth2Client.prototype, 'getAccessToken') as jasmine.Spy;
      getAccessTokenSpy.and.returnValue(Promise.resolve({token: 'valid-token'} as any));
      onSpy = spyOn(googleAuth.OAuth2Client.prototype, 'on');
    });

    it('should authenticate valid session and call next', async () => {
      const sessionData: SessionData = {
        user: {id: '123', email: 'test@example.com', name: 'Test User'},
        token: {access_token: 'valid-token', expiry_date: Date.now() + 100000},
      };
      const encrypted = encryptSession(sessionData, mockEncryptionKey);

      const req = {
        cookies: {
          GeEvalSession: encrypted,
        },
      } as unknown as Request;
      const res = {} as unknown as Response;
      const next = jasmine.createSpy('next');

      const middleware = createAuthenticateMiddleware(mockConfig);
      await middleware(req, res, next);

      expect(setCredentialsSpy).toHaveBeenCalledWith(sessionData.token);
      expect(req.session?.user?.id).toBe('123');
      expect(req.session?.token.access_token).toBe('valid-token');
      expect(next).toHaveBeenCalled();
    });

    it('should refresh token and update cookie if expired', async () => {
      const sessionData: SessionData = {
        user: {id: '123', email: 'test@example.com', name: 'Test User'},
        token:
            {access_token: 'expired-token', expiry_date: Date.now() - 10000},
      };
      const encrypted = encryptSession(sessionData, mockEncryptionKey);

      const req = {
        cookies: {
          GeEvalSession: encrypted,
        },
      } as unknown as Request;
      const res = {
        cookie: jasmine.createSpy('cookie'),
      } as unknown as Response;
      const next = jasmine.createSpy('next');

      getAccessTokenSpy.and.callFake(async () => {
        const listener = onSpy.calls.mostRecent().args[1];
        listener({access_token: 'new-token', expiry_date: Date.now() + 100000});
        return {token: 'new-token'};
      });

      const middleware = createAuthenticateMiddleware(mockConfig);
      await middleware(req, res, next);

      expect(setCredentialsSpy).toHaveBeenCalledWith(sessionData.token);
      expect(res.cookie).toHaveBeenCalled();
      expect(req.session?.user?.id).toBe('123');
      expect(req.session?.token?.access_token).toBe('new-token');
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 if no session cookie', async () => {
      const req = {cookies: {}} as unknown as Request;
      const res = {
        status: jasmine.createSpy('status').and.returnValue({
          json: jasmine.createSpy('json'),
        }),
      } as unknown as Response;
      const next = jasmine.createSpy('next');

      const middleware = createAuthenticateMiddleware(mockConfig);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if session is invalid', async () => {
      const req = {
        cookies: {
          GeEvalSession: 'invalid-cookie-content',
        },
      } as unknown as Request;
      const res = {
        clearCookie: jasmine.createSpy('clearCookie'),
        status: jasmine.createSpy('status').and.returnValue({
          json: jasmine.createSpy('json'),
        }),
      } as unknown as Response;
      const next = jasmine.createSpy('next');

      const middleware = createAuthenticateMiddleware(mockConfig);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.clearCookie).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });
});
