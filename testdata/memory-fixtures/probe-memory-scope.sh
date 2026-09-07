#!/usr/bin/env bash
#
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Answers two questions that decide how a repeatable memory eval has to be
# built. Both are unanswerable from the API surface: there is no memory
# resource in v1, v1alpha or v1beta, so the only way to observe the memory
# store is to talk to the assistant.
#
#   1. SCOPE — is a memory keyed to the session's `userPseudoId`, or to the
#      identity behind the access token? If it is the pseudo id, a per-run
#      pseudo id gives every run a clean store and nothing else is needed.
#   2. TEARDOWN — will the assistant delete a memory when asked to in
#      conversation? If it will, runs can clean up after themselves instead of
#      needing the UI.
#
# Run against a live engine in September 2026, the answers were: memories
# follow the token's identity (a different pseudo id, and no session at all,
# both recalled the seeded code), and the assistant does honour a
# conversational deletion. That is what the `reset` phase is built on. Both are
# product behaviours rather than documented guarantees, so re-run this before
# trusting either on an engine or a release you have not checked.
#
# This writes ONE memory (a nonsense probe code) to the account behind the
# token. Step 4 tries to remove it. If step 4 reports that the memory survived,
# delete it by hand: Settings > Personalization > Memories.
#
# Usage:
#   PROJECT_ID=my-project \
#   ENGINE_ID=my-engine \
#   TOKEN="$(gcloud auth print-access-token)" \
#   ./probe-memory-scope.sh
#
# Optional: REGION (default global), SETTLE (default 8 seconds).

set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${ENGINE_ID:?set ENGINE_ID}"
: "${TOKEN:?set TOKEN, e.g. TOKEN=\$(gcloud auth print-access-token)}"
REGION="${REGION:-global}"
SETTLE="${SETTLE:-8}"

if [[ "$REGION" == "global" ]]; then
  HOST="discoveryengine.googleapis.com"
else
  HOST="${REGION}-discoveryengine.googleapis.com"
fi
ENGINE="projects/${PROJECT_ID}/locations/${REGION}/collections/default_collection/engines/${ENGINE_ID}"
BASE="https://${HOST}/v1/${ENGINE}"

# Unguessable, so a correct answer cannot come from anywhere but the memory.
PROBE="QUOKKA-$(( RANDOM % 9000 + 1000 ))"
PSEUDO_A="eval-probe-a-$(date +%s)"
PSEUDO_B="eval-probe-b-$(date +%s)"

# Creates a session with the given userPseudoId and echoes its resource name.
new_session() {
  curl -sS -X POST "${BASE}/sessions" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"userPseudoId\": \"$1\"}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])'
}

# Sends one turn. $1 = session resource name (may be empty), $2 = query text.
assist() {
  local session_field=''
  [[ -n "$1" ]] && session_field="\"session\": \"$1\","
  curl -sS -X POST "${BASE}/assistants/default_assistant:streamAssist" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{${session_field} \"query\": {\"text\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")}, \"toolsSpec\": {\"vertexAiSearchSpec\": {}}}"
}

# Reports whether the probe code came back. $1 = label, $2 = raw response.
report() {
  if grep -qi -- "$PROBE" <<<"$2"; then
    echo "  $1: RECALLED the probe code"
    return 0
  fi
  echo "  $1: did not recall it"
  return 1
}

echo "Probe code: ${PROBE}"
echo "Engine:     ${ENGINE}"
echo

echo "1. Seeding the memory in a session with userPseudoId=${PSEUDO_A}"
SESSION_A1="$(new_session "$PSEUDO_A")"
assist "$SESSION_A1" "Remember that my probe code is ${PROBE}." >/dev/null
echo "   seeded in ${SESSION_A1##*/}, waiting ${SETTLE}s for the write to land"
sleep "$SETTLE"
echo

echo "2. Reading it back from THREE fresh sessions"
SESSION_A2="$(new_session "$PSEUDO_A")"
SESSION_B1="$(new_session "$PSEUDO_B")"
SAME_PSEUDO=0; OTHER_PSEUDO=0; NO_SESSION=0
report "same pseudo id  (${PSEUDO_A})" "$(assist "$SESSION_A2" 'What is my probe code?')" && SAME_PSEUDO=1
report "other pseudo id (${PSEUDO_B})" "$(assist "$SESSION_B1" 'What is my probe code?')" && OTHER_PSEUDO=1
report "no session at all (what the studio sends today)" "$(assist '' 'What is my probe code?')" && NO_SESSION=1
echo

echo "SCOPE:"
if (( SAME_PSEUDO == 1 && OTHER_PSEUDO == 0 )); then
  echo "  Memories are scoped to userPseudoId. A per-run pseudo id isolates every"
  echo "  run on one account: no teardown, no extra identities."
elif (( SAME_PSEUDO == 1 || OTHER_PSEUDO == 1 || NO_SESSION == 1 )); then
  echo "  Memories follow the token's identity, not the pseudo id. Isolation needs"
  echo "  a different principal per run, or run-scoped values in the query set."
else
  echo "  Nothing recalled the code. Either the memory was never saved (is"
  echo "  personalization-memory on for this engine?) or ${SETTLE}s was too short."
  echo "  Re-run with a larger SETTLE before drawing any conclusion."
fi
echo

echo "3. Asking the assistant to forget it"
SESSION_A3="$(new_session "$PSEUDO_A")"
assist "$SESSION_A3" 'Forget my probe code. Delete that memory.' >/dev/null
sleep "$SETTLE"
echo

echo "4. Checking whether it is really gone"
SESSION_A4="$(new_session "$PSEUDO_A")"
STILL_THERE=0
report "after asking it to forget" "$(assist "$SESSION_A4" 'What is my probe code?')" && STILL_THERE=1
echo

echo "TEARDOWN:"
if (( STILL_THERE == 0 )); then
  echo "  The assistant honoured the deletion. A teardown phase can make runs"
  echo "  self-cleaning. Confirm in the UI that the memory row is actually gone"
  echo "  and not merely being withheld from the answer."
else
  echo "  The memory survived. Teardown stays manual: delete ${PROBE} by hand in"
  echo "  Settings > Personalization > Memories."
fi
