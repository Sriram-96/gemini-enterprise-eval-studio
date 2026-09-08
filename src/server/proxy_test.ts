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

import {resolveEnginePath} from './proxy';

describe('resolveEnginePath', () => {
  const FULL_PATH =
      'projects/my-project/locations/global/collections/default_collection/engines/my-engine';

  it('should expand a bare engine id under the default collection', () => {
    expect(resolveEnginePath('my-project', 'global', 'my-engine'))
        .toBe(FULL_PATH);
  });

  it('should pass through a well-formed full engine path', () => {
    expect(resolveEnginePath('my-project', 'global', FULL_PATH))
        .toBe(FULL_PATH);
  });

  it('should keep the collection named in a full path', () => {
    const custom = FULL_PATH.replace('default_collection', 'other_collection');
    expect(resolveEnginePath('my-project', 'global', custom)).toBe(custom);
  });

  it('should reject a full path that is not an engine resource', () => {
    expect(resolveEnginePath(
               'my-project', 'global',
               'projects/p/locations/global/collections/c/dataStores/d'))
        .toBeNull();
    expect(resolveEnginePath('my-project', 'global', `${FULL_PATH}/assistants/x`))
        .toBeNull();
  });

  it('should reject a bare id that could escape the resource path', () => {
    // Without this the id would be interpolated straight into the request URL
    // and could address a resource other than the one named.
    expect(resolveEnginePath('my-project', 'global', '../../other')).toBeNull();
    expect(resolveEnginePath('my-project', 'global', 'engine/assistants/x'))
        .toBeNull();
    expect(resolveEnginePath('my-project', 'global', 'engine?alt=media'))
        .toBeNull();
    expect(resolveEnginePath('my-project', 'global', '')).toBeNull();
  });
});
