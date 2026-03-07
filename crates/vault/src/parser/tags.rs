use regex::Regex;
use std::sync::LazyLock;

// Captura #tag: al inicio de línea o después de whitespace.
// El grupo 1 es el nombre del tag.
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z][a-zA-Z0-9_\-/]*)").unwrap());

pub fn extract_tags(text: &str) -> Vec<String> {
    let content = strip_frontmatter(text);

    TAG_RE
        .captures_iter(content)
        .map(|cap| cap[1].to_string())
        .collect()
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
        // # Header no es un tag porque no tiene letras pegadas al #
        // En realidad "# Header" tiene un espacio después del #, así que la regex no lo captura
        let tags = extract_tags("# Header\n## Subheader");
        assert!(tags.is_empty());
    }

    #[test]
    fn ignores_frontmatter_tags() {
        let text = "---\ntags: [rust, web]\n---\n#real-tag aquí";
        let tags = extract_tags(text);
        assert_eq!(tags, vec!["real-tag"]);
    }
}
