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

import {Injectable} from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';

import {AuthProvider, AuthService} from './auth.service';

/**
 * No-op Authentication Service for no-auth mode.
 * Bypasses authentication and enables credential inputs in the UI.
 */
@Injectable()
export class NoopAuthService extends AuthService {
  override readonly showCredentialInputs = true;
  override readonly isAuthenticated$ = new BehaviorSubject<boolean>(true).asObservable();
  override readonly isAuthChecked$ = new BehaviorSubject<boolean>(true).asObservable();
  override readonly isLoadingProviders$ = new BehaviorSubject<boolean>(false).asObservable();
  override readonly providers$ = new BehaviorSubject<AuthProvider[]>([]).asObservable();

  override checkAuth(): void {}
  override loadProviders(): void {}
  override loginWithProvider(providerId: string): void {}
  override logout(): void {}
}
