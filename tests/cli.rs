use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    db: PathBuf,
    cave: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("claude");
        fs::create_dir_all(root.join("memory/projects/alpha")).unwrap();
        fs::create_dir_all(root.join("memory/projects/beta")).unwrap();
        fs::create_dir_all(root.join("agent-memory/dev")).unwrap();
        fs::write(root.join("memory/projects/alpha/decision.md"), "# Widget ledger\nProject alpha uses widget ledger isolation. See [evidence](evidence.md).\n<private>NEVER-RETURN-THIS</private>\n").unwrap();
        fs::write(root.join("memory/projects/alpha/evidence.md"), "# Widget evidence\nWidget acceptance checks require a pinned snapshot. Historical VERIFIED is not a current release pass.\n").unwrap();
        fs::write(
            root.join("memory/projects/beta/decision.md"),
            "# Widget beta\nProject beta uses a different widget ledger.\n",
        )
        .unwrap();
        fs::write(
            root.join("agent-memory/dev/pattern.md"),
            "# Widget convention\nGlobal widget conventions are shared.\n",
        )
        .unwrap();
        let cave = temp.path().join("cavemem.db");
        let conn = Connection::open(&cave).unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, ide TEXT, cwd TEXT, started_at INTEGER, ended_at INTEGER, metadata TEXT);
            CREATE TABLE summaries(id INTEGER PRIMARY KEY, session_id TEXT, scope TEXT, content TEXT, compressed INTEGER, intensity TEXT, ts INTEGER);
            CREATE TABLE observations(id INTEGER PRIMARY KEY, session_id TEXT, kind TEXT, content TEXT, compressed INTEGER, intensity TEXT, ts INTEGER, metadata TEXT);
            INSERT INTO sessions VALUES('session-one','claude-code','/home/iron-fixture/Projects/alpha',1,2,NULL);
            INSERT INTO summaries VALUES(11,'session-one','turn','The zephyr outage was caused by widget retries.',1,'full',12345);").unwrap();
        let db = temp.path().join("iron.db");
        Self {
            _temp: temp,
            root,
            db,
            cave,
        }
    }

    fn call(&self, args: &[&str]) -> (Value, Vec<u8>) {
        let out = Command::new(env!("CARGO_BIN_EXE_iron"))
            .arg("--db")
            .arg(&self.db)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        (serde_json::from_slice(&out.stdout).unwrap(), out.stdout)
    }

    fn import(&self) -> Value {
        self.call(&[
            "memory",
            "import",
            "--claude-root",
            self.root.to_str().unwrap(),
            "--cavemem-db",
            self.cave.to_str().unwrap(),
        ])
        .0
    }
}

#[test]
fn import_preserves_source_and_exposes_summary_only_cavemem() {
    let fixture = Fixture::new();
    let before = Sha256::digest(fs::read(&fixture.cave).unwrap());
    let first = fixture.import();
    assert!(first["inserted"].as_u64().unwrap() >= 5);
    assert_eq!(Sha256::digest(fs::read(&fixture.cave).unwrap()), before);
    let again = fixture.import();
    assert_eq!(again["inserted"], 0);
    assert_eq!(again["updated"], 0);
    assert_eq!(again["removed"], 0);
    let search = fixture
        .call(&[
            "memory",
            "search",
            "zephyr",
            "--project",
            "alpha",
            "--strict-project",
        ])
        .0;
    let id = search["results"][0]["id"].as_str().unwrap();
    let record = fixture.call(&["memory", "get", id]).0;
    assert!(record["content"].as_str().unwrap().contains("zephyr"));
    assert!(record["metadata"].to_string().contains("session-one"));
}

#[test]
fn scope_privacy_and_explicit_links_are_visible_through_cli() {
    let fixture = Fixture::new();
    fixture.import();
    let (out, raw) = fixture.call(&[
        "memory",
        "search",
        "widget",
        "--project",
        "alpha",
        "--strict-project",
        "--max-bytes",
        "2000",
    ]);
    assert!(raw.len() <= 2000);
    assert!(!out["results"].as_array().unwrap().is_empty());
    for hit in out["results"].as_array().unwrap() {
        assert_eq!(hit["project"], "alpha");
    }
    let search = fixture
        .call(&[
            "memory",
            "search",
            "isolation",
            "--project",
            "alpha",
            "--strict-project",
        ])
        .0;
    let id = search["results"][0]["id"].as_str().unwrap();
    let record = fixture.call(&["memory", "get", id]).0;
    assert!(!record.to_string().contains("NEVER-RETURN-THIS"));
    let related = fixture.call(&["memory", "related", id]).0;
    assert!(
        related["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["source_path"].as_str().unwrap().ends_with("evidence.md"))
    );
}

#[test]
fn refresh_replaces_removed_and_changed_source_records() {
    let fixture = Fixture::new();
    fixture.import();
    fs::remove_file(fixture.root.join("memory/projects/beta/decision.md")).unwrap();
    fs::write(
        fixture.root.join("memory/projects/alpha/decision.md"),
        "# New guidance\nThe quasar correction replaces prior guidance.\n",
    )
    .unwrap();
    let refresh = fixture.import();
    assert!(refresh["updated"].as_u64().unwrap() >= 1);
    assert!(refresh["removed"].as_u64().unwrap() >= 1);
    assert_eq!(
        fixture.call(&["memory", "search", "isolation"]).0["no_match"],
        true
    );
    assert_eq!(
        fixture.call(&["memory", "search", "quasar"]).0["no_match"],
        false
    );
}

#[test]
fn invalid_queries_and_small_budgets_do_not_crash_or_expand_output() {
    let fixture = Fixture::new();
    fixture.import();
    for query in [
        "\" OR * NOT (",
        "水🚀",
        "widget\"; DROP TABLE memories; --",
        "zyxqvunknown",
    ] {
        let (_, raw) = fixture.call(&["memory", "search", query, "--max-bytes", "256"]);
        assert!(raw.len() <= 256);
    }
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .args(["memory", "search", "widget", "--max-bytes", "5"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn reviewer_context_excludes_session_narratives() {
    let fixture = Fixture::new();
    fixture.import();
    assert_eq!(
        fixture.call(&["context", "zephyr", "--role", "reviewer"]).0["no_match"],
        true
    );
    assert_eq!(
        fixture.call(&["context", "widget", "--role", "reviewer"]).0["no_match"],
        false
    );
}

#[test]
fn explicit_source_filters_keep_captured_history_and_curated_notes_separate() {
    let fixture = Fixture::new();
    fixture.import();
    assert_eq!(
        fixture
            .call(&["memory", "search", "zephyr", "--source", "history"])
            .0["no_match"],
        false
    );
    assert_eq!(
        fixture
            .call(&["memory", "search", "zephyr", "--source", "curated"])
            .0["no_match"],
        true
    );
    assert_eq!(
        fixture
            .call(&["memory", "search", "widget", "--source", "native"])
            .0["no_match"],
        true
    );
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .args([
            "context", "zephyr", "--role", "reviewer", "--source", "history",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn mcp_stdio_initializes_calls_tools_and_keeps_notifications_silent() {
    let fixture = Fixture::new();
    fixture.import();
    let mut child = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"zephyr","max_bytes":1000}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"widget","unknown":true}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"does/not/exist"}),
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}),
    ];
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 5);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 6);
    let content = replies[2]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(content.len() <= 1000);
    assert_eq!(
        serde_json::from_str::<Value>(content).unwrap()["no_match"],
        false
    );
    assert_eq!(replies[3]["error"]["code"], -32602);
    assert_eq!(replies[4]["error"]["code"], -32601);
}

