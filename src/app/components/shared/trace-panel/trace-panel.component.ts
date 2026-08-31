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
import {Component, EventEmitter, Input, Output} from '@angular/core';

import {ResultRow} from '../../../models/result-row.model';
import {CitedSource, GroundedSegment} from '../../../models/trace.model';

/**
 * Shows the full journey behind one answer, so a tester can confirm the agent
 * reached it through the right documents rather than only that it sounded
 * plausible.
 *
 * Reads in the order the work happened: what the model thought, which tools it
 * ran, which documents it cited, and finally which claim rests on which
 * document.
 */
@Component({
  selector: 'app-trace-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './trace-panel.component.html'
})
export class TracePanelComponent {
  /** The row to inspect. Null closes the panel. */
  @Input() row: ResultRow|null = null;
  /** Emitted when the user dismisses the panel. */
  @Output() closed = new EventEmitter<void>();

  /** The thinking trace, split back into the lines it was joined from. */
  get thoughts(): string[] {
    return (this.row?.thoughts ?? '').split('\n').filter(line => !!line);
  }

  /** The documents the answer cited. */
  get sources(): CitedSource[] {
    return this.row?.trace?.sources ?? [];
  }

  /** Only the segments that actually name a source. */
  get attributedSegments(): GroundedSegment[] {
    return (this.row?.trace?.segments ?? [])
        .filter(segment => segment.sourceKeys.length > 0);
  }

  /** Whether there is any evidence at all to show. */
  get hasEvidence(): boolean {
    const trace = this.row?.trace;
    return !!(this.thoughts.length || trace?.sources.length ||
              trace?.toolCalls.length);
  }

  /**
   * Names the sources behind one segment, for display next to its text.
   * @param segment The attributed span.
   * @returns The title (or uri) of each backing document.
   */
  labelSources(segment: GroundedSegment): string {
    return segment.sourceKeys
        .map(key => {
          const source = this.sources.find(
              candidate => candidate.document === key ||
                  candidate.uri === key || candidate.title === key ||
                  candidate.snippet === key);
          return source?.title || source?.uri || key;
        })
        .join(', ');
  }

  close() {
    this.closed.emit();
  }
}
