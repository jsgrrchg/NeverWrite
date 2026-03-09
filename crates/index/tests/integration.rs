use std::path::PathBuf;

use vault_ai_index::VaultIndex;
use vault_ai_types::{NoteDocument, NoteId, NotePath, TextRange, WikiLink};

fn make_note(
    id: &str,
    title: &str,
    links: Vec<(&str, Option<&str>)>,
    tags: Vec<&str>,
) -> NoteDocument {
    NoteDocument {
        id: NoteId(id.to_string()),
        path: NotePath(PathBuf::from(format!("{}.md", id))),
        title: title.to_string(),
        raw_markdown: String::new(),
        links: links
            .into_iter()
            .map(|(target, alias)| WikiLink {
                target: target.to_string(),
                alias: alias.map(|a| a.to_string()),
                range: TextRange { start: 0, end: 0 },
            })
            .collect(),
        tags: tags.into_iter().map(|t| t.to_string()).collect(),
        frontmatter: None,
    }
}

fn build_sample_index() -> VaultIndex {
    let notes = vec![
        make_note(
            "nota1",
            "Primera Nota",
            vec![("nota2", None)],
            vec!["rust", "proyecto"],
        ),
        make_note(
            "nota2",
            "Segunda Nota",
            vec![("nota1", Some("primera")), ("carpeta/nota3", None)],
            vec!["rust"],
        ),
        make_note("carpeta/nota3", "Nota en Carpeta", vec![], vec!["web"]),
        make_note(
            "carpeta/nota1",
            "Otra Nota1",
            vec![("nota2", None)],
            vec!["proyecto"],
        ),
    ];
    VaultIndex::build(notes)
}

// --- Tests de construcción ---

#[test]
fn build_index_has_all_notes() {
    let index = build_sample_index();
    assert_eq!(index.metadata.len(), 4);
}

#[test]
fn names_map_built_correctly() {
    let index = build_sample_index();
    // "nota1" aparece dos veces (nota1 y carpeta/nota1)
    let nota1_entries = index.names.get("nota1").unwrap();
    assert_eq!(nota1_entries.len(), 2);

    let nota3_entries = index.names.get("nota3").unwrap();
    assert_eq!(nota3_entries.len(), 1);
}

// --- Tests de backlinks ---

#[test]
fn backlinks_a_to_b() {
    let index = build_sample_index();
    // nota1 linka a nota2 → nota2 tiene backlink de nota1
    let backlinks = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota1"));
    // carpeta/nota1 también linka a nota2
    assert!(bl_ids.contains(&"carpeta/nota1"));
}

