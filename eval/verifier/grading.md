# Verifier eval: grading

Programmatic, no LLM judge: each case's verdict and importance come straight from `verifyClaim`. At the app's default setting, a claim is **shown** to the user when its verdict is refuted, partially_supported or misleading **and** its importance isn't `minor`.

| Metric | Cases | Passes when |
|---|---|---|
| **display_ok** (headline) | all | real errors are shown; everything else (true claims, nitpicks, unknowables) is not |
| **correct** | all | the verdict is one of the case's accepted verdicts |
| **caught** (recall) | real-error cases | the error is shown |
| **quiet** (specificity) | all other cases | nothing is shown |

Recorded on every case: cost (tokens × list price), latency, web searches, sources cited, and sources whose URL didn't come from a search result.

Choices I made, which you can change:
- **No importance-match metric.** A real error flagged "major" when the case says "moderate" still counts as caught, because both are shown.
- **`correct` is reported but isn't the headline.** For the user, what matters is what appears on screen, and some verdict pairs (refuted vs partially_supported) are matters of judgement.
- **Unverifiable cases count as "should stay quiet"**, so flagging an unknowable claim as an error counts against the verifier.

## Running it

```bash
npx tsx eval/verifier/run-eval.mjs --flow .claude/hillclimb/verifier --variant baseline --model claude-haiku-5-5 --reps 2 --approve-harness
```

`--approve-harness` is needed once. It records a hash of the runner, cases and prompts, so later edits to any of them are noticed. Re-running resumes where it stopped. To compare the Sonnet verifier, run with `--variant v1 --model claude-sonnet-5-5`; for a prompt change, edit `lib/prompts.ts` and run the next `v<N>`.

Build the report (a self-contained HTML page) with:

```bash
node <claude-api skill dir>/shared/evals/report/build-report-lite.mjs .claude/hillclimb/verifier/
```

Expected cost: about 56 cases × 2 reps × ~$0.015 ≈ **$1.70** per Haiku run. That's an estimate from the earlier app runs, which took about 1–3 searches per claim.
