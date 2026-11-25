use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::model::BrowseOptions;
use crate::native::{FeedbackRequest, MergeProjectsRequest, RememberRequest};
use crate::output;
use crate::service::{self, SearchRequest};
use crate::store::{SCHEMA_VERSION, Store};

const INDEX_HTML: &str = include_str!("ui/index.html");
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT_CONNS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(10);

const CSP_HEADER: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const UNIQUE_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "origin",
    "sec-fetch-site",
    "content-type",
    "referer",
];

struct ServerState {
    db: PathBuf,
    bound_addr: SocketAddr,
    configured_host: Option<String>,
    relink_in_flight: AtomicBool,
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
    extra_headers: Vec<(&'static str, &'static str)>,
}

impl HttpResponse {
    fn json(status: u16, value: &Value) -> Self {
        let body =
            serde_json::to_vec(value).unwrap_or_else(|_| b"{\"error\":\"encode failed\"}".to_vec());
        Self {
            status,
            reason: reason_phrase(status),
            content_type: "application/json; charset=utf-8",
            body,
            extra_headers: Vec::new(),
        }
    }

    fn error(status: u16, msg: impl Into<String>) -> Self {
        Self::json(status, &json!({ "error": msg.into() }))
    }

    fn html(body: &'static str) -> Self {
        Self {
            status: 200,
            reason: "OK",
            content_type: "text/html; charset=utf-8",
            body: body.as_bytes().to_vec(),
            extra_headers: vec![("Content-Security-Policy", CSP_HEADER)],
        }
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

struct ActiveConnGuard(Arc<AtomicUsize>);

impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct RelinkGuard<'a>(&'a AtomicBool);

impl Drop for RelinkGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub fn serve(db: &Path, host: &str, port: u16) -> Result<()> {
    let _ = Store::open(db, false)
        .context("cannot open Iron index; run `iron memory import` first")?;
    let listener = TcpListener::bind((host, port))
        .with_context(|| format!("cannot bind iron ui server to {host}:{port}"))?;
    let local_addr: SocketAddr = listener.local_addr()?;
    eprintln!(
        "iron ui listening on http://{local_addr} (db: {})",
        db.display()
    );
    let stop = Arc::new(AtomicBool::new(false));
    serve_on_listener_with_host(db.to_path_buf(), listener, Some(host.to_owned()), stop)
}

pub fn serve_on_listener(
    db: PathBuf,
    listener: TcpListener,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    serve_on_listener_with_host(db, listener, None, stop)
}

fn serve_on_listener_with_host(
    db: PathBuf,
    listener: TcpListener,
    configured_host: Option<String>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let bound_addr = listener.local_addr()?;
    let active = Arc::new(AtomicUsize::new(0));
    let state = Arc::new(ServerState {
        db,
        bound_addr,
        configured_host,
        relink_in_flight: AtomicBool::new(false),
    });

    for incoming in listener.incoming() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let mut stream = match incoming {
            Ok(s) => s,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                eprintln!("iron ui accept error: {err}");
                continue;
            }
        };
        if stop.load(Ordering::Acquire) {
            break;
        }

        let prev = active.fetch_add(1, Ordering::AcqRel);
        if prev >= MAX_CONCURRENT_CONNS {
            active.fetch_sub(1, Ordering::AcqRel);
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let _ = write_response(
                &mut stream,
                &HttpResponse::error(503, "server busy; retry shortly"),
                false,
            );
            continue;
        }

        let guard = ActiveConnGuard(Arc::clone(&active));
        let st = Arc::clone(&state);
        if thread::Builder::new()
            .name("iron-ui-req".into())
            .spawn(move || {
                let _guard = guard;
                handle_connection(stream, &st);
            })
            .is_err()
        {
            // Guard was moved only if spawn succeeded; on Err, guard is dropped cleanly here.
            eprintln!("iron ui failed to spawn worker thread");
        }
    }
    Ok(())
}

