use regex::Regex;
use std::sync::LazyLock;

use super::frontmatter::extract_frontmatter;

// Captura #tag: al inicio de línea o después de whitespace.
// El grupo 1 es el nombre del tag.
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z][a-zA-Z0-9_\-/]*)").unwrap());

pub fn extract_tags(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();

    // 1. Tags desde el campo tags:/tag: del frontmatter YAML
    if let Some(fm) = extract_frontmatter(text) {
        for key in &["tags", "tag"] {
            if let Some(value) = fm.get(key) {
                match value {
                    serde_json::Value::Array(arr) => {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                let tag = s.trim().trim_start_matches('#').to_string();
                                if !tag.is_empty() && !tags.contains(&tag) {
                                    tags.push(tag);
                                }
                            }
                        }
                    }
                    serde_json::Value::String(s) => {
                        for part in s.split(',') {
                            let tag = part.trim().trim_start_matches('#').to_string();
                            if !tag.is_empty() && !tags.contains(&tag) {
                                tags.push(tag);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // 2. Tags inline #tag del body
    let content = strip_frontmatter(text);
    for cap in TAG_RE.captures_iter(content) {
        let tag = cap[1].to_string();
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }

    tags
}

fn strip_frontmatter(text: &str) -> &str {
    if text.starts_with("---") {
        if let Some(end) = text[3..].find("\n---") {
            return &text[end + 7..]; // 3 (primer ---) + end + 4 (\n---)
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_tag() {
        let tags = extract_tags("Texto con #proyecto aquí");
        assert_eq!(tags, vec!["proyecto"]);
    }

    #[test]
    fn multiple_tags() {
        let tags = extract_tags("#rust #web-dev #tools/cli");
        assert_eq!(tags, vec!["rust", "web-dev", "tools/cli"]);
    }

    #[test]
    fn tag_at_start_of_line() {
        let tags = extract_tags("#inicio de línea");
        assert_eq!(tags, vec!["inicio"]);
    }

    #[test]
    fn no_tags() {
        let tags = extract_tags("Sin tags aquí");
        assert!(tags.is_empty());
    }

    #[test]
    fn ignores_headers() {
        let tags = extract_tags("# Header\n## Subheader");
        assert!(tags.is_empty());
    }

    #[test]
    fn frontmatter_array_tags() {
        let text = "---\ntags:\n  - rust\n  - web\n---\nContenido";
        let tags = extract_tags(text);
        assert!(tags.contains(&"rust".to_string()));
        assert!(tags.contains(&"web".to_string()));
    }

    #[test]
    fn frontmatter_inline_tags() {
        let text = "---\ntags: [clippings, CHILE, Venezuela]\n---\nContenido";
        let tags = extract_tags(text);
        assert!(tags.contains(&"clippings".to_string()));
        assert!(tags.contains(&"CHILE".to_string()));
        assert!(tags.contains(&"Venezuela".to_string()));
    }

    #[test]
    fn frontmatter_and_body_tags_deduped() {
        let text = "---\ntags: [rust]\n---\n#rust y #web";
        let tags = extract_tags(text);
        assert_eq!(tags.iter().filter(|t| t.as_str() == "rust").count(), 1);
        assert!(tags.contains(&"web".to_string()));
    }
}
