use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use iron_suite::{backup, drift, graph, import, intelligence, mcp, migrate, native, output, refresh, service, sleep, store::Store, ui};
use serde_json::json;
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(
    name = "iron",
    version,
    about = "Local memory retrieval, reinforcement, and cross-session linking for Iron Suite"
)]
struct Cli {
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Memory {
        #[command(subcommand)]
        command: MemoryCommand,
    },
    Context(ContextArgs),
    Mcp {
        #[arg(long)]
        claude_root: Option<PathBuf>,
        #[arg(long)]
        cavemem_db: Option<PathBuf>,
    },
    Ui {
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 7420)]
        port: u16,
    },
}

#[derive(Subcommand)]
enum MemoryCommand {
    Backup {
        #[arg(long)]
        output: PathBuf,
    },
    Export {
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "native", value_parser = ["native", "summaries"])]
        scope: String,
    },
    Remember {
        #[arg(long)]
        title: String,
        #[arg(long)]
        content: String,
        #[arg(long)]
        project: String,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long = "supersedes")]
        supersedes: Vec<String>,
    },
    Feedback {
        id: String,
        #[arg(long, value_parser = ["helpful", "outdated", "contradicted"])]
        outcome: String,
        #[arg(long)]
        superseded_by: Option<String>,
    },
    Link,
    Sleep {
        #[arg(long)]
        repos_root: Option<PathBuf>,
    },
    AuditDrift {
        #[arg(long)]
        project: String,
        #[arg(long)]
        repo: PathBuf,
    },
    Recall {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        session: String,
    },
    Outcome {
        #[arg(long, value_parser = ["pass", "fail", "correction"])]
        outcome: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long = "id")]
        ids: Vec<String>,
        #[arg(long)]
        note: Option<String>,
    },
    MergeProject {
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        exact: bool,
        #[arg(long)]
        no_alias: bool,
    },
    Consolidate {
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value_t = 3)]
        min_occurrences: usize,
        #[arg(long, default_value_t = 15)]
        limit: usize,
    },
    Migrate {
        #[arg(long)]
        from: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        archive_output: Option<PathBuf>,
    },
    Import {
        #[arg(long)]
        claude_root: Option<PathBuf>,
        #[arg(long)]
        cavemem_db: Option<PathBuf>,
        #[arg(long)]
        native_jsonl: Option<PathBuf>,
    },
    Search(SearchArgs),
    Get {
        id: String,
        #[arg(long, default_value_t = 0)]
        offset: usize,
        #[arg(long, default_value_t = 4000)]
        max_bytes: usize,
        #[arg(long)]
        section: Option<String>,
    },
    Related {
        id: String,
        #[arg(long)]
        relation: Option<String>,
        #[arg(long, default_value_t = 10)]
        limit: usize,
        #[arg(long, default_value_t = 4000)]
        max_bytes: usize,
    },
    Graph {
        #[command(subcommand)]
        command: GraphCommand,
    },
    Stats,
}

#[derive(Args)]
struct GraphQueryArgs {
    #[arg(long)]
    repo: Option<String>,
    #[arg(long)]
    limit: Option<usize>,
    #[arg(long, default_value_t = graph::DEFAULT_MAX_BYTES)]
    max_bytes: usize,
}

