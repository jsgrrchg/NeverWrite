pub mod frontmatter;
pub mod tags;
pub mod wikilinks;

use vault_ai_types::NoteDocument;

pub use frontmatter::extract_frontmatter;
pub use tags::extract_tags;
pub use wikilinks::extract_wikilinks;

/// Parsea el contenido markdown completo de una nota.
pub fn parse_note(id: &str, path: &std::path::Path, raw_markdown: &str) -> NoteDocument {
    let links = extract_wikilinks(raw_markdown);
    let tags = extract_tags(raw_markdown);
    let frontmatter = extract_frontmatter(raw_markdown);

    let title = derive_title(path, raw_markdown, frontmatter.as_ref());

    NoteDocument {
        id: vault_ai_types::NoteId(id.to_string()),
        path: vault_ai_types::NotePath(path.to_path_buf()),
        title,
        raw_markdown: raw_markdown.to_string(),
        links,
        tags,
        frontmatter,
    }
}

/// Deriva el título de la nota: frontmatter > primer H1 > nombre del archivo.
fn derive_title(
    path: &std::path::Path,
    raw_markdown: &str,
    frontmatter: Option<&serde_json::Value>,
) -> String {
    // 1. Intentar desde frontmatter
    if let Some(fm) = frontmatter {
        if let Some(title) = fm.get("title").and_then(|v| v.as_str()) {
            return title.to_string();
        }
    }

    // 2. Intentar primer heading H1
    for line in raw_markdown.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            return title.to_string();
        }
        // Saltar líneas vacías y frontmatter
        if !trimmed.is_empty() && !trimmed.starts_with("---") {
            break;
        }
    }

    // 3. Nombre del archivo sin extensión
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Sin título")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn title_from_frontmatter() {
        let md = "---\ntitle: Desde FM\n---\n# Heading\nContenido";
        let note = parse_note("test", Path::new("test.md"), md);
        assert_eq!(note.title, "Desde FM");
    }

    #[test]
    fn title_from_h1() {
        let md = "# Mi Título\nContenido";
        let note = parse_note("test", Path::new("test.md"), md);
        assert_eq!(note.title, "Mi Título");
    }

    #[test]
    fn title_from_filename() {
        let md = "Solo contenido sin heading";
        let note = parse_note("test", Path::new("mi-nota.md"), md);
        assert_eq!(note.title, "mi-nota");
    }

    #[test]
    fn full_parse() {
        let md = "---\ntitle: Test\ntags: [a]\n---\n# Test\n\nVer [[Otra Nota|link]] y #tag1\n";
        let note = parse_note("test", Path::new("test.md"), md);
        assert_eq!(note.title, "Test");
        assert_eq!(note.links.len(), 1);
        assert_eq!(note.links[0].target, "Otra Nota");
        assert!(note.tags.contains(&"tag1".to_string()));
        assert!(note.frontmatter.is_some());
    }
}
