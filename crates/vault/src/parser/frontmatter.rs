use serde_json::Value;

/// Extrae el frontmatter YAML entre delimitadores `---` y lo devuelve como JSON Value.
/// Retorna None si no hay frontmatter válido.
pub fn extract_frontmatter(text: &str) -> Option<Value> {
    if !text.starts_with("---") {
        return None;
    }

    let rest = &text[3..];
    let end = rest.find("\n---")?;
    let yaml_str = &rest[..end];

    // Parsear YAML y convertir a serde_json::Value
    let yaml_value: serde_yaml::Value = serde_yaml::from_str(yaml_str).ok()?;
    serde_json::to_value(yaml_value).ok()
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
        // YAML vacío parsea a null
        assert!(fm.is_some());
    }

    #[test]
    fn frontmatter_with_dates() {
        let text = "---\ndate: 2024-01-15\ndraft: true\n---\nContenido";
        let fm = extract_frontmatter(text).unwrap();
        assert_eq!(fm["draft"], true);
    }
}
