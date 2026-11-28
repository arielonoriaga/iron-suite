import argparse
import hashlib
import json
import math
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    hashed = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            hashed.update(block)
    return hashed.hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()


def reject_non_json_number(value):
    raise ValueError(f"non-JSON numeric literal: {value}")


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"source escapes the supplied corpus: {relative}")
    return path


def read_cases(path, root):
    cases = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    seen = set()
    for case in cases:
        if case["id"] in seen:
            raise ValueError("duplicate case id")
        seen.add(case["id"])
        if case["split"] not in {"calibration", "heldout"}:
            raise ValueError("invalid split")
        if not isinstance(case["query"], str) or not case["query"].strip():
            raise ValueError("query must be nonempty")
        if case["expectation"] not in {"evidence", "no_match"}:
            raise ValueError("invalid expectation")
        if bool(case["expected_sources"]) != (case["expectation"] == "evidence"):
            raise ValueError("expected sources disagree with expectation")
        for relative in case["expected_sources"] + case.get("forbidden_sources", []):
            if not inside(root, relative).is_file():
                raise ValueError(f"missing fixture source: {relative}")
    return cases


def check_manifest(path, cases_path, root):
    if path is None:
        return {"status": "not_supplied", "files": {}}
    manifest = json.loads(path.read_text())
    if digest(cases_path.read_bytes()) != manifest["fixture_sha256"]:
        raise ValueError("fixture changed since its source manifest was frozen")
    observed = {}
    changed = []
    for relative, expected in manifest["sources"].items():
        data = inside(root, relative).read_bytes()
        actual = {"sha256": digest(data), "bytes": len(data)}
        observed[relative] = actual
        if actual != expected:
            changed.append(relative)
    return {"status": "matched" if not changed else "drift", "changed": changed, "files": observed}


def discovery_paths(root, expected_sources):
    indexes = set()
    for relative in expected_sources:
        parent = inside(root, relative).parent
        while parent.is_relative_to(root):
            candidate = parent / "MEMORY.md"
            if candidate.is_file():
                indexes.add(candidate)
            if parent == root:
                break
            parent = parent.parent
    ordered = sorted(indexes, key=lambda path: (len(path.relative_to(root).parts), str(path)))
    for relative in expected_sources:
        path = inside(root, relative)
        if path not in ordered:
            ordered.append(path)
    return ordered


def file_read_baseline(root, case, budgets):
    started = time.perf_counter_ns()
    expected = {inside(root, relative) for relative in case["expected_sources"]}
    payload = {"label": "ancestor_indexes_then_full_expected_markdown", "files": []}
    files = []
    prefixes = []
    reached = set()
    for path in discovery_paths(root, case["expected_sources"]):
        raw = path.read_bytes()
        relative = str(path.relative_to(root))
        role = "expected_source" if path in expected else "discovery_index"
        payload["files"].append({"path": relative, "role": role, "content": raw.decode("utf-8")})
        files.append({"path": relative, "role": role, "file_bytes": len(raw), "sha256": digest(raw)})
        if path in expected:
            reached.add(path)
        prefixes.append((len(encode(payload)), len(reached)))
    total = len(encode(payload))
    elapsed = (time.perf_counter_ns() - started) / 1_000_000
    at_budget = {}
    for budget in budgets:
        covered = max((count for size, count in prefixes if size <= budget), default=0)
        at_budget[str(budget)] = {
            "fits_full_payload": total <= budget,
            "source_recall": covered / len(expected) if expected else None,
        }
    return {"payload_bytes": total, "latency_ms": elapsed, "files": files, "at_budget": at_budget}