fn handle_connection(mut stream: TcpStream, state: &ServerState) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_nodelay(true);

    match read_request(&mut stream) {
        Ok(Some(req)) => {
            let is_head = req.method == "HEAD";
            let resp = dispatch(&req, state);
            let _ = write_response(&mut stream, &resp, is_head);
        }
        Ok(None) => {}
        Err(resp) => {
            let _ = write_response(&mut stream, &resp, false);
        }
    }
}

fn read_with_deadline(
    stream: &mut TcpStream,
    buf: &mut [u8],
    deadline: Instant,
) -> std::result::Result<usize, HttpResponse> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(HttpResponse::error(400, "request read timed out"));
        }
        let remaining = deadline.saturating_duration_since(now);
        let _ = stream.set_read_timeout(Some(remaining));
        match stream.read(buf) {
            Ok(n) => return Ok(n),
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err)
                if err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::TimedOut =>
            {
                return Err(HttpResponse::error(400, "request read timed out"));
            }
            Err(_) => return Err(HttpResponse::error(400, "failed to read request")),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> std::result::Result<Option<HttpRequest>, HttpResponse> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            if pos > MAX_HEADER_BYTES {
                return Err(HttpResponse::error(413, "request headers exceed 16 KiB"));
            }
            break pos;
        }
        if buf.len() >= MAX_HEADER_BYTES + 4 {
            return Err(HttpResponse::error(413, "request headers exceed 16 KiB"));
        }
        let n = read_with_deadline(stream, &mut chunk, deadline)?;
        if n == 0 {
            if buf.is_empty() {
                return Ok(None);
            }
            return Err(HttpResponse::error(400, "incomplete HTTP request"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let header_bytes = &buf[..header_end];
    let header_str = std::str::from_utf8(header_bytes)
        .map_err(|_| HttpResponse::error(400, "headers must be valid UTF-8"))?;

    let mut lines = header_str.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HttpResponse::error(400, "missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| HttpResponse::error(400, "missing HTTP method"))?
        .to_owned();
    let target = parts
        .next()
        .ok_or_else(|| HttpResponse::error(400, "missing request target"))?;
    let version = parts
        .next()
        .ok_or_else(|| HttpResponse::error(400, "missing HTTP version"))?;
    if !matches!(version, "HTTP/1.1" | "HTTP/1.0") || parts.next().is_some() {
        return Err(HttpResponse::error(
            400,
            "unsupported HTTP version or malformed request line",
        ));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, val)) = line.split_once(':') else {
            return Err(HttpResponse::error(400, "malformed HTTP header"));
        };
        let key = name.trim().to_ascii_lowercase();
        let value = val.trim().to_owned();
        if UNIQUE_HEADERS.contains(&key.as_str()) && headers.contains_key(&key) {
            return Err(HttpResponse::error(
                400,
                format!("duplicate `{key}` header is forbidden"),
            ));
        }
        headers.insert(key, value);
    }

    if headers.contains_key("transfer-encoding") {
        return Err(HttpResponse::error(
            501,
            "chunked transfer encoding is not supported; send Content-Length",
        ));
    }

    let content_length: usize = match headers.get("content-length") {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| HttpResponse::error(400, "invalid Content-Length header"))?,
        None => 0,
    };
    if content_length > MAX_BODY_BYTES {
        return Err(HttpResponse::error(413, "request body exceeds 1 MiB limit"));
    }

    let mut body = Vec::with_capacity(content_length.min(64 * 1024));
    let already = &buf[header_end + 4..];
    if already.len() > content_length {
        body.extend_from_slice(&already[..content_length]);
    } else {
        body.extend_from_slice(already);
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let to_read = remaining.min(chunk.len());
        let n = read_with_deadline(stream, &mut chunk[..to_read], deadline)?;
        if n == 0 {
            return Err(HttpResponse::error(400, "unexpected EOF while reading body"));
        }
        body.extend_from_slice(&chunk[..n]);
    }

    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(raw_path, false)
        .map_err(|e| HttpResponse::error(400, format!("invalid request path: {e}")))?;
    let query = parse_query(raw_query)
        .map_err(|e| HttpResponse::error(400, format!("invalid query string: {e}")))?;

    Ok(Some(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    }))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn write_response(
    stream: &mut TcpStream,
    resp: &HttpResponse,
    head_only: bool,
) -> std::io::Result<()> {
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n",
        resp.status,
        resp.reason,
        resp.content_type,
        resp.body.len()
    );
    for (k, v) in &resp.extra_headers {
        header.push_str(k);
        header.push_str(": ");
        header.push_str(v);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(&resp.body)?;
    }
    stream.flush()
}

