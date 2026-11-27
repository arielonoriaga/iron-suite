use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use iron_proto::{
    AgentState, JournalEntry, SessionSummary, StructuredPrompt, TodoItem, TodoStatus,
};
use rusqlite::{Connection, OptionalExtension, params};

const MAX_TAIL_LINES: usize = 500;
const MAX_TAIL_BYTES: usize = 64 * 1024;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct StateStore {
    conn: Connection,
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .with_context(|| format!("create sqlite parent dir {}", parent.display()))?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .with_context(|| format!("chmod 0700 {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open sqlite state db {}", path.display()))?;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                cli TEXT NOT NULL,
                host_id TEXT NOT NULL,
                project TEXT NOT NULL,
                worktree_path TEXT NOT NULL,
                git_branch TEXT NOT NULL,
                git_dirty INTEGER NOT NULL DEFAULT 0,
                git_behind_main INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                phase TEXT NOT NULL,
                phases_json TEXT NOT NULL,
                ram_mb INTEGER NOT NULL DEFAULT 0,
                pinned_host TEXT,
                pin_reason TEXT,
                checkpoint TEXT NOT NULL DEFAULT '',
                resume_cmd TEXT,
                resume_argv_json TEXT,
                prompt_json TEXT,
                queue_job_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                hibernated_at_ms INTEGER
            );

            CREATE TABLE IF NOT EXISTS session_todos (
                session_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                text TEXT NOT NULL,
                status TEXT NOT NULL,
                PRIMARY KEY (session_id, idx),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_scrollback_tail (
                session_id TEXT PRIMARY KEY,
                tail_text TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS journal_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms INTEGER NOT NULL,
                session_id TEXT,
                agent_label TEXT NOT NULL,
                kind TEXT NOT NULL,
                message TEXT NOT NULL
            );
            ",
        )
        .context("initialize iron-agentd sqlite schema")?;

        // Safe idempotent migration for databases created before `resume_argv_json`.
        let has_argv_col: bool = conn
            .prepare("PRAGMA table_info(sessions)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "resume_argv_json");
        if !has_argv_col {
            conn.execute("ALTER TABLE sessions ADD COLUMN resume_argv_json TEXT", [])?;
        }

        Ok(Self { conn })
    }

    pub fn upsert_session(&self, s: &SessionSummary) -> Result<()> {
        let state_str = serde_json::to_string(&s.state)?;
        let phases_json = serde_json::to_string(&s.phases)?;
        let resume_argv_json = s
            .resume_argv
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let prompt_json = s
            .prompt
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let queue_job_json = s
            .queue_job
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let hibernated_at = if s.state == AgentState::Hibernated {
            Some(s.updated_at_ms)
        } else {
            None
        };

        self.conn.execute(
            "
            INSERT INTO sessions (
                id, title, cli, host_id, project, worktree_path, git_branch,
                git_dirty, git_behind_main, state, phase, phases_json, ram_mb,
                pinned_host, pin_reason, checkpoint, resume_cmd, resume_argv_json,
                prompt_json, queue_job_json, created_at_ms, updated_at_ms, hibernated_at_ms
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21, ?22, ?23
            )
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                cli = excluded.cli,
                host_id = excluded.host_id,
                project = excluded.project,
                worktree_path = excluded.worktree_path,
                git_branch = excluded.git_branch,
                git_dirty = excluded.git_dirty,
                git_behind_main = excluded.git_behind_main,
                state = excluded.state,
                phase = excluded.phase,
                phases_json = excluded.phases_json,
                ram_mb = excluded.ram_mb,
                pinned_host = excluded.pinned_host,
                pin_reason = excluded.pin_reason,
                checkpoint = excluded.checkpoint,
                resume_cmd = excluded.resume_cmd,
                resume_argv_json = excluded.resume_argv_json,
                prompt_json = excluded.prompt_json,
                queue_job_json = excluded.queue_job_json,
                updated_at_ms = excluded.updated_at_ms,
                hibernated_at_ms = excluded.hibernated_at_ms
            ",
            params![
                s.id,
                s.title,
                s.cli,
                s.host_id,
                s.project,
                s.worktree_path,
                s.git_branch,
                i32::from(s.git_dirty),
                s.git_behind_main,
                state_str,
                s.phase,
                phases_json,
                s.ram_mb,
                s.pinned_host,
                s.pin_reason,
                s.checkpoint,
                s.resume_cmd,
                resume_argv_json,
                prompt_json,
                queue_job_json,
                s.updated_at_ms,
                s.updated_at_ms,
                hibernated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        let mut stmt = self.conn.prepare(
            "
            SELECT id, title, cli, host_id, project, worktree_path, git_branch,
                   git_dirty, git_behind_main, state, phase, phases_json, ram_mb,
                   pinned_host, pin_reason, checkpoint, resume_cmd, resume_argv_json,
                   prompt_json, queue_job_json, updated_at_ms
            FROM sessions
            ORDER BY updated_at_ms DESC
            ",
        )?;
        let rows = stmt.query_map([], row_to_session)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// On daemon startup, any previously live session has no running PTY anymore;
    /// mark it Hibernated (`ram_mb = 0`, `prompt_json = NULL`) so persisted state never lies.
    pub fn mark_orphaned_sessions_hibernated(&self) -> Result<usize> {
        let hibernated_json = serde_json::to_string(&AgentState::Hibernated)?;
        let now = now_ms();
        let changed = self.conn.execute(
            "
            UPDATE sessions
            SET state = ?1,
                ram_mb = 0,
                prompt_json = NULL,
                hibernated_at_ms = COALESCE(hibernated_at_ms, ?2),
                updated_at_ms = ?2
            WHERE state != ?1
            ",
            params![hibernated_json, now],
        )?;
        Ok(changed)
    }

    pub fn replace_todos(&mut self, session_id: &str, todos: &[TodoItem]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM session_todos WHERE session_id = ?1",
            params![session_id],
        )?;
        for (idx, item) in todos.iter().enumerate() {
            let st = serde_json::to_string(&item.status)?;
            tx.execute(
                "INSERT INTO session_todos (session_id, idx, text, status) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, idx as i64, item.text, st],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_todos(&self, session_id: &str) -> Result<Vec<TodoItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT text, status FROM session_todos WHERE session_id = ?1 ORDER BY idx ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let text: String = row.get(0)?;
            let status_json: String = row.get(1)?;
            let status: TodoStatus = serde_json::from_str(&status_json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(TodoItem { text, status })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn save_scrollback_tail(&self, session_id: &str, lines: &[String]) -> Result<()> {
        let slice = if lines.len() > MAX_TAIL_LINES {
            &lines[lines.len() - MAX_TAIL_LINES..]
        } else {
            lines
        };
        let mut joined = slice.join("\n");
        if joined.len() > MAX_TAIL_BYTES {
            let mut start = joined.len() - MAX_TAIL_BYTES;
            while !joined.is_char_boundary(start) && start < joined.len() {
                start += 1;
            }
            joined = joined[start..].to_string();
        }
        self.conn.execute(
            "
            INSERT INTO session_scrollback_tail (session_id, tail_text, updated_at_ms)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(session_id) DO UPDATE SET
                tail_text = excluded.tail_text,
                updated_at_ms = excluded.updated_at_ms
            ",
            params![session_id, joined, now_ms()],
        )?;
        Ok(())
    }

    pub fn load_scrollback_tail(&self, session_id: &str) -> Result<Vec<String>> {
        let text: Option<String> = self
            .conn
            .query_row(
                "SELECT tail_text FROM session_scrollback_tail WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(match text {
            Some(t) if !t.is_empty() => t.lines().map(str::to_string).collect(),
            _ => Vec::new(),
        })
    }

    pub fn append_journal(
        &self,
        session_id: Option<&str>,
        agent_label: &str,
        kind: &str,
        message: &str,
    ) -> Result<JournalEntry> {
        let ts = now_ms();
        self.conn.execute(
            "INSERT INTO journal_events (ts_ms, session_id, agent_label, kind, message) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ts, session_id, agent_label, kind, message],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(JournalEntry {
            id,
            ts_ms: ts,
            session_id: session_id.map(str::to_string),
            agent_label: agent_label.to_string(),
            kind: kind.to_string(),
            message: message.to_string(),
        })
    }

    pub fn list_journal(&self, session_id: Option<&str>, limit: usize) -> Result<Vec<JournalEntry>> {
        let limit = limit.clamp(1, 200) as i64;
        let mut out = Vec::new();
        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, ts_ms, session_id, agent_label, kind, message
                 FROM journal_events
                 WHERE session_id = ?1 OR session_id IS NULL
                 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![sid, limit], row_to_journal)?;
            for r in rows {
                out.push(r?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, ts_ms, session_id, agent_label, kind, message
                 FROM journal_events ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], row_to_journal)?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }
}

fn row_to_journal(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalEntry> {
    Ok(JournalEntry {
        id: row.get(0)?,
        ts_ms: row.get(1)?,
        session_id: row.get(2)?,
        agent_label: row.get(3)?,
        kind: row.get(4)?,
        message: row.get(5)?,
    })
}

fn parse_col_json<T: serde::de::DeserializeOwned>(
    col_idx: usize,
    raw: &str,
) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            col_idx,
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    let state_json: String = row.get(9)?;
    let phases_json: String = row.get(11)?;
    let resume_argv_json: Option<String> = row.get(17)?;
    let prompt_json: Option<String> = row.get(18)?;
    let queue_json: Option<String> = row.get(19)?;

    let state: AgentState = parse_col_json(9, &state_json)?;
    let phases: Vec<String> = parse_col_json(11, &phases_json)?;
    let resume_argv: Option<Vec<String>> = resume_argv_json
        .as_deref()
        .map(|j| parse_col_json(17, j))
        .transpose()?;
    let prompt: Option<StructuredPrompt> = prompt_json
        .as_deref()
        .map(|j| parse_col_json(18, j))
        .transpose()?;
    let queue_job = queue_json
        .as_deref()
        .map(|j| parse_col_json(19, j))
        .transpose()?;

    Ok(SessionSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        cli: row.get(2)?,
        host_id: row.get(3)?,
        project: row.get(4)?,
        worktree_path: row.get(5)?,
        git_branch: row.get(6)?,
        git_dirty: row.get::<_, i32>(7)? != 0,
        git_behind_main: row.get(8)?,
        state,
        phase: row.get(10)?,
        phases,
        ram_mb: row.get(12)?,
        pinned_host: row.get(13)?,
        pin_reason: row.get(14)?,
        checkpoint: row.get(15)?,
        resume_cmd: row.get(16)?,
        resume_argv,
        prompt,
        queue_job,
        updated_at_ms: row.get(20)?,
    })
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn persists_session_todos_tail_and_orphaned_recovery() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("state.db");
        let mut store = StateStore::open(&db_path).unwrap();

        let s = SessionSummary {
            id: "sess-1".into(),
            title: "iron-term · test".into(),
            cli: "shell".into(),
            host_id: "desktop".into(),
            project: "iron-term".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            git_branch: "main".into(),
            git_dirty: false,
            git_behind_main: 0,
            state: AgentState::NeedsApproval,
            phase: "build".into(),
            phases: vec!["brief".into(), "build".into(), "verify".into()],
            ram_mb: 9,
            pinned_host: None,
            pin_reason: None,
            checkpoint: "building daemon".into(),
            resume_cmd: None,
            resume_argv: Some(vec!["/bin/sh".into(), "-c".into(), "echo hi".into()]),
            prompt: Some(StructuredPrompt {
                kind: iron_proto::PromptKind::Guardrail,
                title: "stale".into(),
                description: String::new(),
                command: String::new(),
                actions: vec![],
            }),
            queue_job: None,
            updated_at_ms: now_ms(),
        };
        store.upsert_session(&s).unwrap();
        store
            .replace_todos(
                "sess-1",
                &[TodoItem {
                    text: "Write SQLite store".into(),
                    status: TodoStatus::Done,
                }],
            )
            .unwrap();
        store
            .save_scrollback_tail("sess-1", &["line 1".into(), "line 2".into()])
            .unwrap();
        store
            .append_journal(Some("sess-1"), "iron-term · test", "note", "started")
            .unwrap();

        assert_eq!(store.mark_orphaned_sessions_hibernated().unwrap(), 1);
        let loaded = store.list_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].state, AgentState::Hibernated);
        assert_eq!(loaded[0].ram_mb, 0);
        assert!(loaded[0].prompt.is_none());
        assert_eq!(
            loaded[0].resume_argv,
            Some(vec!["/bin/sh".into(), "-c".into(), "echo hi".into()])
        );
        assert_eq!(store.list_todos("sess-1").unwrap().len(), 1);
        assert_eq!(
            store.load_scrollback_tail("sess-1").unwrap(),
            vec!["line 1", "line 2"]
        );
        assert_eq!(store.list_journal(Some("sess-1"), 10).unwrap().len(), 1);
    }
}
