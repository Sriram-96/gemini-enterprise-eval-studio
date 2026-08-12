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
 * See the License for the License for the specific language governing permissions and
 * limitations under the License.
 */



/** User data stored in the session. */
export interface UserSessionData {
  email: string | null | undefined;
  name: string | null | undefined;
  id: string | null | undefined;
}

/** Token data stored in the session. */
export interface TokenSessionData {
  access_token?: string | null;
  expiry_date?: number | null;
}

/** Combined session data. */
export interface SessionData {
  providerId?: string;
  user: UserSessionData;
  token: TokenSessionData;
}

declare global {
  namespace Express {
    interface Request {
      cookies?: { [key: string]: string };
      session?: SessionData;
    }
  }
}