fn dispatch(req: &HttpRequest, state: &ServerState) -> HttpResponse {
    if let Err(resp) = verify_host_allowlist(req, state) {
        return resp;
    }
    match req.method.as_str() {
        "GET" | "HEAD" => dispatch_get(req, &state.db),
        "POST" => {
            if let Err(resp) = verify_post_csrf(req) {
                return resp;
            }
            dispatch_post(req, state)
        }
        _ => HttpResponse::error(405, format!("method {} not allowed", req.method)),
    }
}

fn verify_host_allowlist(req: &HttpRequest, state: &ServerState) -> std::result::Result<(), HttpResponse> {
    let Some(host) = req.headers.get("host").map(|h| h.trim()).filter(|h| !h.is_empty()) else {
        return Err(HttpResponse::error(400, "missing Host header"));
    };
    let port = state.bound_addr.port();
    let ip = state.bound_addr.ip();

    let mut allowed: Vec<String> = vec![
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ];
    if port == 80 {
        allowed.push("127.0.0.1".to_owned());
        allowed.push("localhost".to_owned());
        allowed.push("[::1]".to_owned());
    }
    if !ip.is_loopback() && !ip.is_unspecified() {
        let host_fmt = match ip {
            IpAddr::V4(v4) => format!("{v4}:{port}"),
            IpAddr::V6(v6) => format!("[{v6}]:{port}"),
        };
        allowed.push(host_fmt);
        if port == 80 {
            allowed.push(match ip {
                IpAddr::V4(v4) => v4.to_string(),
                IpAddr::V6(v6) => format!("[{v6}]"),
            });
        }
    }
    if let Some(cfg) = state.configured_host.as_deref()
        && cfg != "0.0.0.0"
        && cfg != "::"
    {
        allowed.push(format!("{cfg}:{port}"));
        if port == 80 {
            allowed.push(cfg.to_owned());
        }
    }
    // If bound explicitly to 0.0.0.0 / ::, still allow IP literals on the bound port (blocks DNS rebinding hostnames!).
    if ip.is_unspecified()
        && let Some((h, p)) = split_host_port(host)
        && p.unwrap_or(80) == port
        && h.parse::<IpAddr>().is_ok()
    {
        return Ok(());
    }

    if allowed.iter().any(|a| a.eq_ignore_ascii_case(host)) {
        return Ok(());
    }
    Err(HttpResponse::error(
        403,
        "Host header not permitted for this iron ui listener (DNS rebinding guard)",
    ))
}

fn split_host_port(host: &str) -> Option<(&str, Option<u16>)> {
    if let Some(rest) = host.strip_prefix('[') {
        let (addr, tail) = rest.split_once(']')?;
        if tail.is_empty() {
            return Some((addr, None));
        }
        let port = tail.strip_prefix(':')?.parse::<u16>().ok()?;
        return Some((addr, Some(port)));
    }
    if let Some((h, p)) = host.rsplit_once(':')
        && !h.contains(':')
    {
        let port = p.parse::<u16>().ok()?;
        return Some((h, Some(port)));
    }
    Some((host, None))
}

