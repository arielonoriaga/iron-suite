use std::path::{Path, PathBuf};

use clap::Parser;

/// Alacritty-compatible CLI arguments for launching the native GPUI IronTerm client.
#[derive(Debug, Clone, Parser, PartialEq, Eq)]
#[command(
    name = "iron-term",
    version,
    about = "Native GPUI multi-agent terminal (Option D: Alacritty Blade)"
)]
pub struct CliArgs {
    /// Start the initial shell in the specified working directory
    #[arg(long = "working-directory", value_name = "DIR")]
    pub working_directory: Option<PathBuf>,

    /// Set the window and initial session title
    #[arg(short = 't', long = "title", value_name = "TITLE")]
    pub title: Option<String>,

    /// Path to the iron-agentd Unix socket
    #[arg(long = "socket", env = "IRON_TERM_SOCKET", value_name = "PATH")]
    pub socket: Option<String>,

    /// Always spawn and attach a fresh live shell session on launch
    #[arg(long = "new-session")]
    pub new_session: bool,

    /// Start in Celestial Light theme instead of Celestial Dark
    #[arg(long = "light")]
    pub light: bool,

    /// Execute the specified command and arguments inside a newly spawned session
    #[arg(
        short = 'e',
        long = "command",
        num_args = 1..,
        trailing_var_arg = true,
        allow_hyphen_values = true,
        value_name = "CMD"
    )]
    pub command: Vec<String>,
}

impl CliArgs {
    pub fn socket_path(&self) -> PathBuf {
        self.socket
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_socket_path)
    }

    pub fn resolved_working_directory(&self) -> PathBuf {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        resolve_working_directory(self.working_directory.as_deref(), &cwd)
    }

    /// True when the caller explicitly requested a new session, working directory, or command,
    /// meaning IronTerm should spawn and attach a fresh session immediately on launch.
    pub fn force_spawn_new_session(&self) -> bool {
        self.new_session || self.working_directory.is_some() || !self.command.is_empty()
    }

    pub fn initial_window_title(&self) -> String {
        self.title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "IronTerm".to_string())
    }

    pub fn derive_spawn_metadata(&self) -> SpawnMetadata {
        let worktree = self.resolved_working_directory();
        let project = worktree
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("shell")
            .to_string();

        let cli = detect_cli_label(&self.command);
        let title = self
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("{project} · {cli}"));

        SpawnMetadata {
            title,
            project,
            worktree_path: worktree.to_string_lossy().into_owned(),
            cli,
            command: self.command.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnMetadata {
    pub title: String,
    pub project: String,
    pub worktree_path: String,
    pub cli: String,
    pub command: Vec<String>,
}

pub fn resolve_working_directory(explicit: Option<&Path>, cwd: &Path) -> PathBuf {
    match explicit {
        Some(dir) if dir.is_absolute() => dir.to_path_buf(),
        Some(dir) => cwd.join(dir),
        None => cwd.to_path_buf(),
    }
}

pub fn default_socket_path() -> PathBuf {
    iron_proto::resolve_socket_path()
}

#[cfg(test)]
pub fn default_socket_path_from(xdg_runtime_dir: Option<&str>, uid: u32) -> PathBuf {
    iron_proto::resolve_socket_path_from(None, xdg_runtime_dir, uid)
}

pub fn detect_cli_label(command: &[String]) -> String {
    let Some(first) = command.first() else {
        return "shell".to_string();
    };
    let bin = Path::new(first)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(first)
        .to_ascii_lowercase();
    match bin.as_str() {
        "claude" | "claude-code" => "claude".to_string(),
        "codex" => "codex".to_string(),
        "agy" | "antigravity" => "agy".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "shell".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_alacritty_compatible_flags() {
        let args = CliArgs::try_parse_from([
            "iron-term",
            "--working-directory",
            "/tmp/my-repo",
            "--title",
            "Build Shell",
            "--socket",
            "/tmp/custom.sock",
            "-e",
            "claude",
            "--resume",
            "abc123",
        ])
        .expect("parse flags");

        assert_eq!(
            args.working_directory.as_deref(),
            Some(Path::new("/tmp/my-repo"))
        );
        assert_eq!(args.title.as_deref(), Some("Build Shell"));
        assert_eq!(args.socket.as_deref(), Some("/tmp/custom.sock"));
        assert_eq!(args.socket_path(), PathBuf::from("/tmp/custom.sock"));
        assert_eq!(args.command, vec!["claude", "--resume", "abc123"]);
        assert!(args.force_spawn_new_session());

        let meta = args.derive_spawn_metadata();
        assert_eq!(meta.project, "my-repo");
        assert_eq!(meta.cli, "claude");
        assert_eq!(meta.title, "Build Shell");
        assert_eq!(meta.worktree_path, "/tmp/my-repo");
    }

    #[test]
    fn parses_minimal_invocation_without_force_spawn() {
        let args = CliArgs::try_parse_from(["iron-term"]).expect("parse default");
        assert!(args.working_directory.is_none());
        assert!(args.title.is_none());
        assert!(args.command.is_empty());
        assert!(!args.new_session);
        assert!(!args.light);
        assert!(!args.force_spawn_new_session());
        assert_eq!(args.initial_window_title(), "IronTerm");
    }

    #[test]
    fn new_session_flag_forces_fresh_spawn() {
        let args = CliArgs::try_parse_from(["iron-term", "--new-session"]).expect("parse flag");
        assert!(args.new_session);
        assert!(args.force_spawn_new_session());
    }

    #[test]
    fn preserves_hyphenated_args_after_exec_flag() {
        let args = CliArgs::try_parse_from([
            "iron-term",
            "-e",
            "/bin/sh",
            "-lc",
            "echo --title not-a-flag",
        ])
        .expect("parse -e");

        assert_eq!(
            args.command,
            vec!["/bin/sh", "-lc", "echo --title not-a-flag"]
        );
        assert!(args.title.is_none());
        assert_eq!(detect_cli_label(&args.command), "sh");
    }

    #[test]
    fn resolves_relative_working_directory_against_cwd() {
        let cwd = Path::new("/home/tester/workspace");
        assert_eq!(
            resolve_working_directory(Some(Path::new("sub/pkg")), cwd),
            PathBuf::from("/home/tester/workspace/sub/pkg")
        );
        assert_eq!(
            resolve_working_directory(Some(Path::new("/abs/path")), cwd),
            PathBuf::from("/abs/path")
        );
        assert_eq!(
            resolve_working_directory(None, cwd),
            PathBuf::from("/home/tester/workspace")
        );
    }

    #[test]
    fn filters_empty_xdg_runtime_dir_and_scopes_tmp_fallback_by_uid() {
        assert_eq!(
            default_socket_path_from(Some("/run/user/1000"), 1000),
            PathBuf::from("/run/user/1000/iron-term/agentd.sock")
        );
        assert_eq!(
            default_socket_path_from(Some("   "), 1000),
            PathBuf::from("/tmp/iron-term-1000/agentd.sock")
        );
        assert_eq!(
            default_socket_path_from(None, 4242),
            PathBuf::from("/tmp/iron-term-4242/agentd.sock")
        );
    }

    #[test]
    fn empty_socket_override_falls_back_to_default_resolver() {
        for raw in ["", "   "] {
            let args = CliArgs::try_parse_from(["iron-term", "--socket", raw])
                .expect("empty --socket must parse cleanly");
            assert_eq!(args.socket_path(), default_socket_path());
        }
    }
}
