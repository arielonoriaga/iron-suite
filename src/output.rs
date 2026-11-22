use anyhow::{Result, bail};
use serde_json::{Value, json};

pub const DEFAULT_BUDGET: usize = 4000;
pub const MAX_BUDGET: usize = 65536;

pub fn validate_budget(budget: usize) -> Result<()> {
    if !(256..=MAX_BUDGET).contains(&budget) {
        bail!("max-bytes must be between 256 and {MAX_BUDGET}");
    }
    Ok(())
}

pub fn encode(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(value)? + "\n")
}

pub fn prefix(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn items(items: Vec<Value>, budget: usize) -> Result<Value> {
    validate_budget(budget)?;
    let no_match = items.is_empty();
    let mut out = json!({"results": [], "truncated": false, "no_match": no_match});
    for item in items {
        out["results"].as_array_mut().unwrap().push(item);
        if encode(&out)?.len() > budget {
            out["results"].as_array_mut().unwrap().pop();
            out["truncated"] = json!(true);
            break;
        }
    }
    Ok(out)
}

pub fn body(mut value: Value, content: &str, offset: usize, budget: usize) -> Result<Value> {
    validate_budget(budget)?;
    if offset > content.len() || !content.is_char_boundary(offset) {
        bail!("offset must be a UTF-8 byte boundary within the record");
    }
    value["offset"] = json!(offset);
    value["content"] = json!("");
    value["truncated"] = json!(true);
    value["next_offset"] = json!(offset);
    for key in [
        "metadata",
        "source_path",
        "title",
        "source_key",
        "source_group",
        "updated_at",
        "source_type",
        "kind",
        "project",
    ] {
        if encode(&value)?.len() + 16 <= budget {
            break;
        }
        value.as_object_mut().unwrap().remove(key);
        value["attribution_omitted"] = json!(true);
    }
    if encode(&value)?.len() + 16 > budget {
        bail!("record attribution exceeds byte budget; increase max-bytes");
    }
    let remaining = &content[offset..];
    let mut low = 0;
    let mut high = remaining.len().min(budget);
    let mut best = 0;
    while low <= high {
        let mid = low + (high - low) / 2;
        let chunk = prefix(remaining, mid);
        let end = offset + chunk.len();
        value["content"] = json!(chunk);
        value["truncated"] = json!(end < content.len());
        value["next_offset"] = if end < content.len() {
            json!(end)
        } else {
            Value::Null
        };
        if encode(&value)?.len() <= budget {
            best = chunk.len();
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    let end = offset + best;
    value["content"] = json!(&remaining[..best]);
    value["truncated"] = json!(end < content.len());
    value["next_offset"] = if end < content.len() {
        json!(end)
    } else {
        Value::Null
    };
    if best == 0 && !remaining.is_empty() {
        bail!("byte budget leaves no room for content; increase max-bytes");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_budget_counts_json_escapes_and_newline() {
        let input = vec![json!({"text": "\"\\\n".repeat(300)})];
        let out = items(input, 256).unwrap();
        assert!(encode(&out).unwrap().len() <= 256);
        assert_eq!(out["truncated"], true);
        assert_eq!(out["no_match"], false);
    }

    #[test]
    fn unicode_pages_reconstruct_exact_original() {
        let original = "á水🚀\"\n".repeat(500);
        let mut result = String::new();
        let mut offset = 0;
        loop {
            let page = body(json!({"id":"mem_test"}), &original, offset, 256).unwrap();
            assert!(encode(&page).unwrap().len() <= 256);
            result.push_str(page["content"].as_str().unwrap());
            match page["next_offset"].as_u64() {
                Some(next) => {
                    assert!(next as usize > offset);
                    offset = next as usize;
                }
                None => break,
            }
        }
        assert_eq!(result, original);
    }

    #[test]
    fn byte_offsets_do_not_split_characters() {
        assert!(body(json!({"id":"x"}), "水", 1, 256).is_err());
        assert!(validate_budget(255).is_err());
        assert!(validate_budget(MAX_BUDGET + 1).is_err());
    }
}