#[test]
fn missing_sources_and_source_index_collision_are_refused() {
    let fixture = Fixture::new();
    fixture.import();
    let before = fs::read(&fixture.db).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .args([
            "memory",
            "import",
            "--claude-root",
            "/nonexistent-iron-fixture",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(before, fs::read(&fixture.db).unwrap());
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.cave)
        .arg("memory")
        .arg("import")
        .arg("--cavemem-db")
        .arg(&fixture.cave)
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[test]
fn mcp_native_save_is_visible_to_cli_and_survives_source_refresh() {
    let fixture = Fixture::new();
    fixture.import();
    let mut child = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"antigravity-fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_remember","arguments":{"title":"Shared orbit decision","content":"The orbitmarker belongs in one desktop hub.","project":"alpha","agent":"antigravity","kind":"decision"}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"orbitmarker","project":"alpha","strict_project":true}}}),
    ];
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    let saved: Value =
        serde_json::from_str(replies[1]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let search: Value =
        serde_json::from_str(replies[2]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(saved["saved"], true);
    assert_eq!(search["results"][0]["id"], saved["id"]);
    fixture.import();
    let record = fixture
        .call(&["memory", "get", saved["id"].as_str().unwrap()])
        .0;
    assert_eq!(record["metadata"]["agent"], "antigravity");
    assert_eq!(record["source_type"], "iron");
    let replay = fixture
        .call(&[
            "memory",
            "remember",
            "--title",
            "Shared orbit decision",
            "--content",
            "The orbitmarker belongs in one desktop hub.",
            "--project",
            "alpha",
            "--agent",
            "antigravity",
            "--kind",
            "decision",
        ])
        .0;
    assert_eq!(replay["id"], saved["id"]);
    assert_eq!(replay["duplicate"], true);
}

#[test]
fn mcp_handles_maximum_escaped_native_content_and_rejects_oversized_content() {
    let fixture = Fixture::new();
    fixture.import();
    let mut child = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"boundary-fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_remember","arguments":{"title":"Maximum escaped content","content":"\u{0001}".repeat(65536),"project":"alpha"}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_remember","arguments":{"title":"Over maximum","content":"a".repeat(65537),"project":"alpha"}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"ping"}),
    ];
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[1]["result"]["isError"], false);
    assert_eq!(replies[2]["result"]["isError"], true);
    assert_eq!(replies[3]["result"], json!({}));
}

