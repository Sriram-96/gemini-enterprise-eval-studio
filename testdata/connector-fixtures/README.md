# Connector attribution fixtures

Synthetic "internal" documents for testing whether an agent actually retrieves
from a connector, and whether the `source-attribution` scorer catches it when
it does not.

**These contain no real private information.** That is deliberate — the point
is to test retrieval, not to expose anything. Do not substitute real
confidential documents to run this test.

## Why the facts look arbitrary

Every number, name and codename here is invented and **unguessable**. That is
the whole design. If a query can be answered from the model's prior knowledge,
an agent that retrieved nothing still answers correctly, and the test proves
nothing about the connector.

A per diem of `$63`, a pool ceiling of `128`, a floor price of `$12,900`, an
incident commander named `Priya Vellanki` — none of these are inferable. A
correct answer is only possible if the document was actually read.

## The documents

Upload all six. Name each Google Doc **exactly** as listed, because
`expected_sources` matches on a substring of the document title.

| File | Google Doc title |
| --- | --- |
| `01-travel-expense-policy-v7-CURRENT.md` | `Travel and Expense Policy v7 (Current)` |
| `02-travel-expense-policy-v6-SUPERSEDED.md` | `Travel and Expense Policy v6 (Superseded)` |
| `03-incident-postmortem-INC-4471.md` | `Incident Postmortem INC-4471` |
| `04-vendor-security-review-castellan.md` | `Vendor Security Review - Castellan Data Systems` |
| `05-oncall-rotation-handbook.md` | `On-Call Rotation Handbook` |
| `06-q3-enterprise-pricing-teardown.md` | `Q3 Enterprise Pricing Teardown` |

## The query set

`queryset.attribution.csv` holds **29 rows: 11 single-turn and 18 across five
conversations**, in one file because the runner takes one upload.

Mixing them is safe. Rows are grouped by `conversation_id` and each group is
sorted by its `turn` value, so a conversation's rows do not have to be adjacent
in the file and do not have to be in turn order. Rows with a blank
`conversation_id` each run as their own independent single-turn query. To run
only part of the set, filter the file in a spreadsheet — the grouping does not
depend on row position.

Neither block is a set of variations on one test; each group probes a different
failure mode.

### Single-turn rows (blank `conversation_id`)

**The version trap** — pre-approval and receipt-window rows. This is the
sharpest test in the corpus. The v6 and v7 policies are near-identical
documents with different numbers: per diem `$58` vs `$63`, pre-approval
`$1,800` vs `$2,400`, receipts `30 days` vs `21 days`. An agent that retrieves
the superseded document returns a confident, well-formatted, **wrong** answer
that no answer-quality scorer would flag. Attribution catches it because the
cited title is v6, not v7.

**Single-document canaries** — failed-transaction count, root cause, Castellan
approval scope, the AI-4471-2 deadline. Plain retrieval against facts that
exist in exactly one place.

**Multi-source, fractional scoring** — the fan-out/raw-card question and the
"who was IC, who reviewed" question both need INC-4471 *and* the Castellan
review. Find one and confabulate the other and the score is 0.5, with
`details.missing` naming the document never opened. These justify the `;`
separator.

**Cross-domain distractor** — the pricing rows. The pricing doc contains `$63
per seat` and the expense policy a `$63` per diem: same number, different
document, different meaning. Tests that retrieval is not keyword-matching a
figure.

**Cold negative control** — `What is our parental leave policy?`. Nothing in
the corpus covers it, `expected_sources` is blank, so the scorer records a
**skip** rather than a zero. What you are checking is that the agent *declines*
instead of inventing a policy and citing an unrelated document. A skip in the
score column with a confident fabricated answer in `fetched` is a failure, and
only a human reading that row will see it.

### Multi-turn conversations

Multi-turn is not just "the single-turn test with history attached". It opens a
failure mode that single-turn cannot reach: **source drift**. An agent grounds
turn 1 correctly, then answers turn 3 from *its own earlier output* instead of
re-reading the document. The prose stays right, the citation quietly
disappears, and nothing but per-turn `expected_sources` notices. Every turn
here carries an expectation for that reason — including the ones whose answer
is "obvious" from the conversation so far.

