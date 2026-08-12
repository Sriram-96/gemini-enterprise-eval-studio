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

import * as nodeCrypto from 'crypto';
import {NextFunction, Request, Response, Router} from 'express';
import {IdentityPoolClient, OAuth2Client} from 'google-auth-library';

import * as zlib from 'zlib';

import {AuthProvider, Config} from './config';
import {SessionData} from './types';

/**
 * Key derivation from the config secret.
 */
function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(nodeCrypto.createHash('sha256').update(secret).digest());
}

/**
 * Encrypts session data using AES-256-GCM.
 */
export function encryptSession(
    sessionData: SessionData, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv(
      'aes-256-gcm', Uint8Array.from(key), Uint8Array.from(iv));

  let encrypted = cipher.update(JSON.stringify(sessionData), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts session data using AES-256-GCM.
 */
export function decryptSession(
    encryptedSession: string, encryptionKey: string): SessionData {
  const [ivHex, tagHex, encryptedHex] = encryptedSession.split(':');
  if (!ivHex || !encryptedHex || !tagHex) {
    throw new Error('Invalid session cookie format');
  }

  const key = deriveKey(encryptionKey);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = nodeCrypto.createDecipheriv(
      'aes-256-gcm', Uint8Array.from(key), Uint8Array.from(iv));
  decipher.setAuthTag(Uint8Array.from(tag));

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted) as SessionData;
}

const TRUSTED_HOST_PATTERN =
    /^([a-z0-9-]+-[a-z0-9-]+\.a\.run\.app|.*\.corp\.google\.com|localhost(:\d+)?)$/i;

/**
 * Escapes special XML characters to prevent XML injection.
 */
export function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Validates the Host header and builds the canonical redirect URI for authentication.
 */
export function getValidatedRedirectUri(req: Request, isProd: boolean): string {
  if (process.env['BASE_URL']) {
    return `${process.env['BASE_URL'].replace(/\/$/, '')}/auth/callback`;
  }

  const host = req.get('host');
  if (!host || !TRUSTED_HOST_PATTERN.test(host)) {
    throw new Error(`Untrusted or invalid Host header: ${host}`);
  }

  const protocol = isProd ? 'https' : req.protocol;
  return `${protocol}://${host}/auth/callback`;
}

/**
 * Custom cookie parser middleware since third_party/javascript/node_modules
 * does not contain cookie-parser.
 */
export function cookieParserMiddleware(
    req: Request, res: Response, next: NextFunction) {
  const cookieHeader = req.headers.cookie;
  const cookies: {[key: string]: string} = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        try {
          cookies[name] = decodeURIComponent(value);
        } catch {
          cookies[name] = value;
        }
      }
    });
  }
  req.cookies = cookies;
  next();
}

/**
 * Middleware to authenticate requests, verifying and automatically
 * refreshing the Google OAuth2 access token if needed.
 */
export function createAuthenticateMiddleware(config: Config) {
  const sessionConfig = config.session_config;
  const encryptionKey = sessionConfig.encryption_key_secret;
  const isProd = process.env['NODE_ENV'] === 'production';
  const cookieName = isProd ? '__Host-GeEvalSession' : 'GeEvalSession';
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 3600000, // 1 hour
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const encryptedSession = req.cookies?.[cookieName];
    if (!encryptedSession) {
      res.status(401).json({error: 'Unauthorized: No session cookie'});
      return;
    }

    try {
      const session = decryptSession(encryptedSession, encryptionKey);

      const provider = session.providerId ?
          config.auth_providers.find(p => p.id === session.providerId) :
          config.auth_providers.find(p => p.type === 'google_identity');

      if (!provider || provider.type !== 'google_identity') {
        if (session.token.expiry_date &&
            Date.now() >= session.token.expiry_date) {
          throw new Error(
              'Access token expired for non-google_identity provider.');
        }
        req.session = session;
        next();
        return;
      }

      const oauth2Client = new OAuth2Client(
          provider.client_id, provider.client_secret_secret);
      oauth2Client.setCredentials(session.token);

      let tokensRefreshed = false;
      let refreshedTokens = {...session.token};
      oauth2Client.on('tokens', (newTokens) => {
        refreshedTokens = {...refreshedTokens, ...newTokens};
        tokensRefreshed = true;
      });

      const tokenRes = await oauth2Client.getAccessToken();
      const freshAccessToken = tokenRes.token;

      if (!freshAccessToken) {
        throw new Error('Failed to obtain fresh access token.');
      }

      if (tokensRefreshed) {
        const updatedSession = {
          ...session,
          token: refreshedTokens,
        };
        const newEncryptedSession =
            encryptSession(updatedSession, encryptionKey);
        res.cookie(cookieName, newEncryptedSession, cookieOptions);
      }

      session.token = {
        ...session.token,
        access_token: freshAccessToken
      };
      req.session = session;
      next();
    } catch (err) {
      res.clearCookie(cookieName, cookieOptions);
      res.status(401).json({error: 'Unauthorized: Session invalid or expired'});
    }
  };
}