#[test]
fn migrate_v1_store_splits_hot_and_cold_archive_with_zero_loss_and_archive_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let v1_db = temp.path().join("v1_legacy.db");
    let conn = Connection::open(&v1_db).unwrap();
    conn.pragma_update(None, "application_id", 0x4952_4f4e_i64)
        .unwrap();
    conn.execute_batch(
        "PRAGMA user_version = 1;
         CREATE TABLE bodies (
             hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64),
             content TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE records (
             rowid INTEGER PRIMARY KEY,
             id TEXT NOT NULL UNIQUE,
             source_group TEXT NOT NULL,
             source_key TEXT NOT NULL UNIQUE,
             source_type TEXT NOT NULL,
             kind TEXT NOT NULL,
             project TEXT NOT NULL,
             title TEXT NOT NULL,
             content_hash TEXT NOT NULL REFERENCES bodies(hash),
             source_path TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             metadata TEXT NOT NULL
         );
         CREATE TABLE memory_links (
             from_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
             to_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
             relation TEXT NOT NULL,
             PRIMARY KEY (from_id, to_id, relation)
         ) WITHOUT ROWID;
         INSERT INTO bodies VALUES (
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'Curated ledger rule referencing src/ledger_guard.rs and CWE-89.'
         );
         INSERT INTO bodies VALUES (
             'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
             'Turn summary referencing src/ledger_guard.rs and CWE-89 in session two.'
         );
         INSERT INTO bodies VALUES (
             'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
             'Cold raw tool output observation containing raretoken_coldobs_99.'
         );
         INSERT INTO records VALUES (
             1, 'mem_curated_one', 'md:alpha:rule.md', 'md:alpha:rule.md', 'markdown', 'curated',
             'alpha', 'Ledger guard rule',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'memory/projects/alpha/rule.md', 1000, '{}'
         );
         INSERT INTO records VALUES (
             2, 'mem_summary_two', 'cavemem:summaries', 'cavemem:summary:2', 'cavemem', 'summary',
             'beta', 'Session summary two',
             'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
             'cavemem://summary/2', 2000, '{\"session_id\":\"sess-2\"}'
         );
         INSERT INTO records VALUES (
             3, 'mem_obs_three', 'cavemem:observations', 'cavemem:obs:3', 'cavemem', 'observation',
             'alpha', 'Raw bash observation',
             'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
             'cavemem://observation/3', 3000, '{\"session_id\":\"sess-1\"}'
         );
         INSERT INTO memory_links VALUES ('mem_curated_one', 'mem_summary_two', 'references');",
    )
    .unwrap();
    drop(conn);

    let hot_db = temp.path().join("memory.db");
    let archive_db = temp.path().join("archive.db");
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .args([
            "memory",
            "migrate",
            "--from",
            v1_db.to_str().unwrap(),
            "--output",
            hot_db.to_str().unwrap(),
            "--archive-output",
            archive_db.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["source_records"], 3);
    assert_eq!(report["hot_records"], 2);
    assert_eq!(report["archive_records"], 1);
    assert!(report["auto_links_built"].as_u64().unwrap() >= 2);

    // Hot search does not include cold observation, archive search finds it, and get falls back cleanly
    let hot_miss: Value = serde_json::from_slice(
        &Command::new(env!("CARGO_BIN_EXE_iron"))
            .arg("--db")
            .arg(&hot_db)
            .args(["memory", "search", "raretoken_coldobs_99"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(hot_miss["no_match"], true);

    let arch_hit: Value = serde_json::from_slice(
        &Command::new(env!("CARGO_BIN_EXE_iron"))
            .arg("--db")
            .arg(&hot_db)
            .args([
                "memory",
                "search",
                "raretoken_coldobs_99",
                "--source",
                "archive",
            ])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(arch_hit["results"][0]["id"], "mem_obs_three");

    let fallback_get: Value = serde_json::from_slice(
        &Command::new(env!("CARGO_BIN_EXE_iron"))
            .arg("--db")
            .arg(&hot_db)
            .args(["memory", "get", "mem_obs_three"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(fallback_get["found"], true);
    assert!(
        fallback_get["content"]
            .as_str()
            .unwrap()
            .contains("raretoken_coldobs_99")
    );
}

#[test]
fn v02_autolink_reinforcement_feedback_supersession_and_consolidate_work_end_to_end() {
    let fixture = Fixture::new();
    fixture.import();

    // Save two notes across different projects sharing technical anchors (src/outbox_worker.rs + SQLSTATE 40001)
    let first = fixture
        .call(&[
            "memory",
            "remember",
            "--title",
            "Outbox serialization failure",
            "--content",
            "Retry SQLSTATE 40001 inside src/outbox_worker.rs using jittered backoff.",
            "--project",
            "alpha",
            "--agent",
            "claude",
            "--kind",
            "gotcha",
        ])
        .0;
    let first_id = first["id"].as_str().unwrap().to_owned();

    let second = fixture
        .call(&[
            "memory",
            "remember",
            "--title",
            "Beta outbox retry lesson",
            "--content",
            "Service beta also hit SQLSTATE 40001 in src/outbox_worker.rs during burst writes.",
            "--project",
            "beta",
            "--agent",
            "codex",
            "--kind",
            "note",
        ])
        .0;
    let second_id = second["id"].as_str().unwrap().to_owned();
    // Write-time cross-project auto-link discovery!
    assert!(
        second["related_memories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == first_id && m["relation"] == "shares_anchor")
    );

    // Consolidate surfaces recurring anchor cluster across distinct memories
    let consolidated = fixture
        .call(&["memory", "consolidate", "--min-occurrences", "2"])
        .0;
    assert!(
        consolidated["clusters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["anchor"].as_str().unwrap().contains("outbox_worker.rs"))
    );

    // MCP session: supersede first_id via a correction, verify implicit get reinforcement & feedback tool
    let mut child = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(&fixture.db)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"v02-fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_remember","arguments":{
            "title":"Corrected outbox retry cap",
            "content":"Cap SQLSTATE 40001 retries in src/outbox_worker.rs at 3 attempts before dead-lettering.",
            "project":"alpha",
            "agent":"antigravity",
            "kind":"correction",
            "supersedes":[first_id]
        }}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_get","arguments":{"id":second_id}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_feedback","arguments":{"id":second_id,"outcome":"helpful"}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"outbox_worker","project":"alpha","strict_project":true}}}),
    ];
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let corr_saved: Value =
        serde_json::from_str(replies[1]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let corr_id = corr_saved["id"].as_str().unwrap();
    assert_eq!(corr_saved["superseded"][0], first_id);

    let feedback_reply: Value =
        serde_json::from_str(replies[3]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(feedback_reply["stats"]["use_count"], 2);
    assert_eq!(feedback_reply["stats"]["confirm_count"], 1);

    let search_reply: Value =
        serde_json::from_str(replies[4]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let results = search_reply["results"].as_array().unwrap();
    assert_eq!(results[0]["id"], corr_id);
    let old_hit = results.iter().find(|r| r["id"] == first_id).unwrap();
    assert_eq!(old_hit["status"], "superseded");
    assert_eq!(old_hit["superseded_by"], corr_id);
}

#[test]
fn file_recall_credits_markdown_memory_once_per_session_and_feeds_outcomes() {
    let fixture = Fixture::new();
    fixture.import();
    let decision = fixture.root.join("memory/projects/alpha/decision.md");
    let decision = decision.to_str().unwrap();

    let (first, _) = fixture.call(&[
        "memory",
        "recall",
        "--path",
        decision,
        "--session",
        "claude-s1",
    ]);
    assert_eq!(first["found"], true);
    assert_eq!(first["project"], "alpha");
    assert_eq!(first["reinforced"], true);
    let id = first["id"].as_str().unwrap().to_owned();

    let (again, _) = fixture.call(&[
        "memory",
        "recall",
        "--path",
        decision,
        "--session",
        "claude-s1",
    ]);
    assert_eq!(again["id"], id.as_str());
    assert_eq!(again["reinforced"], false);

    let missing = fixture.root.join("memory/projects/alpha/absent.md");
    let (absent, _) = fixture.call(&[
        "memory",
        "recall",
        "--path",
        missing.to_str().unwrap(),
        "--session",
        "claude-s1",
    ]);
    assert_eq!(absent["found"], false);

    let (outcome, _) = fixture.call(&["memory", "outcome", "--outcome", "pass", "--project", "alpha"]);
    let targets: Vec<&str> = outcome["target_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(targets, vec![id.as_str()]);
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn init_git_repo(dir: &std::path::Path, files: &[(&str, &str)]) -> String {
    fs::create_dir_all(dir).unwrap();
    git_in(dir, &["init", "-q"]);
    git_in(dir, &["config", "user.email", "test@iron.local"]);
    git_in(dir, &["config", "user.name", "Iron Test"]);
    for (rel, body) in files {
        let target = dir.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&target, body).unwrap();
    }
    git_in(dir, &["add", "."]);
    git_in(dir, &["commit", "-q", "-m", "init"]);
    git_in(dir, &["rev-parse", "HEAD"])
}

fn write_graph_cfg(db: &std::path::Path, cfg: Value) {
    let cfg_path = db.parent().unwrap().join("system-graph.json");
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
}

fn run_iron_text(db: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_iron"))
        .arg("--db")
        .arg(db)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "iron {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn call_mcp_sequence(db: &std::path::Path, requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_iron"))
        .args(["--db", db.to_str().unwrap(), "mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).unwrap();
    writeln!(stdin, "{}", json!({"jsonrpc":"2.0","method":"notifications/initialized"})).unwrap();
    for req in requests {
        writeln!(stdin, "{req}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn system_graph_refresh_skips_unchanged_rescans_on_commit_and_serves_queries_and_mcp() {
    let fixture = Fixture::new();
    fixture.import();

    let repos_root = fixture._temp.path().join("repos");
    let api_sha = init_git_repo(
        &repos_root.join("shop-api"),
        &[(
            "backend/src/api.rs",
            r#"pub fn router() -> Router {
    Router::new()
        .route(
            "/api/internal/invoices",
            post(create_invoice),
        )
        .route("/api/v1/sales", get(list_sales))
}
"#,
        )],
    );
    init_git_repo(
        &repos_root.join("billing-svc"),
        &[
            (
                "src/client.rs",
                r#"impl ShopClient {
    /// Emit invoice in shop-api.
    async fn issue(&self) {
        let _ = self.http.post(format!("{}/api/internal/invoices", self.base_url)).send().await;
    }

    async fn unknown_call(&self) {
        let _ = self.http.get(format!("{}/api/v1/does-not-exist", self.other_url)).send().await;
    }
}
"#,
            ),
            (
                "src/scrapers/vendor.rs",
                r#"async fn scrape(c: &reqwest::Client) {
    let _ = c.get("https://vendor.example/items").send().await;
}
"#,
            ),
        ],
    );
    init_git_repo(
        &repos_root.join("shop-web"),
        &[
            (
                "frontend/src/lib/api.ts",
                r#"export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  sales: {
    list: () => apiFetch("/sales"),
  },
};
"#,
            ),
            (
                "frontend/src/pages/sales/SalesView.tsx",
                r#"// Render active sales list.
export async function loadSales() {
  return api.sales.list();
}
"#,
            ),
        ],
    );

    let cfg = json!({
        "repos_root": repos_root,
        "services": {
            "shop-api": {"repo": "shop-api", "root": "backend", "stack": "axum"},
            "billing-svc": {"repo": "billing-svc", "root": "", "stack": "axum"},
            "shop-web": {
                "repo": "shop-web",
                "root": "frontend",
                "stack": "spa",
                "client": "src/lib/api.ts",
                "base": "shop-api",
                "base_prefix": "/api/v1"
            }
        },
        "env": {},
        "clients": {
            "billing-svc:src/client.rs": "shop-api"
        },
        "external": [
            "billing-svc:src/scrapers/**"
        ]
    });
    fs::write(
        fixture.db.parent().unwrap().join("system-graph.json"),
        serde_json::to_string_pretty(&cfg).unwrap(),
    )
    .unwrap();

    let missing_replies = call_mcp_sequence(
        &fixture.db,
        &[json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "system_graph",
                "arguments": {"query": "POST /api/internal/invoices", "direction": "callers"}
            }
        })],
    );
    assert_eq!(missing_replies[0]["result"]["isError"], false);
    assert!(
        missing_replies[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("iron memory graph refresh")
    );

    let (first_refresh, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(first_refresh["scanned"], 3);
    assert_eq!(first_refresh["skipped"], 0);
    assert_eq!(first_refresh["endpoints"], 2);
    assert_eq!(first_refresh["edges"], 2);
    assert_eq!(first_refresh["fog"], 1);

    let short_sha = &api_sha[..7];
    let who_inv = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "who-calls",
            "POST /api/internal/invoices",
            "--max-bytes",
            "1200",
        ],
    );
    assert!(who_inv.len() <= 1200);
    let expected_inv = format!(
        "POST /api/internal/invoices <- shop-api backend/src/api.rs:4@{short_sha} (create_invoice, full)\n  <- billing-svc src/client.rs:4 [configured] — issue: Emit invoice in shop-api.\n"
    );
    assert_eq!(who_inv, expected_inv);

    let who_sales = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "who-calls",
            "GET /api/v1/sales",
            "--max-bytes",
            "1200",
        ],
    );
    assert!(who_sales.len() <= 1200);
    assert!(who_sales.contains("1 files in pages: sales"), "{who_sales}");
    assert!(who_sales.contains("[configured]"), "{who_sales}");

    let abs_client = repos_root.join("billing-svc/src/client.rs");
    let impact_txt = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "impact",
            "--file",
            abs_client.to_str().unwrap(),
        ],
    );
    assert!(impact_txt.contains("POST /api/internal/invoices -> shop-api"), "{impact_txt}");
    assert!(impact_txt.contains("GET /api/v1/does-not-exist -> [fog]"), "{impact_txt}");

    let fog_txt = run_iron_text(&fixture.db, &["memory", "graph", "fog"]);
    assert!(fog_txt.contains("fog: 1 unresolved"), "{fog_txt}");
    assert!(fog_txt.contains("/api/v1/does-not-exist"), "{fog_txt}");
    assert!(!fog_txt.contains("vendor.rs"), "{fog_txt}");

    let (second_refresh, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(second_refresh["scanned"], 0);
    assert_eq!(second_refresh["skipped"], 3);

    fs::write(
        repos_root.join("shop-api/backend/src/extra.rs"),
        "pub fn extra() -> Router { Router::new().route(\"/api/v1/ping\", get(ping)) }\n",
    )
    .unwrap();
    git_in(&repos_root.join("shop-api"), &["add", "."]);
    git_in(&repos_root.join("shop-api"), &["commit", "-q", "-m", "add ping"]);

    let (third_refresh, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(third_refresh["scanned"], 1);
    assert_eq!(third_refresh["skipped"], 2);
    assert_eq!(third_refresh["files_scanned"], 1);
    assert_eq!(third_refresh["endpoints"], 3);

    let who_ping = run_iron_text(&fixture.db, &["memory", "graph", "who-calls", "/api/v1/ping"]);
    assert!(who_ping.contains("GET /api/v1/ping <- shop-api backend/src/extra.rs:1@"), "{who_ping}");

    let mcp_replies = call_mcp_sequence(
        &fixture.db,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "system_graph",
                    "arguments": {"query": "POST /api/internal/invoices", "direction": "callers"}
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "system_graph",
                    "arguments": {"query": "billing-svc", "direction": "callees"}
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "system_graph",
                    "arguments": {"query": "src/client.rs", "direction": "impact", "repo": "billing-svc"}
                }
            }),
        ],
    );
    assert_eq!(mcp_replies[0]["result"]["isError"], false);
    assert!(
        mcp_replies[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("billing-svc src/client.rs:4")
    );
    assert!(
        mcp_replies[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("POST /api/internal/invoices -> shop-api")
    );
    assert!(
        mcp_replies[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("makes 2 call(s) from src/client.rs")
    );
}

#[test]
fn system_graph_incremental_rescan_touch_changes_and_suggest_apply() {
    let fixture = Fixture::new();
    fixture.import();

    let repos_root = fixture._temp.path().join("repos");
    let addon_dir = repos_root.join("ez-addon");
    let commerce_dir = repos_root.join("ez-commerce");

    init_git_repo(
        &addon_dir,
        &[
            (
                "src/bin/api.rs",
                r#"use ez_addon::modules::catalog;
fn app() -> Router {
    Router::new()
        .nest("/catalog", catalog::router())
}
"#,
            ),
            (
                "src/modules/catalog/mod.rs",
                r#"pub fn router() -> Router {
    Router::new()
        .route("/v1/brands", get(list_brands))
        .route("/v1/products", post(create_product))
}
"#,
            ),
            (
                "src/modules/cochera/ez_commerce.rs",
                r#"impl Client {
    async fn issue(&self) {
        let _ = self.http.post(format!("{}/api/internal/invoices", self.base_url)).send().await;
    }

    async fn live_hook(&self) {
        let _ = self.http.get(format!("{}/api/v1/uncommitted-hook", self.base_url)).send().await;
    }
}
"#,
            ),
        ],
    );

    init_git_repo(
        &commerce_dir,
        &[
            (
                "backend/src/api.rs",
                r#"pub fn router() -> Router {
    Router::new()
        .route("/api/internal/invoices", post(create_invoice))
}
"#,
            ),
            (
                "backend/src/other.rs",
                r#"pub fn other_router() -> Router {
    Router::new()
        .route("/api/v1/other", get(get_other))
}
"#,
            ),
            (
                "backend/src/http_catalog.rs",
                r#"impl CatalogClient {
    async fn brands(&self) {
        let _ = self.http.get(format!("{}/v1/brands", self.base_url)).send().await;
    }

    async fn create(&self) {
        let _ = self.http.post(format!("{}/v1/products", self.base_url)).send().await;
    }
}
"#,
            ),
            (
                "backend/src/external_vendor.rs",
                r#"const BASE: &str = "https://api.stripe.com";
impl StripeClient {
    async fn charge(&self) {
        let _ = self.http.post(format!("{}/v1/charges", self.base_url)).send().await;
    }
}
"#,
            ),
            (
                "docker-compose.yml",
                "services:\n  app:\n    environment:\n      EZ_COMMERCE_URL: http://ez-commerce-api:8080\n",
            ),
        ],
    );

    let cfg = json!({
        "repos_root": repos_root,
        "services": {
            "ez-addon-api": {
                "repo": "ez-addon",
                "root": "",
                "stack": "axum",
                "entry": "src/bin/api.rs"
            },
            "ez-commerce-api": {
                "repo": "ez-commerce",
                "root": "backend",
                "stack": "axum"
            }
        },
        "env": {},
        "clients": {
            "ez-addon:src/modules/cochera/ez_commerce.rs": "ez-commerce-api"
        },
        "external": []
    });
    let cfg_path = fixture.db.parent().unwrap().join("system-graph.json");
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();

    let (initial, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(initial["scanned"], 2);
    assert_eq!(initial["skipped"], 0);
    assert_eq!(initial["files_scanned"], 8);
    assert_eq!(initial["files_skipped"], 0);
    assert_eq!(initial["edges"], 1);
    assert_eq!(initial["fog"], 4);

    let (noop, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(noop["scanned"], 0);
    assert_eq!(noop["skipped"], 2);
    assert_eq!(noop["files_scanned"], 0);
    assert_eq!(noop["files_skipped"], 8);

    fs::write(
        commerce_dir.join("backend/src/other.rs"),
        r#"pub fn other_router() -> Router {
    Router::new()
        .route("/api/v1/other", get(get_other))
        .route("/api/v1/other-two", get(get_other_two))
}
"#,
    )
    .unwrap();
    git_in(&commerce_dir, &["add", "backend/src/other.rs"]);
    git_in(&commerce_dir, &["commit", "-q", "-m", "add other-two"]);

    let (one_file, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(one_file["files_scanned"], 1);
    assert_eq!(one_file["services_rescanned"], json!([]));

    fs::write(
        commerce_dir.join("backend/src/other.rs"),
        r#"pub fn other_router() -> Router {
    Router::new()
        .nest("/api/v2", nested_router())
}
"#,
    )
    .unwrap();
    git_in(&commerce_dir, &["add", "backend/src/other.rs"]);
    git_in(&commerce_dir, &["commit", "-q", "-m", "add nest"]);

    let (rescan, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(rescan["services_rescanned"], json!(["ez-commerce-api"]));
    assert!(rescan["files_scanned"].as_u64().unwrap() >= 4);

    let api_rs = commerce_dir.join("backend/src/api.rs");
    fs::write(
        &api_rs,
        r#"pub fn router() -> Router {
    Router::new()
        .route("/api/internal/invoices", post(create_invoice))
        .route("/api/v1/uncommitted-hook", get(live_hook))
}
"#,
    )
    .unwrap();
    let touch_impact = run_iron_text(
        &fixture.db,
        &["memory", "graph", "touch", api_rs.to_str().unwrap()],
    );
    assert!(!touch_impact.is_empty());
    assert!(touch_impact.len() <= 300, "len={}", touch_impact.len());
    assert!(
        touch_impact.contains("ez-addon-api") && touch_impact.contains("/api/v1/uncommitted-hook"),
        "impact={touch_impact}"
    );

    let other_rs = commerce_dir.join("backend/src/other.rs");
    let no_impact = run_iron_text(
        &fixture.db,
        &["memory", "graph", "touch", other_rs.to_str().unwrap()],
    );
    assert_eq!(no_impact, "");

    let (touch_json, _) = fixture.call(&[
        "memory",
        "graph",
        "touch",
        "--json",
        api_rs.to_str().unwrap(),
    ]);
    assert_eq!(touch_json["files_scanned"], 1);
    assert!(touch_json["cross_repo_edges"].as_u64().unwrap() >= 2);

    let addon_client = addon_dir.join("src/modules/cochera/ez_commerce.rs");
    fs::write(
        &addon_client,
        r#"impl Client {
    async fn live_hook(&self) {
        let _ = self.http.get(format!("{}/api/v1/uncommitted-hook", self.base_url)).send().await;
    }
}
"#,
    )
    .unwrap();
    let _ = run_iron_text(
        &fixture.db,
        &["memory", "graph", "touch", addon_client.to_str().unwrap()],
    );
    let changes_txt = run_iron_text(&fixture.db, &["memory", "graph", "changes", "--since", "7"]);
    assert!(
        changes_txt.contains("- ez-addon-api") && changes_txt.contains("/api/internal/invoices"),
        "changes={changes_txt}"
    );

    const ENV_COMMERCE_URL: &str = "EZ_COMMERCE_URL";
    let (suggested, _) = fixture.call(&["memory", "graph", "suggest"]);
    assert_eq!(suggested["applied"], false);
    assert_eq!(
        suggested["prefixes"]["ez-commerce:backend/src/http_catalog.rs"],
        "/catalog"
    );
    assert_eq!(
        suggested["env"][ENV_COMMERCE_URL],
        "ez-commerce-api"
    );
    assert_eq!(
        suggested["external"],
        json!(["ez-commerce:backend/src/external_vendor.rs"])
    );

    let (applied, _) = fixture.call(&["memory", "graph", "suggest", "--apply"]);
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["fog_before"], 3);
    assert_eq!(applied["fog_after"], 0);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&cfg_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let who_brands = run_iron_text(
        &fixture.db,
        &["memory", "graph", "who-calls", "GET /catalog/v1/brands"],
    );
    assert!(
        who_brands.contains("backend/src/http_catalog.rs"),
        "who_brands={who_brands}"
    );
}

