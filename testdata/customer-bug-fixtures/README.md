# Customer bug fixtures

One query set that reproduces the customer-reported bugs in the Gemini
Enterprise backlog, plus the documents it needs indexed.

Where [`../connector-fixtures/`](../connector-fixtures/) tests whether
retrieval works at all, this corpus tests **named defects**. Every row exists
because a customer reported something, and the `bug` column on every row
carries the backlog number it came from, so the mapping survives even if this
README and the CSV are separated.

**These contain no real customer data.** Harbourline Group, Kestrelworks,
Project Meridian and every person named are invented. That is deliberate for
the same reason as in the connector fixtures: if a query can be answered from
the model's prior knowledge, a broken agent still answers correctly and the
test proves nothing.

---

## The query set

[`queryset.customer-bugs.csv`](queryset.customer-bugs.csv) — 96 rows, 17 bugs,
one upload.

| Column | Purpose |
| --- | --- |
| `query`, `golden` | Read by the run. `golden` is the expected answer. |
| `conversation_id`, `turn` | Group and order the multi-turn rows. Blank on single-turn rows. |
| `agent` | Which custom agent serves the row. Blank on every row here, meaning the engine's default assistant. |
| `expected_sources` | Read by the **Source Attribution** scorer. Blank rows are recorded as skips, not zeros. |
| `bug` | Backlog number. Documentation only — not read by the run. |
| `check` | What actually decides this row: `answer`, `sources`, `thoughts`, `trace`, `latency`, or a combination. Documentation only. |