fn verify_post_csrf(req: &HttpRequest) -> std::result::Result<(), HttpResponse> {
    let Some(host) = req.headers.get("host").map(|h| h.trim()).filter(|h| !h.is_empty()) else {
        return Err(HttpResponse::error(400, "missing Host header"));
    };
    let media_type = req
        .headers
        .get("content-type")
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if media_type != "application/json" {
        return Err(HttpResponse::error(
            415,
            "POST requests must use Content-Type: application/json",
        ));
    }
    if let Some(fetch_site) = req.headers.get("sec-fetch-site")
        && !fetch_site.eq_ignore_ascii_case("same-origin")
        && !fetch_site.eq_ignore_ascii_case("none")
    {
        return Err(HttpResponse::error(
            403,
            "non-same-origin Sec-Fetch-Site POST rejected",
        ));
    }
    if let Some(origin) = req.headers.get("origin") {
        let origin_host = extract_url_authority(origin);
        match origin_host {
            Some(oh) if oh.eq_ignore_ascii_case(host) => {}
            _ => {
                return Err(HttpResponse::error(
                    403,
                    "Origin header does not match Host; cross-origin mutation blocked",
                ));
            }
        }
    } else if let Some(referer) = req.headers.get("referer") {
        let ref_host = extract_url_authority(referer);
        match ref_host {
            Some(rh) if rh.eq_ignore_ascii_case(host) => {}
            _ => {
                return Err(HttpResponse::error(
                    403,
                    "Referer header does not match Host; cross-origin mutation blocked",
                ));
            }
        }
    }
    Ok(())
}

fn extract_url_authority(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some(authority)
}

fn dispatch_get(req: &HttpRequest, db: &Path) -> HttpResponse {
    match req.path.as_str() {
        "/" | "/index.html" => HttpResponse::html(INDEX_HTML),
        "/api/health" => match Store::open(db, false) {
            Ok(_) => HttpResponse::json(
                200,
                &json!({
                    "ok": true,
                    "db_path": db.display().to_string(),
                    "schema_version": SCHEMA_VERSION,
                }),
            ),
            Err(err) => HttpResponse::error(500, format!("{err:#}")),
        },
        "/api/stats" => handle_store_read(db, |store| {
            let stats = store.stats()?;
            let facets = store.facets()?;
            Ok(json!({
                "stats": stats,
                "facets": facets,
            }))
        }),
        "/api/records" => handle_browse(req, db),
        "/api/context" => handle_context(req, db),
        "/api/audit" => handle_store_read(db, |store| store.audit_health()),
        "/api/consolidate" => handle_consolidate(req, db),
        "/api/graph" => handle_graph(req, db),
        "/api/evolution" => handle_evolution(req, db),
        "/api/aliases" => match crate::aliases::load(db) {
            Ok(aliases) => HttpResponse::json(200, &json!({ "aliases": aliases })),
            Err(err) => HttpResponse::error(500, format!("{err:#}")),
        },
        path if path.starts_with("/api/records/") => {
            let id = &path["/api/records/".len()..];
            if id.contains('/') || validate_id(id).is_err() {
                return HttpResponse::error(400, "invalid memory ID");
            }
            let store = match Store::open(db, false) {
                Ok(s) => s,
                Err(err) => return HttpResponse::error(500, format!("{err:#}")),
            };
            match store.inspect(id) {
                Ok(Some(record)) => HttpResponse::json(200, &record),
                Ok(None) => {
                    let archive_path = db.with_file_name("archive.db");
                    if archive_path.is_file()
                        && let Ok(arch_store) = Store::open(&archive_path, false)
                        && let Ok(Some(mut rec)) = arch_store.inspect(id)
                    {
                        rec["archived"] = json!(true);
                        return HttpResponse::json(200, &rec);
                    }
                    HttpResponse::error(404, format!("memory not found: {id}"))
                }
                Err(err) => HttpResponse::error(500, format!("{err:#}")),
            }
        }
        _ => HttpResponse::error(404, format!("route not found: {}", req.path)),
    }
}

