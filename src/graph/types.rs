use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::contracts::PayloadContract;

pub const EXTRACTOR_VERSION: i64 = 5;
pub const DEFAULT_MAX_BYTES: usize = 1200;
pub const TOUCH_MAX_BYTES: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkKind {
    Fn,
    Struct,
    Enum,
    Const,
    Method,
    Arrow,
    ObjectMember,
    Frontmatter,
    Script,
}

impl ChunkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fn => "fn",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Const => "const",
            Self::Method => "method",
            Self::Arrow => "arrow",
            Self::ObjectMember => "object_member",
            Self::Frontmatter => "frontmatter",
            Self::Script => "script",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "fn" => Some(Self::Fn),
            "struct" => Some(Self::Struct),
            "enum" => Some(Self::Enum),
            "const" => Some(Self::Const),
            "method" => Some(Self::Method),
            "arrow" => Some(Self::Arrow),
            "object_member" => Some(Self::ObjectMember),
            "frontmatter" => Some(Self::Frontmatter),
            "script" => Some(Self::Script),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairVerifyState {
    Verified,
    UnverifiedSinceChange,
    NeverVerified,
}

impl PairVerifyState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::UnverifiedSinceChange => "unverified-since-change",
            Self::NeverVerified => "never-verified",
        }
    }

    pub fn from_keys(pair_key: &str, verified_pair_key: &str) -> Self {
        if verified_pair_key.is_empty() {
            Self::NeverVerified
        } else if pair_key == verified_pair_key {
            Self::Verified
        } else {
            Self::UnverifiedSinceChange
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StaleReason {
    ChunkChanged,
    SymbolMissing,
}

impl StaleReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChunkChanged => "chunk_changed",
            Self::SymbolMissing => "symbol_missing",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedChunk {
    pub kind: ChunkKind,
    pub qualified_name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub norm_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
    Any,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
            Self::Any => "ANY",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "PATCH" => Some(Self::Patch),
            "DELETE" => Some(Self::Delete),
            "HEAD" => Some(Self::Head),
            "OPTIONS" => Some(Self::Options),
            "ANY" => Some(Self::Any),
            _ => None,
        }
    }

    pub fn parse_crud(raw: &str) -> Option<Self> {
        match raw {
            "get" => Some(Self::Get),
            "post" => Some(Self::Post),
            "put" => Some(Self::Put),
            "patch" => Some(Self::Patch),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }

    pub fn parse_hono(raw: &str) -> Option<Self> {
        match raw {
            "all" => Some(Self::Any),
            "head" => Some(Self::Head),
            "options" => Some(Self::Options),
            other => Self::parse_crud(other),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stack {
    Axum,
    Spa,
    Hono,
    Nginx,
    Web,
    Express,
}

impl Stack {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Axum => "axum",
            Self::Spa => "spa",
            Self::Hono => "hono",
            Self::Nginx => "nginx",
            Self::Web => "web",
            Self::Express => "express",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "axum" => Some(Self::Axum),
            "spa" => Some(Self::Spa),
            "hono" => Some(Self::Hono),
            "nginx" => Some(Self::Nginx),
            "web" => Some(Self::Web),
            "express" => Some(Self::Express),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrefixState {
    Full,
    Resolved,
    Partial,
}

impl PrefixState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Resolved => "resolved",
            Self::Partial => "partial",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" => Some(Self::Full),
            "resolved" => Some(Self::Resolved),
            "partial" => Some(Self::Partial),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Configured,
    Unique,
    Name,
    Suffix,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Configured => "configured",
            Self::Unique => "unique",
            Self::Name => "name",
            Self::Suffix => "suffix",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "configured" => Some(Self::Configured),
            "unique" => Some(Self::Unique),
            "name" => Some(Self::Name),
            "suffix" => Some(Self::Suffix),
            _ => None,
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::Configured => 0,
            Self::Unique => 1,
            Self::Name => 2,
            Self::Suffix => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Callers,
    Callees,
    Impact,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Callers => "callers",
            Self::Callees => "callees",
            Self::Impact => "impact",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshStatus {
    Skipped,
    Incremental,
    Full,
}

impl RefreshStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skipped => "skipped",
            Self::Incremental => "incremental",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphConfig {
    pub repos_root: PathBuf,
    pub services: BTreeMap<String, ServiceConfig>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub clients: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prefixes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub containers: BTreeMap<String, String>,
    #[serde(default)]
    pub external: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_pairs_file: Option<PathBuf>,
}

impl GraphConfig {
    pub fn with_services(repos_root: PathBuf, services: BTreeMap<String, ServiceConfig>) -> Self {
        Self {
            repos_root,
            services,
            env: BTreeMap::new(),
            clients: BTreeMap::new(),
            prefixes: BTreeMap::new(),
            containers: BTreeMap::new(),
            external: Vec::new(),
            verified_pairs_file: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceConfig {
    pub repo: String,
    #[serde(default)]
    pub root: String,
    pub stack: Stack,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_prefix: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EndpointChunkRefs {
    pub handler: Option<(String, String)>,
    pub req_type: Option<(String, String)>,
    pub res_type: Option<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedEndpoint {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
    pub file: String,
    pub line: usize,
    pub handler: String,
    pub prefix_state: PrefixState,
    pub req_contract: Option<PayloadContract>,
    pub res_contract: Option<PayloadContract>,
    pub contract_hash: String,
    pub chunk_refs: EndpointChunkRefs,
}

impl ExtractedEndpoint {
    pub fn simple(
        method: HttpMethod,
        path: &str,
        file: &str,
        line: usize,
        handler: &str,
        prefix_state: PrefixState,
    ) -> Self {
        let p = path.to_owned();
        Self {
            method,
            path_raw: p.clone(),
            path_norm: p,
            file: file.to_owned(),
            line,
            handler: handler.to_owned(),
            prefix_state,
            req_contract: None,
            res_contract: None,
            contract_hash: String::new(),
            chunk_refs: EndpointChunkRefs::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedCall {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
    pub file: String,
    pub line: usize,
    pub base_ref: String,
    pub symbol: String,
    pub area: String,
    pub why: String,
    pub external: bool,
    pub req_contract: Option<PayloadContract>,
}

impl ExtractedCall {
    pub fn simple(
        method: HttpMethod,
        path: &str,
        file: &str,
        line: usize,
        base_ref: &str,
        symbol: &str,
        why: &str,
    ) -> Self {
        Self {
            base_ref: base_ref.to_owned(),
            symbol: symbol.to_owned(),
            area: String::new(),
            why: why.to_owned(),
            external: false,
            req_contract: None,
            method,
            path_raw: path.to_owned(),
            path_norm: path.to_owned(),
            file: file.to_owned(),
            line,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpGraphRequest {
    pub query: String,
    pub direction: Direction,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_enums_roundtrip_str_and_rank() {
        for method in [
            HttpMethod::Get,
            HttpMethod::Post,
            HttpMethod::Put,
            HttpMethod::Patch,
            HttpMethod::Delete,
            HttpMethod::Head,
            HttpMethod::Options,
            HttpMethod::Any,
        ] {
            assert_eq!(HttpMethod::parse(method.as_str()), Some(method));
        }
        assert_eq!(HttpMethod::parse_crud("post"), Some(HttpMethod::Post));
        assert_eq!(HttpMethod::parse_crud("head"), None);

        for stack in [
            Stack::Axum,
            Stack::Spa,
            Stack::Hono,
            Stack::Nginx,
            Stack::Web,
            Stack::Express,
        ] {
            assert_eq!(Stack::parse(stack.as_str()), Some(stack));
        }
        assert_eq!(HttpMethod::parse_hono("all"), Some(HttpMethod::Any));
        for state in [PrefixState::Full, PrefixState::Resolved, PrefixState::Partial] {
            assert_eq!(PrefixState::parse(state.as_str()), Some(state));
        }
        for conf in [
            Confidence::Configured,
            Confidence::Unique,
            Confidence::Name,
            Confidence::Suffix,
        ] {
            assert_eq!(Confidence::parse(conf.as_str()), Some(conf));
        }
        assert!(Confidence::Configured.rank() < Confidence::Suffix.rank());
        assert_eq!(Direction::Impact.as_str(), "impact");
        assert_eq!(RefreshStatus::Incremental.as_str(), "incremental");
        for kind in [
            ChunkKind::Fn,
            ChunkKind::Struct,
            ChunkKind::Enum,
            ChunkKind::Const,
            ChunkKind::Method,
            ChunkKind::Arrow,
            ChunkKind::ObjectMember,
            ChunkKind::Frontmatter,
            ChunkKind::Script,
        ] {
            assert_eq!(ChunkKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(PairVerifyState::from_keys("a", "").as_str(), "never-verified");
        assert_eq!(PairVerifyState::from_keys("a", "a").as_str(), "verified");
        assert_eq!(PairVerifyState::from_keys("a", "b").as_str(), "unverified-since-change");
        assert_eq!(StaleReason::ChunkChanged.as_str(), "chunk_changed");
        assert_eq!(StaleReason::SymbolMissing.as_str(), "symbol_missing");
    }
}