#[derive(Subcommand)]
enum GraphCommand {
    Refresh,
    Touch {
        #[arg(required = true)]
        paths: Vec<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    Suggest {
        #[arg(long)]
        apply: bool,
    },
    Changes {
        #[arg(long, default_value_t = 7)]
        since: u64,
        #[command(flatten)]
        opts: GraphQueryArgs,
    },
    WhoCalls {
        query: String,
        #[command(flatten)]
        opts: GraphQueryArgs,
    },
    Impact {
        #[arg(long)]
        file: PathBuf,
        #[command(flatten)]
        opts: GraphQueryArgs,
    },
    Fog {
        #[command(flatten)]
        opts: GraphQueryArgs,
    },
}

#[derive(Args)]
struct SearchArgs {
    query: String,
    #[arg(long, conflicts_with = "repo")]
    project: Option<String>,
    #[arg(long)]
    repo: Option<PathBuf>,
    #[arg(long)]
    strict_project: bool,
    #[arg(long, default_value_t = 10)]
    limit: usize,
    #[arg(long, default_value_t = 4000)]
    max_bytes: usize,
    #[arg(long, value_parser=["all", "curated", "history", "native", "archive"])]
    source: Option<String>,
}

#[derive(Args)]
struct ContextArgs {
    #[command(flatten)]
    search: SearchArgs,
    #[arg(long, default_value="developer", value_parser=["developer", "reviewer", "verifier"])]
    role: String,
}

impl SearchArgs {
    fn request(self, role: Option<String>) -> Result<service::SearchRequest> {
        let project = match self.repo {
            Some(repo) => Some(import::project_for_repo(&repo)?),
            None => self.project,
        };
        Ok(service::SearchRequest {
            query: self.query,
            project,
            strict_project: self.strict_project,
            limit: Some(self.limit),
            max_bytes: Some(self.max_bytes),
            role,
            source: self.source,
        })
    }
}

fn default_db() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is unset; supply --db")?;
    Ok(PathBuf::from(home).join(".local/share/iron/memory.db"))
}

fn run_graph(db: &std::path::Path, command: GraphCommand) -> Result<()> {
    let text = match command {
        GraphCommand::Refresh => output::encode(&graph::refresh(db)?)?,
        GraphCommand::Touch { paths, json } => {
            let report = graph::touch(db, &paths)?;
            if json {
                output::encode(&report.json_value)?
            } else {
                report.impact_text
            }
        }
        GraphCommand::Suggest { apply } => output::encode(&graph::run_suggest(db, apply)?)?,
        GraphCommand::Changes { since, opts } => graph::query_changes(
            db,
            since,
            opts.repo.as_deref(),
            opts.limit,
            opts.max_bytes,
        )?,
        GraphCommand::WhoCalls { query, opts } => {
            graph::query_who_calls(db, &query, opts.repo.as_deref(), opts.limit, opts.max_bytes)?
        }
        GraphCommand::Impact { file, opts } => {
            graph::query_impact(db, &file, opts.repo.as_deref(), opts.limit, opts.max_bytes)?
        }
        GraphCommand::Fog { opts } => {
            graph::query_fog(db, opts.repo.as_deref(), opts.limit, opts.max_bytes)?
        }
    };
    io::stdout().lock().write_all(text.as_bytes())?;
    Ok(())
}

fn run_readonly_memory(db: &std::path::Path, command: MemoryCommand) -> Result<serde_json::Value> {
    let store =
        Store::open(db, false).context("cannot open Iron index; run memory import first")?;
    match command {
        MemoryCommand::Search(args) => {
            service::search_with_archive(&store, Some(db), args.request(None)?)
        }
        MemoryCommand::Get {
            id,
            offset,
            max_bytes,
            section,
        } => service::get_with_archive(
            &store,
            Some(db),
            service::GetRequest {
                id,
                offset,
                max_bytes: Some(max_bytes),
                section,
            },
        ),
        MemoryCommand::Related {
            id,
            relation,
            limit,
            max_bytes,
        } => service::related(
            &store,
            service::RelatedRequest {
                id,
                relation,
                limit: Some(limit),
                max_bytes: Some(max_bytes),
            },
        ),
        MemoryCommand::Consolidate {
            project,
            min_occurrences,
            limit,
        } => store.consolidate(project.as_deref(), min_occurrences, limit),
        MemoryCommand::Export { output, scope } => native::export_jsonl(&store, &output, &scope),
        MemoryCommand::Stats => store.stats(),
        MemoryCommand::Import { .. }
        | MemoryCommand::Remember { .. }
        | MemoryCommand::Feedback { .. }
        | MemoryCommand::Link
        | MemoryCommand::MergeProject { .. }
        | MemoryCommand::Migrate { .. }
        | MemoryCommand::Backup { .. }
        | MemoryCommand::Sleep { .. }
        | MemoryCommand::AuditDrift { .. }
        | MemoryCommand::Recall { .. }
        | MemoryCommand::Graph { .. }
        | MemoryCommand::Outcome { .. } => unreachable!(),
    }
}

