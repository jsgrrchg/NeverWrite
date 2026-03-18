use serde::{Deserialize, Serialize};

const DEFAULT_SERVER_URL: &str = "https://api.languagetool.org";

/// Minimal percent-encoding for application/x-www-form-urlencoded values.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from(HEX[(byte >> 4) as usize]));
                out.push(char::from(HEX[(byte & 0x0f) as usize]));
            }
        }
    }
    out
}

const HEX: [u8; 16] = *b"0123456789ABCDEF";

// --- Public types (returned to frontend) ---

#[derive(Debug, Clone, Serialize)]
pub struct GrammarDiagnostic {
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub message: String,
    pub short_message: Option<String>,
    pub replacements: Vec<String>,
    pub rule_id: String,
    pub rule_description: String,
    pub issue_type: String,
    pub category_id: String,
    pub category_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrammarCheckResponse {
    pub language: String,
    pub diagnostics: Vec<GrammarDiagnostic>,
}

// --- LanguageTool API response parsing ---

#[derive(Deserialize)]
struct LTResponse {
    language: LTLanguage,
    matches: Vec<LTMatch>,
}

#[derive(Deserialize)]
struct LTLanguage {
    code: String,
}

#[derive(Deserialize)]
struct LTMatch {
    message: String,
    #[serde(rename = "shortMessage")]
    short_message: Option<String>,
    /// Character offset in the original text (Unicode scalar values).
    offset: usize,
    /// Length in characters.
    length: usize,
    replacements: Vec<LTReplacement>,
    rule: LTRule,
}

#[derive(Deserialize)]
struct LTReplacement {
    value: String,
}

#[derive(Deserialize)]
struct LTRule {
    id: String,
    description: String,
    #[serde(rename = "issueType")]
    issue_type: Option<String>,
    category: LTCategory,
}

#[derive(Deserialize)]
struct LTCategory {
    id: String,
    name: String,
}

// --- Core ---

pub fn resolve_server_url(custom_url: Option<&str>) -> &str {
    match custom_url {
        Some(url) if !url.trim().is_empty() => url.trim(),
        _ => DEFAULT_SERVER_URL,
    }
}

pub async fn check_grammar(
    text: &str,
    language: &str,
    server_url: &str,
) -> Result<GrammarCheckResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let url = format!("{}/v2/check", server_url.trim_end_matches('/'));

    // Build URL-encoded form body (reqwest 0.13 requires the `form` cargo feature
    // which is not enabled; encode manually instead).
    let body = format!(
        "text={}&language={}",
        percent_encode(text),
        percent_encode(language),
    );

    let response = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Grammar check request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Grammar check failed: HTTP {}", response.status()));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read grammar check response: {e}"))?;

    let lt_response: LTResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse grammar check response: {e}"))?;

    // LanguageTool returns offset/length in Unicode characters (scalar values).
    // CodeMirror uses UTF-16 offsets. Convert via char_offset_to_utf16.
    let diagnostics = lt_response
        .matches
        .into_iter()
        .filter_map(|m| {
            let start_utf16 = char_offset_to_utf16(text, m.offset)?;
            let end_utf16 = char_offset_to_utf16(text, m.offset + m.length)?;
            Some(GrammarDiagnostic {
                start_utf16,
                end_utf16,
                message: m.message,
                short_message: m.short_message,
                replacements: m
                    .replacements
                    .into_iter()
                    .take(5)
                    .map(|r| r.value)
                    .collect(),
                rule_id: m.rule.id,
                rule_description: m.rule.description,
                issue_type: m.rule.issue_type.unwrap_or_default(),
                category_id: m.rule.category.id,
                category_name: m.rule.category.name,
            })
        })
        .collect();

    Ok(GrammarCheckResponse {
        language: lt_response.language.code,
        diagnostics,
    })
}

/// Convert a character offset (Unicode scalar values) to a UTF-16 code-unit offset.
fn char_offset_to_utf16(text: &str, char_offset: usize) -> Option<usize> {
    let mut utf16_offset = 0;
    let mut char_count = 0;
    for ch in text.chars() {
        if char_count == char_offset {
            return Some(utf16_offset);
        }
        utf16_offset += ch.len_utf16();
        char_count += 1;
    }
    // char_offset == total char count → end of string
    if char_offset == char_count {
        return Some(utf16_offset);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn char_offset_to_utf16_ascii() {
        let text = "Hello world";
        assert_eq!(char_offset_to_utf16(text, 0), Some(0));
        assert_eq!(char_offset_to_utf16(text, 5), Some(5));
        assert_eq!(char_offset_to_utf16(text, 11), Some(11));
    }

    #[test]
    fn char_offset_to_utf16_multibyte() {
        // "café" — 'é' is U+00E9, 1 UTF-16 code unit, 2 UTF-8 bytes
        let text = "café";
        assert_eq!(char_offset_to_utf16(text, 0), Some(0)); // c
        assert_eq!(char_offset_to_utf16(text, 3), Some(3)); // é
        assert_eq!(char_offset_to_utf16(text, 4), Some(4)); // end
    }

    #[test]
    fn char_offset_to_utf16_surrogate_pairs() {
        // "A😀B" — 😀 is U+1F600, needs 2 UTF-16 code units (surrogate pair)
        let text = "A😀B";
        assert_eq!(char_offset_to_utf16(text, 0), Some(0)); // A
        assert_eq!(char_offset_to_utf16(text, 1), Some(1)); // 😀
        assert_eq!(char_offset_to_utf16(text, 2), Some(3)); // B (after surrogate pair)
        assert_eq!(char_offset_to_utf16(text, 3), Some(4)); // end
    }

    #[test]
    fn char_offset_out_of_bounds() {
        let text = "hi";
        assert_eq!(char_offset_to_utf16(text, 99), None);
    }

    #[test]
    fn resolve_server_url_default() {
        assert_eq!(resolve_server_url(None), DEFAULT_SERVER_URL);
        assert_eq!(resolve_server_url(Some("")), DEFAULT_SERVER_URL);
        assert_eq!(resolve_server_url(Some("   ")), DEFAULT_SERVER_URL);
    }

    #[test]
    fn resolve_server_url_custom() {
        assert_eq!(
            resolve_server_url(Some("http://localhost:8081")),
            "http://localhost:8081"
        );
    }
}
