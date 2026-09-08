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

import {isSeedConversation, memoryPhaseOf, orderedPhaseOf, readMemorySupport, validateMemoryRows} from './memory.model';

describe('memory.model', () => {
  describe('readMemorySupport', () => {
    it('should report on when the engine enables the feature', () => {
      expect(readMemorySupport({
        uiSettings: {features: {'personalization-memory': 'FEATURE_STATE_ON'}}
      })).toBe('on');
    });

    it('should report off when the engine disables the feature', () => {
      expect(readMemorySupport({
        uiSettings: {features: {'personalization-memory': 'FEATURE_STATE_OFF'}}
      })).toBe('off');
    });

    it('should treat an unspecified state as unknown rather than off', () => {
      expect(readMemorySupport({
        uiSettings:
            {features: {'personalization-memory': 'FEATURE_STATE_UNSPECIFIED'}}
      })).toBe('unknown');
    });

    it('should treat an engine that omits the key as unknown', () => {
      // An engine reporting other features but not this one says nothing about
      // memories, so the run must not be blocked on its silence.
      expect(readMemorySupport({uiSettings: {features: {'skills': 'FEATURE_STATE_ON'}}}))
          .toBe('unknown');
      expect(readMemorySupport({uiSettings: {}})).toBe('unknown');
      expect(readMemorySupport({})).toBe('unknown');
    });

    it('should treat a failed widget-config fetch as unknown', () => {
      expect(readMemorySupport(null)).toBe('unknown');
      expect(readMemorySupport(undefined)).toBe('unknown');
    });
  });

  describe('memoryPhaseOf', () => {
    it('should read every phase, ignoring case and surrounding space', () => {
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: 'seed'})).toBe('seed');
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: '  Recall '}))
          .toBe('recall');
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: 'SEED'})).toBe('seed');
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: ' Reset '}))
          .toBe('reset');
    });

    it('should return undefined for an ordinary row', () => {
      expect(memoryPhaseOf({query: 'q', golden: 'g'})).toBeUndefined();
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: ''})).toBeUndefined();
      expect(memoryPhaseOf({query: 'q', golden: 'g', phase: '   '}))
          .toBeUndefined();
    });
  });

  describe('orderedPhaseOf', () => {
    it('should name the sequential phase a conversation belongs to', () => {
      expect(orderedPhaseOf([{query: 'a', golden: 'g', phase: 'reset'}]))
          .toBe('reset');
      expect(orderedPhaseOf([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c'},
        {query: 'b', golden: 'g', phase: 'seed', conversation_id: 'c'},
      ])).toBe('seed');
    });

    it('should leave recall and ordinary conversations to the main pool', () => {
      expect(orderedPhaseOf([{query: 'a', golden: 'g', phase: 'recall'}]))
          .toBeUndefined();
      expect(orderedPhaseOf([{query: 'a', golden: 'g'}])).toBeUndefined();
    });
  });

  describe('isSeedConversation', () => {
    it('should identify a conversation whose turns seed memories', () => {
      expect(isSeedConversation([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c'},
        {query: 'b', golden: 'g', phase: 'seed', conversation_id: 'c'},
      ])).toBeTrue();
    });

    it('should not claim reset, recall or ordinary conversations', () => {
      expect(isSeedConversation([{query: 'a', golden: 'g', phase: 'reset'}]))
          .toBeFalse();
      expect(isSeedConversation([{query: 'a', golden: 'g', phase: 'recall'}]))
          .toBeFalse();
      expect(isSeedConversation([{query: 'a', golden: 'g'}])).toBeFalse();
    });
  });

  describe('validateMemoryRows', () => {
    it('should accept a file with no phase column at all', () => {
      expect(validateMemoryRows([
        {query: 'a', golden: 'g'},
        {query: 'b', golden: 'g', conversation_id: 'c', turn: '1'},
        {query: 'c', golden: 'g', conversation_id: 'c', turn: '2'},
      ])).toBeNull();
    });

    it('should accept a well-formed seed and recall pair', () => {
      expect(validateMemoryRows([
        {query: 'remember I prefer metric', golden: 'ok', phase: 'seed'},
        {query: 'what units do I prefer?', golden: 'metric', phase: 'recall'},
      ])).toBeNull();
    });

    it('should accept a multi-turn seed conversation', () => {
      expect(validateMemoryRows([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c', turn: '1'},
        {query: 'b', golden: 'g', phase: 'seed', conversation_id: 'c', turn: '2'},
      ])).toBeNull();
    });

    it('should accept a reset row ahead of the seed rows', () => {
      expect(validateMemoryRows([
        {query: 'forget everything about me', golden: 'ok', phase: 'reset'},
        {query: 'remember I prefer metric', golden: 'ok', phase: 'seed'},
        {query: 'what units do I prefer?', golden: 'metric', phase: 'recall'},
      ])).toBeNull();
    });

    it('should reject a misspelt phase value', () => {
      const error = validateMemoryRows([
        {query: 'a', golden: 'g', phase: 'seeed'},
      ]);
      expect(error).toContain('seeed');
      expect(error).toContain('a');
      // The message has to name every value the column accepts, or an author
      // who mistyped 'reset' would never learn the phase exists.
      expect(error).toContain('reset');
    });

    it('should reject a recall row that threads an existing conversation', () => {
      // Threading it would test within-session context, not saved memory.
      const error = validateMemoryRows([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c', turn: '1'},
        {query: 'b', golden: 'g', phase: 'recall', conversation_id: 'c', turn: '2'},
      ]);
      expect(error).toContain('recall');
      expect(error).toContain('new chat');
    });

    it('should reject a conversation whose turns disagree about the phase', () => {
      const error = validateMemoryRows([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c', turn: '1'},
        {query: 'b', golden: 'g', conversation_id: 'c', turn: '2'},
      ]);
      expect(error).toContain('c');
      expect(error).toContain('mixes phases');
    });

    it('should let two conversations carry different phases', () => {
      expect(validateMemoryRows([
        {query: 'a', golden: 'g', phase: 'seed', conversation_id: 'c1', turn: '1'},
        {query: 'b', golden: 'g', phase: 'seed', conversation_id: 'c1', turn: '2'},
        {query: 'c', golden: 'g', conversation_id: 'c2', turn: '1'},
        {query: 'd', golden: 'g', conversation_id: 'c2', turn: '2'},
      ])).toBeNull();
    });
  });
});
