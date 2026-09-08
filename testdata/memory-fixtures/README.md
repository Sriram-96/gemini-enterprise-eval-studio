# Saved memory fixtures

One query set for Gemini Enterprise's **saved memories** ("Memories"): the
account-wide facts the assistant keeps about a user and applies in later,
unrelated chats.

Where [`../connector-fixtures/`](../connector-fixtures/) tests whether
retrieval works and [`../customer-bug-fixtures/`](../customer-bug-fixtures/)
tests named defects, this corpus tests **state that outlives the session**. It
is the only fixture in `testdata/` that writes to the account under test — and,
because that state outlives the run, the only one that has to **delete** from it
too: the file opens with two `reset` rows that clear the account before anything
is seeded.

**There are no documents to index.** Nothing here is answered from a corpus.
Every fact a recall row asks for was put there by a seed row earlier in the
same run, so the only source that can produce a correct answer is the saved
memory itself. That is the same unguessability argument the other fixtures make
about invented documents, applied to state instead of retrieval: `CC-OPS-4478`
and "Callum Vasey" are not inferable, so a correct answer proves the memory was
saved *and* recalled.

---

## Before you run it

-   **Use a throwaway account.** Everything here happens to the identity behind
    the access token, not to a run-scoped identity. Seeding writes memories to
    it, and the `reset` rows ask the assistant to **delete every memory it holds
    for that user** — not just the ones this file created, and not undoably. Do
    not point this at an account whose memories you would miss.
-   **Nothing asks you to confirm.** Pressing Run sends the reset rows straight
    away. Uploading this file *is* the decision to clear the account, so check
    which account the token belongs to first.
-   **The engine needs `personalization-memory` on.** The run reads the flag
    when you select an engine and refuses a seeding run outright against an
    engine that reports it off. An engine that reports neither way is not
    thereby off: the run proceeds and the detected state lands on every memory
    row of the results.
-   **Pick an answer scorer, not Source Attribution.** No row cites a document,
    so attribution would record every row as a skip.

## The query set

[`queryset.saved-memories.csv`](queryset.saved-memories.csv) — 27 rows in one
upload: 2 reset, 9 seed, 13 recall, 3 controls.

| Column | Purpose |
| --- | --- |
| `query`, `golden` | Read by the run. `golden` is the expected answer. |
| `conversation_id`, `turn` | Group and order the multi-turn reset and seed rows. Blank elsewhere. |
| `phase` | Read by the run: `reset`, `seed`, `recall`, or blank. Drives the phase ordering. |
| `memory` | Which memory the row writes or reads, `M-01` to `M-08`. Documentation only. |
| `check` | What decides the row: `answer`, `formatting`, `negative`, or `control`. Documentation only. |