#[test]
fn system_graph_phase2_hono_nginx_web_memory_and_safe_suggest() {
    let fixture = Fixture::new();
    let repos_root = fixture.root.join("repos");

    let mgmt_dir = repos_root.join("huggian-management");
    let landings_dir = repos_root.join("huggian-landings");
    let vps_dir = repos_root.join("host-vps");

    init_git_repo(
        &mgmt_dir,
        &[
            (
                "services/core/src/server.ts",
                r#"
import { Hono } from 'hono';
import { createPublicRoutes } from './routes/public.routes';
export function buildApp() {
  const app = new Hono();
  const pub = createPublicRoutes();
  app.route('/v1', pub);
  app.route('/api/v1', pub);
  return app;
}
"#,
            ),
            (
                "services/core/src/routes/public.routes.ts",
                r#"
import { Hono } from 'hono';
export function createPublicRoutes() {
  const router = new Hono();
  router.post('/public/signup', (c) => c.json({ ok: true }));
  router.get('/catalog/v1/brands', (c) => c.json([]));
  return router;
}
"#,
            ),
        ],
    );
    init_git_repo(
        &landings_dir,
        &[
            (
                "apps/huggian/src/pages/signup.astro",
                r#"---
const API_URL = import.meta.env.PUBLIC_API_URL ?? 'https://api.huggian.com';
---
<script>
async function submit() {
  await fetch(`${API_URL}/v1/public/signup`, { method: 'POST' });
  await fetch('https://api.external-vendor.test/v1/ping');
}
</script>
"#,
            ),
            (
                "apps/huggian/src/pages/contact.astro",
                r#"---
---
<script>
async function send() {
  await fetch('https://formsubmit.co/ajax/test', { method: 'POST' });
}
</script>
"#,
            ),
        ],
    );
    init_git_repo(
        &vps_dir,
        &[(
            "nginx/conf.d/huggian.conf",
            r#"
server {
    listen 443 ssl;
    server_name api.huggian.com;
    location ~ ^/regex-only {
        set $upstream huggian-core:3010;
        proxy_pass http://$upstream;
    }
    location / {
        set $upstream huggian-core:3010;
        proxy_pass http://$upstream;
    }
}
"#,
        )],
    );

    fixture.call(&[
        "memory",
        "remember",
        "--title",
        "Public signup rate limit rule",
        "--content",
        "Enforced in `services/core/src/routes/public.routes.ts` for POST /v1/public/signup.",
        "--project",
        "huggian-management",
        "--kind",
        "decision",
    ]);

    let cfg_path = fixture.db.parent().unwrap().join("system-graph.json");
    fs::write(
        &cfg_path,
        serde_json::to_string_pretty(&json!({
            "repos_root": repos_root,
            "services": {
                "huggian-core": { "repo": "huggian-management", "root": "services/core", "stack": "hono", "entry": "src/server.ts" },
                "landings": { "repo": "huggian-landings", "root": "apps/huggian", "stack": "web" },
                "nginx": { "repo": "host-vps", "root": "nginx/conf.d", "stack": "nginx" }
            },
            "containers": {
                "huggian-core": "huggian-core"
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (refreshed, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(refreshed["endpoints"], 4);
    assert_eq!(refreshed["edges"], 1);
    assert_eq!(refreshed["fog"], 2);

    let who = run_iron_text(
        &fixture.db,
        &["memory", "graph", "who-calls", "POST /v1/public/signup"],
    );
    assert!(who.contains("apps/huggian/src/pages/signup.astro"), "who={who}");
    assert!(who.contains("mem: "), "who={who}");
    assert!(who.contains("Public signup rate limit rule"), "who={who}");

    let who_tight = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "who-calls",
            "POST /v1/public/signup",
            "--max-bytes",
            "256",
        ],
    );
    assert!(who_tight.len() <= 256, "len={}", who_tight.len());

    let imp = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "impact",
            "--file",
            "apps/huggian/src/pages/signup.astro",
            "--repo",
            "huggian-landings",
        ],
    );
    assert!(imp.contains("mem: "), "imp={imp}");
    let imp_tight = run_iron_text(
        &fixture.db,
        &[
            "memory",
            "graph",
            "impact",
            "--file",
            "apps/huggian/src/pages/signup.astro",
            "--repo",
            "huggian-landings",
            "--max-bytes",
            "256",
        ],
    );
    assert!(imp_tight.len() <= 256, "len={}", imp_tight.len());

    let (safe_res, _) = fixture.call(&["memory", "graph", "suggest", "--apply", "--safe"]);
    assert_eq!(safe_res["safe"], true);
    assert_eq!(safe_res["applied"], true);
    assert_eq!(safe_res["rules_applied"], 1);
    assert_eq!(safe_res["fog_before"], 2);
    assert_eq!(safe_res["fog_after"], 1);
    let log_text =
        fs::read_to_string(fixture.db.parent().unwrap().join("graph-learning.jsonl")).unwrap();
    assert!(log_text.contains("contact.astro"), "log={log_text}");
    let who_after = run_iron_text(
        &fixture.db,
        &["memory", "graph", "who-calls", "POST /v1/public/signup"],
    );
    assert!(who_after.contains("apps/huggian/src/pages/signup.astro"));
}

#[test]
fn system_graph_breaking_alerts_contracts_mismatches_and_express_under_byte_cap() {
    let fixture = Fixture::new();
    let repos_root = fixture.root.join("repos");
    let shop_dir = repos_root.join("shop");
    let addon_dir = repos_root.join("addon");
    let wa_dir = repos_root.join("ez-wa");

    let api_rs_initial = r#"
#[derive(Deserialize)]
pub struct InvoiceReq {
    pub customer_id: String,
    pub total: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize)]
pub struct InvoiceRes {
    pub cae: String,
    pub total: i64,
}

async fn create_invoice(Json(req): Json<InvoiceReq>) -> Result<Json<InvoiceRes>, AppError> {
    todo!()
}

async fn create_order() -> Json<InvoiceRes> {
    todo!()
}

pub fn router() -> Router {
    Router::new()
        .route("/api/internal/invoices", post(create_invoice))
        .route("/api/v1/orders", post(create_order))
}
"#;
    init_git_repo(
        &shop_dir,
        &[
            ("backend/src/api.rs", api_rs_initial),
            (
                "backend/src/wa_client.rs",
                r#"
impl WaClient {
    async fn send(&self, to: &str, text: &str) {
        let url = format!("{}/send", self.base_url.trim_end_matches('/'));
        let _ = self.http
            .post(url)
            .json(&serde_json::json!({ "to": to, "text": text }))
            .send()
            .await;
    }
}
"#,
            ),
            (
                "frontend/src/lib/api.ts",
                r#"
export const api = {
  orders: {
    create: (body: unknown) => apiFetch("/orders", { method: "POST", body }),
  },
};
"#,
            ),
            (
                "frontend/src/pages/orders/NewOrder.tsx",
                r#"
export async function submitOrder() {
  return api.orders.create({ sku: "A1" });
}
"#,
            ),
        ],
    );
    let addon_client_initial = r#"
#[derive(Serialize)]
struct InvoicePayload {
    customer_id: String,
    total: i64,
}

impl ShopClient {
    async fn issue(&self) {
        let body = InvoicePayload { customer_id: "c1".into(), total: 100 };
        let _ = self.http
            .post(format!("{}/api/internal/invoices", self.base_url))
            .json(&body)
            .send()
            .await;
    }
}
"#;
    init_git_repo(&addon_dir, &[("src/client.rs", addon_client_initial)]);
    init_git_repo(
        &wa_dir,
        &[(
            "src/app.js",
            r#"
import express from 'express';
export function createApp() {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/send', (req, res) => res.json({ ok: true }));
  return app;
}
"#,
        )],
    );

    write_graph_cfg(
        &fixture.db,
        json!({
            "repos_root": repos_root,
            "services": {
                "shop-api": { "repo": "shop", "root": "backend", "stack": "axum" },
                "shop-web": { "repo": "shop", "root": "frontend", "stack": "spa", "client": "src/lib/api.ts", "base": "shop-api", "base_prefix": "/api/v1" },
                "addon-api": { "repo": "addon", "root": "", "stack": "axum" },
                "ez-wa": { "repo": "ez-wa", "root": "", "stack": "express" }
            },
            "clients": {
                "addon:src/client.rs": "shop-api",
                "shop:backend/src/wa_client.rs": "ez-wa"
            }
        }),
    );

    let (init_ref, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(init_ref["edges"], 3);
    assert_eq!(init_ref["fog"], 0);
    assert_eq!(init_ref["breaking"], json!([]));

    let graph_text = |extra: &[&str]| {
        let mut args = vec!["memory", "graph"];
        args.extend_from_slice(extra);
        run_iron_text(&fixture.db, &args)
    };
    let who_send = graph_text(&["who-calls", "POST /send"]);
    assert!(who_send.contains("backend/src/wa_client.rs"), "who_send={who_send}");

    let no_mismatch = graph_text(&["contracts", "--mismatches"]);
    assert!(no_mismatch.contains("0 mismatches"), "no_mismatch={no_mismatch}");
    let bad_budget = Command::new(env!("CARGO_BIN_EXE_iron"))
        .args(["--db", fixture.db.to_str().unwrap(), "memory", "graph", "contracts", "--max-bytes", "10"])
        .output()
        .unwrap();
    assert!(!bad_budget.status.success());

    let api_rs = shop_dir.join("backend/src/api.rs");
    let contract_changed_src = api_rs_initial.replace("pub customer_id: String,", "pub tenant_id: String,");
    fs::write(&api_rs, &contract_changed_src).unwrap();
    let contract_touch = graph_text(&["touch", api_rs.to_str().unwrap()]);
    assert!(contract_touch.len() <= 300, "len={} out={contract_touch}", contract_touch.len());
    assert!(contract_touch.contains("⚠ CONTRACT POST /api/internal/invoices"), "out={contract_touch}");
    assert!(contract_touch.contains("-customer_id +tenant_id"), "out={contract_touch}");
    assert!(contract_touch.contains("addon src/client.rs:"), "out={contract_touch}");

    let mismatches = graph_text(&["contracts", "--mismatches", "--max-bytes", "600"]);
    assert!(mismatches.len() <= 600, "len={}", mismatches.len());
    assert!(mismatches.contains("POST /api/internal/invoices"), "mismatches={mismatches}");
    assert!(mismatches.contains("missing: tenant_id"), "mismatches={mismatches}");
    assert!(mismatches.contains("unknown: customer_id"), "mismatches={mismatches}");

    let who_inv = graph_text(&["who-calls", "POST /api/internal/invoices"]);
    assert!(who_inv.contains("mismatch("), "who_inv={who_inv}");

    let client_rs = addon_dir.join("src/client.rs");
    let imp_client = graph_text(&["impact", "--file", client_rs.to_str().unwrap()]);
    assert!(imp_client.contains("mismatch("), "imp_client={imp_client}");

    let renamed_src = contract_changed_src
        .replace("/api/internal/invoices", "/api/internal/invoices-v2")
        .replace("/api/v1/orders", "/api/v2/orders");
    fs::write(&api_rs, &renamed_src).unwrap();
    let (break_json, _) = fixture.call(&[
        "memory",
        "graph",
        "touch",
        "--json",
        api_rs.to_str().unwrap(),
    ]);
    let break_text = break_json["impact"].as_str().unwrap();
    assert!(break_text.len() <= 300, "len={} text={break_text}", break_text.len());
    assert!(
        break_text.starts_with("⚠ BREAKING POST /api/internal/invoices removed here (renamed to /api/internal/invoices-v2?); 1 caller now unresolved: addon src/client.rs:"),
        "break_text={break_text}"
    );
    let breaking_arr = break_json["breaking"].as_array().unwrap();
    assert_eq!(breaking_arr.len(), 2, "breaking={breaking_arr:?}");
    assert_eq!(breaking_arr[0]["cross_repo"], true);
    assert_eq!(breaking_arr[1]["cross_repo"], false);

    let changes_txt = graph_text(&["changes", "--since", "7"]);
    assert!(changes_txt.contains("[BREAKING]"), "changes={changes_txt}");

    fs::write(&api_rs, api_rs_initial).unwrap();
    let _ = graph_text(&["touch", api_rs.to_str().unwrap()]);
    let broken_caller = addon_client_initial.replace("/api/internal/invoices", "/api/internal/invoices-typo");
    fs::write(&client_rs, &broken_caller).unwrap();
    let caller_touch = graph_text(&["touch", client_rs.to_str().unwrap()]);
    assert!(caller_touch.len() <= 300, "len={} out={caller_touch}", caller_touch.len());
    assert!(
        caller_touch.contains("⚠ BREAKING POST /api/internal/invoices-typo no longer resolves"),
        "caller_touch={caller_touch}"
    );
}

#[test]
fn system_graph_chunks_verified_pairs_unrelated_edit_and_stale_memories() {
    let fixture = Fixture::new();
    let repos_root = fixture.root.join("repos");
    fs::create_dir_all(&repos_root).unwrap();

    let api_initial = r#"use axum::{Json, Router, routing::post};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct InvoiceReq {
    pub company_id: String,
    pub amount: i64,
}

#[derive(Serialize)]
pub struct InvoiceRes {
    pub cae: String,
}

pub async fn create_invoice(Json(req): Json<InvoiceReq>) -> Json<InvoiceRes> {
    Json(InvoiceRes { cae: req.company_id })
}

pub fn unrelated_helper(n: i64) -> i64 {
    n + 1
}

pub fn router() -> Router {
    Router::new().route("/api/internal/invoices", post(create_invoice))
}
"#;
    let client_initial = r#"pub struct ShopClient {
    base_url: String,
    http: reqwest::Client,
}

impl ShopClient {
    pub async fn issue_invoice(&self, company_id: &str) {
        let payload = serde_json::json!({ "company_id": company_id, "amount": 100 });
        let _ = self.http.post(format!("{}/api/internal/invoices", self.base_url)).json(&payload).send().await;
    }
}
"#;
    let shop_dir = repos_root.join("shop");
    let addon_dir = repos_root.join("addon");
    let other_initial = "pub fn other_helper(x: i32) -> i32 {\n    x * 2\n}\n";
    let extra_initial = "export function loadExtra(): Promise<{ ok: boolean }> {\n  return Promise.resolve({ ok: true });\n}\n";
    init_git_repo(
        &shop_dir,
        &[
            ("backend/src/api.rs", api_initial),
            ("backend/src/other.rs", other_initial),
            ("extra/src/app.ts", extra_initial),
        ],
    );
    init_git_repo(&addon_dir, &[("src/client.rs", client_initial)]);

    write_graph_cfg(
        &fixture.db,
        json!({
            "repos_root": repos_root,
            "services": {
                "shop-api": { "repo": "shop", "root": "backend", "stack": "axum" },
                "shop-extra": { "repo": "shop", "root": "extra", "stack": "spa" },
                "addon-api": { "repo": "addon", "root": "", "stack": "axum" }
            },
            "clients": {
                "addon:src/client.rs": "shop-api"
            }
        }),
    );

    let graph_text = |extra: &[&str]| {
        let mut args = vec!["memory", "graph"];
        args.extend_from_slice(extra);
        run_iron_text(&fixture.db, &args)
    };

    let (init_ref, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(init_ref["edges"], 1);
    let init_chunks = init_ref["chunks"].as_u64().unwrap();
    assert!(init_chunks >= 7, "init={init_ref}");
    assert!(init_ref["chunks_changed"].as_u64().unwrap() >= 7);

    let unv_never = graph_text(&["unverified", "--repo", "shop"]);
    assert!(unv_never.contains("[never-verified]"), "unv_never={unv_never}");
    assert!(!unv_never.contains("[unverified-since-change]"), "unv_never={unv_never}");

    write_graph_cfg(
        &fixture.db,
        json!({
            "repos_root": repos_root,
            "services": {
                "shop-api": { "repo": "shop", "root": "backend", "stack": "axum" },
                "addon-api": { "repo": "addon", "root": "", "stack": "axum" }
            },
            "clients": {
                "addon:src/client.rs": "shop-api"
            }
        }),
    );
    let (after_remove_svc, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert!(
        after_remove_svc["chunks"].as_u64().unwrap() < init_chunks,
        "removed service chunks must be pruned: {after_remove_svc}"
    );

    let (no_change, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(no_change["chunks_changed"], 0);

    let other_rs = shop_dir.join("backend/src/other.rs");
    fs::write(&other_rs, "pub fn other_helper(x: i32) -> i32 {\n    x * 3\n}\n").unwrap();
    git_in(&shop_dir, &["add", "backend/src/other.rs"]);
    git_in(&shop_dir, &["commit", "-m", "chore: bump other helper"]);
    let (after_commit, _) = fixture.call(&["memory", "graph", "refresh"]);
    assert_eq!(after_commit["chunks_changed"], 1);

    let (bad_verify, _) = fixture.call(&[
        "memory",
        "graph",
        "verify",
        "--repo",
        "shop",
        "--sha",
        "deadbeef1234",
    ]);
    assert_eq!(bad_verify["verified_edges"], 0);

    let (verified, _) = fixture.call(&["memory", "graph", "verify", "--repo", "shop"]);
    assert_eq!(verified["verified_edges"], 1);
    let verified_sha = verified["sha"].as_str().unwrap().to_owned();
    let short_sha = &verified_sha[..7];

    let unv_after_verify = graph_text(&["unverified", "--repo", "shop"]);
    assert!(
        unv_after_verify.contains("0 cross-repo edges"),
        "unv={unv_after_verify}"
    );
    let who_verified = graph_text(&["who-calls", "POST /api/internal/invoices"]);
    assert!(
        who_verified.contains(&format!("[verified @{short_sha}]")),
        "who={who_verified}"
    );
    let client_rs = addon_dir.join("src/client.rs");
    let imp_verified = graph_text(&["impact", "--file", client_rs.to_str().unwrap()]);
    assert!(
        imp_verified.contains(&format!("[verified @{short_sha}]")),
        "imp={imp_verified}"
    );

    let (mem_changed, _) = fixture.call(&[
        "memory",
        "remember",
        "--project",
        "shop",
        "--title",
        "Invoice handler invariant",
        "--content",
        "Enforces idempotency in `backend/src/api.rs::create_invoice`.",
    ]);
    let mem_changed_id = mem_changed["id"].as_str().unwrap().to_owned();
    let (mem_missing, _) = fixture.call(&[
        "memory",
        "remember",
        "--project",
        "shop",
        "--title",
        "Legacy deleted handler",
        "--content",
        "Calls `backend/src/api.rs::old_deleted_handler`.",
    ]);
    let mem_missing_id = mem_missing["id"].as_str().unwrap().to_owned();

    let api_rs = shop_dir.join("backend/src/api.rs");
    let comment_only = api_initial.replace(
        "Json(InvoiceRes { cae: req.company_id })",
        "// comment-only edit\n    Json(InvoiceRes { cae: req.company_id })",
    );
    fs::write(&api_rs, &comment_only).unwrap();
    let (comment_touch, _) = fixture.call(&[
        "memory",
        "graph",
        "touch",
        "--json",
        api_rs.to_str().unwrap(),
    ]);
    assert_eq!(comment_touch["chunks_changed"], 0, "comment={comment_touch}");
    assert_eq!(comment_touch["breaking"], json!([]));
    assert_eq!(comment_touch["contract_changes"], json!([]));
    assert_eq!(comment_touch["impact"], "");
    assert!(
        graph_text(&["unverified", "--repo", "shop"]).contains("0 cross-repo edges")
    );

    let unrelated_edit = comment_only.replace("n + 1", "n + 2\n    + 3");
    fs::write(&api_rs, &unrelated_edit).unwrap();
    let (unrelated_touch, _) = fixture.call(&[
        "memory",
        "graph",
        "touch",
        "--json",
        api_rs.to_str().unwrap(),
    ]);
    assert_eq!(unrelated_touch["chunks_changed"], 1, "unrelated={unrelated_touch}");
    assert_eq!(unrelated_touch["breaking"], json!([]));
    assert_eq!(unrelated_touch["contract_changes"], json!([]));
    assert_eq!(unrelated_touch["impact"], "");
    assert!(
        graph_text(&["unverified", "--repo", "shop"]).contains("0 cross-repo edges")
    );

    std::thread::sleep(std::time::Duration::from_millis(5));
    let logic_edit = unrelated_edit.replace(
        "Json(InvoiceRes { cae: req.company_id })",
        "let cae = format!(\"CAE-{}\", req.company_id);\n    Json(InvoiceRes { cae })",
    );
    fs::write(&api_rs, &logic_edit).unwrap();
    fs::write(&other_rs, "pub fn other_helper(x: i32) -> i32 {\n    x * 4\n}\n").unwrap();
    let (logic_touch, _) = fixture.call(&[
        "memory",
        "graph",
        "touch",
        "--json",
        api_rs.to_str().unwrap(),
        other_rs.to_str().unwrap(),
    ]);
    assert_eq!(logic_touch["chunks_changed"], 2, "logic={logic_touch}");
    assert_eq!(logic_touch["cross_repo_edges"], 1, "logic={logic_touch}");
    let logic_impact = logic_touch["impact"].as_str().unwrap();
    assert!(
        logic_impact.contains("api.rs") && logic_impact.contains("/api/internal/invoices"),
        "impact={logic_impact}"
    );
    assert!(
        !logic_impact.contains("other.rs"),
        "unrelated file must not inherit handler impact: {logic_impact}"
    );
    assert!(
        logic_impact.contains(&format!("(last verified pair @{short_sha})")),
        "impact={logic_impact}"
    );

    let unv_changed = graph_text(&["unverified", "--repo", "shop"]);
    assert!(
        unv_changed.contains("/api/internal/invoices")
            && unv_changed.contains(&format!("changed since verified @{short_sha}")),
        "unv={unv_changed}"
    );
    let who_changed = graph_text(&["who-calls", "POST /api/internal/invoices"]);
    assert!(
        who_changed.contains(&format!("[changed since verified @{short_sha}]")),
        "who={who_changed}"
    );
    assert!(who_changed.contains(&mem_changed_id), "who={who_changed}");

    let stale = graph_text(&["stale-memories", "--repo", "shop"]);
    assert!(stale.contains(&mem_changed_id) && stale.contains("chunk_changed"), "stale={stale}");
    assert!(stale.contains(&mem_missing_id) && stale.contains("symbol_missing"), "stale={stale}");

    let (reverified, _) = fixture.call(&["memory", "graph", "verify", "--repo", "shop"]);
    assert_eq!(reverified["verified_edges"], 1);
    assert!(
        graph_text(&["unverified", "--repo", "shop"]).contains("0 cross-repo edges")
    );
}
