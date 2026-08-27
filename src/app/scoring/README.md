# Scoring

Every evaluated row is scored by a **scorer**: a strategy that turns a query,
the agent's response and (optionally) a golden answer into a normalized score
between `0.0` and `1.0`.

| File | Role |
| --- | --- |
| `scorer.ts` | The `Scorer` contract plus the `ScoringRequest` / `ScoreResult` shapes. |
| `scorer.registry.ts` | The `SCORERS` token listing every available scorer, and `ScorerRegistry` for looking them up. |
| `scorers/` | The scorer implementations. |

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

Throw an `Error` with a user facing message from `score()` when scoring fails.
The caller records it as `scoreError` on the row and keeps the fetched response.
