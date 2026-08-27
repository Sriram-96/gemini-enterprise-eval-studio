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

import {TestBed} from '@angular/core/testing';

import {AppConfig} from '../../models/app-config.model';
import {EvalBackendService} from '../../services/eval-backend.service';
import {MockEvalBackendService} from '../../testing/mocks';

import {AutoRaterScorer} from './auto-rater.scorer';

const CONFIG: AppConfig = {
  projectId: 'project',
  region: 'global',
  selectedEngine: 'engine',
  selectedModel: 'model',
  autoRaterModel: 'gemini-3.5-flash',
  autoRaterInstruction: 'instructions',
  selectedDataStores: [],
  enableWebSearch: false
};

/** Builds a successful auto rater response carrying the given raw text. */
function ratedWith(text: string): Promise<Response> {
  return Promise.resolve(new Response(
      JSON.stringify({candidates: [{content: {parts: [{text}]}}]})));
}

describe('AutoRaterScorer', () => {
  let scorer: AutoRaterScorer;
  let mockBackendService: MockEvalBackendService;

  beforeEach(() => {
    mockBackendService = new MockEvalBackendService();
    TestBed.configureTestingModule({
      providers: [{provide: EvalBackendService, useValue: mockBackendService}]
    });
    scorer = TestBed.inject(AutoRaterScorer);
  });

  /** Scores a fixed query/response pair with the default config. */
  async function score(config: AppConfig = CONFIG): Promise<number> {
    const result = await scorer.score(
        {query: 'query', response: 'response', golden: 'golden', config});
    return result.score;
  }

  describe('score parsing', () => {
    it('should parse a clean float score', async () => {
      mockBackendService.callScoreSpy.and.returnValue(ratedWith('0.85'));

      expect(await score()).toBe(0.85);
    });

    it('should parse a score wrapped in markdown fences', async () => {
      mockBackendService.callScoreSpy.and.returnValue(
          ratedWith('```\n0.85\n```'));

      expect(await score()).toBe(0.85);
    });

    it('should parse a score with conversational text', async () => {
      mockBackendService.callScoreSpy.and.returnValue(
          ratedWith('The semantic similarity score is 0.9.'));

      expect(await score()).toBe(0.9);
    });

    it('should parse score with prefix', async () => {
      mockBackendService.callScoreSpy.and.returnValue(ratedWith('Score: 0.75'));

      expect(await score()).toBe(0.75);
    });

    it('should parse score when range instruction 0.0-1.0 is mentioned at the end',
       async () => {
         mockBackendService.callScoreSpy.and.returnValue(
             ratedWith('The score is 0.85, which is between 0.0 and 1.0.'));

         expect(await score()).toBe(0.85);
       });

    it('should parse score with scale suffix', async () => {
      mockBackendService.callScoreSpy.and.returnValue(
          ratedWith('0.85 (scale 0-1)'));

      expect(await score()).toBe(0.85);
    });

    it('should parse score with fraction suffix', async () => {
      mockBackendService.callScoreSpy.and.returnValue(ratedWith('0.85/1.0'));

      expect(await score()).toBe(0.85);
    });

    it('should parse score with "out of" suffix', async () => {
      mockBackendService.callScoreSpy.and.returnValue(
          ratedWith('0.85 out of 1'));

      expect(await score()).toBe(0.85);
    });
  });

  describe('error handling', () => {
    it('should throw an error if the response is not ok', async () => {
      mockBackendService.callScoreSpy.and.returnValue(Promise.resolve(
          new Response('', {status: 500, statusText: 'Internal Server Error'})));

      await expectAsync(score()).toBeRejectedWithError(
          /HTTP error! status: 500/);
    });

    it('should throw detailed error message from JSON response if available',
       async () => {
         const errorResponse = {error: {message: 'Detailed error from API'}};
         mockBackendService.callScoreSpy.and.returnValue(
             Promise.resolve(new Response(
                 JSON.stringify(errorResponse),
                 {status: 400, statusText: 'Bad Request'})));

         await expectAsync(score()).toBeRejectedWithError(
             'Detailed error from API');
       });

    it('should throw permission denied error for 403 status if JSON parsing fails',
       async () => {
         mockBackendService.callScoreSpy.and.returnValue(Promise.resolve(
             new Response('Not JSON', {status: 403, statusText: 'Forbidden'})));

         await expectAsync(score()).toBeRejectedWithError(
             'Permission denied. Please check your Google Cloud access token.');
       });
  });

  describe('model selection', () => {
    it('should call callScore with autoRaterModel regardless of selectedModel',
       async () => {
         const customConfig: AppConfig = {
           ...CONFIG,
           selectedModel: 'some-other-model',
           autoRaterModel: 'my-custom-model'
         };
         mockBackendService.callScoreSpy.and.returnValue(ratedWith('0.85'));

         await score(customConfig);

         expect(mockBackendService.callScoreSpy)
             .toHaveBeenCalledWith(
                 jasmine.objectContaining({model: 'my-custom-model'}));
       });
  });

  describe('configuration', () => {
    it('should require a golden answer', () => {
      expect(scorer.requiresGolden).toBeTrue();
    });

    it('should reject a config without an auto rater model', () => {
      expect(scorer.validate({...CONFIG, autoRaterModel: ''})).toBeTruthy();
      expect(scorer.validate(CONFIG)).toBeNull();
    });
  });
});
