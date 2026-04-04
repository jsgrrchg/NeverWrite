use std::path::PathBuf;

use vault_ai_index::VaultIndex;
use vault_ai_types::{NoteDocument, NoteId, NotePath, PdfDocument, TextRange, WikiLink};

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

// --- Build tests ---

#[test]
fn build_index_has_all_notes() {
    let index = build_sample_index();
    assert_eq!(index.metadata.len(), 4);
}

#[test]
fn names_map_built_correctly() {
    let index = build_sample_index();
    // "nota1" appears twice (nota1 and carpeta/nota1).
    let nota1_entries = index.names.get("nota1").unwrap();
    assert_eq!(nota1_entries.len(), 2);

    let nota3_entries = index.names.get("nota3").unwrap();
    assert_eq!(nota3_entries.len(), 1);
}

// --- Backlink tests ---

#[test]
fn backlinks_a_to_b() {
    let index = build_sample_index();
    // nota1 links to nota2 -> nota2 has a backlink from nota1.
    let backlinks = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota1"));
    // carpeta/nota1 also links to nota2.
    assert!(bl_ids.contains(&"carpeta/nota1"));
}

#[test]
fn backlinks_bidirectional() {
    let index = build_sample_index();
    // nota2 links to nota1 -> nota1 has a backlink from nota2.
    let backlinks = index.get_backlinks(&NoteId("nota1".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota2"));
}

#[test]
fn backlinks_with_path() {
    let index = build_sample_index();
    // nota2 links to carpeta/nota3 -> carpeta/nota3 has a backlink from nota2.
    let backlinks = index.get_backlinks(&NoteId("carpeta/nota3".into()));
    let bl_ids: Vec<&str> = backlinks.iter().map(|id| id.0.as_str()).collect();
    assert!(bl_ids.contains(&"nota2"));
}

// --- Forward link tests ---

#[test]
fn forward_links() {
    let index = build_sample_index();
    let fwd = index.get_forward_links(&NoteId("nota2".into()));
    let fwd_ids: Vec<&str> = fwd.iter().map(|id| id.0.as_str()).collect();
    assert!(fwd_ids.contains(&"nota1"));
    assert!(fwd_ids.contains(&"carpeta/nota3"));
}

// --- Tag tests ---

#[test]
fn tags_index() {
    let index = build_sample_index();
    let rust_notes = index.get_notes_by_tag("rust");
    assert_eq!(rust_notes.len(), 2);

    let web_notes = index.get_notes_by_tag("web");
    assert_eq!(web_notes.len(), 1);
    assert_eq!(web_notes[0].0, "carpeta/nota3");
}

// --- Wikilink resolution tests ---

#[test]
fn resolve_unique_name() {
    let index = build_sample_index();
    // nota3 is unique -> it resolves directly.
    let resolved = index.resolve_wikilink("nota3", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota3".into())));
}

#[test]
fn resolve_ambiguous_by_proximity() {
    let index = build_sample_index();
    // "nota1" is ambiguous (nota1 and carpeta/nota1).
    // From carpeta/nota3, the closest match is carpeta/nota1.
    let resolved = index.resolve_wikilink("nota1", &NoteId("carpeta/nota3".into()));
    assert_eq!(resolved, Some(NoteId("carpeta/nota1".into())));

    // From nota2 (root), the closest match is nota1.
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

    let resolved = index.resolve_wikilink("Donald Trump's Greenland plan", &NoteId("nota1".into()));
    assert_eq!(resolved, Some(NoteId("news/trumps-greenland".into())));
}

#[test]
fn suggest_wikilinks_by_prefix_without_full_scan() {
    let index = VaultIndex::build(vec![
        make_note("refs/rust-book", "Rust Book", vec![], vec![]),
        make_note("refs/rust-belt", "Rust Belt", vec![], vec![]),
        make_note("refs/python", "Python Notes", vec![], vec![]),
        make_note("nota1", "Primera Nota", vec![], vec![]),
    ]);

    let suggestions = index.suggest_wikilinks("rus", &NoteId("nota1".into()), 5, false);
    let ids: Vec<&str> = suggestions.iter().map(|id| id.0.as_str()).collect();

    assert!(ids.contains(&"refs/rust-book"));
    assert!(ids.contains(&"refs/rust-belt"));
    assert!(!ids.contains(&"refs/python"));
}

#[test]
fn suggest_wikilinks_prefers_closest_path_on_ties() {
    let index = VaultIndex::build(vec![
        make_note("work/alpha", "Alpha Note", vec![], vec![]),
        make_note("archive/alpha", "Alpha Note", vec![], vec![]),
        make_note("work/project/current", "Current", vec![], vec![]),
    ]);

    let suggestions =
        index.suggest_wikilinks("alpha", &NoteId("work/project/current".into()), 2, false);
    let ids: Vec<&str> = suggestions.iter().map(|id| id.0.as_str()).collect();

    assert_eq!(ids.first().copied(), Some("work/alpha"));
}

#[test]
fn suggest_wikilinks_empty_query_uses_sorted_order() {
    let index = VaultIndex::build(vec![
        make_note("refs/zulu", "Zulu Note", vec![], vec![]),
        make_note("refs/alpha", "Alpha Note", vec![], vec![]),
        make_note("refs/bravo", "Bravo Note", vec![], vec![]),
        make_note("refs/current", "Current", vec![], vec![]),
    ]);

    let suggestions = index.suggest_wikilinks("", &NoteId("refs/current".into()), 4, false);
    let ids: Vec<&str> = suggestions.iter().map(|id| id.0.as_str()).collect();

    assert_eq!(
        ids,
        vec!["refs/alpha", "refs/bravo", "refs/current", "refs/zulu"]
    );
}

#[test]
fn reindex_updates_empty_query_suggestion_order() {
    let mut index = VaultIndex::build(vec![
        make_note("refs/zulu", "Zulu Note", vec![], vec![]),
        make_note("refs/alpha", "Alpha Note", vec![], vec![]),
        make_note("refs/current", "Current", vec![], vec![]),
    ]);

    index.reindex_note(make_note("refs/zulu", "Able Note", vec![], vec![]));

    let suggestions = index.suggest_wikilinks("", &NoteId("refs/current".into()), 3, false);
    let ids: Vec<&str> = suggestions.iter().map(|id| id.0.as_str()).collect();

    assert_eq!(ids, vec!["refs/zulu", "refs/alpha", "refs/current"]);
}

#[test]
fn suggest_wikilinks_can_prefer_file_name_over_title() {
    let index = VaultIndex::build(vec![
        make_note("docs/invoice-template", "Billing Guide", vec![], vec![]),
        make_note("docs/current", "Current", vec![], vec![]),
    ]);

    let suggestions = index.suggest_wikilinks("invoice", &NoteId("docs/current".into()), 5, true);
    let ids: Vec<&str> = suggestions.iter().map(|id| id.0.as_str()).collect();

    assert_eq!(ids, vec!["docs/invoice-template"]);
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

// --- Search tests ---

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
    // All notes have "Nota" in the title.
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
    // carpeta/nota3 and carpeta/nota1 match by path.
    assert_eq!(results.len(), 2);
}

// --- Reindex tests ---

#[test]
fn reindex_note_updates_index() {
    let mut index = build_sample_index();

    // Change nota1: it now links to carpeta/nota3 instead of nota2.
    let updated = make_note(
        "nota1",
        "Nota Actualizada",
        vec![("carpeta/nota3", None)],
        vec!["nuevo-tag"],
    );
    index.reindex_note(updated);

    // The title changed.
    assert_eq!(
        index.metadata.get(&NoteId("nota1".into())).unwrap().title,
        "Nota Actualizada"
    );

    // Forward links updated.
    let fwd = index.get_forward_links(&NoteId("nota1".into()));
    assert_eq!(fwd.len(), 1);
    assert_eq!(fwd[0].0, "carpeta/nota3");

    // nota2 no longer has a backlink from nota1.
    let bl = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = bl.iter().map(|id| id.0.as_str()).collect();
    assert!(!bl_ids.contains(&"nota1"));

    // The old tag no longer exists for nota1.
    let rust_notes = index.get_notes_by_tag("rust");
    let rust_ids: Vec<&str> = rust_notes.iter().map(|id| id.0.as_str()).collect();
    assert!(!rust_ids.contains(&"nota1"));

    // The new tag does exist.
    let new_tag = index.get_notes_by_tag("nuevo-tag");
    assert_eq!(new_tag.len(), 1);
}

#[test]
fn remove_note_cleans_index() {
    let mut index = build_sample_index();
    index.remove_note(&NoteId("nota1".into()));

    assert_eq!(index.metadata.len(), 3);
    assert!(!index.metadata.contains_key(&NoteId("nota1".into())));

    // nota2 backlinks no longer include nota1.
    let bl = index.get_backlinks(&NoteId("nota2".into()));
    let bl_ids: Vec<&str> = bl.iter().map(|id| id.0.as_str()).collect();
    assert!(!bl_ids.contains(&"nota1"));
}

#[test]
fn reindex_updates_exact_title_and_filename_maps() {
    let mut index = VaultIndex::build(vec![
        make_note("folder/old-name", "Old Title", vec![], vec![]),
        make_note("note", "Current", vec![("Old Title", None)], vec![]),
    ]);

    index.remove_note(&NoteId("folder/old-name".into()));
    index.reindex_note(make_note("folder/new-name", "New Title", vec![], vec![]));

    let resolved_old = index.resolve_wikilink("Old Title", &NoteId("note".into()));
    assert_eq!(resolved_old, None);

    let resolved_new = index.resolve_wikilink("New Title", &NoteId("note".into()));
    assert_eq!(resolved_new, Some(NoteId("folder/new-name".into())));

    let resolved_filename = index.resolve_wikilink("new-name", &NoteId("note".into()));
    assert_eq!(resolved_filename, Some(NoteId("folder/new-name".into())));
}

// --- PDF index tests ---

fn make_pdf(id: &str, title: &str, pages: Vec<&str>) -> PdfDocument {
    PdfDocument {
        id: NoteId(id.to_string()),
        path: NotePath(PathBuf::from(format!("{id}.pdf"))),
        title: title.to_string(),
        page_count: pages.len(),
        extracted_pages: pages.into_iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn register_pdf_adds_to_index() {
    let mut index = build_sample_index();
    let doc = make_pdf("papers/quantum", "Quantum Computing", vec!["Page one text"]);
    index.register_pdf(&doc, 1000, 900, 5000);

    assert!(index
        .pdf_metadata
        .contains_key(&NoteId("papers/quantum".into())));
    assert!(index
        .pdf_search_index
        .contains_key(&NoteId("papers/quantum".into())));

    let meta = &index.pdf_metadata[&NoteId("papers/quantum".into())];
    assert_eq!(meta.title, "Quantum Computing");
    assert_eq!(meta.page_count, 1);
    assert_eq!(meta.modified_at, 1000);
    assert_eq!(meta.size, 5000);
}

#[test]
fn remove_pdf_cleans_index() {
    let mut index = build_sample_index();
    let doc = make_pdf("papers/quantum", "Quantum Computing", vec!["text"]);
    index.register_pdf(&doc, 1000, 900, 5000);

    index.remove_pdf(&NoteId("papers/quantum".into()));

    assert!(!index
        .pdf_metadata
        .contains_key(&NoteId("papers/quantum".into())));
    assert!(!index
        .pdf_search_index
        .contains_key(&NoteId("papers/quantum".into())));
}

#[test]
fn reindex_pdf_updates_metadata() {
    let mut index = build_sample_index();
    let doc = make_pdf("report", "Old Title", vec!["old text"]);
    index.register_pdf(&doc, 1000, 900, 5000);

    let updated = make_pdf("report", "New Title", vec!["new text", "page two"]);
    index.reindex_pdf(&updated, 2000, 900, 8000);

    let meta = &index.pdf_metadata[&NoteId("report".into())];
    assert_eq!(meta.title, "New Title");
    assert_eq!(meta.page_count, 2);
    assert_eq!(meta.modified_at, 2000);
    assert_eq!(meta.size, 8000);
}

#[test]
fn pdf_metadata_empty_by_default() {
    let index = build_sample_index();
    assert!(index.pdf_metadata.is_empty());
    assert!(index.pdf_search_index.is_empty());
}
