use regex::{Captures, Regex};
use std::sync::LazyLock;

static PRIVATE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<\s*(/?)\s*private(?:\s+[^>]*?)?\s*>").unwrap());
static PEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
    )
    .unwrap()
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}").unwrap());
static PROVIDER_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}",
        r"|(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        r"|gh[pousr]_[A-Za-z0-9]{20,}",
        r"|github_pat_[A-Za-z0-9_]{20,128}\b",
        r"|xox[baprs]-[A-Za-z0-9-]{10,72}\b",
        r"|st\.[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}\b)"
    ))
    .unwrap()
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b([\w-]*(?:api[_-]?key|secret|token|password|passwd|authorization|[_-]key))(["']?)(\s*[=:]\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\[PRIVATE REDACTED\]|\[REDACTED\]|[^\s,;}\])]+))"#,
    )
    .unwrap()
});
static URL_PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)([^\s@/]+)(@)").unwrap());
static QUERY_KEY_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&]key=)([A-Za-z0-9_%~+/=.-]{12,})").unwrap()
});
static ENV_LINE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)^([ \t]*(?:export[ \t]+)?key)(\s*=\s*)(?:"([^"\r\n]{16,})"|'([^'\r\n]{16,})'|([A-Za-z0-9_+/=-]{16,}))([ \t]*)$"#).unwrap()
});
static PROSE_BACKTICK_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b((?:(?:api[_ -]?)?key|secret|token|password|auth(?:\s+command)?)`?)((?:[^`\n]{0,24}`[^`\n]{1,40}`)?[^`\n]{0,24}`)([^`\r\n]{16,128})(`)").unwrap()
});
static PREFIXED_COLON_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b((?:svc|app|[a-z]{2})-[A-Za-z0-9_.-]+:)([A-Za-z0-9_.+=-]{16,})").unwrap()
});
static SECRET_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[\w-]*(?:api[_-]?key|secret|token|password|passwd|authorization|[_-]key)$")
        .unwrap()
});

pub(crate) fn is_secret_field(name: &str) -> bool {
    SECRET_FIELD.is_match(name)
}

pub(crate) fn redact_credential(value: &str) -> String {
    if value.is_empty() || matches!(value, "[REDACTED]" | "[PRIVATE REDACTED]") {
        value.to_owned()
    } else {
        "[REDACTED]".into()
    }
}

fn looks_like_code_or_path(candidate: &str) -> bool {
    if candidate.contains(char::is_whitespace)
        || candidate.contains("::")
        || candidate.contains('/')
        || candidate.starts_with("./")
        || candidate.starts_with("../")
        || matches!(candidate, "[REDACTED]" | "[PRIVATE REDACTED]")
    {
        return true;
    }
    const CODE_EXTS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".md", ".sh", ".json",
        ".toml", ".yaml", ".yml", ".sql", ".html", ".css", ".lock", ".db",
    ];
    CODE_EXTS.iter().any(|ext| candidate.ends_with(ext))
}

pub fn redact(text: &str) -> String {
    let private = redact_private(text);
    let pem = PEM.replace_all(&private, "[REDACTED]");
    let bearer = BEARER.replace_all(&pem, "Bearer [REDACTED]");
    let providers = PROVIDER_KEY.replace_all(&bearer, "[REDACTED]");
    let url_creds = URL_PASSWORD.replace_all(&providers, "${1}[REDACTED]${3}");
    let query_keys = QUERY_KEY_PARAM.replace_all(&url_creds, "${1}[REDACTED]");
    let env_keys = ENV_LINE_KEY.replace_all(&query_keys, |captures: &Captures<'_>| {
        let (value, quote) = if let Some(v) = captures.get(3) {
            (v.as_str(), "\"")
        } else if let Some(v) = captures.get(4) {
            (v.as_str(), "'")
        } else {
            (captures.get(5).unwrap().as_str(), "")
        };
        if (quote.is_empty() && !is_literal_assignment(value)) || looks_like_code_or_path(value) {
            return captures[0].to_owned();
        }
        format!("{}{}{quote}[REDACTED]{quote}{}", &captures[1], &captures[2], &captures[6])
    });
    let prose_keys = PROSE_BACKTICK_SECRET.replace_all(&env_keys, |captures: &Captures<'_>| {
        let candidate = &captures[3];
        let body = candidate.split_once(':').filter(|(p, _)| p.contains('-') && p.len() <= 24).map(|(_, v)| v).unwrap_or(candidate);
        if looks_like_code_or_path(body) {
            return captures[0].to_owned();
        }
        format!("{}{}[REDACTED]{}", &captures[1], &captures[2], &captures[4])
    });
    let prefixed = PREFIXED_COLON_SECRET.replace_all(&prose_keys, |captures: &Captures<'_>| {
        let end = captures.get(0).unwrap().end();
        let next = prose_keys[end..].chars().next();
        if matches!(next, Some('/')) || looks_like_code_or_path(&captures[2]) {
            return captures[0].to_owned();
        }
        format!("{}[REDACTED]", &captures[1])
    });
    ASSIGNMENT
        .replace_all(&prefixed, |captures: &Captures<'_>| {
            let (value, quote) = if let Some(value) = captures.get(4) {
                (value.as_str(), "\"")
            } else if let Some(value) = captures.get(5) {
                (value.as_str(), "'")
            } else {
                (captures.get(6).unwrap().as_str(), "")
            };
            if quote.is_empty() && !is_literal_assignment(value) {
                return captures[0].to_owned();
            }
            let value = redact_credential(value);
            format!(
                "{}{}{}{quote}{value}{quote}",
                &captures[1], &captures[2], &captures[3]
            )
        })
        .into_owned()
}

fn redact_private(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut depth = 0usize;
    let mut cursor = 0usize;
    for tag in PRIVATE_TAG.captures_iter(text) {
        let full = tag.get(0).unwrap();
        if depth == 0 {
            output.push_str(&text[cursor..full.start()]);
        }
        if tag[1].is_empty() {
            if depth == 0 {
                output.push_str("[PRIVATE REDACTED]");
            }
            depth += 1;
        } else {
            depth = depth.saturating_sub(1);
        }
        cursor = full.end();
    }
    if depth == 0 {
        output.push_str(&text[cursor..]);
    }
    output
}

fn is_literal_assignment(value: &str) -> bool {
    if value.is_empty() || value == "[REDACTED]" || value == "[PRIVATE REDACTED]" {
        return false;
    }
    if matches!(value, "undefined" | "null" | "None" | "true" | "false") {
        return false;
    }
    if let Some((name, _)) = value.split_once('(')
        && !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.'))
    {
        return false;
    }
    !value.starts_with("${") && !value.starts_with("process.env.") && !value.starts_with("env::")
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn private_regions_cover_nested_unclosed_and_unicode_text() {
        let input = "日本語 before <PRIVATE>hidden <private>inner</private>still hidden</PRIVATE> café <private data-x='1'>tail";
        let output = redact(input);
        assert_eq!(
            output,
            "日本語 before [PRIVATE REDACTED] café [PRIVATE REDACTED]"
        );
        assert!(!output.contains("hidden"));
        assert!(!output.contains("tail"));
        assert_eq!(
            redact("a<private>x</private>b<private>y</private>c"),
            "a[PRIVATE REDACTED]b[PRIVATE REDACTED]c"
        );
    }

    #[test]
    fn removes_provider_keys_credentials_and_private_keys() {
        let input = concat!(
            "Bearer abcdefgh12345678\n",
            "sk-", "proj-1234567890abcdefgh\n",
            "AKIA", "ABCDEFGHIJKLMNOP\n",
            "ghp_", "abcdefghijklmnopqrstuvwxyz1234\n",
            "github_pat_", "abcdefghijklmnopqrstuvwxyz1234\n",
            "xoxb-", "123456789012-secret\n",
            "st.", "550e8400-e29b-41d4-a716-446655440000", ".0123456789ABCDEF012345", ".0123456789abcdef012345\n",
            "postgres://user:p4ssword@localhost/db\n",
            "-----BEGIN ", "RSA PRIVATE KEY-----\nsecret key material\n-----END ", "RSA PRIVATE KEY-----\n"
        );
        let output = redact(input);
        assert!(!output.contains("12345678"));
        assert!(!output.contains("550e8400-e29b"));
        assert!(!output.contains("0123456789ABCDEF012345"));
        assert!(!output.contains("secret key material"));
        assert!(!output.contains("p4ssword"));
        assert!(output.contains("postgres://user:[REDACTED]@localhost/db"));
        assert_eq!(
            redact(concat!("a\n-----BEGIN ", "PRIVATE KEY-----\nunclosed")),
            "a\n[REDACTED]"
        );
        assert_eq!(
            redact(concat!("https://api.example.test/v1?key=", "0123456789abcdef%2Bsecret&ok=1")),
            "https://api.example.test/v1?key=[REDACTED]&ok=1"
        );
        assert_eq!(
            redact(concat!("export key=\"", "0123456789abcdefXYZ", "\"")),
            "export key=\"[REDACTED]\""
        );
        assert_eq!(
            redact(concat!("Set `API_KEY` to `", "abcdef0123456789uvwxyz1234", "`")),
            "Set `API_KEY` to `[REDACTED]`"
        );
        assert_eq!(
            redact(concat!("svc-notify:", "abcdefghijklmno==")),
            "svc-notify:[REDACTED]"
        );
    }

    #[test]
    fn preserves_ordinary_code_paths_and_repo_refs() {
        let code = concat!(
            "let key = record.source_key;\n",
            "const key = process.env.GOOGLE_MAPS_KEY;\n",
            "token logic in `src/auth/token_service.rs` and `crate::auth::verify_token`\n",
            "svc-commerce:src/modules/billing/service.rs\n",
            "svc-inventory:feat/webhook-retry\n"
        );
        assert_eq!(redact(code), code);
    }

    #[test]
    fn redacts_assignment_values_and_keeps_ordinary_source() {
        let input = concat!(
            r#"DATABASE_PASSWORD="p4ssword123" aws_secret_"#,
            r#"access_key='a1b2c3d4e5' {"api_"#,
            r#"key":"z9y8x7w6v5"} STRIPE_SECRET_"#,
            r#"KEY = sk_12345678"#
        );
        let output = redact(input);
        assert!(!output.contains("p4ssword123"));
        assert!(!output.contains("a1b2c3d4e5"));
        assert!(!output.contains("z9y8x7w6v5"));
        assert!(output.contains(r#""api_key":"[REDACTED]""#));
        let source = "cacheKey = useful_value\npassword = undefined\ntoken = getToken()\napi_key = process.env.API_KEY\napi_key = ${API_KEY}";
        assert_eq!(redact(source), source);
    }

    #[test]
    fn keeps_full_unicode_and_nonsecret_text() {
        let text = "# 忘れない 🧠\nCafé naïve — Привет\n\nA long ordinary note with punctuation.\n";
        assert_eq!(redact(text), text);
        assert_eq!(redact(&redact(text)), text);
    }

    #[test]
    fn explicit_assignments_redact_alphabetic_and_short_credentials() {
        let input = concat!(
            "DATABASE_PASSWORD=\"correcthorsebatterystaple\"\napi_",
            "key = 'ABCDEFGHIJKLMNOPQRSTUVWX'\npassword=plaintext\ntoken=1234\nThe alphabetic phrase correcthorsebatterystaple remains ordinary prose here."
        );
        let output = redact(input);
        assert!(output.starts_with("DATABASE_PASSWORD=\"[REDACTED]\"\napi_key = '[REDACTED]'\npassword=[REDACTED]\ntoken=[REDACTED]"));
        assert!(output.ends_with(
            "The alphabetic phrase correcthorsebatterystaple remains ordinary prose here."
        ));
        assert_eq!(redact(&output), output);
    }
}
