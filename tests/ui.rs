use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iron_stack::model::{ImportBatch, MemoryLink, MemoryRecord};
use iron_stack::store::Store;
use iron_stack::ui::serve_on_listener;
use serde_json::{Value, json};
use tempfile::TempDir;

struct TestServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TestServer {
    fn start(db: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let db_path = db.to_path_buf();
        let handle = thread::spawn(move || {
            let _ = serve_on_listener(db_path, listener, stop_clone);
        });
        Self {
            addr,
            stop,
            handle: Some(handle),
        }
    }

    fn request_raw(&self, raw_http: &[u8]) -> HttpResp {
        let mut stream = TcpStream::connect_timeout(&self.addr, Duration::from_secs(5))
            .expect("connect test server");
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.write_all(raw_http).unwrap();
        stream.flush().unwrap();
        let mut resp_bytes = Vec::new();
        stream.read_to_end(&mut resp_bytes).unwrap();
        parse_resp(&resp_bytes)
    }

    fn request(
        &self,
        method: &str,
        target: &str,
        extra_headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> HttpResp {
        let body_bytes = body.unwrap_or(&[]);
        let has_host = extra_headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("host"));
        let mut raw = format!("{method} {target} HTTP/1.1\r\n");
        if !has_host {
            raw.push_str(&format!("Host: {}\r\n", self.addr));
        }
        raw.push_str("Connection: close\r\n");
        for (k, v) in extra_headers {
            raw.push_str(&format!("{k}: {v}\r\n"));
        }
        if !body_bytes.is_empty() || method == "POST" {
            raw.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
        }
        raw.push_str("\r\n");
        let mut bytes = raw.into_bytes();
        bytes.extend_from_slice(body_bytes);
        self.request_raw(&bytes)
    }

    fn get_json(&self, target: &str) -> (u16, Value) {
        let r = self.request("GET", target, &[], None);
        let v: Value = serde_json::from_slice(&r.body).expect("valid JSON response");
        (r.status, v)
    }

