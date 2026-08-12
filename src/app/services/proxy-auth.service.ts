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

import {HttpClient} from '@angular/common/http';
import {Injectable, NgZone} from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';

import {AuthProvider, AuthService} from './auth.service';

/**
 * Implementation of AuthService that proxies requests to the Express backend.
 */
@Injectable()
export class ProxyAuthService extends AuthService {
  override readonly showCredentialInputs = false;
  private readonly isAuthenticatedSubject = new BehaviorSubject<boolean>(false);
  private readonly isAuthCheckedSubject = new BehaviorSubject<boolean>(false);
  private readonly providersSubject = new BehaviorSubject<AuthProvider[]>([]);
  private readonly isLoadingProvidersSubject = new BehaviorSubject<boolean>(false);

  override readonly isAuthenticated$: Observable<boolean> =
      this.isAuthenticatedSubject.asObservable();
  override readonly isAuthChecked$: Observable<boolean> =
      this.isAuthCheckedSubject.asObservable();
  override readonly providers$: Observable<AuthProvider[]> =
      this.providersSubject.asObservable();
  override readonly isLoadingProviders$: Observable<boolean> =
      this.isLoadingProvidersSubject.asObservable();

  constructor(
      private readonly http: HttpClient,
      private readonly zone: NgZone
  ) {
    super();
  }

  override checkAuth(): void {
    this.http.get<{authenticated: boolean}>('/api/auth/user').subscribe({
      next: (res) => {
        this.zone.run(() => {
          this.isAuthenticatedSubject.next(res.authenticated);
          this.isAuthCheckedSubject.next(true);
          if (!res.authenticated) {
            this.loadProviders();
          }
        });
      },
      error: (err) => {
        this.zone.run(() => {
          console.error('Auth check failed:', err);
          this.isAuthenticatedSubject.next(false);
          this.isAuthCheckedSubject.next(true);
          this.loadProviders();
        });
      }
    });
  }

  override loadProviders(): void {
    this.isLoadingProvidersSubject.next(true);
    this.http.get<AuthProvider[]>('/api/auth/providers').subscribe({
      next: (res) => {
        this.zone.run(() => {
          this.providersSubject.next(res);
          this.isLoadingProvidersSubject.next(false);
        });
      },
      error: (err) => {
        this.zone.run(() => {
          console.error('Failed to load auth providers:', err);
          this.isLoadingProvidersSubject.next(false);
        });
      }
    });
  }

  override loginWithProvider(providerId: string): void {
    window.location.href = `/auth/login?provider=${providerId}`;
  }

  override logout(): void {
    this.http.post('/auth/logout', {}).subscribe({
      next: () => {
        window.location.reload();
      },
      error: (err) => {
        console.error('Logout failed', err);
      }
    });
  }
}