fn dispatch_post(req: &HttpRequest, state: &ServerState) -> HttpResponse {
    let db = &state.db;
    match req.path.as_str() {
        "/api/feedback" => {
            let payload: FeedbackRequest = match serde_json::from_slice(&req.body) {
                Ok(p) => p,
                Err(err) => return HttpResponse::error(400, format!("invalid JSON payload: {err}")),
            };
            let id = payload.id.clone();
            let feedback = match crate::native::feedback(db, payload) {
                Ok(v) => v,
                Err(err) => return map_client_or_server_err(err),
            };
            let record = Store::open(db, false)
                .and_then(|s| s.inspect(&id))
                .ok()
                .flatten();
            HttpResponse::json(
                200,
                &json!({
                    "feedback": feedback,
                    "record": record,
                }),
            )
        }
        "/api/remember" => {
            let payload: RememberRequest = match serde_json::from_slice(&req.body) {
                Ok(p) => p,
                Err(err) => return HttpResponse::error(400, format!("invalid JSON payload: {err}")),
            };
            let created = match crate::native::remember(db, payload) {
                Ok(v) => v,
                Err(err) => return map_client_or_server_err(err),
            };
            let new_id = created.get("id").and_then(Value::as_str).map(str::to_owned);
            let record = new_id.and_then(|id| {
                Store::open(db, false)
                    .and_then(|s| s.inspect(&id))
                    .ok()
                    .flatten()
            });
            HttpResponse::json(
                200,
                &json!({
                    "remember": created,
                    "record": record,
                }),
            )
        }
        "/api/projects/merge" => {
            let payload: MergeProjectsRequest = match serde_json::from_slice(&req.body) {
                Ok(p) => p,
                Err(err) => return HttpResponse::error(400, format!("invalid JSON payload: {err}")),
            };
            match crate::native::merge_projects(db, payload) {
                Ok(v) => HttpResponse::json(200, &v),
                Err(err) => map_client_or_server_err(err),
            }
        }
        "/api/aliases/delete" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct DeleteAliasReq {
                from: String,
            }
            let payload: DeleteAliasReq = match serde_json::from_slice(&req.body) {
                Ok(p) => p,
                Err(err) => return HttpResponse::error(400, format!("invalid JSON payload: {err}")),
            };
            match crate::native::remove_project_alias(db, &payload.from) {
                Ok(v) => HttpResponse::json(200, &v),
                Err(err) => map_client_or_server_err(err),
            }
        }
        "/api/relink" => {
            if state
                .relink_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return HttpResponse::error(409, "auto-link rebuild already in progress");
            }
            let _guard = RelinkGuard(&state.relink_in_flight);
            match Store::open(db, true).and_then(|mut s| s.rebuild_auto_links()) {
                Ok(built) => HttpResponse::json(200, &json!({ "auto_links_built": built })),
                Err(err) => HttpResponse::error(500, format!("{err:#}")),
            }
        }
        _ => HttpResponse::error(404, format!("route not found: {}", req.path)),
    }
}

fn handle_store_read<F>(db: &Path, f: F) -> HttpResponse
where
    F: FnOnce(&Store) -> Result<Value>,
{
    let store = match Store::open(db, false) {
        Ok(s) => s,
        Err(err) => return HttpResponse::error(500, format!("{err:#}")),
    };
    match f(&store) {
        Ok(val) => HttpResponse::json(200, &val),
        Err(err) => map_client_or_server_err(err),
    }
}