fn run(cli: Cli) -> Result<()> {
    let db = cli.db.map(Ok).unwrap_or_else(default_db)?;
    if let Command::Mcp {
        claude_root,
        cavemem_db,
    } = &cli.command
    {
        if claude_root.is_some() || cavemem_db.is_some() {
            refresh::run(&db, claude_root.as_deref(), cavemem_db.as_deref(), None)?;
        }
        return mcp::serve(&db);
    }
    if let Command::Ui { host, port } = &cli.command {
        return ui::serve(&db, host, *port);
    }
    if let Command::Memory {
        command: MemoryCommand::Graph { command },
    } = cli.command
    {
        return run_graph(&db, command);
    }
    let result = match cli.command {
        Command::Memory {
            command: MemoryCommand::Backup { output },
        } => backup::run(&db, &output)?,
        Command::Memory {
            command:
                MemoryCommand::Migrate {
                    from,
                    output,
                    archive_output,
                },
        } => migrate::migrate_store(&from, &output, archive_output.as_deref())?,
        Command::Memory {
            command:
                MemoryCommand::Remember {
                    title,
                    content,
                    project,
                    kind,
                    agent,
                    supersedes,
                },
        } => native::remember(
            &db,
            native::RememberRequest {
                title,
                content,
                project,
                kind,
                agent,
                supersedes,
            },
        )?,
        Command::Memory {
            command:
                MemoryCommand::Feedback {
                    id,
                    outcome,
                    superseded_by,
                },
        } => native::feedback(
            &db,
            native::FeedbackRequest {
                id,
                outcome,
                superseded_by,
            },
        )?,
        Command::Memory {
            command:
                MemoryCommand::MergeProject {
                    from,
                    to,
                    exact,
                    no_alias,
                },
        } => native::merge_projects(
            &db,
            native::MergeProjectsRequest {
                from,
                to,
                include_subpaths: !exact,
                save_alias: !no_alias,
            },
        )?,
        Command::Memory {
            command: MemoryCommand::Link,
        } => {
            let mut store = Store::open(&db, true)?;
            let built = store.rebuild_auto_links()?;
            json!({"auto_links_built": built})
        }
        Command::Memory {
            command: MemoryCommand::Sleep { repos_root },
        } => sleep::run(&db, repos_root.as_deref())?,
        Command::Memory {
            command: MemoryCommand::AuditDrift { project, repo },
        } => drift::audit_and_save_drift(&db, &project, &repo)?,
        Command::Memory {
            command:
                MemoryCommand::Outcome {
                    outcome,
                    project,
                    ids,
                    note,
                },
        } => intelligence::record_outcome(&db, &outcome, project.as_deref(), &ids, note.as_deref())?,
        Command::Memory {
            command: MemoryCommand::Recall { path, session },
        } => intelligence::record_file_recall(&db, &session, &path)?,
        Command::Memory {
            command:
                MemoryCommand::Import {
                    claude_root,
                    cavemem_db,
                    native_jsonl,
                },
        } => refresh::run(
            &db,
            claude_root.as_deref(),
            cavemem_db.as_deref(),
            native_jsonl.as_deref(),
        )?,
        Command::Memory { command } => run_readonly_memory(&db, command)?,
        Command::Context(args) => {
            let store = Store::open(&db, false)
                .context("cannot open Iron index; run memory import first")?;
            service::search_with_archive(&store, Some(&db), args.search.request(Some(args.role))?)?
        }
        Command::Mcp { .. } | Command::Ui { .. } => unreachable!(),
    };
    io::stdout()
        .lock()
        .write_all(output::encode(&result)?.as_bytes())?;
    Ok(())
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("{}", json!({"error": format!("{error:#}")}));
        std::process::exit(1);
    }
}
