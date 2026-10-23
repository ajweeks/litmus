# Duplicate-detection eval: grading

Programmatic, no LLM judge. Each run seeds the case's known claims into a fresh chat in an isolated database (`.claude/hillclimb/dedup/eval.db`), runs the app's real `extractClaims` on the passage, and reads `duplicate_of` on what comes back.

| Metric | Cases | Passes when |
|---|---|---|
| **dedup_ok** (headline) | all | no wrong merge, and a true duplicate was merged (borderline cases pass either way) |
| **safe** | all | no extracted claim was merged into a known claim it doesn't duplicate |
| **merged** (recall) | strict duplicate cases | the duplicate was found |

`safe` is the one to watch: a wrong merge copies another claim's verdict and correction onto the user's screen with no search, which is how the Artemis II "not planned" correction happened. A missed merge costs only one extra check.

Recorded on every case: cost, latency, claims extracted, merges, related links.

Choices I made, which you can change:
- **A merge into the wrong known claim of a true-duplicate case counts as both a wrong merge and a miss.**
- **Three borderline cases (`either: true`)** accept merge or no merge, but never a merge into the distractor.
- **Only the extractor is tested here.** The verifier has its own eval in `eval/verifier/`.

## Running it

```bash
npx tsx eval/dedup/run-eval.mjs --flow .claude/hillclimb/dedup --variant baseline --model claude-haiku-5-5 --reps 3 --approve-harness
```

`--approve-harness` is needed once (and again after editing the cases, prompts or runner). Compare a model with `--variant v1 --model claude-sonnet-5-5`. Report:

```bash
node <claude-api skill dir>/shared/evals/report/build-report-lite.mjs .claude/hillclimb/dedup/
```

Expected cost: one extraction call per case, no searches. About 30 cases × 3 reps × ~$0.0005 ≈ **$0.05** per Haiku run (estimate from the extraction costs recorded in the app's database).
