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

/**
 * Represents a row in the input CSV file.
 */
export interface CSVRow {
  query: string;
  golden: string;
  /**
   * Optional. Rows sharing the same conversation_id are sent to the same
   * Assistant session in order, as turns of one multi-turn conversation,
   * instead of as independent single-turn queries.
   */
  conversation_id?: string;
  /**
   * Optional. Determines execution order within a conversation_id
   * (ascending numeric order). If omitted, rows are processed in their
   * original CSV order.
   */
  turn?: string;
  /**
   * Optional. `seed` for a row whose job is to make the assistant save a
   * memory, `recall` for a row that asks about one in a fresh chat. Seed rows
   * all run, sequentially, before anything else in the file. Blank behaves
   * exactly as before. See models/memory.model.ts.
   */
  phase?: string;
  [key: string]: string|undefined;
}