Reset rows run first, one at a time; the run pauses five seconds for the
deletion to land; the seed rows then run, one at a time; the run pauses again;
then the recall rows and the controls run together across the usual worker
pool. Full mechanics are in the
[main README](../../README.md#evaluating-saved-memories).

The rows are grouped reset-then-seeds-first for readability only. Ordering
comes from `phase`, not row position, so the file can be reordered or filtered
— but never split `conv-reset`, `conv-seed-profile` or `conv-seed-prefs`,
because turn *n* is sent with the session returned by turn *n − 1*.

## The reset rows

The two `reset` rows are what make this file give the same answer twice.
Memories key off the token's principal, so a second run on the same account
would otherwise start with everything the first run left behind — and that
leftover state silently invalidates the sharpest rows in the set (see
[Re-running](#re-running)).

There is no delete API, so the deletion is a conversation like everything else:
turn 1 asks the assistant to forget everything, turn 2 asks it to list what it
still holds. Turn 2 is the receipt. It is not a strong one — both turns share a
session, so the second answer is the assistant's own report rather than an
independent read of the store — but a run whose turn 2 still enumerates last
run's cost centre is a run you should not read any further.

The reset rows carry no `memory` id, because they write nothing. They are also
the reason this file cannot be run casually: they delete memories this tool
never created.

[`probe-memory-scope.sh`](probe-memory-scope.sh) is the diagnostic behind this
design. Point it at an engine and it seeds one nonsense code, reads it back
from the same pseudo id, a different pseudo id and no session at all, then asks
the assistant to forget it. Run it if a recall row starts behaving oddly, or on
an engine you have not used before: it separates "the memory was never saved"
from "the memory was saved and not applied" in about a minute.

## The memories

| ID | Seeded value | Seeded by | Recall rows |
| --- | --- | --- | --- |
| **M-01** | Induction-lane workstream on Project Meridian, at the Truganina DC | `conv-seed-profile` turn 1 | 3 |
| **M-02** | Cost centre `CC-OPS-4478`, **correcting** `CC-OPS-4471` | `conv-seed-profile` turns 2–3 | 3 |
| **M-03** | Dates as ISO 8601 `YYYY-MM-DD` | `conv-seed-prefs` turn 1 | 3 |
| **M-04** | Australian English spelling | `conv-seed-prefs` turn 2 | 3 |
| **M-05** | Three sentences or fewer | `conv-seed-prefs` turn 3 | 2 |
| **M-06** | Escalate DC-7 conveyor faults to Callum Vasey, never the Kestrelworks helpdesk | single seed row | 3 |
| **M-07** | Amounts in AUD | single seed row | 2 |
| **M-08** | *Nothing* — the seed row asks for a nickname **and asks that it not be saved** | single seed row | 1 |

Every seed row is phrased as a plain user turn, because that is the only way to
write a memory: `default_assistant` has no memory API. Nothing marks these
turns as belonging to a test run, deliberately — a run-unique marker spliced
into the query would change the memory text under test.

## What each recall row is actually for

**Does an update replace, or accumulate?** `What cost centre should I charge a
new purchase order to?` is the sharpest row in the set. `CC-OPS-4471` was
seeded and then corrected to `CC-OPS-4478` two turns later. An assistant that
stores both and answers with the first, or hedges with "CC-OPS-4478, formerly
CC-OPS-4471", has kept a memory the user retracted. Only the corrected value
passes.

**Is a memory applied when nobody asks for it?** The direct rows (`Which site
do I work at?`) prove the memory exists. The indirect ones — draft a status
update, explain an induction lane, price twelve drive units — prove it is
*used*. A memory that only surfaces when interrogated is not doing the job.

**Do memories interfere?** `Draft a short note to my escalation contact…`
requires three at once: the contact from M-06, the spelling from M-04 and the
date format from M-03. Applying one and dropping the other two is a common,
quiet failure.

**Does the assistant invent memories?** Two negative rows. `What should you
call me?` follows a seed turn that supplied a nickname *and* asked that it not
be saved; a saved "Skipper" means the assistant wrote a memory it was told not
to write. `How long do I like my meetings to be?` was never seeded at all, so
any confident preference is fabricated. Both are failures that look like
successes in a score column, because the answer is fluent.

**How is the reference rendered?** Three `formatting` rows exist for customer
bug **#33** — memory values appearing *in the middle of words*, and paragraph
spacing opening up around them. `In one paragraph tell me everything you have
saved about me` is the concentrated version: the highest density of memory
references the set can produce, in a shape where any splicing artefact is
visible. A scorer will not catch this. Read the `fetched` column.

> The other half of bug #33 — copy and paste substituting paragraph spacing for
> the memory reference — is a clipboard behaviour of the Gemini Enterprise UI.
> It is not reachable through `streamAssist` and cannot be evaluated here; copy
> the answer out of the product by hand to check it.

**Controls.** Three rows with a blank `phase`: an arithmetic question, a
checklist and a definition. None depends on memory, and they run in the same
pool as the recall rows. They exist because a failing recall row is ambiguous —
the answer may be wrong, or the memory may never have been saved, and the score
cannot tell you which. If the controls pass and the recall rows fail, the run
worked and memory did not. If the controls fail too, the run itself is broken
and the recall rows say nothing at all.

## Reading the results

`eval_results.csv` gains a `Phase` column, and the memory rows also carry the
engine's detected feature state. Export rows come back in completion order, not
file order, so join on `query` to line them up with this set. The `memory` and
`check` columns are not carried into the export.

Work through it in this order:

1.  Did the three controls pass? If not, stop — nothing else in the run is
    interpretable.
2.  Did the second reset row report an empty store? If it listed anything, the
    run started dirty and the recall rows are being scored against a mixture of
    this run's memories and an earlier run's.
3.  Did every seed row get an acknowledgement? A seed row that errored, or that
    answered without agreeing to save anything, means the recall rows behind it
    were never testing anything.
4.  Was the feature state `on`? If it came back unknown, a failing recall row
    is inconclusive rather than a defect.
5.  Then read the recall rows — including the `fetched` text of the
    `formatting` rows, which no score reflects.

## Teardown

Seeded memories persist on the account after the run and **no API can remove
them** — the reset rows work only because the assistant honours the request
conversationally, which is a behaviour rather than a guarantee. The run itself
says nothing about what it left; the checklist below is the record.

Running this file again clears them, so teardown only matters when you are done
with the account. To clear them now, either send `Forget everything you have
saved about me` in the product, or delete the rows by hand in the Gemini
Enterprise UI. This set leaves seven, plus whatever the M-08 row wrongly saved
if that check failed:

-   [ ] Induction-lane workstream on Project Meridian, Truganina DC
-   [ ] Cost centre CC-OPS-4478 — **and** CC-OPS-4471 if the correction
        accumulated rather than replaced
-   [ ] Dates in ISO 8601
-   [ ] Australian English spelling
-   [ ] Three sentences or fewer
-   [ ] Escalate DC-7 faults to Callum Vasey
-   [ ] Amounts in AUD
-   [ ] "Skipper", if the assistant saved it despite being asked not to

## Re-running

The reset rows exist so that you can. Run the file as-is, as often as you like:
each run clears the account before it seeds, so every run measures the same
thing.

What the reset rows are protecting is worth spelling out, because a dirty run
does not look dirty. The M-02 correction test is the clearest case: once
`CC-OPS-4478` is already saved from last time, the recall row passes whether or
not this run's correction was honoured, because the right answer is sitting
there already. The negative rows degrade the same way — a "Skipper" left over
from a failed run makes the next run's failure look pre-existing. Neither shows
up as an error; both show up as a score you can read straight past.

If you delete the reset rows, you take that protection off. Clear the account
by hand between runs instead.