def execute(argv, timeout):
    started = time.perf_counter_ns()
    try:
        result = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
        output, error, code = result.stdout, result.stderr, result.returncode
        failure = None
    except subprocess.TimeoutExpired as exc:
        output, error, code = exc.stdout or b"", exc.stderr or b"", None
        failure = "timeout"
    elapsed = (time.perf_counter_ns() - started) / 1_000_000
    try:
        parsed = json.loads(output.decode("utf-8"), parse_constant=reject_non_json_number)
    except (UnicodeDecodeError, ValueError):
        parsed = None
        failure = failure or "invalid_utf8_or_json"
    if code != 0:
        failure = failure or "nonzero_exit"
    return {
        "latency_ms": elapsed,
        "stdout_bytes": len(output),
        "stdout_sha256": digest(output),
        "stderr_bytes": len(error),
        "stderr_sha256": digest(error),
        "returncode": code,
        "failure": failure,
        "parsed": parsed,
    }


def normalize_source(root, source):
    if source.startswith("file://"):
        uri = urlparse(source)
        if uri.netloc not in {"", "localhost"}:
            return None
        source = unquote(uri.path)
    try:
        path = inside(root, source)
    except (ValueError, OSError):
        return None
    return str(path.relative_to(root))


def inspect_search(measurement, root, case, budget, limit):
    payload = measurement.pop("parsed")
    failures = [measurement["failure"]] if measurement["failure"] else []
    if measurement["stdout_bytes"] > budget:
        failures.append("output_exceeds_byte_budget")
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        failures.append("missing_results_array")
        payload = {"results": []}
    if not isinstance(payload.get("truncated"), bool):
        failures.append("missing_truncated_boolean")
    if len(payload["results"]) > limit:
        failures.append("result_limit_exceeded")
    expected = {str(inside(root, relative).relative_to(root)) for relative in case["expected_sources"]}
    forbidden = {str(inside(root, relative).relative_to(root)) for relative in case.get("forbidden_sources", [])}
    found = set()
    hits = []
    scope_violations = 0
    forbidden_hits = 0
    for result in payload["results"]:
        if not isinstance(result, dict) or any(not isinstance(result.get(key), str) for key in ("id", "source_path", "project", "snippet", "source_type")):
            failures.append("malformed_result")
            continue
        source = normalize_source(root, result["source_path"])
        if source in expected and result["snippet"].strip():
            found.add(source)
        if source in forbidden:
            forbidden_hits += 1
        project = case.get("project")
        allowed = {project} if case.get("strict_project") else {project, "*"}
        if project and result["project"] not in allowed:
            scope_violations += 1
        hits.append({
            "id": result["id"],
            "source": source,
            "source_locator_sha256": digest(result["source_path"].encode()),
            "source_type": result["source_type"],
            "project": result["project"],
            "snippet_bytes": len(result["snippet"].encode()),
        })
    if scope_violations:
        failures.append("project_scope_violation")
    if forbidden_hits:
        failures.append("forbidden_source_returned")
    valid = not failures
    no_match = case["expectation"] == "no_match"
    return {
        **measurement,
        "case_id": case["id"],
        "split": case["split"],
        "language": case["language"],
        "tags": case["tags"],
        "budget_bytes": budget,
        "contract_valid": valid,
        "contract_failures": sorted(set(failures)),
        "truncated": payload.get("truncated"),
        "result_count": len(payload["results"]),
        "hits": hits,
        "matched_expected_sources": sorted(found),
        "source_recall_at_budget": len(found) / len(expected) if expected and valid else (0.0 if expected else None),
        "no_match_correct": valid and not payload["results"] and not payload["truncated"] if no_match else None,
        "scope_violations": scope_violations,
    }


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def summarize(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault((row["split"], row["budget_bytes"]), []).append(row)
    summary = []
    for (split, budget), values in sorted(grouped.items()):
        answerable = [row["source_recall_at_budget"] for row in values if row["source_recall_at_budget"] is not None]
        no_match = [row["no_match_correct"] for row in values if row["no_match_correct"] is not None]
        summary.append({
            "split": split,
            "budget_bytes": budget,
            "measurements": len(values),
            "cases": len({row["case_id"] for row in values}),
            "contract_failure_count": sum(not row["contract_valid"] for row in values),
            "macro_source_recall_at_budget": statistics.mean(answerable) if answerable else None,
            "no_match_accuracy": statistics.mean(no_match) if no_match else None,
            "latency_p50_ms": percentile([row["latency_ms"] for row in values], 0.5),
            "latency_p95_ms": percentile([row["latency_ms"] for row in values], 0.95),
            "mean_payload_bytes": statistics.mean(row["stdout_bytes"] for row in values),
            "max_payload_bytes": max(row["stdout_bytes"] for row in values),
        })
    return summary


def database_fingerprint(path):
    if path is None:
        return None
    return {suffix or "main": file_digest(Path(str(path) + suffix)) for suffix in ("", "-wal") if Path(str(path) + suffix).is_file()}


def import_and_replay(args):
    command = [str(args.iron), "--db", str(args.index), "memory", "import", "--claude-root", str(args.claude_root)]
    if args.cavemem_db:
        command += ["--cavemem-db", str(args.cavemem_db)]
    imports = []
    stats = []
    for _ in range(2):
        imported = execute(command, args.timeout)
        if imported["failure"] or not isinstance(imported["parsed"], dict):
            raise ValueError("import failed; raw child output is withheld from the report")
        if any(type(imported["parsed"].get(key)) is not int or imported["parsed"][key] < 0 for key in ("inserted", "updated", "unchanged", "removed")):
            raise ValueError("import report has missing or invalid mutation counters")
        imports.append(imported)
        measured = execute([str(args.iron), "--db", str(args.index), "memory", "stats"], args.timeout)
        if measured["failure"] or not isinstance(measured["parsed"], dict):
            raise ValueError("stats failed after import")
        stats.append(measured)
    return {
        "imports": imports,
        "stats": stats,
        "stats_unchanged_on_replay": stats[0]["parsed"] == stats[1]["parsed"],
        "replay_mutations_zero": all(imports[1]["parsed"][key] == 0 for key in ("inserted", "updated", "removed")),
    }


def same_path(left, right):
    return left == right or (left.exists() and right.exists() and left.samefile(right))


def validate_destinations(args):
    protected = {path for path in (args.iron, args.cases, args.manifest, args.cavemem_db) if path}
    if args.cavemem_db:
        protected.update(Path(str(args.cavemem_db) + suffix) for suffix in ("-wal", "-shm"))
    if any(path.is_relative_to(args.claude_root) or any(same_path(path, source) for source in protected) for path in (args.index, args.output)):
        raise ValueError("index and report must be separate paths outside the source corpus, fixtures, source database, and binary")
    if any(same_path(args.output, Path(str(args.index) + suffix)) for suffix in ("", "-wal", "-shm")):
        raise ValueError("report must not overwrite the benchmark database or its sidecars")
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("report already exists; use a fresh output path")


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        output.write(encode(report))


def run(args, cases, initial_manifest):
    validate_destinations(args)
    if args.index.exists() and not args.reuse_index:
        raise ValueError("benchmark index already exists; use a fresh path or explicit --reuse-index")
    if args.cavemem_db and not args.cavemem_db.is_file():
        raise ValueError("explicit Cavemem source database must exist")
    source_db_before = database_fingerprint(args.cavemem_db)
    imported = import_and_replay(args)
    baselines = {case["id"]: file_read_baseline(args.claude_root, case, args.budgets) for case in cases}
    jobs = [(case, budget, repeat) for repeat in range(args.repeats) for case in cases for budget in args.budgets]
    random.Random(args.seed).shuffle(jobs)
    rows = []
    for case, budget, repeat in jobs:
        argv = [str(args.iron), "--db", str(args.index), "memory", "search", case["query"], "--max-bytes", str(budget), "--limit", str(args.limit)]
        if case.get("project"):
            argv += ["--project", case["project"]]
        if case.get("strict_project"):
            argv.append("--strict-project")
        measured = inspect_search(execute(argv, args.timeout), args.claude_root, case, budget, args.limit)
        measured["repeat"] = repeat
        rows.append(measured)
    final_manifest = check_manifest(args.manifest, args.cases, args.claude_root)
    source_db_after = database_fingerprint(args.cavemem_db)
    report = {
        "schema_version": 1,
        "status": "measured_no_acceptance_verdict",
        "method": {
            "metric": "expected-source recall with nonempty snippets inside valid serialized stdout budget",
            "not_measured": ["answer correctness", "authority or freshness resolution", "model tokens", "billing savings", "peak RSS"],
            "baseline": "known-source oracle: available ancestor MEMORY.md indexes, then complete relevant Markdown, sequential whole-file payloads",
            "latency": "subprocess wall time including fresh CLI launch; filesystem cache uncontrolled; baseline reads run in this Python process",
            "budgets_bytes": args.budgets,
            "repeats": args.repeats,
            "seed": args.seed,
        },
        "fixture_sha256": digest(args.cases.read_bytes()),
        "binary": {"sha256": file_digest(args.iron), "bytes": args.iron.stat().st_size},
        "source_manifest": {key: value for key, value in initial_manifest.items() if key != "files"},
        "selected_sources_unchanged_during_run": initial_manifest["files"] == final_manifest["files"] if args.manifest else None,
        "cavemem_source_unchanged_during_run": source_db_before == source_db_after if args.cavemem_db else None,
        "cavemem_source_before": source_db_before,
        "import": imported,
        "summary": summarize(rows),
        "file_read_baselines": baselines,
        "measurements": rows,
    }
    write_report(args.output, report)
    print(json.dumps({"report": str(args.output), "summary": report["summary"]}, indent=2))
    failed = any(not row["contract_valid"] for row in rows)
    failed = failed or not imported["replay_mutations_zero"]
    failed = failed or report["selected_sources_unchanged_during_run"] is False
    failed = failed or report["cavemem_source_unchanged_during_run"] is False
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["validate", "run"])
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("synthetic.jsonl"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--claude-root", type=Path, required=True)
    parser.add_argument("--cavemem-db", type=Path)
    parser.add_argument("--iron", type=Path)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--split", choices=["all", "calibration", "heldout"], default="all")
    parser.add_argument("--budgets", type=int, nargs="+", default=[2000, 4000])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--seed", type=int, default=20261120)
    parser.add_argument("--reuse-index", action="store_true")
    parser.add_argument("--allow-source-drift", action="store_true")
    args = parser.parse_args()
    for name in ("claude_root", "cavemem_db", "iron", "index", "cases", "manifest", "output"):
        value = getattr(args, name)
        if value is not None:
            setattr(args, name, value.expanduser().resolve())
    if args.manifest is None:
        candidate = args.cases.with_name(args.cases.stem + "-sources.json")
        if candidate.is_file():
            args.manifest = candidate
    if not args.claude_root.is_dir():
        parser.error("explicit Claude root must exist")
    if min(args.budgets) < 256 or args.repeats < 1 or args.limit < 1 or args.timeout <= 0:
        parser.error("invalid budget, repeats, limit, or timeout")
    try:
        cases = read_cases(args.cases, args.claude_root)
        manifest = check_manifest(args.manifest, args.cases, args.claude_root)
        if manifest["status"] == "drift" and not args.allow_source_drift:
            raise ValueError("source snapshot drift; use the frozen corpus or explicit --allow-source-drift")
        selected = [case for case in cases if args.split == "all" or case["split"] == args.split]
        if not selected:
            raise ValueError("selected split is empty")
        if args.mode == "validate":
            print(json.dumps({"cases": len(selected), "fixture_sha256": digest(args.cases.read_bytes()), "manifest_status": manifest["status"]}))
            return 0
        if not args.iron or not args.iron.is_file() or not args.index or not args.output:
            parser.error("run needs --iron, --index, and --output")
        return run(args, selected, manifest)
    except (ValueError, OSError, KeyError) as exc:
        print(f"evaluation error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
