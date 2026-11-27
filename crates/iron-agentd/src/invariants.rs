use iron_proto::{HostMode, HostStatus, SessionSummary};

/// Enforces host-routing invariants before migrating a session between PCs.
/// Fails closed with a concise (`<=8` words) reason matching Option D's lock badge.
pub fn validate_move_host(session: &SessionSummary, target: &HostStatus) -> Result<(), String> {
    if let Some(pinned) = session.pinned_host.as_deref()
        && pinned != target.id
    {
        let reason = session
            .pin_reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Pinned to {pinned}"));
        return Err(reason);
    }
    if target.mode == HostMode::Off {
        return Err(format!("{} is OFF — switch mode first", target.hostname));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use iron_proto::AgentState;

    use super::*;

    fn sample_session(pinned_host: Option<&str>, pin_reason: Option<&str>) -> SessionSummary {
        SessionSummary {
            id: "s1".into(),
            title: "ez-commerce · cash-shift-be".into(),
            cli: "agy".into(),
            host_id: "desktop".into(),
            project: "ez-commerce".into(),
            worktree_path: "/tmp".into(),
            git_branch: "main".into(),
            git_dirty: false,
            git_behind_main: 0,
            state: AgentState::Running,
            phase: "build".into(),
            phases: vec!["brief".into(), "build".into()],
            ram_mb: 8,
            pinned_host: pinned_host.map(str::to_string),
            pin_reason: pin_reason.map(str::to_string),
            checkpoint: String::new(),
            resume_cmd: None,
            resume_argv: None,
            prompt: None,
            queue_job: None,
            updated_at_ms: 0,
        }
    }

    fn sample_host(id: &str, mode: HostMode) -> HostStatus {
        HostStatus {
            id: id.into(),
            hostname: id.into(),
            mode,
            cpu_pct: 10,
            cap_pct: 50,
            ram_used_gb: 4.0,
            ram_total_gb: 16.0,
            active_slots: 0,
            max_slots: 1,
        }
    }

    #[test]
    fn blocks_move_when_pinned() {
        let s = sample_session(Some("desktop"), Some("Needs local Postgres on desktop"));
        let laptop = sample_host("laptop", HostMode::Shared);
        let err = validate_move_host(&s, &laptop).unwrap_err();
        assert_eq!(err, "Needs local Postgres on desktop");
    }

    #[test]
    fn blocks_move_when_target_host_off() {
        let s = sample_session(None, None);
        let laptop = sample_host("laptop", HostMode::Off);
        let err = validate_move_host(&s, &laptop).unwrap_err();
        assert!(err.contains("OFF"));
    }

    #[test]
    fn allows_move_when_unpinned_and_host_ready() {
        let s = sample_session(None, None);
        let laptop = sample_host("laptop", HostMode::Shared);
        assert!(validate_move_host(&s, &laptop).is_ok());
    }
}
