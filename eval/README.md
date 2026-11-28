# Independent Iron Memory evaluation

The public suite has ten fictional edge cases (`synthetic.jsonl`, the runner default). A 40-question historical source-retrieval set was prepared against the author's private Markdown corpus; it lives with that corpus and is not shipped, because its queries and paths describe a personal setup. To build your own, write questions against a frozen copy of your corpus before looking at Iron's results, split them into calibration and held-out cases, and keep the held-out set frozen.

The synthetic suite tests same-marker cross-project isolation, global inclusion versus strict scope, explicit no-answer cases, privacy exclusion, obsolete notes, and two conflicting reports. It has no real source content. Its calibration/held-out labels organize diagnostic runs; paired fictional topics mean it is not an independent statistical hold-out set. Stale and contradiction cases measure whether relevant source evidence is found, not whether the tool correctly decides authority or freshness. File-update/deletion refresh invariants belong in the implementation's integration tests.

## Run

Python 3.10+ and the supplied external Iron binary are sufficient. No package installation, Cargo build, daemon, network request, or model call is made by the runner.

```sh
python3 eval/runner.py validate \
  --claude-root /path/to/frozen/claude-copy

python3 eval/runner.py run \
  --iron /path/to/iron \
  --claude-root /path/to/frozen/claude-copy \
  --cavemem-db /path/to/copied/cavemem.db \
  --index /path/to/fresh/benchmark.db \
  --split calibration \
  --budgets 2000 4000 \
  --repeats 3 \
  --output /path/to/calibration-report.json
```

Repeat with `--split heldout` and a different fresh index/report after freezing the implementation. Omitting `--split` runs both. To deliberately reuse a benchmark index, pass `--reuse-index`; the report still includes both imports and their counters. Reusing the calibration index does not change source contents, but a fresh index gives a clearer initial-import timing.

The explicit root must contain the original relative layout (`memory/`, `agent-memory/`, and/or `projects/*/memory/`). Project keys in the cases are exact directory names, including case. All source reads are through the caller-supplied root. Index and report paths must be separate from the corpus, binary, fixture files, and supplied Cavemem database. A supplied source database must exist. Prefer an offline copy so unrelated live capture does not invalidate source-stability checks.

The runner automatically loads `<case-stem>-sources.json` beside the JSONL fixture. It refuses modified fixture bytes and source-hash drift. `--allow-source-drift` allows a deliberate comparison against a changed source snapshot and labels that drift; it never allows modified fixture bytes to bypass the manifest. A source manifest pins the judged source files and their available ancestor indexes, not every distractor in the corpus.

```sh
python3 eval/runner.py run \
  --iron /path/to/iron \
  --claude-root eval/synthetic-corpus \
  --cases eval/synthetic.jsonl \
  --index /path/to/fresh/synthetic.db \
  --output /path/to/synthetic-report.json

python3 -m unittest discover -s eval -p test_runner.py -v
```

The fourteen runner tests exercise the subprocess argv boundary with a fixture binary, exact byte limits, source drift, path containment, source-database sidecar and hardlink protection, malformed responses, project filtering, no-match scoring, and content-free reports. Report destinations must be new files; exclusive creation also refuses a hardlink introduced after destination validation. They validate the evaluation harness only; they are not evidence about Iron's runtime behavior.

## Contract and measurements

The runner uses these CLI operations:

```text
iron --db INDEX memory import --claude-root ROOT [--cavemem-db DB]
iron --db INDEX memory stats
iron --db INDEX memory search QUERY [--project KEY] [--strict-project] --max-bytes N --limit 10
```

Import must return JSON with integer `inserted`, `updated`, `unchanged`, and `removed` counters. Two consecutive imports are measured. The second import's inserted, updated, and removed counts must be zero; complete stats equality is also reported. Search must return a JSON object containing `results` and a boolean `truncated`; each hit must provide string `id`, `source_path`, `project`, `snippet`, and `source_type` fields.

- **Payload bytes:** actual stdout length, including UTF-8 encoding and the final newline. Invalid UTF-8/JSON, oversized output, malformed hits, missing envelope fields, limit overflow, or project-scope leakage make that measurement invalid and give it zero answerable-source recall.
- **Source recall at budget:** unique expected source paths found with nonempty snippets divided by all expected source paths. Canonical file aliases count once. A source hit is not proof that its snippet answers the question. This is source-level relevance evaluation; source recall is not semantic answer accuracy.
- **No-match accuracy:** a valid, untruncated response with an empty result array for a no-answer case. An empty truncated payload cannot establish absence. Retrieval misses and false positive no-answer results remain visible without being hidden behind process exit success.
- **Latency:** wall time around each fresh CLI subprocess, including process launch and JSON output. Jobs are deterministically shuffled across budgets and repetitions. Filesystem caches are uncontrolled; no cold-cache claim is made. P50 and P95 are nearest-rank percentiles. Baseline reads occur in Python, so their latency is descriptive rather than an equal-process comparison.
- **Import and identity:** first/replay wall times, raw count reports, stats, binary SHA-256 and size, and fixture SHA-256. Selected source hashes are checked again after the run. The supplied Cavemem main database and WAL, if present, are fingerprinted before and after; a change can also mean an external writer was active.

Reports contain normalized source paths, IDs, source kinds, scope keys, hashes, counts, and snippet byte lengths. They do not persist retrieved snippets, titles, source bodies, or raw child stderr. This reduces incidental propagation of historical content but does not anonymize path and provenance metadata.

Exit code `0` means the runner completed with valid search contracts, a mutation-free replay, and stable checked sources. It does **not** mean a recall target was reached or the implementation is accepted. Exit `1` means a measured contract/replay/source-stability failure; the report is still written. Exit `2` means invalid input or failed preparation/import. No quality threshold is invented by this harness.

## File-read baseline

For each answerable case, the runner reads available ancestor `MEMORY.md` files from shallowest to deepest, then the complete expected Markdown files in fixture order. The available ancestor chain is an optimistic discovery path chosen from the judged source locations; it does not simulate an agent finding the answer from scratch. If no ancestor index exists, the report shows that absence instead of inventing a navigation cost.

Each file is represented in a labelled JSON payload with its relative path, role, and full content. `payload_bytes` is the exact encoded size of that payload. The report saves only path/role/size/hash metadata. At each budget, baseline coverage counts only complete expected files whose entire sequential prefix, including index reads and JSON wrappers, fits. Files are not sliced to manufacture coverage. No-answer cases have no meaningful full-file source-recall baseline.

This is a **known-source full-file read baseline**, not a model-token baseline, not a search-engine benchmark, and not evidence of billing savings. It intentionally gives file reading the correct destination; it does not include wrong turns, repeated reading, or an LLM deciding relevance. Iron's brief snippets and the baseline's complete files carry different amounts of context. Compare byte cost alongside source coverage and inspect answer usefulness separately before claiming a benefit.

Labels target Markdown only. Importing Cavemem supplies realistic additional records and count evidence, but these labels do not measure summary/observation relevance. Peak RSS, sustained MCP costs, cold startup, source-refresh correctness, and live answer quality require the root verifier's separate measurements.

## Frozen identifiers

| Suite | Cases | SHA-256 |
| --- | --- | --- |
| `synthetic.jsonl` | 10 | `e1b8f4fa2950f2f66b7ad612ffeb24ad16cee51f5e5745982fbe7e40c2fb9554` |

No Iron search result was used to select or reword these questions. Preparation-time validation confirms source existence and hashes; actual retrieval measurements are intentionally left to the root verifier.
