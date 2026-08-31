# Scoring

Every evaluated row is scored by one or more **scorers**: strategies that turn
a query, the agent's response and (optionally) a golden answer into a
normalized score between `0.0` and `1.0`.

| File | Role |
| --- | --- |
| `scorer.ts` | The `Scorer` contract, the `ScoringRequest` / `ScoreResult` shapes, and the `ScorerRunResult` / `ScoreSummary` shapes a multi-scorer run produces. |
| `scorer.registry.ts` | The `SCORERS` token listing every available scorer, and `ScorerRegistry` for looking them up. |
| `scorers/` | The scorer implementations. |

## The built-in scorers

| Id | Name | Notes |
| --- | --- | --- |
| `auto-rater` | Auto Rater (LLM as a judge) | Asks a Gemini model to rate the response against the golden answer using your rubric. Understands meaning; costs a backend call per row and is not reproducible. |
| `rouge-l` | ROUGE-L | Longest common subsequence of the tokenized golden answer and response, as an F1 measure. Offline, free and bit-deterministic; lexical only, so synonyms and typos score low. |

They complement each other, which is the point of running several: the auto
rater handles semantics, ROUGE-L provides a reproducible lexical floor.

## How a run uses them

`EvalService` never talks to a scorer directly. It resolves everything named by
`AppConfig.selectedScorers` through `ScorerRegistry.resolveAll` and runs them in
`scoreAll`, one after another rather than concurrently, so a run spreads its
load instead of firing every scorer's backend call at once.

Each scorer produces its own `ScorerRunResult`, and `summarizeScorerResults`
collapses them onto the row: the **primary** score is the first scorer that ran,
which is registry order, not the order the user checked the boxes in. A scorer
that throws does not stop the others — its failure is recorded on its own entry.
A scorer with `requiresGolden` is skipped, not failed, on a row with no golden
answer.

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
     inject(RougeLScorer),
     inject(ExactMatchScorer),
   ],
   ```

That is all that is required. The configuration form picks the new scorer up
automatically: the **Scoring Methods** picker renders a checkbox per registered
scorer (and hides itself entirely when only one is registered), and the first
entry in the list is the default selection.

## Optional hooks

Override these on your scorer when the defaults do not fit:

- `requiresGolden` — set to `false` for reference-free scorers (safety,
  groundedness, …). Rows without a golden answer are skipped when it is `true`.
- `configKeys` — the `AppConfig` keys your scorer reads. The configuration form
  renders only the inputs belonging to the selected scorers, so a new setting
  needs a field on `AppConfig`, an input in `config-form.component.html` guarded
  by `usesConfigKey('yourKey')`, and the key listed here.
- `validate(config)` — return an error message when the scorer cannot run with
  the current configuration; the wizard blocks the **Next** button while any
  selected scorer returns one.
- `ScoreResult.details` — attach a rationale or per-criterion sub-scores.
  ROUGE-L uses this to expose its recall, precision and LCS length.

Throw an `Error` with a user facing message from `score()` when scoring fails.
The caller records it as `scoreError` on the row and keeps the fetched response.