    fn post_json(&self, target: &str, payload: &Value, extra: &[(&str, &str)]) -> (u16, Value) {
        let body = serde_json::to_vec(payload).unwrap();
        let mut headers = vec![("Content-Type", "application/json")];
        headers.extend_from_slice(extra);
        let r = self.request("POST", target, &headers, Some(&body));
        let v: Value = serde_json::from_slice(&r.body).expect("valid JSON response");
        (r.status, v)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(500));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

struct HttpResp {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_resp(bytes: &[u8]) -> HttpResp {
    let split = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP response header boundary");
    let head = std::str::from_utf8(&bytes[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap();
    let status: u16 = status_line.split_whitespace().nth(1).unwrap().parse().unwrap();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    HttpResp {
        status,
        headers,
        body: bytes[split + 4..].to_vec(),
    }
}

#[allow(clippy::too_many_arguments)]
fn make_record(
    id: &str,
    source_type: &str,
    kind: &str,
    project: &str,
    title: &str,
    content: &str,
    source_path: &str,
    updated_at: i64,
) -> MemoryRecord {
    MemoryRecord {
        id: id.to_owned(),
        source_group: "seed".to_owned(),
        source_key: id.to_owned(),
        source_type: source_type.to_owned(),
        kind: kind.to_owned(),
        project: project.to_owned(),
        title: title.to_owned(),
        content: content.to_owned(),
        source_path: source_path.to_owned(),
        updated_at,
        metadata: json!({"seed": true}),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn seed_db() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("memory.db");
    let now = now_ms();
    let mut store = Store::open(&db, true).unwrap();
    let records = vec![
        make_record(
            "rec_md_1",
            "markdown",
            "curated",
            "commerce-core",
            "Order token validation rule",
            "Always run validate_order_token before debiting wallet. nebularsignal curated rule.",
            "/home/dev/.claude/projects/commerce-core/memory/order_token.md",
            now - 5_000,
        ),
        make_record(
            "rec_md_dup",
            "markdown",
            "curated",
            "commerce-core/.claude/worktrees/feat-a",
            "Order token validation rule (worktree copy)",
            "Always run validate_order_token before debiting wallet. nebularsignal curated rule.",
            "/home/dev/.claude/projects/commerce-core-wt/memory/order_token.md",
            now - 4_000,
        ),
        make_record(
            "rec_iron_1",
            "iron",
            "decision",
            "commerce-core/frontend",
            "UI polling decision",
            "Prefer server push over polling when checking validate_order_token status.",
            "native://iron/rec_iron_1",
            now - 3_000,
        ),
        make_record(
            "rec_hist_1",
            "history",
            "summary",
            "commerce-core",
            "Session 1 investigating nebularsignal",
            "Debugged nebularsignal in validate_order_token handler across session 1.",
            "history://session-1",
            now - 86_400_000,
        ),
        make_record(
            "rec_hist_2",
            "history",
            "summary",
            "commerce-core",
            "Session 2 fixing validate_order_token",
            "Fixed retry loop around validate_order_token in session 2.",
            "history://session-2",
            now - 2 * 86_400_000,
        ),
        make_record(
            "rec_hist_3",
            "history",
            "summary",
            "commerce-core",
            "Session 3 auditing validate_order_token",
            "Verified validate_order_token edge case in session 3.",
            "history://session-3",
            now - 3 * 86_400_000,
        ),
    ];
    store
        .apply(&ImportBatch {
            groups: vec!["seed".into()],
            records,
            links: vec![MemoryLink::explicit(
                "rec_md_1".into(),
                "rec_iron_1".into(),
                "references".into(),
            )],
            ..Default::default()
        })
        .unwrap();
    store.record_feedback("rec_iron_1", "helpful", None).unwrap();

    // Also seed a sibling archive.db to verify read-only archive inspect fallback
    let archive_db = tmp.path().join("archive.db");
    let mut astore = Store::open(&archive_db, true).unwrap();
    astore
        .apply(&ImportBatch {
            groups: vec!["arch".into()],
            records: vec![MemoryRecord {
                id: "rec_arch_1".into(),
                source_group: "arch".into(),
                source_key: "arch_1".into(),
                source_type: "history".into(),
                kind: "summary".into(),
                project: "commerce-core".into(),
                title: "Archived historical note".into(),
                content: "Legacy archived details for nebularsignal.".into(),
                source_path: "history://archive-1".into(),
                updated_at: now - 10 * 86_400_000,
                metadata: json!({}),
            }],
            ..Default::default()
        })
        .unwrap();

    (tmp, db)
}

#[test]
fn ui_serves_html_with_security_headers_head_and_health() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    let resp = srv.request("GET", "/", &[], None);
    assert_eq!(resp.status, 200);
    assert!(resp.headers["content-type"].starts_with("text/html"));
    assert_eq!(resp.headers["x-frame-options"], "DENY");
    assert_eq!(resp.headers["x-content-type-options"], "nosniff");
    assert_eq!(resp.headers["cache-control"], "no-store");
    assert!(resp.headers["content-security-policy"].contains("form-action 'none'"));
    let html = String::from_utf8(resp.body).unwrap();
    assert!(html.contains("IRON // SECOND BRAIN"));

    let head = srv.request("HEAD", "/", &[], None);
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());

    let bad_method = srv.request("DELETE", "/api/health", &[], None);
    assert_eq!(bad_method.status, 405);

    let (status, health) = srv.get_json("/api/health");
    assert_eq!(status, 200);
    assert_eq!(health["ok"], true);
    assert_eq!(health["schema_version"], 2);
}

#[test]
fn ui_inspect_is_read_only_validates_ids_and_falls_back_to_archive() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    for _ in 0..3 {
        let (status, rec) = srv.get_json("/api/records/rec_md_1");
        assert_eq!(status, 200);
        assert_eq!(rec["id"], "rec_md_1");
        assert_eq!(rec["stats"]["use_count"], 0);
        assert_eq!(rec["stats"]["confirm_count"], 0);
        assert_eq!(rec["outgoing_link_count"], 1);
        assert_eq!(rec["duplicate_bodies"].as_array().unwrap().len(), 1);
    }

