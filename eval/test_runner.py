import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import runner


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "corpus"
        self.root.mkdir()
        (self.root / "memory").mkdir()
        (self.root / "memory/MEMORY.md").write_text("# Index\n- [Note](note.md)\n")
        (self.root / "memory/note.md").write_text("# Note\nPRIVATE_REPORT_SENTINEL café avión\n")
        self.case = {
            "id": "one",
            "split": "heldout",
            "query": "café",
            "expected_sources": ["memory/note.md"],
            "expectation": "evidence",
            "language": "es",
            "tags": ["synthetic"],
        }
        self.hit = {
            "id": "mem_one",
            "source_path": str(self.root / "memory/note.md"),
            "project": "*",
            "source_type": "markdown",
            "snippet": "PRIVATE_REPORT_SENTINEL café avión",
        }

    def measured(self, results, truncated=False):
        parsed = {"results": results, "truncated": truncated}
        return {"failure": None, "stdout_bytes": len(runner.encode(parsed)), "latency_ms": 1, "parsed": parsed}

    def test_budget_counts_utf8_and_final_newline_and_invalid_output_gets_no_credit(self):
        measured = self.measured([self.hit])
        result = runner.inspect_search(copy.deepcopy(measured), self.root, self.case, measured["stdout_bytes"], 10)
        self.assertEqual(result["source_recall_at_budget"], 1)
        result = runner.inspect_search(measured, self.root, self.case, measured["stdout_bytes"] - 1, 10)
        self.assertEqual(result["source_recall_at_budget"], 0)
        self.assertIn("output_exceeds_byte_budget", result["contract_failures"])

    def test_empty_snippet_does_not_count_as_evidence(self):
        self.hit["snippet"] = " \n"
        result = runner.inspect_search(self.measured([self.hit]), self.root, self.case, 2000, 10)
        self.assertEqual(result["source_recall_at_budget"], 0)

    def test_missing_envelope_is_not_a_correct_no_match(self):
        self.case.update(expected_sources=[], expectation="no_match")
        malformed = {"failure": None, "stdout_bytes": 3, "latency_ms": 1, "parsed": {}}
        result = runner.inspect_search(malformed, self.root, self.case, 2000, 10)
        self.assertFalse(result["no_match_correct"])
        self.assertFalse(result["contract_valid"])

    def test_truncated_empty_output_does_not_establish_no_match(self):
        self.case.update(expected_sources=[], expectation="no_match")
        result = runner.inspect_search(self.measured([], truncated=True), self.root, self.case, 2000, 10)
        self.assertFalse(result["no_match_correct"])
        result = runner.inspect_search(self.measured([]), self.root, self.case, 2000, 10)
        self.assertTrue(result["no_match_correct"])

    def test_project_and_global_scopes_are_checked_in_the_received_payload(self):
        self.case.update(project="northstar", strict_project=True)
        result = runner.inspect_search(self.measured([self.hit]), self.root, self.case, 2000, 10)
        self.assertIn("project_scope_violation", result["contract_failures"])
        self.case["strict_project"] = False
        result = runner.inspect_search(self.measured([self.hit]), self.root, self.case, 2000, 10)
        self.assertTrue(result["contract_valid"])
        self.hit["project"] = "southbank"
        result = runner.inspect_search(self.measured([self.hit]), self.root, self.case, 2000, 10)
        self.assertFalse(result["contract_valid"])

    def test_path_aliases_deduplicate_and_outside_paths_never_match(self):
        (self.root / "alias.md").symlink_to(self.root / "memory/note.md")
        self.hit["source_path"] = (self.root / "alias.md").as_uri()
        result = runner.inspect_search(self.measured([self.hit, self.hit]), self.root, self.case, 2000, 10)
        self.assertEqual(result["source_recall_at_budget"], 1)
        self.assertEqual(len(result["matched_expected_sources"]), 1)
        self.hit["source_path"] = str(self.base / "other.md")
        result = runner.inspect_search(self.measured([self.hit]), self.root, self.case, 2000, 10)
        self.assertEqual(result["source_recall_at_budget"], 0)

    def test_baseline_reads_indexes_then_whole_sources_and_does_not_save_content(self):
        full = runner.file_read_baseline(self.root, self.case, [10000])
        self.assertEqual([file["role"] for file in full["files"]], ["discovery_index", "expected_source"])
        bounded = runner.file_read_baseline(self.root, self.case, [full["payload_bytes"] - 1, full["payload_bytes"]])
        self.assertEqual(bounded["at_budget"][str(full["payload_bytes"] - 1)]["source_recall"], 0)
        self.assertEqual(bounded["at_budget"][str(full["payload_bytes"])]["source_recall"], 1)
        self.assertNotIn("PRIVATE_REPORT_SENTINEL", json.dumps(bounded))

    def test_fixture_path_cannot_escape_corpus(self):
        (self.base / "outside.md").write_text("outside")
        self.case["expected_sources"] = ["../outside.md"]
        cases = self.base / "cases.jsonl"
        cases.write_bytes(runner.encode(self.case))
        with self.assertRaisesRegex(ValueError, "escapes"):
            runner.read_cases(cases, self.root)

    def test_manifest_detects_source_drift_and_refuses_changed_queries(self):
        cases = self.base / "cases.jsonl"
        cases.write_bytes(runner.encode(self.case))
        source = self.root / "memory/note.md"
        manifest = self.base / "manifest.json"
        manifest.write_text(json.dumps({"fixture_sha256": runner.digest(cases.read_bytes()), "sources": {"memory/note.md": {"sha256": runner.digest(source.read_bytes()), "bytes": source.stat().st_size}}}))
        self.assertEqual(runner.check_manifest(manifest, cases, self.root)["status"], "matched")
        source.write_text("changed")
        self.assertEqual(runner.check_manifest(manifest, cases, self.root)["status"], "drift")
        cases.write_bytes(runner.encode({**self.case, "query": "changed"}))
        with self.assertRaisesRegex(ValueError, "fixture changed"):
            runner.check_manifest(manifest, cases, self.root)

    def test_child_invalid_json_and_stderr_are_not_returned_as_data(self):
        measured = runner.execute([sys.executable, "-c", "import sys; print('{\"x\":NaN}'); print('PRIVATE_REPORT_SENTINEL',file=sys.stderr)"], 5)
        self.assertEqual(measured["failure"], "invalid_utf8_or_json")
        self.assertNotIn("PRIVATE_REPORT_SENTINEL", json.dumps(measured))

    def test_output_cannot_overwrite_source_database_sidecars_or_hardlinks(self):
        source = self.base / "source.db"
        source.write_text("source")
        args = SimpleNamespace(iron=self.base / "iron", cases=self.base / "cases", manifest=None, cavemem_db=source, index=self.base / "index.db", output=self.base / "source.db-wal", claude_root=self.root)
        with self.assertRaisesRegex(ValueError, "separate paths"):
            runner.validate_destinations(args)
        alias = self.base / "source-alias.db"
        alias.hardlink_to(source)
        args.output = alias
        with self.assertRaisesRegex(ValueError, "separate paths"):
            runner.validate_destinations(args)
        args.output = self.base / "index.db-wal"
        with self.assertRaisesRegex(ValueError, "sidecars"):
            runner.validate_destinations(args)

    def test_existing_reports_and_hardlinked_corpus_outputs_are_refused(self):
        source = self.root / "memory/note.md"
        original = source.read_bytes()
        output = self.base / "report.json"
        args = SimpleNamespace(iron=self.base / "iron", cases=self.base / "cases", manifest=None, cavemem_db=None, index=self.base / "index.db", output=output, claude_root=self.root)
        output.hardlink_to(source)
        with self.assertRaisesRegex(ValueError, "report already exists"):
            runner.validate_destinations(args)
        self.assertEqual(source.read_bytes(), original)
        output.unlink()
        output.write_bytes(b"existing report")
        with self.assertRaisesRegex(ValueError, "report already exists"):
            runner.validate_destinations(args)
        self.assertEqual(output.read_bytes(), b"existing report")

    def test_report_publication_refuses_a_late_hardlink_without_overwriting(self):
        source = self.root / "memory/note.md"
        original = source.read_bytes()
        output = self.base / "report.json"
        args = SimpleNamespace(iron=self.base / "iron", cases=self.base / "cases", manifest=None, cavemem_db=None, index=self.base / "index.db", output=output, claude_root=self.root)
        runner.validate_destinations(args)
        output.hardlink_to(source)
        with self.assertRaises(FileExistsError):
            runner.write_report(output, {"new": "report"})
        self.assertEqual(source.read_bytes(), original)

    def test_subprocess_boundary_invokes_real_argv_and_keeps_reports_content_free(self):
        binary = self.base / "fake-iron"
        binary.write_text("""#!/usr/bin/env python3
import json,sys
from pathlib import Path
args=sys.argv[1:]
assert args[0]=='--db'
assert args[2]=='memory'
state=Path(args[1])
command=args[3]
if command=='import':
    assert '--claude-root' in args
    existed=state.exists()
    state.write_text(args[args.index('--claude-root')+1])
    print(json.dumps({'inserted':0 if existed else 1,'updated':0,'unchanged':1 if existed else 0,'removed':0}))
elif command=='stats':
    print(json.dumps({'records':1}))
elif command=='search':
    assert args[4]=='café'
    assert args[args.index('--max-bytes')+1]=='2000'
    assert args[args.index('--limit')+1]=='10'
    print(json.dumps({'results':[{'id':'mem_one','source_path':str(Path(state.read_text())/'memory/note.md'),'project':'*','source_type':'markdown','snippet':'PRIVATE_REPORT_SENTINEL café'}],'truncated':False},ensure_ascii=False))
else:
    sys.exit(1)
""")
        binary.chmod(0o755)
        cases = self.base / "cases.jsonl"
        cases.write_bytes(runner.encode(self.case))
        output = self.base / "report.json"
        command = [sys.executable, str(Path(runner.__file__)), "run", "--iron", str(binary), "--index", str(self.base / "index.db"), "--claude-root", str(self.root), "--cases", str(cases), "--budgets", "2000", "--repeats", "1", "--output", str(output)]
        process = subprocess.run(command, capture_output=True, check=False)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        report = json.loads(output.read_bytes())
        self.assertEqual(report["summary"][0]["macro_source_recall_at_budget"], 1)
        self.assertTrue(report["import"]["replay_mutations_zero"])
        self.assertNotIn("PRIVATE_REPORT_SENTINEL", output.read_text())
        self.assertEqual(report["status"], "measured_no_acceptance_verdict")


if __name__ == "__main__":
    unittest.main()
