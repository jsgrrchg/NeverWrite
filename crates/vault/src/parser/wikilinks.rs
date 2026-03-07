use regex::Regex;
use std::sync::LazyLock;
use vault_ai_types::{TextRange, WikiLink};

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\[\]]+?)(?:\|([^\[\]]+?))?\]\]").unwrap());

pub fn extract_wikilinks(text: &str) -> Vec<WikiLink> {
    WIKILINK_RE
        .captures_iter(text)
        .map(|cap| {
            let full_match = cap.get(0).unwrap();
            let target = cap[1].to_string();
            let alias = cap.get(2).map(|m| m.as_str().to_string());
            WikiLink {
                target,
                alias,
                range: TextRange {
                    start: full_match.start(),
                    end: full_match.end(),
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_link() {
        let links = extract_wikilinks("Ver [[Mi Nota]] para más info");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Mi Nota");
        assert_eq!(links[0].alias, None);
    }

    #[test]
    fn link_with_alias() {
        let links = extract_wikilinks("Ver [[Mi Nota|mi enlace]] aquí");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Mi Nota");
        assert_eq!(links[0].alias, Some("mi enlace".to_string()));
    }

    #[test]
    fn link_with_path() {
        let links = extract_wikilinks("Ver [[carpeta/subcarpeta/nota]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "carpeta/subcarpeta/nota");
    }

    #[test]
    fn multiple_links() {
        let links = extract_wikilinks("[[A]] texto [[B|alias]] más [[C]]");
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].target, "A");
        assert_eq!(links[1].target, "B");
        assert_eq!(links[1].alias, Some("alias".to_string()));
        assert_eq!(links[2].target, "C");
    }

    #[test]
    fn no_links() {
        let links = extract_wikilinks("Texto sin links");
        assert!(links.is_empty());
    }

    #[test]
    fn ranges_are_correct() {
        let text = "abc [[target]] xyz";
        let links = extract_wikilinks(text);
        assert_eq!(links[0].range.start, 4);
        assert_eq!(links[0].range.end, 14);
        assert_eq!(
            &text[links[0].range.start..links[0].range.end],
            "[[target]]"
        );
    }
}