    // Sibling archive.db fallback returns archived: true
    let (s_arch, arch) = srv.get_json("/api/records/rec_arch_1");
    assert_eq!(s_arch, 200);
    assert_eq!(arch["id"], "rec_arch_1");
    assert_eq!(arch["archived"], true);

    let (status_404, _) = srv.get_json("/api/records/rec_missing_id");
    assert_eq!(status_404, 404);

    let (status_400, _) = srv.get_json("/api/records/bad-id!");
    assert_eq!(status_400, 400);
}

#[test]
fn ui_browse_filters_sorts_handles_punctuation_queries_and_rejects_bad_offsets() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    let (s, curated) = srv.get_json("/api/records?source=curated");
    assert_eq!(s, 200);
    assert_eq!(curated["total"], 3);

    let (s, unverified) = srv.get_json("/api/records?source=curated&status=unverified");
    assert_eq!(s, 200);
    assert_eq!(unverified["total"], 2);

    let (s, verified) = srv.get_json("/api/records?status=verified");
    assert_eq!(s, 200);
    assert_eq!(verified["total"], 1);
    assert_eq!(verified["items"][0]["id"], "rec_iron_1");

    let (s, by_id) = srv.get_json("/api/records?q=rec_md_1");
    assert_eq!(s, 200);
    assert_eq!(by_id["total"], 1);
    assert_eq!(by_id["items"][0]["id"], "rec_md_1");

    // P0-1 regression test: punctuation-only query must NOT crash SQLite with ESCAPE ''
    let (s, punct) = srv.get_json("/api/records?q=*");
    assert_eq!(s, 200);
    assert!(punct["items"].is_array());
    let (s, dashes) = srv.get_json("/api/records?q=---");
    assert_eq!(s, 200);
    assert!(dashes["items"].is_array());

    // All sort keys work cleanly
    for sort in ["updated", "use_count", "confirm_count", "contradict_count", "links", "title"] {
        let (s, sorted) = srv.get_json(&format!("/api/records?sort={sort}"));
        assert_eq!(s, 200, "sort={sort} failed");
        assert_eq!(sorted["total"], 6);
    }
    let (_, by_links) = srv.get_json("/api/records?sort=links");
    assert_eq!(by_links["items"][0]["id"], "rec_md_1");

    // P1-2 regression test: offset exceeding i64::MAX returns 400
    let (s_ovf, _) = srv.get_json("/api/records?offset=18446744073709551615");
    assert_eq!(s_ovf, 400);

    // Invalid day filter returns 400
    let (s_day, _) = srv.get_json("/api/records?day=not-a-day");
    assert_eq!(s_day, 400);
}

#[test]
fn ui_context_simulator_respects_role_filters_and_byte_budget() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    let (s, dev) = srv.get_json("/api/context?q=nebularsignal&role=developer&project=commerce-core");
    assert_eq!(s, 200);
    let dev_types: Vec<&str> = dev["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["source_type"].as_str().unwrap())
        .collect();
    assert!(dev_types.contains(&"markdown"));
    assert!(dev_types.contains(&"history"));
    assert!(dev["budget_used_bytes"].as_u64().unwrap() <= dev["budget_max_bytes"].as_u64().unwrap());

    let (s, rev) = srv.get_json("/api/context?q=nebularsignal&role=reviewer&project=commerce-core");
    assert_eq!(s, 200);
    let rev_hits = rev["results"].as_array().unwrap();
    assert!(!rev_hits.is_empty());
    assert!(rev_hits.iter().all(|h| h["source_type"] == "markdown"));

    let (s_bad, _) = srv.get_json("/api/context?q=nebularsignal&role=reviewer&source=history");
    assert_eq!(s_bad, 400);

    let (s_tiny, tiny) = srv.get_json("/api/context?q=nebularsignal&role=developer&max_bytes=256");
    assert_eq!(s_tiny, 200);
    assert_eq!(tiny["truncated"], true);
}

#[test]
fn ui_blocks_dns_rebinding_csrf_duplicate_headers_and_oversized_requests() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    // DNS rebinding Host header blocked on GET AND POST
    let evil_host = format!("evil.attacker:{}", srv.addr.port());
    let r_get = srv.request("GET", "/api/health", &[("Host", &evil_host)], None);
    assert_eq!(r_get.status, 403);