/**
 * Factory for creating the authentication Express router.
 */
export function createAuthRouter(config: Config): Router {
  const router = Router();
  const sessionConfig = config.session_config;
  const encryptionKey = sessionConfig.encryption_key_secret;

  const isProd = process.env['NODE_ENV'] === 'production';
  const cookieName = isProd ? '__Host-GeEvalSession' : 'GeEvalSession';
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 3600000, // 1 hour
  };

  const stateCookieName = isProd ? '__Host-GeEvalState' : 'GeEvalState';
  const stateCookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 300000, // 5 minutes
  };

  const getGoogleProvider = (): AuthProvider|undefined => {
    return config.auth_providers.find(p => p.type === 'google_identity');
  };

  // 1. GET /api/auth/providers
  router.get('/api/auth/providers', (req: Request, res: Response) => {
    const providers = config.auth_providers.map(p => ({
                                                   id: p.id,
                                                   type: p.type,
                                                   display_name: p.display_name,
                                                   client_id: p.client_id,
                                                   idp_issuer_url: p.idp_issuer_url,
                                                 }));
    res.json(providers);
  });

  // 2. GET /auth/login
  router.get('/auth/login', async (req: Request, res: Response) => {
    const providerId = req.query['provider'] as string;
    const provider = config.auth_providers.find(p => p.id === providerId);

    if (!provider) {
      res.status(400).send('Invalid or missing provider parameter.');
      return;
    }

    // 1. Generate 32-byte cryptographically secure random nonce
    const nonce = nodeCrypto.randomBytes(32).toString('hex');

    // 2. Create base64url-encoded state payload
    const statePayload = JSON.stringify({ providerId: provider.id, nonce });
    const state = Buffer.from(statePayload, 'utf8').toString('base64url');

    // 3. Save nonce in a short-lived HTTP-only cookie
    res.cookie(stateCookieName, nonce, stateCookieOptions);

    let redirectUri: string;
    try {
      redirectUri = getValidatedRedirectUri(req, isProd);
    } catch (err) {
      res.status(400).send((err as Error).message);
      return;
    }

    if (provider.type === 'google_identity') {
      const oauth2Client = new OAuth2Client(
          provider.client_id, provider.client_secret_secret, redirectUri);

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'
        ],
        prompt: 'select_account',
        state: state,
      });

      res.status(302).setHeader('Location', authUrl).end();
    } else if (provider.type === '3p_saml') {
      try {
        const idpSsoUrl = provider['idp_sso_url'] as string;
        const samlEntityId = `https://iam.googleapis.com/locations/global/workforcePools/${provider.gcp_pool_id}/providers/${provider.gcp_provider_id}`;

        const escapedIdpSsoUrl = escapeXml(idpSsoUrl);
        const escapedSamlEntityId = escapeXml(samlEntityId);
        const escapedRedirectUri = escapeXml(redirectUri);

        const authnRequest =
            `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${
                nodeCrypto.randomUUID()}" Version="2.0" IssueInstant="${
                new Date().toISOString()}" Destination="${
                escapedIdpSsoUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="${
                escapedRedirectUri}">
  <saml:Issuer>${escapedSamlEntityId}</saml:Issuer>
</samlp:AuthnRequest>`;

        const deflated = zlib.deflateRawSync(authnRequest);
        const samlRequest = deflated.toString('base64');

        const params = new URLSearchParams(
            {SAMLRequest: samlRequest, RelayState: state});
        res.status(302).setHeader('Location', `${idpSsoUrl}?${params.toString()}`).end();
      } catch (err) {
        res.status(500).send(
            `Failed to initiate SAML login: ${(err as Error).message}`);
      }
    } else if (provider.type === '3p_oidc') {
      try {
        const discoveryRes = await fetch(
            `${provider.idp_issuer_url}/.well-known/openid-configuration`);
        if (!discoveryRes.ok) throw new Error('Failed to fetch OIDC discovery');
        const discovery = await discoveryRes.json();

        const params = new URLSearchParams({
          client_id: provider.client_id || '',
          response_type: 'code',
          scope: 'openid email',
          redirect_uri: redirectUri,
          state: state
        });
        res.status(302).setHeader('Location', `${discovery.authorization_endpoint}?${params.toString()}`).end();
      } catch (err) {
        res.status(500).send(
            `Failed to initiate OIDC login: ${(err as Error).message}`);
      }
    } else {
      res.status(501).send(
          `Provider type ${(provider as {type?: string}).type} not yet implemented.`);
    }
  });

  // 3. GET/POST /auth/callback
  router.all('/auth/callback', async (req: Request, res: Response) => {
    const code = (req.query['code'] || req.body?.code) as string | undefined;
    const stateStr = (req.query['state'] || req.body?.state ||
                      req.body?.RelayState) as string | undefined;
    const samlResponse = req.body?.SAMLResponse as string | undefined;

    if (!code && !samlResponse) {
      res.status(400).send('Authorization code or SAMLResponse is missing.');
      return;
    }

    // 1. Retrieve the expected nonce from the browser's cookie
    const expectedNonce = req.cookies?.[stateCookieName];

    // 2. Immediately clear the state cookie to prevent replay attacks
    res.clearCookie(stateCookieName, stateCookieOptions);

    if (!stateStr) {
      res.status(400).send('State or RelayState parameter is missing.');
      return;
    }

    // 3. Decode state parameter
    let stateObj: { providerId?: string; nonce?: string } = {};
    try {
      const jsonStr = Buffer.from(stateStr, 'base64url').toString('utf8');
      stateObj = JSON.parse(jsonStr) as { providerId?: string; nonce?: string };
    } catch (err) {
      res.status(400).send('Invalid state parameter encoding.');
      return;
    }

    // 4. Verify CSRF Nonce
    if (
      !expectedNonce ||
      !stateObj.nonce ||
      expectedNonce.length !== stateObj.nonce.length ||
      !nodeCrypto.timingSafeEqual(
          new Uint8Array(Buffer.from(expectedNonce)),
          new Uint8Array(Buffer.from(stateObj.nonce)))
    ) {
      res.status(403).send('CSRF validation failed: State/nonce mismatch.');
      return;
    }

    const providerId = stateObj.providerId;
    const provider = providerId ?
        config.auth_providers.find(p => p.id === providerId) :
        getGoogleProvider();

    if (!provider) {
      res.status(500).send(
          'Authentication provider is not configured or not found.');
      return;
    }

    try {
      const redirectUri = getValidatedRedirectUri(req, isProd);
      let sessionData: SessionData;

      if (provider.type === 'google_identity') {
        const oauth2Client = new OAuth2Client(
            provider.client_id, provider.client_secret_secret, redirectUri);

        const {tokens} = await oauth2Client.getToken(code as string);

        const userInfoRes = await fetch(
            'https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: {Authorization: `Bearer ${tokens.access_token}`}
            });
        if (!userInfoRes.ok) {
          throw new Error(
              `Failed to fetch user info: ${await userInfoRes.text()}`);
        }
        const userInfo = await userInfoRes.json() as
            {email?: string, name?: string, id?: string};

        sessionData = {
          providerId: provider.id,
          user: {
            email: userInfo.email,
            name: userInfo.name || userInfo.email,
            id: userInfo.id,
          },
          token: {
            access_token: tokens.access_token,
            expiry_date: tokens.expiry_date,
          },
        };
      } else if (provider.type === '3p_saml') {
        if (!samlResponse)
          throw new Error('SAMLResponse is missing for SAML provider.');

        const client = new IdentityPoolClient({
          type: 'external_account',
          audience: `//iam.googleapis.com/locations/global/workforcePools/${provider.gcp_pool_id}/providers/${provider.gcp_provider_id}`,
          subject_token_type: 'urn:ietf:params:oauth:token-type:saml2',
          token_url: 'https://sts.googleapis.com/v1/token',
          subject_token_supplier: {
            getSubjectToken: async () => samlResponse
          }
        });

        const {token: accessToken} = await client.getAccessToken();

        // Basic user info extraction from SAML XML without a full parser
        const decodedSaml =
            Buffer.from(samlResponse, 'base64').toString('utf8');
        const nameIdMatch =
            decodedSaml.match(/<(?:\w+:)?NameID[^>]*>([^<]+)<\/(?:\w+:)?NameID>/);
        const nameId = nameIdMatch ? nameIdMatch[1] : 'unknown-saml-user';

        sessionData = {
          providerId: provider.id,
          user: {
            email: nameId,
            name: nameId,
            id: nameId,
          },
          token: {
            access_token: accessToken || undefined,
            expiry_date: client.credentials?.expiry_date,
          },
        };
      } else if (provider.type === '3p_oidc') {
        const discoveryRes = await fetch(
            `${provider.idp_issuer_url}/.well-known/openid-configuration`);
        if (!discoveryRes.ok) throw new Error('Failed to fetch OIDC discovery');
        const discovery = await discoveryRes.json();

        const tokenRes = await fetch(discovery.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' +
                Buffer
                    .from(`${provider.client_id}:${
                        provider.client_secret_secret}`)
                    .toString('base64')
          },
          body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  code: code as string,
                  redirect_uri: redirectUri
                }).toString()
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok)
          throw new Error(
              `Failed to get OIDC token: ${JSON.stringify(tokenData)}`);

        const idToken = tokenData.id_token;
        if (!idToken)
          throw new Error('OIDC provider did not return an id_token');

        const payloadBase64 = idToken.split('.')[1];
        const payloadStr =
            Buffer.from(payloadBase64, 'base64').toString('utf8');
        const payload = JSON.parse(payloadStr) as
            {email?: string, name?: string, sub?: string};

        const client = new IdentityPoolClient({
          type: 'external_account',
          audience: `//iam.googleapis.com/locations/global/workforcePools/${provider.gcp_pool_id}/providers/${provider.gcp_provider_id}`,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          token_url: 'https://sts.googleapis.com/v1/token',
          subject_token_supplier: {
            getSubjectToken: async () => idToken
          }
        });

        const {token: accessToken} = await client.getAccessToken();

        sessionData = {
          providerId: provider.id,
          user: {
            email: payload.email,
            name: payload.name || payload.email,
            id: payload.sub,
          },
          token: {
            access_token: accessToken || undefined,
            expiry_date: client.credentials?.expiry_date,
          },
        };
      } else {
        throw new Error(`Provider type ${(provider as {type?: string}).type} not yet implemented.`);
      }

      const encryptedSession = encryptSession(sessionData, encryptionKey);
      res.cookie(cookieName, encryptedSession, cookieOptions);

      res.status(302).setHeader('Location', '/').end();
    } catch (err) {
      res.status(500).send(`Authentication failed: ${(err as Error).message}`);
    }
  });

  // 4. POST /auth/logout
  router.post('/auth/logout', (req: Request, res: Response) => {
    res.clearCookie(cookieName, cookieOptions);
    res.status(200).send({success: true});
  });

  // 5. GET /api/auth/user
  router.get('/api/auth/user', async (req: Request, res: Response) => {
    const encryptedSession = req.cookies?.[cookieName];
    if (!encryptedSession) {
      res.status(401).json({authenticated: false});
      return;
    }

    try {
      const session = decryptSession(encryptedSession, encryptionKey);
      res.json({
        authenticated: true,
        user: session.user,
      });
    } catch (err) {
      res.clearCookie(cookieName, cookieOptions);
      res.status(401).json({authenticated: false, error: 'Invalid session'});
    }
  });

  return router;
}
