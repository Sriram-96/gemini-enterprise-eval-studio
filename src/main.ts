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

import {bootstrapApplication} from '@angular/platform-browser';

import {AppComponent} from './app/app.component';
import {AuthService} from './app/services/auth.service';
import {DirectGcpEvalBackendService} from './app/services/direct-gcp-eval-backend.service';
import {EvalBackendService} from './app/services/eval-backend.service';
import {NoopAuthService} from './app/services/noop-auth.service';
import {StateService} from './app/services/state.service';

bootstrapApplication(AppComponent, {
  providers: [
    StateService,
    {provide: AuthService, useClass: NoopAuthService},
    {provide: EvalBackendService, useClass: DirectGcpEvalBackendService},
  ]
}).catch((err) => console.error(err));