    let r_post = srv.request(
        "POST",
        "/api/feedback",
        &[
            ("Host", &evil_host),
            ("Origin", &format!("http://{evil_host}")),
            ("Content-Type", "application/json"),
        ],
        Some(br#"{"id":"rec_md_1","outcome":"helpful"}"#),
    );
    assert_eq!(r_post.status, 403);

    // Cross-origin & same-site Sec-Fetch-Site rejected
    let (s, _) = srv.post_json(
        "/api/feedback",
        &json!({"id": "rec_md_1", "outcome": "helpful"}),
        &[("Origin", "http://evil.example")],
    );
    assert_eq!(s, 403);

    let (s, _) = srv.post_json(
        "/api/feedback",
        &json!({"id": "rec_md_1", "outcome": "helpful"}),
        &[("Sec-Fetch-Site", "same-site")],
    );
    assert_eq!(s, 403);

    // Non-exact JSON Content-Type rejected (e.g. application/json-foo)
    let r_ct = srv.request(
        "POST",
        "/api/feedback",
        &[("Content-Type", "application/json-foo")],
        Some(br#"{"id":"rec_md_1","outcome":"helpful"}"#),
    );
    assert_eq!(r_ct.status, 415);

    // Duplicate Host header rejected with 400
    let dup_host = format!(
        "GET /api/health HTTP/1.1\r\nHost: {}\r\nHost: {}\r\nConnection: close\r\n\r\n",
        srv.addr, srv.addr
    );
    assert_eq!(srv.request_raw(dup_host.as_bytes()).status, 400);

    // Chunked transfer encoding rejected with 501
    let chunked = format!(
        "POST /api/feedback HTTP/1.1\r\nHost: {}\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n0\r\n\r\n",
        srv.addr
    );
    assert_eq!(srv.request_raw(chunked.as_bytes()).status, 501);

    // Oversized Content-Length rejected with 413
    let huge = format!(
        "POST /api/feedback HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n",
        srv.addr
    );
    assert_eq!(srv.request_raw(huge.as_bytes()).status, 413);

    // Confirm zero mutations leaked from any blocked request
    let (_, rec) = srv.get_json("/api/records/rec_md_1");
    assert_eq!(rec["stats"]["confirm_count"], 0);
}

#[test]
fn ui_feedback_remember_supersede_and_relink_persist_mutations() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);
    let origin = format!("http://{}", srv.addr);

    let (s, fb) = srv.post_json(
        "/api/feedback",
        &json!({"id": "rec_md_1", "outcome": "helpful"}),
        &[("Origin", origin.as_str()), ("Sec-Fetch-Site", "same-origin")],
    );
    assert_eq!(s, 200);
    assert_eq!(fb["record"]["stats"]["confirm_count"], 1);
    assert_eq!(fb["record"]["stats"]["use_count"], 1);