#[test]
fn backlinks_bidirectional() {
    let index = build_sample_index();
    // nota2 linka a nota1 → nota1 tiene backlink de nota2
    let backlinks = index.get_backlinks(&NoteId("nota1".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota2"));
}

#[test]
fn backlinks_with_path() {
    let index = build_sample_index();
    // nota2 linka a carpeta/nota3 → carpeta/nota3 tiene backlink de nota2
    let backlinks = index.get_backlinks(&NoteId("carpeta/nota3".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota2"));
}

// --- Tests de forward links ---

#[test]
fn forward_links() {
    let index = build_sample_index();
    let fwd = index.get_forward_links(&NoteId("nota2".into()));
    let fwd_ids: Vec<&str> = fwd.iter().map(|id| id.0.as_str()).collect();
    assert!(fwd_ids.contains(&"nota1"));
    assert!(fwd_ids.contains(&"carpeta/nota3"));
}

// --- Tests de tags ---

#[test]
fn tags_index() {
    let index = build_sample_index();
    let rust_notes = index.get_notes_by_tag("rust");
    assert_eq!(rust_notes.len(), 2);

    let web_notes = index.get_notes_by_tag("web");
    assert_eq!(web_notes.len(), 1);
    assert_eq!(web_notes[0].0, "carpeta/nota3");
}

// --- Tests de resolución de wikilinks ---

#[test]
fn resolve_unique_name() {
    let index = build_sample_index();
    // nota3 es único → se resuelve directamente
    let resolved = index.resolve_wikilink("nota3", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota3".into())));
}

#[test]
fn resolve_ambiguous_by_proximity() {
    let index = build_sample_index();
    // "nota1" es ambiguo (nota1 y carpeta/nota1)
    // Desde carpeta/nota3, el más cercano es carpeta/nota1
    let resolved = index.resolve_wikilink("nota1", &NoteId("carpeta/nota3".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota1".into())));

    // Desde nota2 (raíz), el más cercano es nota1
    let resolved = index.resolve_wikilink("nota1", &NoteId("nota2".into()));
    assert_eq!(resolved, Some(NoteId("nota1".into())));
}

#[test]
fn resolve_with_path() {
    let index = build_sample_index();
    let resolved = index.resolve_wikilink("carpeta/nota3", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota3".into())));
}

#[test]
fn resolve_nonexistent() {
    let index = build_sample_index();
    let resolved = index.resolve_wikilink("no_existe", &NoteId("nota1".into()));
    assert_eq!(resolved, None);
}

#[test]
fn resolve_by_title_when_filename_differs() {
    let index = VaultIndex::build(vec![
        make_note("refs/rust-book", "Rust Book", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![("Rust Book", None)], vec![]),
    ]);

    let resolved = index.resolve_wikilink("Rust Book", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("refs/rust-book".into())));
}

#[test]
fn resolve_trims_whitespace() {
    let index = VaultIndex::build(vec![
        make_note("refs/guia", "Guia", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink("  Guia  ", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("refs/guia".into())));
}

#[test]
fn resolve_ignores_heading_and_block_refs() {
    let index = VaultIndex::build(vec![
        make_note("refs/guia", "Guia", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink("Guia#intro", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("refs/guia".into())));

    let resolved = index.resolve_wikilink("Guia^bloque-1", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("refs/guia".into())));
}

#[test]
fn resolve_accepts_markdown_extension() {
    let index = VaultIndex::build(vec![
        make_note("carpeta/nota3", "Nota en Carpeta", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink("carpeta/nota3.md", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota3".into())));
}

#[test]
fn resolve_normalizes_typographic_quotes() {
    let index = VaultIndex::build(vec![
        make_note(
            "news/trumps-greenland",
            "Donald Trump's Greenland plan",
            vec![],
            vec![],
        ),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink("Donald Trump’s Greenland plan", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("news/trumps-greenland".into())));
}

#[test]
fn resolve_ignores_trailing_terminal_punctuation() {
    let index = VaultIndex::build(vec![
        make_note(
            "news/south-korea",
            "Trump Says He Will Raise Tariffs on South Korea to 25%",
            vec![],
            vec![],
        ),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink(
        "Trump Says He Will Raise Tariffs on South Korea to 25%.",
        &NoteId("nota1".into()),
    );
    assert_eq!(resolved, Some(NoteId("news/south-korea".into())));
}

#[test]
fn resolve_ignores_diacritics_and_extra_spaces() {
    let index = VaultIndex::build(vec![
        make_note("authors/jose-luis-cava", "José   Luis Cava", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink("Jose Luis Cava", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("authors/jose-luis-cava".into())));
}

#[test]
fn resolve_unique_long_title_prefix() {
    let index = VaultIndex::build(vec![
        make_note(
            "news/starmer-housing",
            "Starmer planta cara a los grandes propietarios y reforma un mecanismo “feudal” de compra de viviendas en el Reino Unido",
            vec![],
            vec![],
        ),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink(
        "Starmer planta cara a los grandes propietarios y reforma un mecanismo \"feudal\" de compra de viviendas",
        &NoteId("nota1".into()),
    );
    assert_eq!(resolved, Some(NoteId("news/starmer-housing".into())));
}

#[test]
fn resolve_unique_long_title_prefix_does_not_guess_when_ambiguous() {
    let index = VaultIndex::build(vec![
        make_note(
            "news/starmer-uk",
            "Starmer planta cara a los grandes propietarios y reforma un mecanismo “feudal” de compra de viviendas en el Reino Unido",
            vec![],
            vec![],
        ),
        make_note(
            "news/starmer-scotland",
            "Starmer planta cara a los grandes propietarios y reforma un mecanismo “feudal” de compra de viviendas en Escocia",
            vec![],
            vec![],
        ),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let resolved = index.resolve_wikilink(
        "Starmer planta cara a los grandes propietarios y reforma un mecanismo \"feudal\" de compra de viviendas",
        &NoteId("nota1".into()),
    );
    assert_eq!(resolved, None);
}

// --- Tests de búsqueda ---

#[test]
fn search_by_title() {
    let index = build_sample_index();
    let results = index.search_by_title("Primera");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].note_id.0, "nota1");
}

#[test]
fn search_by_title_case_insensitive() {
    let index = build_sample_index();
    let results = index.search_by_title("primera");
    assert_eq!(results.len(), 1);
}

#[test]
fn search_by_title_partial() {
    let index = build_sample_index();
    let results = index.search_by_title("Nota");
    // Todas las notas tienen "Nota" en el título
    assert_eq!(results.len(), 4);
}

#[test]
fn search_empty_query() {
    let index = build_sample_index();
    let results = index.search_by_title("");
    assert!(results.is_empty());
}

#[test]
fn search_combined() {
    let index = build_sample_index();
    let results = index.search("carpeta");
    // carpeta/nota3 y carpeta/nota1 coinciden por path
    assert_eq!(results.len(), 2);
}

// --- Tests de reindex ---

#[test]
fn reindex_note_updates_index() {
    let mut index = build_sample_index();

    // Cambiar nota1: ahora linka a carpeta/nota3 en vez de nota2
    let updated = make_note(
        "nota1",
        "Nota Actualizada",
        vec![("carpeta/nota3", None)],
        vec!["nuevo-tag"],
    );
    index.reindex_note(updated);

    // El título cambió
    assert_eq!(
        index.metadata.get(&NoteId("nota1".into())).unwrap().title,
        "Nota Actualizada"
    );

    // Forward links actualizados
    let fwd = index.get_forward_links(&NoteId("nota1".into()));
    assert_eq!(fwd.len(), 1);
    assert_eq!(fwd[0].0, "carpeta/nota3");

    // nota2 ya no tiene backlink de nota1
    let bl = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = bl.iter().map(|id| id.0.as_str()).collect();
    assert!(!bl_ids.contains(&"nota1"));

    // El tag viejo ya no existe para nota1
    let rust_notes = index.get_notes_by_tag("rust");
    let rust_ids: Vec<&str> = rust_notes.iter().map(|id| id.0.as_str()).collect();
    assert!(!rust_ids.contains(&"nota1"));

    // El tag nuevo sí existe
    let new_tag = index.get_notes_by_tag("nuevo-tag");
    assert_eq!(new_tag.len(), 1);
}

#[test]
fn remove_note_cleans_index() {
    let mut index = build_sample_index();
    index.remove_note(&NoteId("nota1".into()));

    assert_eq!(index.metadata.len(), 3);
    assert!(!index.metadata.contains_key(&NoteId("nota1".into())));

    // Los backlinks de nota2 ya no incluyen nota1
    let bl = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = bl.iter().map(|id| id.0.as_str()).collect();
    assert!(!bl_ids.contains(&"nota1"));
}