These bugs are all about the engine's default assistant, so `agent` is blank
throughout. Fill it in on a row to send that row to a custom agent instead —
every turn of one `conversation_id` must name the same agent. See
[Evaluating a custom agent](../../README.md#evaluating-a-custom-agent).

`bug` and `check` are extra columns. The uploader lowercases headers and ignores
anything beyond the columns it knows, so they cost nothing at run time — but
**they are not carried into `eval_results.csv`**, which has a fixed column set.
See [Mapping results back to bugs](#mapping-results-back-to-bugs).

96 rows is not an accident: `CsvService.parseCSV` truncates an uploaded CSV to
the **first 100 rows** and says nothing about it. Adding rows past 100 will
silently drop them.

## Bug → row map

| Bug | Platform / agent | Reported symptom | Rows | Where |
| --- | --- | --- | --- | --- |
| **#17** | Meeting Actions | Turn 2 document content never reaches the agent (session hydration) | 5 | `conv-b17-hydration`, `conv-b17-control` |
| **#30** | Core Chat | Document context not retained across turns without re-referencing | 7 | `conv-b30-persistent`, `conv-b30-interrupted` |
| **#7** | External Meeting Prep | Multi-step agent transfer latency, then regenerate-response error | 4 | `conv-b7-transfer` |
| **#13** | External Meeting Prep | Freeze on large attendee directory enrichment | 4 | `conv-b13-directory` |
| **#14** | Meeting Actions | Reasoning engine stream `DEADLINE_EXCEEDED` | 4 | `conv-b14-reasoning` |
| **#45** | Canvas / Assistant | Error updating a slide with additional content | 6 | `conv-b45-slides`, `conv-b45-doc-control` |
| **#4** | PODS Agent | Thinking trace mis-defines the "S" in PODS | 6 | rows 31–36 |
| **#10** | Virtual Board Agent | Drive connector fallback retrieves an older file version | 7 | rows 37–43 |
| **#11** | Agent Builder / Datastore | Knowledge base files reported as user uploads | 7 | rows 44–50 |
| **#28** | GE Chat | Web search runs with the Google Search connector disabled | 7 | rows 51–57 |
| **#36** | Jira Connector / Chat | Jira listing failure, and "what can you do?" also fails | 7 | rows 58–64 |
| **#2** | Canvas / System Prompt | Australian English spelling not honoured | 6 | rows 65–70 |
| **#6** | General Output | Trailing token duplication ("Maintance window") | 5 | rows 71–75 |
| **#15** | Canvas / Tables | Broken bullets in tables, raw HTML tag leakage | 4 | rows 76–79 |
| **#29** | GE Chat | Background file status string leaked into output | 3 | rows 80–82 |
| **#9** | Virtual Board Agent | Fabricated director quotes and ungrounded answers | 7 | rows 83–89 |
| **#43** | Skills | Custom skills do not auto-trigger from natural language | 7 | rows 90–96 |

Row numbers count data rows in the query set, so row *n* is CSV line *n + 1*.

The multi-turn rows are contiguous in the file for readability only.
Conversations are grouped by `conversation_id` regardless of position, so rows
can be reordered or filtered without breaking threading — but never split a
conversation, because turn *n* is sent with the session returned by turn
*n − 1*.

### Mapping results back to bugs

`eval_results.csv` has a fixed column set and does **not** include `bug` or
`check`, and its rows do not come back in query set order — conversations run
across a worker pool, so the export is ordered by completion. Row 51 of the
query set is not row 51 of the export.

Join on `query` + `conversationId` + `turn` instead. That key is unique across
all 96 rows with one deliberate exception: *"What are the three pillars in the
Harbourline Group Strategy FY26 to FY28?"* is asked twice, once as a #11 row and
once as a #28 positive control. The duplication is the point — the same question
is evidence for two different bugs — so attribute that result to both.

A three-line join is enough:

```python
import csv
key = lambda r: (r['query'], r.get('conversationId', r.get('conversation_id', '')), r['turn'])
bugs = {key(r): r['bug'] for r in csv.DictReader(open('queryset.customer-bugs.csv'))}
for r in csv.DictReader(open('eval_results.csv')):
    print(bugs.get(key(r), '?'), r['score_auto-rater'], r['query'][:60])
```

## Why the rubric is left generic

The auto-rater instruction is a run-level setting, not a per-row column. **Run
this with the default instruction, unchanged** — the stock semantic-similarity
rubric in the Auto Rater Instruction box. Nothing here requires editing it.

The consequence is worth stating plainly: for roughly half of these bugs the
auto-rater score is a *supporting* signal, not the verdict. A judge comparing an
answer to a golden will not reliably notice a duplicated trailing phrase, a US
spelling, a `<br>` tag, or that a correct number came out of the wrong document.
That is what the `check` column is for. Where `check` says something other than
`answer`, read the named column.

Every golden is written as the expected answer rather than as instructions to a
judge, so semantic similarity means something on every row even where it is not
the deciding signal.

---

## Before you run anything

### 1. Index the documents

Everything in [`documents/`](documents/) except `09-…` is a document to index.
Name each one **exactly** as its `Google Doc title:` line says, because
`expected_sources` matches document titles on substring.

| File | Google Doc title | Needed by |
| --- | --- | --- |
| `01-meridian-steering-minutes-2026-08-12.md` | `Project Meridian Steering Committee Minutes 12 August 2026` | #17, #30, #7, #14, #45, #4, #6, #29, #43 |
| `02-harbourline-board-update-h2-fy26-v4-final.md` | `Harbourline Board Update H2 FY26 v4 FINAL` | #10, #9, #14, #15 |
| `03-harbourline-board-update-h2-fy26-reformatted-SUPERSEDED.md` | `Harbourline Board Update H2 FY26 reformatted` | #10 |
| `04-harbourline-group-strategy-fy26-fy28.md` | `Harbourline Group Strategy FY26 to FY28` | #11, #7, #2, #28, #4 |
| `05-harbourline-board-profiles.md` | `Harbourline Board Profiles` | #11, #9 |
| `06-harbourline-executive-team-bios.md` | `Harbourline Executive Team Bios` | #11 |
| `07-pods-framework-reference.md` | `PODS Framework Reference` | #4 |
| `08-meridian-quarterly-review-attendees.md` | `Meridian Program Quarterly Review Attendees` | #13 |

`09-dc-incident-triage-skill.md` is **not** a document. It is the custom skill
definition to create in the agent before running the #43 rows.

Documents 02 and 03 are a matched pair and both must be indexed. 03 is the
decoy: it is the older, superseded copy that bug #10's fallback search finds.
Indexing only 02 makes every #10 row pass trivially.

### 2. Configure the agent

- **#4 (rows 31–36):** paste the block under *Agent system instruction* in
  `07-pods-framework-reference.md` into the agent's system instruction. Bug #4
  is an instruction-adherence defect; an agent that was never given the
  instruction cannot fail to adhere to it, and the run proves nothing.
- **#43 (rows 90–96):** create the `DC Incident Triage` skill exactly as
  specified in `09-dc-incident-triage-skill.md`, description and all.
  Shortening the description removes the trigger phrases these rows fire on.
- **#28 (rows 51–57):** leave the **Web Search** connector unselected. That is
  the condition under test, and it is the one setting in this list that changes
  between runs — see below.
- **#7, #13, #36:** these need live connectors — calendar for #7, directory for
  #13, Jira for #36. Without them the rows still run but only tell you the
  agent declined gracefully.

### 3. One file, one configuration

A single upload runs under a single config, and #28 is the one bug that needs
two. **Run the file twice: once with Web Search off, once with it on**, and
diff the #28 rows between the two exports. Every other bug reads identically in
both runs, so the second pass costs a run and settles #28 rather than leaving
it ambiguous.

### 4. Wait for indexing

Google Drive connector sync is not instant. A query run too early is
indistinguishable from a retrieval failure.

---

## Reading the results, bug by bug

Select all three scorers. Auto Rater and Source Attribution both matter here;
ROUGE-L is cheap and occasionally catches a truncated answer that the judge
scored past.

### #17 — session hydration (rows 1–5)

`conv-b17-hydration` is the customer's exact sequence: a content-free turn 1
(`Hi`), then the document introduced on turn 2. `conv-b17-control` is the same
request with the document introduced on turn 1, which the customer reported as
working. **The finding is the difference between them**, not either alone.

Look for a turn 2 answer claiming the document is empty, unreadable, or that
only a file name was received. Read `score_source-attribution` per turn too: a
turn that answers correctly but cites nothing is answering from the previous
turn's text rather than the document, which is a different defect.

### #30 — cross-turn retention (rows 6–12)

`conv-b30-persistent` asks three follow-ups with no re-reference.
`conv-b30-interrupted` puts an unrelated turn between two document turns, which
is the harder retention case. A request to re-attach or re-name a document an
earlier turn already named is the failure.

### #7, #13, #14 — long-running turns (rows 13–24)

`conv-b7-transfer` turn 4 forces a computation so the code-execution transfer
step actually runs. `conv-b13-directory` turn 2 is the enrichment step that
froze. `conv-b14-reasoning` turns 2 and 3 are two consecutive heavy reasoning
passes, which is how you tell a per-turn deadline from a cumulative one.

**The verdict here is the `ttlt` column, not the score.** Sort the export by
`ttlt` descending. The customer saw 4m 53s on a single transfer step; anything
approaching that is the bug reproducing whether or not the row eventually
returned. Also grep `fetched` for `Error:`, `DEADLINE_EXCEEDED` and
regenerate-response text — a row that failed outright is recorded with `ttft`,
`ttfa` and `ttlt` all at `0`, so a zero latency means failure, not speed.

### #45 — Canvas updates (rows 25–30)

`conv-b45-slides` turn 2 is the reported failure: adding content to an existing
deck. Turn 4 reads the deck back, because a Canvas update can return no error
and still not persist — without the readback you cannot tell a working update
from a silent no-op. `conv-b45-doc-control` runs the same update pattern
against a text artifact to establish whether the defect is slide-specific.

### #4 — thinking trace (rows 31–36)

**Read the `thoughts` column.** The bug lives in the reasoning, not the answer.
Rows 31 and 32 ask the model to state the definition in its answer, where the
auto-rater can see it; the rest do real work with the framework, where the
mis-definition surfaces only in the trace.

Export the results CSV and search `thoughts` for `specific actions`, `steps`,
`summary` and `stakeholders` near `PODS`. A run where every row scores well
while the thinking trace still reads the S as "specific actions" is exactly the
state the customer reported: a correct answer reached by wrong reasoning. The
Trace panel shows the same content under **Thinking**.

### #10 — superseded document (rows 37–43)

The version trap. Every row has a right answer in `H2 FY26 v4 FINAL` and a
plausible wrong answer in the superseded `reformatted` copy: EBIT $412.6m vs
$398.1m, CODB 21.4% vs 22.1%, net debt $1,046.2m vs $1,133.7m, throughput 1,180
vs 1,105, a go/no-go date set vs not set. An agent that falls back to the older
document returns a confident, well-formatted, wrong answer.

Row 39 (`Read the board update I have shared…`) is deliberately vague about
which version it means, which is the condition that let the connector fallback
search fire in the customer's session.

**Source Attribution is the sharper signal here.** The two titles are chosen so
that neither is a substring of the other, so `H2 FY26 v4 FINAL` can only be
satisfied by the current pack. A row scoring well on the auto-rater and 0.0 on
attribution means the agent got the number right from the wrong document, which
is still the bug.

### #11 — sources described as uploads (rows 44–50)

The defect is in how the agent *describes* its sources, so most rows ask a
normal question and then check the framing. Two attack it head-on: row 48
(`Which files have I uploaded in this conversation?`, correct answer: none) and
row 47, which asks the agent to list its sources and say where each came from.

Search `fetched` for `uploaded`, `you shared`, `you provided` and
`the files you`. Any of those applied to an indexed knowledge base document is
the bug.

### #28 — web grounding with the connector off (rows 51–57)

Rows 51–55 pull hard towards a web lookup; rows 56 and 57 are positive controls
answerable from indexed documents, so a column of declines can be
distinguished from a broken engine.

**The verdict is the `citedSources` and `citedConnectors` columns, not the
score.** With web grounding off, no row may cite a source carrying an external
web domain. A web-grounded citation has no data store id, so it shows up in
`citedSources` as a bare URL and leaves `citedDataStores` empty. Diff those two
columns between the off run and the on run — see
[A note on tool-call traces](#a-note-on-tool-call-traces) for why the answer
text alone cannot settle this.

### #36 — Jira connector (rows 58–64)

Covers both halves of the report: the Jira query failures and the "simple what
can you do query is also failing" capability crash (row 58). A clear decline
scores as a pass; an internal error, an empty response, a stack trace or a raw
connector payload does not.

`expected_sources` is blank on every row because Jira data store ids differ per
tenant. To score attribution, fill in your own id from the `citedDataStores`
column after a first run. Note that **data store ids and connector names match
exactly**, not on substring, so paste the id rather than typing `jira`.

### #2 — Australian English (rows 65–70)

Five instructed rows plus one uninstructed control (row 70), which establishes
what the agent's default locale produces. Coverage goes past the `-ise`/`-ize`
family the customer named into `-re` (centre), `-ce` (licence) and `-our`
(labour), and row 69 puts the requirement inside a table, which is where locale
instructions most often stop being applied.

The generic rubric will not catch a spelling slip. **The deterministic check is
a search over the exported `fetched` column**, case-insensitive, for
`iz(e|ed|es|ing|ation)\b`, `\blabor\b`, `\bcenter\b`, `\blicense\b`. That
search is the ground truth; the score is context.

### #6, #15, #29 — output hygiene (rows 71–82)

The #6 rows each end on a different construct — prose, a bold line, a table, a
numbered list, a code block — because the duplication happens as the stream
closes and the closing construct is the variable. The #15 rows all put
multi-line bullets inside table cells. The #29 rows read documents, which is
what generates the background file message in the first place.

**Read the last line of `fetched` literally for the #6 rows.** A judge model
reads a duplicated trailing phrase as a formatting quirk and scores past it far
more often than you would expect; the customer's own report was one repeated
phrase at the very end of an otherwise correct answer. For #15, search `fetched`
for `<br`, `<ul`, `<li`, `</li` and `</ul`. For #29, search for
`The file has been processed and saved to`, storage paths and mime types.

### #9 — fabrication (rows 83–89)

Five fabrication baits and two positive controls (rows 88, 89). The board pack
states in writing that its anticipated questions are unattributed and that no
draft answers exist; Board Profiles names six directors and quotes none of them.
So every director quotation, every "which director asked", and every drafted
answer is a fabrication with a documented ground truth behind it. The controls
establish that the declines above are refusals to fabricate rather than
retrieval failures.

### #43 — skill auto-trigger (rows 90–96)

Three rows quoting trigger phrases verbatim, two paraphrasing them, one manual
`/` invocation, one negative control that must not fire the skill.

The skill is specified to open its response with the literal line
`DC INCIDENT TRIAGE`, which turns "did the skill fire?" into a substring check
over `fetched` instead of a judgement call.

Read the block, not the rows. Row 95 (the manual `/` invocation) failing means
the skill itself is broken and nothing else in the block says anything about
auto-triggering. The verbatim rows passing while the paraphrased rows fail means
the matcher works but is too conservative — which is what the customer
suspected. Everything failing except row 95 is the bug as reported. Row 96
failing to stay quiet is the opposite problem: a run where every row triggers
the skill tells you as little as one where none do.

---

## The captured run

[`eval_results.csv`](eval_results.csv) and
[`eval_traces.jsonl`](eval_traces.jsonl) are one real execution of this query
set — 96 result rows and 96 verbatim streams — kept so the export shape can be
read without standing the agent up first, and so a later run has something to
diff against.

**Tenant identifiers in both files are masked.** The document content, queries,
goldens, answers, thinking traces, citations, latencies and scores are exactly
as captured; only the identity of the environment that produced them is
replaced, with stable placeholders so rows stay joinable across the two files:

| Field | Replaced with |
| --- | --- |
| `projectId` | `example-project` |
| Project number in `engineId` and `session` | `000000000000` |
| Engine id | `eval-studio-agent` |
| `citedDataStores`, `citedConnectors` | `eval-studio-datastore` |
| GCS document paths | `gs://example-bucket/eval-fixtures/…` |
| Session ids | `000000000000000001`–`000000000000000075` |
| `assistToken` | `ASSIST_TOKEN_001`–`ASSIST_TOKEN_096` |

Session pseudonyms are consistent, so the four rows of `conv-b7-transfer` still
share one session id and multi-turn threading is still verifiable from the
export alone. The masking is one-way: the placeholders do not map back to the
original tenant.

This is a single pass with the **Web Search connector unselected**, and the
agent confirms it in the answers themselves — "I am currently configured to
search only across your connected internal databases and do not have access to
live external web engines in this mode". So it is the *off* half of the #28
pair; the *on* half still has to be run and diffed against it.

Worth noticing before you read #28 too quickly: several rows still cite public
`docs.cloud.google.com` URLs with an empty `citedDataStores`. That is Gemini
Enterprise's built-in product-documentation grounding, not the Web Search
connector — which is exactly the kind of citation that makes "did web grounding
run?" a trace question rather than an answer-text question.

---

## What Eval Studio cannot do for these bugs today

Four of the strategies in the backlog specification assume capabilities the
tool does not have. Working around them is fine; not knowing you are working
around them is not.

**Per-row file attachments do not exist.** The request body Eval Studio sends
carries `query.text` and nothing else — no attachment, no inline file. So
"upload a transcript on turn 2" cannot be reproduced literally. Every row here
that the specification describes as attaching a document instead **names an
indexed document in the query text**. That preserves the multi-turn context
question #17 and #30 are really about, but it does not exercise the
`<start_of_user_uploaded_file>` marker-forwarding path that #17's root cause
analysis actually names. Bug #17 in particular is therefore **partially
covered**: the session-hydration behaviour is testable here, the upload payload
path is not, and confirming that half still needs a manual run in the Gemini
Enterprise UI.

**`gradeThoughtContent` is not implemented.** The specification describes a
per-row flag that routes `thoughtText` to the auto-rater. There is no such
column and no such config today: thoughts are captured into the `thoughts`
column and shown in the Trace panel, but the auto-rater is passed only the
final answer. Bug #4 is consequently graded by reading a column rather than by
a score. Rows 31 and 32 exist to give it at least a partial automated signal.

**`ToolTraceEntry[]` and `plannerSteps` are not parsed.** The trace collector
extracts citations, grounding segments and code execution (`executableCode`,
`codeExecutionResult`). It does not extract `diagnosticInfo.plannerSteps`, and
there is no `ToolTraceEntry` type in the codebase. The raw stream *is* kept
verbatim and exported to `eval_traces.jsonl`, so planner steps can be read out
of the JSONL by hand — but the assertions #10, #28 and #36 are specified
against (`assert no web_search entry exists`, `assert the file ID in the tool
trace`) cannot be written as scorer expectations today. This is why those three
lean on `citedSources` and Source Attribution instead.

**No regex or programmatic scorer is registered.** Three scorers exist:
`auto-rater`, `rouge-l` and `source-attribution`. Bugs #2, #6, #15 and #29 are
all naturally regex assertions — the specification describes them that way —
and are graded here by a manual search over the exported CSV, with the generic
auto-rater score as context rather than as the verdict. Those four are the
strongest candidates if a deterministic scorer is added, and adding one would
convert most of the "read this column" guidance above into a real pass/fail.

### A note on tool-call traces

For #28 especially, the answer text is not evidence. A model can produce a
current-sounding fact from parametric memory without any tool call, and it can
run a web search and then not use the result. Those two look similar in
`fetched` and completely different in the trace. `citedSources` plus the raw
stream in the JSONL export is where that question gets settled.

---

## After the run

Keep both exports from each pass, named for the configuration
(`eval_results.web-off.csv`, `eval_results.web-on.csv`). The trace JSONL is the
only place the full stream survives, and for #4, #10, #28 and #36 it is where
the actual answer lives.

Join the export back to the query set first
([Mapping results back to bugs](#mapping-results-back-to-bugs)) so every result
row carries its `bug` and `check` again. Then work through it in this order,
which is roughly cheapest evidence first:

1. **Sort by `ttlt` descending** — settles #7, #13 and #14 in one pass, and
   flags any row that failed outright (`ttlt` of `0`).
2. **Filter the joined `check` for `sources` and `trace`** — #10, #11, #28,
   #36.
3. **Search `thoughts`** — #4.
4. **Search `fetched`** for the literal strings listed above — #2, #6, #15,
   #29, #43.
5. **Read the multi-turn rows as conversations** — #17, #30, #45. A turn is
   only interpretable next to the turn before it.