fn handle_browse(req: &HttpRequest, db: &Path) -> HttpResponse {
    let limit = match parse_opt_usize(&req.query, "limit") {
        Ok(Some(v)) => v.clamp(1, 100),
        Ok(None) => 30,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let offset = match parse_opt_usize(&req.query, "offset") {
        Ok(Some(v)) => {
            if i64::try_from(v).is_err() {
                return HttpResponse::error(400, "invalid offset: exceeds range");
            }
            v
        }
        Ok(None) => 0,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let opts = BrowseOptions {
        project: non_empty(&req.query, "project"),
        source: non_empty(&req.query, "source"),
        kind: non_empty(&req.query, "kind"),
        status: non_empty(&req.query, "status"),
        query: non_empty(&req.query, "q"),
        sort: non_empty(&req.query, "sort"),
        day: non_empty(&req.query, "day"),
        limit,
        offset,
    };
    handle_store_read(db, |store| store.browse(&opts))
}

fn handle_context(req: &HttpRequest, db: &Path) -> HttpResponse {
    let Some(query) = non_empty(&req.query, "q") else {
        return HttpResponse::error(400, "query parameter `q` is required");
    };
    let limit = match parse_opt_usize(&req.query, "limit") {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let max_bytes = match parse_opt_usize(&req.query, "max_bytes") {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let strict_project = matches!(
        req.query.get("strict_project").map(String::as_str),
        Some("true" | "1" | "yes")
    );
    let budget_max = max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    let search_req = SearchRequest {
        query,
        project: non_empty(&req.query, "project"),
        strict_project,
        limit,
        max_bytes,
        role: non_empty(&req.query, "role"),
        source: non_empty(&req.query, "source"),
    };
    handle_store_read(db, |store| {
        let mut res = service::search_with_archive(store, Some(db), search_req)?;
        let used_bytes = output::encode(&res)?.len();
        res["budget_used_bytes"] = json!(used_bytes);
        res["budget_max_bytes"] = json!(budget_max);
        Ok(res)
    })
}

fn handle_consolidate(req: &HttpRequest, db: &Path) -> HttpResponse {
    let min_occurrences = match parse_opt_usize(&req.query, "min_occurrences") {
        Ok(Some(v)) => v.clamp(2, 50),
        Ok(None) => 3,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let limit = match parse_opt_usize(&req.query, "limit") {
        Ok(Some(v)) => v.clamp(1, 50),
        Ok(None) => 20,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let project = non_empty(&req.query, "project");
    handle_store_read(db, |store| {
        store.consolidate(project.as_deref(), min_occurrences, limit)
    })
}

fn handle_graph(req: &HttpRequest, db: &Path) -> HttpResponse {
    let limit = match parse_opt_usize(&req.query, "limit") {
        Ok(Some(v)) => v.clamp(20, 400),
        Ok(None) => 180,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    let source = non_empty(&req.query, "source");
    let project = non_empty(&req.query, "project");
    handle_store_read(db, |store| {
        store.knowledge_graph(source.as_deref(), project.as_deref(), limit)
    })
}

fn handle_evolution(req: &HttpRequest, db: &Path) -> HttpResponse {
    let days = match parse_opt_usize(&req.query, "days") {
        Ok(Some(v)) => v.clamp(7, 90),
        Ok(None) => 14,
        Err(msg) => return HttpResponse::error(400, msg),
    };
    handle_store_read(db, |store| store.evolution(days))
}

fn map_client_or_server_err(err: anyhow::Error) -> HttpResponse {
    let msg = format!("{err:#}");
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not found") || lower.contains("does not exist") {
        return HttpResponse::error(404, msg);
    }
    if lower.contains("invalid")
        || lower.contains("must ")
        || lower.contains("requires ")
        || lower.contains("excludes ")
        || lower.contains("exceed")
        || lower.contains("cannot supersede")
        || lower.contains("cannot be empty")
        || lower.contains("cannot be the global")
        || lower.contains("cycle")
        || lower.contains("outcome must be")
    {
        return HttpResponse::error(400, msg);
    }
    HttpResponse::error(500, msg)
}

fn non_empty(map: &HashMap<String, String>, key: &str) -> Option<String> {
    map.get(key)
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn parse_opt_usize(
    map: &HashMap<String, String>,
    key: &str,
) -> std::result::Result<Option<usize>, String> {
    let Some(raw) = non_empty(map, key) else {
        return Ok(None);
    };
    raw.parse::<usize>()
        .map(Some)
        .map_err(|_| format!("invalid integer for `{key}`: {raw}"))
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        bail!("invalid memory ID");
    }
    Ok(())
}

fn parse_query(raw: &str) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    if raw.is_empty() {
        return Ok(map);
    }
    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(k, true)?;
        let val = percent_decode(v, true)?;
        map.insert(key, val);
    }
    Ok(map)
}

fn percent_decode(input: &str, plus_as_space: bool) -> Result<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' if plus_as_space => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                if i + 2 >= bytes.len() {
                    bail!("truncated percent escape");
                }
                let hi = hex_val(bytes[i + 1])?;
                let lo = hex_val(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).context("percent-decoded text is not valid UTF-8")
}

fn hex_val(b: u8) -> Result<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => bail!("invalid hex digit in percent escape"),
    }
}
