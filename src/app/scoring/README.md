# Scoring

Every evaluated row is scored by a **scorer**: a strategy that turns a query,
the agent's response and (optionally) a golden answer into a normalized score
between `0.0` and `1.0`.

| File | Role |
| --- | --- |
| `scorer.ts` | The `Scorer` contract plus the `ScoringRequest` / `ScoreResult` shapes. |
| `scorer.registry.ts` | The `SCORERS` token listing every available scorer, and `ScorerRegistry` for looking them up. |
| `scorers/` | The scorer implementations. |

## Built-in scorers

| Id | Judges | Needs |
| --- | --- | --- |
| `auto-rater` | What the answer said, against the golden answer, using your rubric. | A `golden` column. |
| `source-attribution` | Where the answer came from: whether the agent cited the documents it was supposed to. | An `expected_sources` column. |

### `source-attribution`

A fluent answer grounded in the wrong document — or in nothing at all — reads
just as well as a correct one, so `auto-rater` cannot tell them apart. This
scorer checks the citations the agent actually returned, turning "did it use
the right source?" into a pass/fail metric instead of something a tester has to
eyeball.

Add an `expected_sources` column to the query set, holding `;`-separated
matchers:

```csv
query,golden,expected_sources
What is our refund window?,30 days.,confluence-policies
Who owns the billing service?,The Payments team.,jira-prod;service-catalog
What is the boiling point of water?,100°C.,
```

A matcher is satisfied when it

- **equals** a cited data store id or connector name (case-insensitive), or
- **appears anywhere in** a cited document's uri, resource name or title.

Data stores and connectors match exactly so that `sales` cannot pass for
`salesforce-crm`; documents match on a substring so a tester can name a page by
its title without pasting a full resource name.

The score is the fraction of matchers satisfied, and `details` records
`{matched, missing, actual}` so a failing row explains itself. A row with an
empty `expected_sources` is skipped rather than scored zero.

`EvalService` never talks to a scorer directly; it resolves the one named by
`AppConfig.selectedScorer` through `ScorerRegistry` and delegates to it.

## Adding a scorer

1. **Implement `Scorer`** in `scorers/`, as a root-provided Angular service so
   it can inject whatever it needs (for example `EvalBackendService`):

   ```ts
   @Injectable({providedIn: 'root'})
   export class ExactMatchScorer extends Scorer {
     readonly id = 'exact-match';
     readonly displayName = 'Exact Match';
     override readonly description = 'Scores 1.0 when the response equals the golden answer.';

     async score({response, golden}: ScoringRequest): Promise<ScoreResult> {
       return {score: response.trim() === golden?.trim() ? 1 : 0};
     }
   }
   ```

2. **Register it** by adding one line to the `SCORERS` factory in
   `scorer.registry.ts`:

   ```ts
   factory: () => [
     inject(AutoRaterScorer),
     inject(ExactMatchScorer),
   ],
   ```

That is all that is required. The configuration form picks the new scorer up
automatically: the **Scoring Method** dropdown appears as soon as more than one
scorer is registered, and the first entry in the list is the default.

## Optional hooks

Override these on your scorer when the defaults do not fit:

- `requiresGolden` — set to `false` for reference-free scorers (safety,
  groundedness, …). Rows without a golden answer are skipped when it is `true`.
- `configKeys` — the `AppConfig` keys your scorer reads. The configuration form
  renders only the inputs belonging to the selected scorer, so a new setting
  needs a field on `AppConfig`, an input in `config-form.component.html` guarded
  by `usesConfigKey('yourKey')`, and the key listed here.
- `validate(config)` — return an error message when the scorer cannot run with
  the current configuration; the wizard blocks the **Next** button while one is
  returned.
- `ScoreResult.details` — attach a rationale or per-criterion sub-scores.
- `ScoreResult.skipped` — return it when the row gave the scorer nothing to
  judge, so it is recorded as a skip rather than as a zero that would drag an
  average down. Use this for inputs `requiresGolden` cannot express.
- `ScoringRequest.trace` — the citations and tool calls behind the response,
  for scorers that judge how the agent reached its answer rather than what it
  said. See `models/trace.model.ts`.

Throw an `Error` with a user facing message from `score()` when scoring fails.
The caller records it as `scoreError` on the row and keeps the fetched response.
