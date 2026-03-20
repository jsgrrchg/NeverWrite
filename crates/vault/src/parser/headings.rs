use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone)]
pub struct Heading {
    pub id: String,
    pub title: String,
    pub level: u8,
    pub anchor: usize,
    pub head: usize,
}

static ATX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(#{1,6})\s+(.+?)\s*$").unwrap());

static SETEXT_H1_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^===+\s*$").unwrap());

static SETEXT_H2_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---+\s*$").unwrap());

// clean_heading_title regexes
static TRAILING_HASHES_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+#+\s*$").unwrap());
static EMBED_WIKILINK_ALIAS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^|\[\]]+)\|([^\[\]]+)\]\]").unwrap());
static EMBED_WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\[\]]+)\]\]").unwrap());
static WIKILINK_ALIAS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^|\[\]]+)\|([^\[\]]+)\]\]").unwrap());
static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap());
static IMG_MD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\([^)]+\)").unwrap());
static IMG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\[[^\]]+\]").unwrap());
static LINK_MD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
static LINK_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\[[^\]]+\]").unwrap());
static AUTOLINK_EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<((?:https?://|mailto:)?[^>\s@]+@[^>\s]+)>").unwrap());
static AUTOLINK_URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<(https?://[^>]+)>").unwrap());
static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]+)`").unwrap());
static FOOTNOTE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\^([^\]]+)\]").unwrap());
static BOLD_STAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*(.*?)\*\*").unwrap());
static BOLD_UNDER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"__(.*?)__").unwrap());
static ITALIC_STAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*(.*?)\*").unwrap());
static ITALIC_UNDER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_(.*?)_").unwrap());
static STRIKETHROUGH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~~(.*?)~~").unwrap());
static HIGHLIGHT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"==(.*?)==").unwrap());
static SUBSCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~([^~]+)~").unwrap());
static SUPERSCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\^([^^]+)\^").unwrap());
static HTML_TAGS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?\s*(?:sub|sup|kbd|br)\s*/?>").unwrap());
static ESCAPED_DOLLAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\\$").unwrap());
static ESCAPED_CHAR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\([\\`*_\{}\[\]()#+\-.!])").unwrap());
static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn clean_heading_title(raw: &str) -> String {
    let s = raw.trim();
    let s = TRAILING_HASHES_RE.replace_all(&s, "");
    let s = EMBED_WIKILINK_ALIAS_RE.replace_all(&s, "$2");
    let s = EMBED_WIKILINK_RE.replace_all(&s, "$1");
    let s = WIKILINK_ALIAS_RE.replace_all(&s, "$2");
    let s = WIKILINK_RE.replace_all(&s, "$1");
    let s = IMG_MD_RE.replace_all(&s, "$1");
    let s = IMG_REF_RE.replace_all(&s, "$1");
    let s = LINK_MD_RE.replace_all(&s, "$1");
    let s = LINK_REF_RE.replace_all(&s, "$1");
    let s = AUTOLINK_EMAIL_RE.replace_all(&s, "$1");
    let s = AUTOLINK_URL_RE.replace_all(&s, "$1");
    let s = INLINE_CODE_RE.replace_all(&s, "$1");
    let s = FOOTNOTE_RE.replace_all(&s, "");
    let s = BOLD_STAR_RE.replace_all(&s, "$1");
    let s = BOLD_UNDER_RE.replace_all(&s, "$1");
    let s = ITALIC_STAR_RE.replace_all(&s, "$1");
    let s = ITALIC_UNDER_RE.replace_all(&s, "$1");
    let s = STRIKETHROUGH_RE.replace_all(&s, "$1");
    let s = HIGHLIGHT_RE.replace_all(&s, "$1");
    let s = SUBSCRIPT_RE.replace_all(&s, "$1");
    let s = SUPERSCRIPT_RE.replace_all(&s, "$1");
    let s = HTML_TAGS_RE.replace_all(&s, "");
    let s = ESCAPED_DOLLAR_RE.replace_all(&s, "$");
    let s = ESCAPED_CHAR_RE.replace_all(&s, "$1");
    let s = WHITESPACE_RE.replace_all(&s, " ");
    s.trim().to_string()
}

/// Strips frontmatter and returns (body_str, frontmatter_utf16_length).
/// The UTF-16 length is used as the offset base for headings.
fn strip_frontmatter(content: &str) -> (&str, usize) {
    if !content.starts_with("---") {
        return (content, 0);
    }

    let rest = &content[3..];
    let Some(end_pos) = rest.find("\n---") else {
        return (content, 0);
    };

    let after_closing = &rest[end_pos + 4..];
    let trailing = if after_closing.starts_with('\n') {
        1
    } else if after_closing.starts_with("\r\n") {
        2
    } else {
        0
    };

    let fm_byte_len = 3 + end_pos + 4 + trailing;
    let fm_utf16_len = content[..fm_byte_len].encode_utf16().count();
    (&content[fm_byte_len..], fm_utf16_len)
}

/// Extracts all headings from markdown content.
/// Offsets are in UTF-16 code units for compatibility with JavaScript/CodeMirror.
pub fn extract_headings(content: &str) -> Vec<Heading> {
    let (body, fm_len) = strip_frontmatter(content);

    let mut headings = Vec::new();
    let lines: Vec<&str> = body.split('\n').collect();
    let mut offset: usize = fm_len; // UTF-16 offset
    let mut fenced_code = false;
    let mut fence_marker = "";

    for (index, raw_line) in lines.iter().enumerate() {
        // Strip \r if present (for \r\n line endings)
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let trimmed = line.trim();

        // Track code fences
        if let Some(marker) = detect_fence(trimmed) {
            if !fenced_code {
                fenced_code = true;
                fence_marker = marker;
            } else if fence_marker_matches(fence_marker, marker) {
                fenced_code = false;
            }
            offset += raw_line.encode_utf16().count() + 1; // +1 for \n
            continue;
        }

        if !fenced_code {
            // ATX headings
            if let Some(caps) = ATX_RE.captures(line) {
                let level = caps[1].len() as u8;
                let title = clean_heading_title(&caps[2]);
                if !title.is_empty() {
                    let line_utf16_len = raw_line.encode_utf16().count();
                    headings.push(Heading {
                        id: format!("{}:{}:{}", offset, level, index),
                        title,
                        level,
                        anchor: offset,
                        head: offset + line_utf16_len,
                    });
                }
            } else if !trimmed.is_empty() {
                // Setext headings (lookahead to next line)
                if let Some(next_line) = lines.get(index + 1) {
                    let next_trimmed = next_line.strip_suffix('\r').unwrap_or(next_line).trim();
                    let setext_level = if SETEXT_H1_RE.is_match(next_trimmed) {
                        Some(1_u8)
                    } else if SETEXT_H2_RE.is_match(next_trimmed) {
                        Some(2_u8)
                    } else {
                        None
                    };

                    if let Some(level) = setext_level {
                        let title = clean_heading_title(trimmed);
                        if !title.is_empty() {
                            let line_utf16_len = raw_line.encode_utf16().count();
                            headings.push(Heading {
                                id: format!("{}:{}:{}", offset, level, index),
                                title,
                                level,
                                anchor: offset,
                                head: offset + line_utf16_len,
                            });
                        }
                    }
                }
            }
        }

        offset += raw_line.encode_utf16().count() + 1; // +1 for \n
    }

    headings
}

fn detect_fence(trimmed: &str) -> Option<&'static str> {
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn fence_marker_matches(open: &str, close: &str) -> bool {
    open == close
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atx_headings() {
        let content = "# Title\n## Subtitle\n### Section\nText\n#### Deep";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 4);
        assert_eq!(headings[0].title, "Title");
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[1].title, "Subtitle");
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[2].title, "Section");
        assert_eq!(headings[2].level, 3);
        assert_eq!(headings[3].title, "Deep");
        assert_eq!(headings[3].level, 4);
    }

    #[test]
    fn setext_headings() {
        let content = "Title\n===\nSubtitle\n---\nText";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].title, "Title");
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[1].title, "Subtitle");
        assert_eq!(headings[1].level, 2);
    }

    #[test]
    fn skips_code_fences() {
        let content = "# Real\n```\n# Not a heading\n```\n## Also Real";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].title, "Real");
        assert_eq!(headings[1].title, "Also Real");
    }

    #[test]
    fn strips_frontmatter() {
        let content = "---\ntitle: Test\n---\n# Heading";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 1);
        assert_eq!(headings[0].title, "Heading");
    }

    #[test]
    fn cleans_markdown_from_titles() {
        let content = "# **Bold** and *italic*\n## [[Link|Display]] text\n### `code` here";
        let headings = extract_headings(content);
        assert_eq!(headings[0].title, "Bold and italic");
        assert_eq!(headings[1].title, "Display text");
        assert_eq!(headings[2].title, "code here");
    }

    #[test]
    fn empty_title_filtered() {
        let content = "# \n## Real heading";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 1);
        assert_eq!(headings[0].title, "Real heading");
    }

    #[test]
    fn offsets_without_frontmatter() {
        let content = "# Title\nText\n## Sub";
        let headings = extract_headings(content);
        assert_eq!(headings[0].anchor, 0);
        assert_eq!(headings[0].head, 7); // "# Title".len() = 7
                                         // "# Title\n" = 8, "Text\n" = 5, total = 13
        assert_eq!(headings[1].anchor, 13);
        assert_eq!(headings[1].head, 19); // 13 + "## Sub".len() = 13 + 6
    }

    #[test]
    fn offsets_with_frontmatter() {
        let content = "---\ntitle: T\n---\n# Heading";
        let headings = extract_headings(content);
        // frontmatter: "---\ntitle: T\n---\n" = 17 chars
        assert_eq!(headings[0].anchor, 17);
        assert_eq!(headings[0].head, 17 + 9); // "# Heading".len() = 9
    }

    #[test]
    fn tilde_code_fence() {
        let content = "# Before\n~~~\n# Inside\n~~~\n# After";
        let headings = extract_headings(content);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].title, "Before");
        assert_eq!(headings[1].title, "After");
    }

    #[test]
    fn clean_heading_wikilinks() {
        assert_eq!(clean_heading_title("[[target]]"), "target");
        assert_eq!(clean_heading_title("[[target|alias]]"), "alias");
        assert_eq!(clean_heading_title("![[embed]]"), "embed");
        assert_eq!(clean_heading_title("![[embed|display]]"), "display");
    }

    #[test]
    fn clean_heading_links() {
        assert_eq!(clean_heading_title("[text](url)"), "text");
        assert_eq!(clean_heading_title("[text][ref]"), "text");
        assert_eq!(clean_heading_title("![alt](url)"), "alt");
    }

    #[test]
    fn clean_heading_formatting() {
        assert_eq!(clean_heading_title("**bold**"), "bold");
        assert_eq!(clean_heading_title("*italic*"), "italic");
        assert_eq!(clean_heading_title("~~struck~~"), "struck");
        assert_eq!(clean_heading_title("==highlight=="), "highlight");
        assert_eq!(clean_heading_title("`code`"), "code");
        assert_eq!(clean_heading_title("# trailing ###"), "# trailing");
    }

    #[test]
    fn clean_heading_escaped() {
        assert_eq!(clean_heading_title(r"\$100"), "$100");
        assert_eq!(clean_heading_title(r"\*star"), "*star");
    }
}
