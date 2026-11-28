use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

const MAX_SHARED_PAIR_LINES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedPair {
    pub pair_key: String,
    pub sha: String,
    pub repo: String,
    pub at: i64,
}

pub fn expand_home(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

pub fn read_pairs(path: &Path) -> Result<Vec<SharedPair>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(BufReader::new(file)
        .lines()
        .take(MAX_SHARED_PAIR_LINES)
        .map_while(std::result::Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect())
}

pub fn append_new_pairs(path: &Path, pairs: &[SharedPair]) -> Result<usize> {
    let mut known: HashSet<String> = read_pairs(path)?.into_iter().map(|p| p.pair_key).collect();
    let fresh: Vec<&SharedPair> = pairs.iter().filter(|p| known.insert(p.pair_key.clone())).collect();
    if fresh.is_empty() {
        return Ok(0);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for pair in &fresh {
        writeln!(file, "{}", serde_json::to_string(pair)?)?;
    }
    Ok(fresh.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(key: &str) -> SharedPair {
        SharedPair { pair_key: key.into(), sha: "abc1234".into(), repo: "shop".into(), at: 1 }
    }

    #[test]
    fn appends_only_unknown_pair_keys_and_reads_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/pairs.jsonl");
        assert_eq!(append_new_pairs(&path, &[pair("a"), pair("b"), pair("a")]).unwrap(), 2);
        assert_eq!(append_new_pairs(&path, &[pair("b"), pair("c")]).unwrap(), 1);
        let keys: Vec<String> = read_pairs(&path).unwrap().into_iter().map(|p| p.pair_key).collect();
        assert_eq!(keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn missing_file_reads_as_empty_and_malformed_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pairs.jsonl");
        assert!(read_pairs(&path).unwrap().is_empty());
        fs::write(&path, "not json\n{\"pair_key\":\"k\",\"sha\":\"s\",\"repo\":\"r\",\"at\":2}\n").unwrap();
        assert_eq!(read_pairs(&path).unwrap(), vec![SharedPair { pair_key: "k".into(), sha: "s".into(), repo: "r".into(), at: 2 }]);
    }
}
