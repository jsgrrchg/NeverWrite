use serde_json::Value;

/// Extracts YAML frontmatter between `---` delimiters and returns it as a JSON Value.
/// Returns None when there is no valid frontmatter.
pub fn extract_frontmatter(text: &str) -> Option<Value> {
    if !text.starts_with("---") {
        return None;
    }

    let rest = &text[3..];
    let end = rest.find("\n---")?;
    let yaml_str = &rest[..end];

    // Parse YAML and convert it to serde_json::Value.
    let yaml_value: serde_yaml::Value = serde_yaml::from_str(yaml_str).ok()?;
    serde_json::to_value(yaml_value).ok()
}

/// Reads a frontmatter field as a trimmed, non-empty string.
///
/// Returns `None` when the frontmatter is absent, the key is missing, the value
/// is not a YAML string, or the value is empty/whitespace-only after trimming.
pub fn frontmatter_string_field(frontmatter: Option<&Value>, key: &str) -> Option<String> {
    let value = frontmatter?.get(key)?.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_frontmatter() {
        let text = "---\ntitle: Mi Nota\ntags:\n  - rust\n  - web\n---\n# Contenido";
        let fm = extract_frontmatter(text).unwrap();
        assert_eq!(fm["title"], "Mi Nota");
        assert_eq!(fm["tags"][0], "rust");
        assert_eq!(fm["tags"][1], "web");
    }

    #[test]
    fn no_frontmatter() {
        let text = "# Solo contenido\nSin frontmatter";
        assert!(extract_frontmatter(text).is_none());
    }

    #[test]
    fn empty_frontmatter() {
        let text = "---\n---\n# Contenido";
        let fm = extract_frontmatter(text);
        // Empty YAML parses to null.
        assert!(fm.is_some());
    }

    #[test]
    fn frontmatter_with_dates() {
        let text = "---\ndate: 2024-01-15\ndraft: true\n---\nContenido";
        let fm = extract_frontmatter(text).unwrap();
        assert_eq!(fm["draft"], true);
    }

    #[test]
    fn string_field_present() {
        let text = "---\nstatus: draft\ntype: article\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(
            frontmatter_string_field(fm.as_ref(), "status"),
            Some("draft".to_string())
        );
        assert_eq!(
            frontmatter_string_field(fm.as_ref(), "type"),
            Some("article".to_string())
        );
    }

    #[test]
    fn string_field_missing() {
        let text = "---\ntitle: Only Title\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "status"), None);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "type"), None);
    }

    #[test]
    fn string_field_no_frontmatter() {
        assert_eq!(frontmatter_string_field(None, "status"), None);
    }

    #[test]
    fn string_field_non_string() {
        let text = "---\nstatus:\n  - a\n  - b\ntype: 42\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "status"), None);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "type"), None);
    }

    #[test]
    fn string_field_empty_string() {
        let text = "---\nstatus: \"\"\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "status"), None);
    }

    #[test]
    fn string_field_whitespace_only_is_trimmed_to_none() {
        let text = "---\nstatus: \"   \"\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(frontmatter_string_field(fm.as_ref(), "status"), None);
    }

    #[test]
    fn string_field_trims_surrounding_whitespace() {
        let text = "---\nstatus: \"  in_review  \"\n---\n# Body";
        let fm = extract_frontmatter(text);
        assert_eq!(
            frontmatter_string_field(fm.as_ref(), "status"),
            Some("in_review".to_string())
        );
    }
}