    let (s, fb2) = srv.post_json(
        "/api/feedback",
        &json!({"id": "rec_md_1", "outcome": "contradicted"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s, 200);
    assert_eq!(fb2["record"]["stats"]["contradict_count"], 1);

    // Feedback with explicit superseded_by links to existing record
    let (s, fb_sup) = srv.post_json(
        "/api/feedback",
        &json!({"id": "rec_md_dup", "outcome": "outdated", "superseded_by": "rec_md_1"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s, 200);
    assert_eq!(fb_sup["record"]["stats"]["status"], "superseded");
    assert_eq!(fb_sup["record"]["stats"]["superseded_by"], "rec_md_1");

    // Remember with supersedes creates replacement and supersedes old
    let (s, rem) = srv.post_json(
        "/api/remember",
        &json!({
            "title": "Updated order token validation rule",
            "content": "Use v2 validate_order_token with idempotency key.",
            "project": "commerce-core",
            "kind": "correction",
            "agent": "human-ui",
            "supersedes": ["rec_md_1"]
        }),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s, 200);
    let new_id = rem["remember"]["id"].as_str().unwrap().to_owned();
    assert_eq!(rem["record"]["supersedes"][0]["id"], "rec_md_1");

    let (s, old_after) = srv.get_json("/api/records/rec_md_1");
    assert_eq!(s, 200);
    assert_eq!(old_after["stats"]["status"], "superseded");
    assert_eq!(old_after["stats"]["superseded_by"], new_id);

    // POST /api/relink rebuilds auto-links cleanly
    let (s, relink) = srv.post_json("/api/relink", &json!({}), &[("Origin", origin.as_str())]);
    assert_eq!(s, 200);
    assert!(relink["auto_links_built"].is_number());
}

#[test]
fn ui_audit_consolidate_graph_and_evolution_endpoints_return_real_data() {
    let (_tmp, db) = seed_db();
    let srv = TestServer::start(&db);

    let (s, audit) = srv.get_json("/api/audit");
    assert_eq!(s, 200);
    assert_eq!(audit["summary"]["records"], 6);
    assert_eq!(audit["summary"]["curated_total"], 3);
    assert_eq!(audit["summary"]["curated_verified"], 1);
    assert_eq!(audit["summary"]["curated_unverified"], 2);
    assert_eq!(audit["project_fragmentation"]["fragmented_roots"], 1);
    assert_eq!(audit["project_fragmentation"]["groups"][0]["canonical_root"], "commerce-core");

    let (s, cons) = srv.get_json("/api/consolidate?min_occurrences=3");
    assert_eq!(s, 200);
    assert!(
        cons["clusters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["anchor"] == "validate_order_token")
    );

    let (s, graph) = srv.get_json("/api/graph?source=curated&limit=50");
    assert_eq!(s, 200);
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
    assert!(graph["nodes"][0]["canonical_root"].is_string());
    assert!(graph["nodes"][0]["cluster"].is_string());

    let (s, evo) = srv.get_json("/api/evolution?days=14");
    assert_eq!(s, 200);
    assert_eq!(evo["timeline"].as_array().unwrap().len(), 14);
    let today_day = evo["today"]["day"].as_str().unwrap().to_owned();
    assert!(evo["today"]["curated"].as_i64().unwrap() >= 3);
    assert!(evo["rates"]["verification_coverage_pct"].is_number());

    // Browse by today's day returns today's curated records
    let (s, by_day) = srv.get_json(&format!("/api/records?day={today_day}&source=curated"));
    assert_eq!(s, 200);
    assert!(by_day["total"].as_i64().unwrap() >= 3);
}

#[test]
fn ui_merge_projects_persists_aliases_resolves_context_and_supports_delete() {
    let (tmp, db) = seed_db();
    let srv = TestServer::start(&db);
    let origin = format!("http://{}", srv.addr);

    // Initially no aliases
    let (s, initial) = srv.get_json("/api/aliases");
    assert_eq!(s, 200);
    assert_eq!(initial["aliases"], json!({}));

    // Cross-origin merge attempt is blocked with 403
    let (s_csrf, _) = srv.post_json(
        "/api/projects/merge",
        &json!({"from": "commerce-core", "to": "unified-stock"}),
        &[("Origin", "http://evil.example")],
    );
    assert_eq!(s_csrf, 403);

    // Unknown JSON fields rejected with 400
    let (s_unk, _) = srv.post_json(
        "/api/projects/merge",
        &json!({"from": "a", "to": "b", "unexpected": true}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_unk, 400);

    let (s_unk_del, _) = srv.post_json(
        "/api/aliases/delete",
        &json!({"from": "a", "extra": 1}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_unk_del, 400);

    // Global "*" and secret-bearing project names rejected with 400
    let (s_star, _) = srv.post_json(
        "/api/projects/merge",
        &json!({"from": "*", "to": "unified-stock"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_star, 400);

    let (s_sec, _) = srv.post_json(
        "/api/projects/merge",
        &json!({"from": "commerce-core", "to": "ghp_1234567890abcdefghijklmnopqrstuvwx"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_sec, 400);

    // Same-origin merge rewrites exact + subpath + worktree records and persists aliases.json
    let (s, merged) = srv.post_json(
        "/api/projects/merge",
        &json!({
            "from": "commerce-core",
            "to": "unified-stock",
            "include_subpaths": true,
            "save_alias": true
        }),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s, 200);
    assert_eq!(merged["updated_records"], 6);
    assert_eq!(merged["aliases"]["commerce-core"], "unified-stock");
    assert!(tmp.path().join("aliases.json").is_file());

    // Old project name AND subpath still resolve transparently in /api/context via aliases.json
    let (s, ctx) = srv.get_json("/api/context?q=nebularsignal&project=commerce-core&strict_project=true");
    assert_eq!(s, 200);
    let hits = ctx["results"].as_array().unwrap();
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h["project"] == "unified-stock"));

    let (s_sub, ctx_sub) = srv.get_json("/api/context?q=nebularsignal&project=commerce-core%2Ffrontend&strict_project=true");
    assert_eq!(s_sub, 200);
    let sub_hits = ctx_sub["results"].as_array().unwrap();
    assert!(!sub_hits.is_empty());
    assert!(sub_hits.iter().all(|h| h["project"] == "unified-stock"));

    // Remember targeting old alias writes under canonical target
    let (s, rem) = srv.post_json(
        "/api/remember",
        &json!({
            "title": "Alias resolution check",
            "content": "Saved under old alias name should resolve to unified-stock.",
            "project": "commerce-core",
            "kind": "note",
            "agent": "human-ui"
        }),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s, 200);
    assert_eq!(rem["record"]["project"], "unified-stock");

    // Alias cycle must be rejected with 400 BEFORE mutating SQLite
    let (s_cyc, cyc) = srv.post_json(
        "/api/projects/merge",
        &json!({
            "from": "unified-stock",
            "to": "commerce-core",
            "include_subpaths": true,
            "save_alias": true
        }),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_cyc, 400, "cycle error must return 400, got: {cyc}");
    // Verify records remained untouched on unified-stock
    let (_, after_cyc) = srv.get_json("/api/records?project=unified-stock");
    assert_eq!(after_cyc["total"], 7);

    // Deleting alias removes it from aliases.json
    let (s_del, deleted) = srv.post_json(
        "/api/aliases/delete",
        &json!({"from": "commerce-core"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_del, 200);
    assert_eq!(deleted["aliases"], json!({}));

    let (s_after, aliases_after) = srv.get_json("/api/aliases");
    assert_eq!(s_after, 200);
    assert_eq!(aliases_after["aliases"], json!({}));
}

#[test]
fn ui_v03_intelligence_sleep_semantic_rrf_graph_drift_sections_and_outcomes() {
    let (tmp, db) = seed_db();
    // Add a multi-section large curated doc + a conflicting rule + a repo-path-citing rule
    let mut store = Store::open(&db, true).unwrap();
    let long_intro = "General architecture guidelines. ".repeat(45);
    let multi_section = format!(
        "# Payment Gateway Guide\n\n{long_intro}\n\n## Retry Backoff\nUse exponential backoff with jitter on billing gateway 502 responses.\n\n## Rollback Procedure\nRun `scripts/rollback_ledger.sh` before truncating pending settlement rows.\n"
    );
    let mut extra_records = vec![
        make_record(
            "rec_sections",
            "markdown",
            "curated",
            "commerce-core",
            "Payment Gateway Guide",
            &multi_section,
            "/home/dev/.claude/projects/commerce-core/memory/gateway.md",
            now_ms(),
        ),
        make_record(
            "rec_conflict_a",
            "markdown",
            "curated",
            "commerce-core",
            "Always poll checkout_sync_job",
            "Always run polling inside `checkout_sync_job` every 5 seconds.",
            "/home/dev/.claude/projects/commerce-core/memory/poll_a.md",
            now_ms(),
        ),
        make_record(
            "rec_conflict_b",
            "iron",
            "correction",
            "commerce-core",
            "Avoid polling checkout_sync_job",
            "Never poll inside `checkout_sync_job`; it is deprecated and replaced by SSE. See `src/deleted_sync_worker.rs`.",
            "native://iron/conflict_b",
            now_ms(),
        ),
    ];
    for r in &mut extra_records {
        r.source_group = "v03".into();
    }
    store
        .apply(&ImportBatch {
            groups: vec!["v03".into()],
            records: extra_records,
            ..Default::default()
        })
        .unwrap();
    drop(store);

    let srv = TestServer::start(&db);
    let origin = format!("http://{}", srv.addr);

    // 1. CSRF & unknown-field guards on /api/sleep and /api/intelligence/dismiss
    let (s_csrf, _) = srv.post_json("/api/sleep", &json!({}), &[("Origin", "http://evil.example")]);
    assert_eq!(s_csrf, 403);
    let (s_unk, _) = srv.post_json("/api/sleep", &json!({"bad": 1}), &[("Origin", origin.as_str())]);
    assert_eq!(s_unk, 400);
    let (s_dis_unk, _) = srv.post_json(
        "/api/intelligence/dismiss",
        &json!({"id": "rec_md_1", "extra": 1}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_dis_unk, 400);

    // 2. Run sleep consolidation via HTTP API -> builds semantic.idx + detects contradiction
    let (s_sleep, sleep_res) = srv.post_json("/api/sleep", &json!({}), &[("Origin", origin.as_str())]);
    assert_eq!(s_sleep, 200);
    assert!(sleep_res["semantic_records_indexed"].as_u64().unwrap() >= 6);
    assert!(sleep_res["contradictions_found"].as_u64().unwrap() >= 1);
    assert!(tmp.path().join("semantic.idx").is_file());
    assert!(tmp.path().join("intelligence.json").is_file());

    let (s_int, intel) = srv.get_json("/api/intelligence");
    assert_eq!(s_int, 200);
    assert!(!intel["contradictions"].as_array().unwrap().is_empty());
    assert!(!intel["review_queue"].as_array().unwrap().is_empty());

    // 3. Conceptual bilingual semantic RRF query with zero exact keyword overlap
    let (s_sem, sem_ctx) =
        srv.get_json("/api/context?q=reintento+facturacion&project=commerce-core&source=curated");
    assert_eq!(s_sem, 200);
    let sem_hits = sem_ctx["results"].as_array().unwrap();
    assert!(
        sem_hits.iter().any(|h| h["id"] == "rec_sections"),
        "expected semantic RRF to surface rec_sections, got: {sem_ctx}"
    );

    // 4. Identifier-aware camelCase splitting (`validateOrderToken` -> `validate_order_token`)
    let (s_camel, camel_ctx) =
        srv.get_json("/api/context?q=validateOrderToken&project=commerce-core&source=curated");
    assert_eq!(s_camel, 200);
    assert!(
        camel_ctx["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["id"] == "rec_md_1")
    );

    // 5. 1-Hop Graph Expansion: searching `nebularsignal` (only on rec_md_1) surfaces
    //    explicitly linked `rec_iron_1` for developer, while reviewer stays markdown-only!
    let (s_dev_g, dev_g) =
        srv.get_json("/api/context?q=nebularsignal&role=developer&source=curated");
    assert_eq!(s_dev_g, 200);
    assert!(
        dev_g["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["id"] == "rec_iron_1"),
        "expected 1-hop graph expansion to surface linked rec_iron_1: {dev_g}"
    );
    let (s_rev_g, rev_g) =
        srv.get_json("/api/context?q=nebularsignal&role=reviewer&source=curated");
    assert_eq!(s_rev_g, 200);
    assert!(
        rev_g["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["source_type"] == "markdown")
    );

    // 6. Section-targeted get returns only the requested Markdown section
    let ro_store = Store::open(&db, false).unwrap();
    let sec_res = iron_stack::service::get_with_archive(
        &ro_store,
        Some(&db),
        iron_stack::service::GetRequest {
            id: "rec_sections".into(),
            offset: 0,
            max_bytes: Some(4000),
            section: Some("Rollback".into()),
        },
    )
    .unwrap();
    assert_eq!(sec_res["section"], "Rollback Procedure");
    assert!(sec_res["content"].as_str().unwrap().contains("rollback_ledger.sh"));
    assert!(!sec_res["content"].as_str().unwrap().contains("General architecture guidelines"));

    // 7. Code-drift audit flags deleted file & surfaces drift metadata on GET /api/records/:id
    let repo_dir = tmp.path().join("commerce-core");
    std::fs::create_dir_all(repo_dir.join("src")).unwrap();
    std::fs::write(repo_dir.join("src/live.rs"), "pub fn ok() {}\n").unwrap();
    let (entries, _) =
        iron_stack::drift::audit_project_drift(&ro_store, "commerce-core", &repo_dir).unwrap();
    assert!(entries.contains_key("rec_conflict_b"));
    let mut istate = iron_stack::intelligence::load_state(&db).unwrap();
    istate.drift = entries;
    iron_stack::intelligence::save_state(&db, &istate).unwrap();
    let (s_rec, rec_b) = srv.get_json("/api/records/rec_conflict_b");
    assert_eq!(s_rec, 200);
    assert_eq!(rec_b["drift"]["drifted"], true);

    // 8. Automatic outcome feedback: pass strengthens co_used links; correction flags & dismiss clears
    let pass_out = iron_stack::intelligence::record_outcome(
        &db,
        "pass",
        Some("commerce-core"),
        &["rec_md_1".into(), "rec_sections".into()],
        None,
    )
    .unwrap();
    assert_eq!(pass_out["reinforced"], 2);
    assert_eq!(pass_out["co_used_links"], 2);

    let corr_out = iron_stack::intelligence::record_outcome(
        &db,
        "correction",
        Some("commerce-core"),
        &["rec_md_1".into()],
        Some("Rule needed update after incident"),
    )
    .unwrap();
    assert_eq!(corr_out["flagged_for_review"], 1);

    let (_, flagged_rec) = srv.get_json("/api/records/rec_md_1");
    assert!(flagged_rec["needs_review"].is_object());

    let (s_dis, dis_res) = srv.post_json(
        "/api/intelligence/dismiss",
        &json!({"id": "rec_md_1"}),
        &[("Origin", origin.as_str())],
    );
    assert_eq!(s_dis, 200);
    assert_eq!(dis_res["dismissed"], true);

    // P0-1 regression: invalid role, strict_project without project, and empty query rejected with 400
    let (s_bad_role, _) = srv.get_json("/api/context?q=nebularsignal&role=reveiwer");
    assert_eq!(s_bad_role, 400);
    let (s_bad_strict, _) = srv.get_json("/api/context?q=nebularsignal&strict_project=true");
    assert_eq!(s_bad_strict, 400);
    let (s_empty_q, _) = srv.get_json("/api/context?q=");
    assert_eq!(s_empty_q, 400);
}
