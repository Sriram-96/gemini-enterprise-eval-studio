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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {BehaviorSubject} from 'rxjs';

import {AppConfig, Engine} from '../../../models/app-config.model';
import {ScoreResult, Scorer, ScoringRequest} from '../../../scoring/scorer';
import {SCORERS} from '../../../scoring/scorer.registry';
import {AuthService} from '../../../services/auth.service';
import {EvalBackendService} from '../../../services/eval-backend.service';
import {StateService} from '../../../services/state.service';
import {MockAuthService, MockEvalBackendService} from '../../../testing/mocks';

import {ConfigFormComponent} from './config-form.component';

/** A scorer whose identity, config keys and validation are test controlled. */
class FakeScorer extends Scorer {
  constructor(
      readonly id: string, readonly displayName: string,
      override readonly configKeys: readonly (keyof AppConfig)[] = [],
      private readonly error: string|null = null) {
    super();
  }

  async score(request: ScoringRequest): Promise<ScoreResult> {
    return {score: 1};
  }

  override validate(config: AppConfig): string|null {
    return this.error;
  }
}

const BASE_CONFIG: AppConfig = {
  projectId: '',
  region: 'global',
  selectedEngine: '',
  selectedModel: '',
  autoRaterModel: '',
  autoRaterInstruction: '',
  selectedDataStores: [],
  enableWebSearch: false
};

describe('ConfigFormComponent multi-scorer selection', () => {
  let fixture: ComponentFixture<ConfigFormComponent>;
  let component: ConfigFormComponent;
  let mockStateService: jasmine.SpyObj<StateService>;
  let configSubject: BehaviorSubject<AppConfig>;

  /** Builds the component with the given scorers registered. */
  async function setUp(scorers: Scorer[], config: Partial<AppConfig> = {}) {
    configSubject = new BehaviorSubject<AppConfig>({...BASE_CONFIG, ...config});
    mockStateService = jasmine.createSpyObj(
        'StateService',
        ['setConfig', 'setEngines', 'getCurrentConfig', 'setErrorMessage'], {
          config$: configSubject.asObservable(),
          engines$: new BehaviorSubject<Engine[]>([]).asObservable(),
          errorMessage$: new BehaviorSubject<string>('').asObservable()
        });
    mockStateService.getCurrentConfig.and.callFake(() => configSubject.value);

    await TestBed
        .configureTestingModule({
          imports: [ConfigFormComponent],
          providers: [
            {provide: StateService, useValue: mockStateService},
            {provide: AuthService, useValue: new MockAuthService()},
            {provide: EvalBackendService, useValue: new MockEvalBackendService()},
            {provide: SCORERS, useValue: scorers},
          ]
        })
        .compileComponents();

    fixture = TestBed.createComponent(ConfigFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /** The scorer checkboxes currently rendered, in DOM order. */
  function checkboxes(): HTMLInputElement[] {
    return Array.from(
        fixture.nativeElement.querySelectorAll(
            'input[type="checkbox"][aria-label]') as
        NodeListOf<HTMLInputElement>);
  }

  it('should hide the picker when only one scorer is registered', async () => {
    await setUp([new FakeScorer('only', 'Only')]);
    expect(checkboxes().length).toBe(0);
    expect(component.getSelectedScorers().map(s => s.id)).toEqual(['only']);
  });

  it('should render a checkbox per scorer when several are registered',
     async () => {
       await setUp([new FakeScorer('a', 'A'), new FakeScorer('b', 'B')]);
       expect(checkboxes().map(input => input.getAttribute('aria-label')))
           .toEqual(['A', 'B']);
       // Only the default is checked out of the box.
       expect(checkboxes().map(input => input.checked)).toEqual([true, false]);
     });

  it('should add a scorer to the selection when its checkbox is clicked',
     async () => {
       await setUp([new FakeScorer('a', 'A'), new FakeScorer('b', 'B')]);
       checkboxes()[1].click();
       fixture.detectChanges();

       expect(component.config.selectedScorers).toEqual(['a', 'b']);
       expect(checkboxes().map(input => input.checked)).toEqual([true, true]);
       expect(mockStateService.setConfig).toHaveBeenCalled();
     });

  it('should remove a scorer from the selection when unchecked', async () => {
    await setUp(
        [new FakeScorer('a', 'A'), new FakeScorer('b', 'B')],
        {selectedScorers: ['a', 'b']});
    checkboxes()[0].click();
    fixture.detectChanges();

    expect(component.config.selectedScorers).toEqual(['b']);
    expect(checkboxes().map(input => input.checked)).toEqual([false, true]);
  });

  it('should disable the last remaining scorer so it cannot be removed',
     async () => {
       await setUp([new FakeScorer('a', 'A'), new FakeScorer('b', 'B')]);
       expect(checkboxes()[0].disabled).toBeTrue();

       component.toggleScorer(component.scorers[0]);
       expect(component.getSelectedScorers().map(s => s.id)).toEqual(['a']);
     });

  it('should summarize the selection', async () => {
    await setUp([new FakeScorer('a', 'A'), new FakeScorer('b', 'B')]);
    expect(component.getSelectedScorersSummary()).toBe('A');

    component.toggleScorer(component.scorers[1]);
    expect(component.getSelectedScorersSummary()).toBe('2 Scorers Selected');
  });

  it('should drop unknown scorer ids from the incoming config', async () => {
    await setUp(
        [new FakeScorer('a', 'A'), new FakeScorer('b', 'B')],
        {selectedScorers: ['ghost', 'b']});
    expect(component.config.selectedScorers).toEqual(['b']);
    expect(mockStateService.setConfig).toHaveBeenCalled();
  });

  it('should fall back to the default when the config names no scorer',
     async () => {
       await setUp(
           [new FakeScorer('a', 'A'), new FakeScorer('b', 'B')],
           {selectedScorers: []});
       expect(component.config.selectedScorers).toEqual(['a']);
     });

  it('should render a config input only while a selected scorer needs it',
     async () => {
       await setUp([
         new FakeScorer('a', 'A'), new FakeScorer('b', 'B', ['autoRaterModel'])
       ]);
       expect(component.usesConfigKey('autoRaterModel')).toBeFalse();

       component.toggleScorer(component.scorers[1]);
       expect(component.usesConfigKey('autoRaterModel')).toBeTrue();
     });

  it('should surface the first validation error across selected scorers',
     async () => {
       await setUp(
           [
             new FakeScorer('a', 'A'), new FakeScorer('b', 'B', [], 'B is off')
           ],
           {selectedScorers: ['a', 'b']});
       expect(component.getScorerValidationError()).toBe('B is off');
       expect(component.canProceed()).toBeFalse();
     });
});