**`conv-perdiem` (4 turns) — anaphora, then a forced pivot to a second
document.** Turn 2 is bare anaphora (`What about international?`) and still has
to re-ground. The payload is turn 4: after three turns anchored on v7, `Has
that rate always been the same?` legitimately requires the *superseded* v6
document as well. An agent locked onto the conversation's first source scores
0.5 with v6 in `details.missing`.

**`conv-incident` (4 turns) — mid-conversation document switch.** Turns 1–2 are
INC-4471. Turn 3 (`What is that vendor approved to handle?`) resolves "that
vendor" to Castellan, whose approval scope lives in a *different* document.
INC-4471 mentions Castellan in passing, so the lazy path — answer from the
document already in hand — is available and wrong. Turn 4 confirms it stayed
switched.

**`conv-oncall` (4 turns) — a false premise from the user.** Turn 3 asserts
`I was fairly sure the acknowledgement window was 20 minutes`, contradicting
the handbook's 12. Two failures are possible and they look different in the
trace: caving to the user, or holding firm but from memory of turn 1 rather
than the document. Attribution separates them. Turn 4 adds a distractor —
Priya Vellanki is named in both the handbook and INC-4471.

**`conv-pricing` (3 turns) — number collision under conversational
anchoring.** Turn 2's answer is `$63 per seat`, and `$63` is also the domestic
per diem in the v7 policy. Same figure, different document, different meaning.

**`conv-coverage` (3 turns) — momentum into an ungrounded question.** Two turns
answered cleanly from the handbook, then parental leave, which no document
covers. `expected_sources` is blank so the row records a skip; what you are
testing is whether two successful citations built enough momentum for the agent
to cite the handbook for something it does not contain. **Read this row by
hand** — a skip plus a confident fabricated answer is a failure the score
column will not show you.

The parental-leave question appears twice on purpose: once cold as a
single-turn row, once here at the end of a conversation. Same question, and the
warmed-up version is the one that more often produces a fabricated answer.

## Running it

### 1. Establish the baseline first

Run the query set **before** the documents are indexed, or against an engine
without the connector attached. Nearly every row should score 0.

This step is not optional ceremony. If rows pass with no documents indexed,
your queries are answerable from prior knowledge and the whole corpus needs
harder facts — you would otherwise read those passes as retrieval working.

### 2. Index and wait

Add the six documents to the connector and wait for indexing to complete.
Google Drive connector sync is not instant; a query run too early looks
identical to a retrieval failure.

### 3. Run with Source Attribution selected

Upload `queryset.attribution.csv`, pick **Source Attribution** as the scoring
method, and run.

Expected: **27 scored rows at 1.0, and 2 skipped** (the two parental-leave
rows).

Turns within a conversation share a session and run in order, so stopping a run
mid-way leaves later turns without the context they assume — which reads as a
retrieval failure but is not one. Let conversations finish.

### 4. Read the failures, not just the score

For any row below 1.0, open the **Trace** panel. `details.missing` names the
matcher that went unsatisfied and `details.actual` lists what the agent cited
instead — that pair usually distinguishes "retrieved nothing" from "retrieved
the wrong document", which have entirely different fixes.

### 5. Prove the scorer discriminates

A column of 1.0s does not prove the scorer works; a matcher that always matches
produces the same column. Change one row's `expected_sources` to a value you
know is wrong, e.g. `Travel and Expense Policy v7` → `nonexistent-datastore`,
and confirm it scores 0.0 with `missing` populated.

## Matching an entire data store instead of a title

Data store ids and connector names match **exactly**, and document uris,
resource names and titles match on a **substring**. So to assert only that an
answer came from the right connector rather than a specific file, put your data
store id in `expected_sources` — for example `google-drive-internal`. Use the
id as it appears in the `citedDataStores` column after a first run, since it is
parsed out of the document resource name rather than typed by hand.
