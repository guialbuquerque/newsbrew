# Newsbrew model benchmarking

Use this guide for classifier/model comparisons. Benchmark validity matters
more than producing a complete-looking report.

## Integrated command and private files

The benchmark implementation lives in `src/benchmark/` and runs with:

```bash
pnpm benchmark
```

It reads and writes only private files under
`~/.config/wes-dev/newsbrew/`, all prefixed with `benchmark-`:

- `~/.config/wes-dev/newsbrew/benchmark-config.json` contains the LM Studio
  connection, general guidance, reader topic preferences, and run controls.
- `~/.config/wes-dev/newsbrew/benchmark-reference.json` contains private
  labeled candidates.
- `~/.config/wes-dev/newsbrew/benchmark-results.json` is the atomic checkpoint
  and final report.

The `--config`, `--reference`, and `--output` options accept a filename only,
require the `benchmark-` prefix, and keep the file inside the Newsbrew config
directory. Use `--model=TEXT`, `--limit=N`, or `--show-misses` for narrower
runs. The command does not start LM Studio or download models, and it unloads
only model instances created during its own run.

The initial ignored reference file was recovered from a legacy selection
exercise. Its selected items are labeled `YES`; unselected items are
provisional `MAYBE`, not fabricated `NO` labels. Review those provisional
labels and assign explicit `NO` labels before treating it as a valid
three-class benchmark. The runner reports missing classes and withholds
rankings until all three classes are represented.

## Labels and datasets

Use three ground-truth classes:

- Wanted
- Neutral/not sufficiently interesting
- Explicit reject

Map those to `YES`, `MAYBE`, and `NO`. An unselected story is not automatically
an explicit reject. Only explicit rejects should inform negative preferences.

Use a fresh held-out set that was not used to tune the prompt. Balance sources
and report class balance. Prefer real current headlines from the reader's
configured publications.

The benchmark prompt, label vocabulary, reasoning mode, and system-prompt
placement must match production. A legacy binary dataset does not directly
measure the current tri-state product.

## Production fidelity

Newsbrew uses one sequential stateful filter chain. The integrated benchmark
does the same, including context-aware session rollover. A benchmark that
branches every headline independently from a synthetic anchor measures a
different system and must be labelled as such.

Do not score repeated text, empty output, truncated reasoning, or malformed
labels as ordinary wrong classifications. Disqualify configurations with
invalid output rather than including them in rankings.

Place experimental strategy text in the system prompt when production places
it there; Gemma has shown meaningful sensitivity to prompt placement.

## Metrics

Always report:

- Completed and valid result counts
- Exact three-way accuracy
- Pass/reject agreement when `YES` and `MAYBE` both enter analysis
- `YES` precision
- Wanted recall
- Explicit-reject recall
- Neutral recall
- Confusion matrix
- Per-source results
- Median and tail latency

Raw accuracy alone is misleading for imbalanced datasets. Numeric `0–10`
scores from thinking-off Gemma were not calibrated and should not be treated
as probabilities.

Separate warm inference latency from model loading and cold-start time. A model
load/runtime crash is an operational failure, not a classification result.

## Runtime controls

For classification benchmarks, prefer a request timeout over a tiny
`max_output_tokens` cap. Small caps can consume the final answer in hidden
reasoning and corrupt the evaluation. This does not override Newsbrew's
production analyser budget, which exists to bound runaway multi-turn article
analysis.

Keep the requested model/reasoning configuration explicit and record what LM
Studio actually loaded. Verify that an unintended duplicate model instance was
not created. Do not change the user's configured or resident model unless the
benchmark task authorizes it.

During a user-run benchmark, inspect only the requested log or artifact. Do not
probe, reload, unload, or otherwise interact with LM Studio merely to answer a
status question.
