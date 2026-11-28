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
    assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 5);
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
