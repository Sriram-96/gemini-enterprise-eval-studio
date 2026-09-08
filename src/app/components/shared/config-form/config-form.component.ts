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

import {CommonModule} from '@angular/common';
import {HttpErrorResponse} from '@angular/common/http';
import {ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output, ViewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Subject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';

import {Agent, agentDisplayName, isRunnableAgent} from '../../../models/agent.model';
import {AppConfig, CollectionComponent, DataStoreComponent, Engine, WidgetConfigResponse} from '../../../models/app-config.model';
import {MemorySupport, readMemorySupport} from '../../../models/memory.model';
import {Scorer} from '../../../scoring/scorer';
import {ScorerRegistry} from '../../../scoring/scorer.registry';
import {AuthService} from '../../../services/auth.service';
import {EvalBackendService} from '../../../services/eval-backend.service';
import {StateService} from '../../../services/state.service';
import {ConnectorMetadata, inferConnectorMetadata} from '../connector.util';
import {InfoTooltipComponent} from '../../shared/info-tooltip/info-tooltip.component';

/**
 * Represents a connector option for selection in the UI.
 */
export interface ConnectorOption {
  id: string;
  displayName: string;
  dataSource?: string;
  entityIds: string[];
}

interface EnginesResponse {
  engines?: Engine[];
}


/**
 * Component for configuring evaluation settings.
 */
@Component({
  selector: 'app-config-form',
  standalone: true,
  imports: [CommonModule, FormsModule, InfoTooltipComponent],
  templateUrl: './config-form.component.html'
})
export class ConfigFormComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();
  @Output() readonly next = new EventEmitter<void>();
  @Input() isRunQueries = false;
  @ViewChild('dropdownContainer') dropdownContainer?: ElementRef;

  config: AppConfig = {
    projectId: '',
    region: 'global',
    selectedEngine: '',
    selectedModel: '',
    selectedAgent: '',
    autoRaterModel: '',
    autoRaterInstruction: '',
    selectedDataStores: [],
    enableWebSearch: false
  };

  autoRaterModels: string[] = ['gemini-3.1-pro-preview', 'gemini-3.5-flash'];
  autoRaterErrorMessage = '';

  /** All registered scoring strategies, in display order. */
  readonly scorers: readonly Scorer[];

  engines: Engine[] = [];
  models: string[] = [];
  loading = false;
  errorMessage = '';

  /**
   * Agents published under the selected engine that can serve a query,
   * refreshed whenever the engine changes.
   */
  agents: Agent[] = [];
  agentsLoading = false;
  /**
   * Why the agent list is empty, when the reason is a failed lookup rather than
   * an engine without agents. Shown beside the picker instead of in
   * `errorMessage`, which belongs to the engine fetch: an engine whose agents
   * cannot be listed is still perfectly usable with its default assistant.
   */
  agentsErrorMessage = '';

  isDropdownOpen = false;
  connectorSearchQuery = '';
  connectors: ConnectorOption[] = [];

  constructor(
      private readonly stateService: StateService,
      private readonly cdr: ChangeDetectorRef,
      readonly authService: AuthService,
      private readonly evalBackendService: EvalBackendService,
      private readonly scorerRegistry: ScorerRegistry
  ) {
    this.scorers = this.scorerRegistry.list();
  }

  ngOnInit() {
    if (!this.authService.showCredentialInputs) {
      this.autoRaterModels = ['gemini-3.5-flash', 'gemini-3.1-pro'];
    }

    this.stateService.config$.pipe(takeUntil(this.destroy$))
        .subscribe((c: AppConfig) => {
          const engineChanged = this.config.selectedEngine !== c.selectedEngine;
          this.config = structuredClone(c);
          const configured = this.config.selectedScorers ?? [];
          const known = configured.filter(id => !!this.scorerRegistry.find(id));
          const normalized =
              known.length > 0 ? known : this.scorerRegistry.defaultIds;
          if (normalized.length !== configured.length ||
              normalized.some((id, i) => id !== configured[i])) {
            this.config.selectedScorers = normalized;
            this.onConfigChange();
          }
          if (this.engines.length > 0) {
            this.updateModelsForSelectedEngine();
            if (engineChanged) {
              this.fetchConnectorsForSelectedEngine();
              this.fetchAgentsForSelectedEngine();
            }
          }
          if (this.autoRaterModels.length > 0 && (!this.config.autoRaterModel || !this.autoRaterModels.includes(this.config.autoRaterModel))) {
            this.config.autoRaterModel = this.autoRaterModels[0];
            this.onConfigChange();
          }
        });

    this.stateService.engines$.pipe(takeUntil(this.destroy$))
        .subscribe((engines: Engine[]) => {
          this.engines = engines;
          if (this.config.selectedEngine && this.engines.length > 0) {
            this.updateModelsForSelectedEngine();
            this.fetchConnectorsForSelectedEngine();
            this.fetchAgentsForSelectedEngine();
          }
        });

    this.stateService.errorMessage$.pipe(takeUntil(this.destroy$))
        .subscribe((errorMessage: string) => {
          this.errorMessage = errorMessage;
        });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Fetches engines from the discovery engine API.
   */
  fetchEngines() {
    this.errorMessage = '';
    this.stateService.setErrorMessage('');
    if (!this.config.projectId) {
      this.errorMessage = 'Please provide Project ID';
      return;
    }
    this.loading = true;

    this.evalBackendService.fetchEngines(this.config.projectId, this.config.region, this.config)
        .then((engines) => {
          this.loading = false;
          if (engines && engines.length > 0) {
            this.engines = engines.map((e: Engine) => ({
              name: e.name,
              displayName: e.displayName || e.name,
              modelConfigs: e.modelConfigs,
              dataStoreIds: e.dataStoreIds
            }));

            this.stateService.setEngines(this.engines);

            if (this.config.selectedEngine) {
              const exists = this.engines.some(
                  e => e.name === this.config.selectedEngine);
              if (exists) {
                this.onEngineChange();
              } else if (this.engines.length > 0) {
                this.config.selectedEngine = this.engines[0].name;
                this.onEngineChange();
              }
            } else if (this.engines.length > 0) {
              this.config.selectedEngine = this.engines[0].name;
              this.onEngineChange();
            }
          } else {
            this.engines = [];
            this.stateService.setEngines([]);
            this.errorMessage = 'No engines found.';
          }
          this.cdr.detectChanges();
        })
        .catch((error: unknown) => {
          this.loading = false;
          this.engines = [];
          this.stateService.setEngines([]);
          
          console.error('Error fetching engines:', error);
          this.errorMessage =
              `Error fetching engines: ${this.describeError(error)}`;
          this.cdr.detectChanges();
        });
  }

  /**
  /**
   * Handles engine selection change, updating available models.
   */
  /** Populates models list based on selected engine, without resetting selectedModel if it's valid. */
  updateModelsForSelectedEngine() {
    const selected =
        this.engines.find(e => e.name === this.config.selectedEngine);
    if (selected) {
      // TODO b/514218151 - Fix hardcoded default models
      const defaultModels = ['auto'];
      this.models = [...defaultModels];

      if (selected.modelConfigs) {
        for (const [model, status] of Object.entries(selected.modelConfigs)) {
          if (status === 'MODEL_ENABLED' && !this.models.includes(model)) {
            this.models.push(model);
          }
        }
      }

      // Offered only when the engine does not report them itself. Every entry
      // has to be an id streamAssist actually accepts, or the dropdown gains
      // an option that fails the run with a 400.
      const fallbackModels =
          ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.5-flash'];
      for (const model of fallbackModels) {
        if (!selected.modelConfigs || !(model in selected.modelConfigs)) {
          if (!this.models.includes(model)) {
            this.models.push(model);
          }
        }
      }

      // Only overwrite if current model is not valid for this engine
      if (!this.config.selectedModel || !this.models.includes(this.config.selectedModel)) {
        this.config.selectedModel = this.models[0] || '';
      }
    }
  }

  onEngineChange() {
    this.config.selectedDataStores = [];
    // Agents belong to one engine, so a selection cannot survive the switch.
    this.config.selectedAgent = '';
    this.agents = [];
    this.updateModelsForSelectedEngine();
    this.fetchConnectorsForSelectedEngine();
    this.fetchAgentsForSelectedEngine();
    this.onConfigChange();
  }

  /**
   * Loads the agents published under the selected engine into the picker.
   *
   * A failure is reported beside the picker and leaves the run on the default
   * assistant rather than blocking it: listing agents needs a permission that
   * running queries does not, so an engine whose agents cannot be read is still
   * evaluable.
   */
  fetchAgentsForSelectedEngine() {
    this.agentsErrorMessage = '';
    if (!this.config.projectId || !this.config.selectedEngine) {
      this.agents = [];
      // Clears the flag an in-flight lookup for the previous engine set; that
      // lookup will be discarded on arrival and so will never clear it itself.
      this.agentsLoading = false;
      return;
    }

    // Pinned so a slow response for a previously selected engine cannot land
    // on top of the current one and offer agents that engine does not have.
    const requestedEngine = this.config.selectedEngine;
    this.agentsLoading = true;

    this.evalBackendService
        .fetchAgents(
            this.config.projectId, this.config.region, requestedEngine,
            this.config)
        .then((agents) => {
          if (requestedEngine !== this.config.selectedEngine) {
            return;
          }
          this.agentsLoading = false;
          this.agents = (agents || []).filter(isRunnableAgent);
          this.validateAndSyncSelectedAgent();
          this.cdr.detectChanges();
        })
        .catch((error: unknown) => {
          if (requestedEngine !== this.config.selectedEngine) {
            return;
          }
          this.agentsLoading = false;
          this.agents = [];
          console.error('Error fetching agents:', error);
          this.agentsErrorMessage =
              `Could not list agents: ${this.describeError(error)}`;
          this.validateAndSyncSelectedAgent();
          this.cdr.detectChanges();
        });
  }

  /** Reduces a caught error to the message worth showing the user. */
  private describeError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      return error.error?.error?.message || error.message ||
          'See console for details.';
    }
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return 'See console for details.';
  }

  /**
   * Drops a selected agent that the freshly loaded list no longer offers, so
   * the run falls back to the default assistant instead of failing every row
   * against an agent that is gone.
   */
  private validateAndSyncSelectedAgent() {
    if (!this.config.selectedAgent) {
      return;
    }
    if (!this.agents.some(a => a.name === this.config.selectedAgent)) {
      this.config.selectedAgent = '';
      this.onConfigChange();
    }
  }

  /** The label shown for an agent in the picker. */
  agentLabel(agent: Agent): string {
    return agentDisplayName(agent);
  }

  /** The agent the run is pointed at, or undefined for the default assistant. */
  getSelectedAgent(): Agent|undefined {
    return this.agents.find(a => a.name === this.config.selectedAgent);
  }

  fetchConnectorsForSelectedEngine() {
    const engine = this.getSelectedEngine();
    if (!this.config.projectId || !this.config.selectedEngine) {
      this.connectors = this.buildFallbackConnectors(engine);
      this.setMemorySupport('unknown');
      this.validateAndSyncSelectedDataStores();
      return;
    }

    this.evalBackendService.fetchWidgetConfig(
        this.config.projectId,
        this.config.region,
        this.config.selectedEngine,
        this.config
    ).then((widgetData) => {
      if (widgetData) {
        const parsed = this.parseWidgetDataForConnectors(widgetData, engine);
        if (parsed.length > 0) {
          this.connectors = parsed;
        } else {
          this.connectors = this.buildFallbackConnectors(engine);
        }
      } else {
        this.connectors = this.buildFallbackConnectors(engine);
      }
      // The widget config already carries the engine's feature map, so the
      // saved-memory state comes free with the connector fetch rather than
      // costing a second call.
      this.setMemorySupport(readMemorySupport(widgetData));
      this.validateAndSyncSelectedDataStores();
      this.cdr.detectChanges();
    }).catch((error) => {
      console.error('Error fetching widget config:', error);
      this.connectors = this.buildFallbackConnectors(engine);
      this.setMemorySupport('unknown');
      this.validateAndSyncSelectedDataStores();
      this.cdr.detectChanges();
    });
  }

  /**
   * Publishes the detected saved-memory state for the run to consult.
   *
   * Deliberately not surfaced in the form: it is a property of the engine
   * rather than something to configure, and it only matters for query sets
   * that use the `phase` column. The run reports it at the point of use
   * instead, by refusing to seed against an engine that reports it off.
   */
  private setMemorySupport(memorySupport: MemorySupport) {
    this.stateService.setMemorySupport(memorySupport);
  }

  /**
   * Filters selectedDataStores to only retain IDs present in `this.connectors`.
   * If any invalid data stores were removed, triggers `onConfigChange()` to sync state.
   */
  private validateAndSyncSelectedDataStores() {
    if (!this.config.selectedDataStores || this.config.selectedDataStores.length === 0) {
      return;
    }
    const validIds = new Set(this.connectors.flatMap(c => c.entityIds));
    const initialLength = this.config.selectedDataStores.length;
    this.config.selectedDataStores = this.config.selectedDataStores.filter(
        id => validIds.has(id));

    if (this.config.selectedDataStores.length !== initialLength) {
      this.onConfigChange();
    }
  }

  /**
   * Infers normalized connector metadata (key, display name, and data source) from a component or ID string.
   */
  inferConnectorMetadata(componentOrId: { id?: string, displayName?: string, dataSource?: string } | string): ConnectorMetadata {
    return inferConnectorMetadata(componentOrId);
  }

  private isValidConnector(component: CollectionComponent): boolean {
    return !!(
        component.connectorAuthState ||
        component.federatedSearchConnectorAuthUri ||
        (component.dataStoreComponents &&
         component.dataStoreComponents.length > 0) ||
        component.dataSource || component.id);
  }

  private upsertConnector(
      connectorsMap: Map<string, ConnectorOption>,
      meta: {key: string; displayName: string; dataSource?: string},
      entityIds: string[], fallbackDataSource?: string): void {
    const existing = connectorsMap.get(meta.key);
    if (existing) {
      for (const id of entityIds) {
        if (!existing.entityIds.includes(id)) {
          existing.entityIds.push(id);
        }
      }
    } else {
      const option: ConnectorOption = {
        id: meta.key,
        displayName: meta.displayName,
        entityIds: [...entityIds]
      };
      const ds = meta.dataSource || fallbackDataSource;
      if (ds) {
        option.dataSource = ds;
      }
      connectorsMap.set(meta.key, option);
    }
  }

  parseWidgetDataForConnectors(widgetData: WidgetConfigResponse, engine: Engine | undefined): ConnectorOption[] {
    const connectorsMap = new Map<string, ConnectorOption>();
    const coveredEntityIds = new Set<string>();

    if (widgetData?.collectionComponents) {
      for (const component of widgetData.collectionComponents) {
        if (this.isValidConnector(component)) {
          const entityIds: string[] = (component.dataStoreComponents || [])
              .map((ds: DataStoreComponent) => ds.id)
              .filter((id: string | undefined): id is string => !!id);

          const effectiveIds = entityIds.length > 0 ? entityIds : (component.id ? [component.id] : []);
          effectiveIds.forEach(id => coveredEntityIds.add(id));
          const meta = this.inferConnectorMetadata(component);
          this.upsertConnector(
              connectorsMap, meta, effectiveIds, component.dataSource);
        }
      }
    }

    if (engine && engine.dataStoreIds) {
      for (const ds of engine.dataStoreIds) {
        if (!coveredEntityIds.has(ds)) {
          const meta = this.inferConnectorMetadata(ds);
          this.upsertConnector(connectorsMap, meta, [ds]);
        }
      }
    }

    const list = Array.from(connectorsMap.values());
    list.push({
      id: 'Web Search',
      displayName: 'Web Search',
      entityIds: []
    });

    return list;
  }

  buildFallbackConnectors(engine: Engine | undefined): ConnectorOption[] {
    const connectorsMap = new Map<string, ConnectorOption>();
    if (engine && engine.dataStoreIds) {
      engine.dataStoreIds.forEach(ds => {
        const meta = this.inferConnectorMetadata(ds);
        this.upsertConnector(connectorsMap, meta, [ds]);
      });
    }
    const list = Array.from(connectorsMap.values());
    list.push({
      id: 'Web Search',
      displayName: 'Web Search',
      entityIds: []
    });
    return list;
  }

  /**
   * Gets the currently selected engine.
   */
  getSelectedEngine(): Engine|undefined {
    return this.engines.find(e => e.name === this.config.selectedEngine);
  }

  /**
   * Checks if a connector is selected (all of its entityIds must be in selectedDataStores).
   */
  isConnectorSelected(connector: ConnectorOption): boolean {
    if (connector.id === 'Web Search') {
      return this.config.enableWebSearch;
    }
    if (!this.config.selectedDataStores || connector.entityIds.length === 0) {
      return false;
    }
    return connector.entityIds.every(id => this.config.selectedDataStores.includes(id));
  }

  /**
   * Toggles the selection of a connector and all its entityIds.
   */
  toggleConnector(connector: ConnectorOption) {
    if (connector.id === 'Web Search') {
      this.config.enableWebSearch = !this.config.enableWebSearch;
    } else {
      if (!this.config.selectedDataStores) {
        this.config.selectedDataStores = [];
      }
      const currentlySelected = this.isConnectorSelected(connector);
      if (currentlySelected) {
        this.config.selectedDataStores = this.config.selectedDataStores.filter(
            id => !connector.entityIds.includes(id));
      } else {
        for (const id of connector.entityIds) {
          if (!this.config.selectedDataStores.includes(id)) {
            this.config.selectedDataStores.push(id);
          }
        }
      }
    }
    this.onConfigChange();
  }

  /**
   * Updates the global state with the current configuration.
   */
  onConfigChange() {
    this.stateService.setConfig(this.config);
  }

  /**
   * Resets the engines list when the token, project ID, or region is changed.
   */
  changeConfigAndResetEngines() {
    this.config.selectedEngine = '';
    this.config.selectedModel = '';
    this.config.selectedAgent = '';
    this.config.selectedDataStores = [];
    this.config.enableWebSearch = false;
    this.stateService.setConfig(this.config);

    this.engines = [];
    this.agents = [];
    this.agentsErrorMessage = '';
    this.stateService.setEngines([]);
    this.cdr.detectChanges();
  }
  toggleDropdown() {
    this.isDropdownOpen = !this.isDropdownOpen;
  }

  @HostListener('document:click', ['$event'])
  clickout(event: Event) {
    if (this.isDropdownOpen && this.dropdownContainer &&
        !this.dropdownContainer.nativeElement.contains(event.target)) {
      this.isDropdownOpen = false;
    }
  }

  getAllAvailableConnectors(): ConnectorOption[] {
    return this.connectors.length > 0
        ? this.connectors
        : this.buildFallbackConnectors(this.getSelectedEngine());
  }

  filteredConnectors(): ConnectorOption[] {
    const all = this.getAllAvailableConnectors();
    if (!this.connectorSearchQuery) {
      return all;
    }
    const q = this.connectorSearchQuery.toLowerCase();
    return all.filter(c => c.displayName.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }

  getSelectedConnectorsSummary(): string {
    const allConnectors = this.getAllAvailableConnectors();
    let count = 0;
    for (const connector of allConnectors) {
      if (this.isConnectorSelected(connector)) {
        count++;
      }
    }
    if (count === 0) {
      return 'Select Connectors';
    }
    return `${count} Connector${count > 1 ? 's' : ''} Selected`;
  }

  /** Gets the scoring strategies that will run, in run order. */
  getSelectedScorers(): readonly Scorer[] {
    return this.scorerRegistry.resolveAll(this.config.selectedScorers);
  }

  /** Checks whether a scorer is part of the current selection. */
  isScorerSelected(scorer: Scorer): boolean {
    return this.getSelectedScorers().some(s => s.id === scorer.id);
  }

  /**
   * Adds or removes a scorer from the selection. The last remaining scorer
   * cannot be removed, because every run needs at least one.
   */
  toggleScorer(scorer: Scorer) {
    const selected = this.getSelectedScorers();
    if (this.isScorerSelected(scorer)) {
      if (selected.length === 1) {
        return;
      }
      this.config.selectedScorers =
          selected.filter(s => s.id !== scorer.id).map(s => s.id);
    } else {
      this.config.selectedScorers = [...selected.map(s => s.id), scorer.id];
    }
    this.onConfigChange();
  }

  /** Summarizes the selection for the multi-select trigger button. */
  getSelectedScorersSummary(): string {
    const selected = this.getSelectedScorers();
    if (selected.length === 1) {
      return selected[0].displayName;
    }
    return `${selected.length} Scorers Selected`;
  }

  /**
   * Checks whether any selected scorer reads the given configuration key, so
   * that only the inputs the run needs are rendered.
   */
  usesConfigKey(key: keyof AppConfig): boolean {
    return this.getSelectedScorers().some(
        scorer => scorer.configKeys.includes(key));
  }

  /**
   * Validates every selected scorer against the current configuration.
   * @returns The first error message, or null when all of them can run.
   */
  getScorerValidationError(): string|null {
    for (const scorer of this.getSelectedScorers()) {
      const error = scorer.validate(this.config);
      if (error) {
        return error;
      }
    }
    return null;
  }

  /**
   * Checks if the form is valid and user can proceed to next step.
   * @returns True if form is valid, false otherwise.
   */
  canProceed(): boolean {
    const baseValid = !!this.config.projectId &&
        !!this.config.selectedEngine && !!this.config.selectedModel &&
        this.engines.length > 0;

    if (!baseValid) {
      return false;
    }

    if (this.isRunQueries) {
      return !this.authService.showCredentialInputs || !!this.config.gCloudToken;
    }

    if (this.getScorerValidationError()) {
      return false;
    }

    if (this.authService.showCredentialInputs) {
      return !!this.config.gCloudToken;
    }

    return true;  }

  /**
   * Saves config and emits next event.
   */
  onNext() {
    this.stateService.setConfig(this.config);
    this.next.emit();
  }
}
