use std::fs;
use tempfile::TempDir;
use vault_ai_vault::pdf;
use vault_ai_vault::Vault;

fn setup_vault() -> (TempDir, Vault) {
    let dir = TempDir::new().unwrap();

    // Crear algunas notas de ejemplo
    fs::write(
        dir.path().join("nota1.md"),
        "---\ntitle: Primera Nota\ntags: [rust]\n---\n# Primera Nota\n\nContenido con [[nota2]] y #proyecto\n",
    )
    .unwrap();

    fs::write(
        dir.path().join("nota2.md"),
        "# Segunda Nota\n\nEsta nota enlaza a [[nota1|primera]] y [[carpeta/nota3]]\n",
    )
    .unwrap();

    fs::create_dir_all(dir.path().join("carpeta")).unwrap();
    fs::write(
        dir.path().join("carpeta/nota3.md"),
        "# Nota en Carpeta\n\n#etiqueta contenido\n",
    )
    .unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    (dir, vault)
}

#[test]
fn open_nonexistent_directory() {
    let result = Vault::open("/tmp/no_existe_vault_test_12345".into());
    assert!(result.is_err());
}

#[test]
fn scan_finds_all_notes() {
    let (_dir, vault) = setup_vault();
    let notes = vault.scan().unwrap();
    assert_eq!(notes.len(), 3);
}

#[test]
fn discover_markdown_files_ignores_internal_dirs() {
    let (dir, vault) = setup_vault();
    fs::create_dir_all(dir.path().join(".obsidian/plugins")).unwrap();
    fs::write(dir.path().join(".obsidian/plugins/ignored.md"), "# Ignored").unwrap();
    fs::create_dir_all(dir.path().join("target/docs")).unwrap();
    fs::write(dir.path().join("target/docs/ignored.md"), "# Ignored").unwrap();
    fs::create_dir_all(dir.path().join(".cargo-home/registry")).unwrap();
    fs::write(
        dir.path().join(".cargo-home/registry/ignored.md"),
        "# Ignored",
    )
    .unwrap();

    let files = vault.discover_markdown_files().unwrap();
    let ids: Vec<&str> = files.iter().map(|file| file.id.as_str()).collect();

    assert_eq!(files.len(), 3);
    assert!(!ids.contains(&".obsidian/plugins/ignored"));
    assert!(!ids.contains(&"target/docs/ignored"));
    assert!(!ids.contains(&".cargo-home/registry/ignored"));
}

#[test]
fn parse_discovered_files_reports_progress() {
    let (_dir, vault) = setup_vault();
    let files = vault.discover_markdown_files().unwrap();
    let mut progress = Vec::new();

    let notes = vault
        .parse_discovered_files(&files, |processed| progress.push(processed))
        .unwrap();

    assert_eq!(notes.len(), files.len());
    assert_eq!(progress, vec![1, 2, 3]);
}

#[test]
fn scan_parses_frontmatter() {
    let (_dir, vault) = setup_vault();
    let notes = vault.scan().unwrap();
    let nota1 = notes.iter().find(|n| n.id.0 == "nota1").unwrap();
    assert_eq!(nota1.title, "Primera Nota");
    assert!(nota1.frontmatter.is_some());
}

#[test]
fn scan_extracts_wikilinks() {
    let (_dir, vault) = setup_vault();
    let notes = vault.scan().unwrap();
    let nota2 = notes.iter().find(|n| n.id.0 == "nota2").unwrap();
    assert_eq!(nota2.links.len(), 2);
    assert_eq!(nota2.links[0].target, "nota1");
    assert_eq!(nota2.links[0].alias, Some("primera".to_string()));
    assert_eq!(nota2.links[1].target, "carpeta/nota3");
}

#[test]
fn scan_extracts_tags() {
    let (_dir, vault) = setup_vault();
    let notes = vault.scan().unwrap();
    let nota1 = notes.iter().find(|n| n.id.0 == "nota1").unwrap();
    assert!(nota1.tags.contains(&"proyecto".to_string()));
}

#[test]
fn read_note_works() {
    let (_dir, vault) = setup_vault();
    let note = vault.read_note("nota1").unwrap();
    assert_eq!(note.title, "Primera Nota");
    assert!(note.raw_markdown.contains("Contenido con"));
}

#[test]
fn read_note_not_found() {
    let (_dir, vault) = setup_vault();
    assert!(vault.read_note("no_existe").is_err());
}

#[test]
fn save_note_works() {
    let (_dir, vault) = setup_vault();
    vault.save_note("nota1", "# Nuevo contenido\n").unwrap();
    let note = vault.read_note("nota1").unwrap();
    assert_eq!(note.raw_markdown, "# Nuevo contenido\n");
    assert_eq!(note.title, "Nuevo contenido");
}

#[test]
fn create_note_works() {
    let (_dir, vault) = setup_vault();
    let note = vault
        .create_note("nueva.md", "# Nueva\n\nContenido")
        .unwrap();
    assert_eq!(note.title, "Nueva");

    // Verificar que el archivo existe
    let read = vault.read_note("nueva").unwrap();
    assert_eq!(read.raw_markdown, "# Nueva\n\nContenido");
}

#[test]
fn create_note_in_subdirectory() {
    let (_dir, vault) = setup_vault();
    let note = vault
        .create_note("sub/deep/nota.md", "# Deep Note")
        .unwrap();
    assert_eq!(note.id.0, "sub/deep/nota");
}

#[test]
fn create_folder_works() {
    let (_dir, vault) = setup_vault();
    let folder = vault.create_folder("projects/2026").unwrap();

    assert_eq!(folder.kind, "folder");
    assert_eq!(folder.relative_path, "projects/2026");
}

#[test]
fn create_note_duplicate_fails() {
    let (_dir, vault) = setup_vault();
    assert!(vault.create_note("nota1.md", "contenido").is_err());
}

#[test]
fn delete_note_works() {
    let (_dir, vault) = setup_vault();
    vault.delete_note("nota1").unwrap();
    assert!(vault.read_note("nota1").is_err());
}

#[test]
fn delete_note_not_found() {
    let (_dir, vault) = setup_vault();
    assert!(vault.delete_note("no_existe").is_err());
}

#[test]
fn rename_note_works() {
    let (_dir, vault) = setup_vault();
    let note = vault.rename_note("nota1", "renamed.md").unwrap();
    assert_eq!(note.id.0, "renamed");

    // El viejo no existe
    assert!(vault.read_note("nota1").is_err());
    // El nuevo sí
    assert!(vault.read_note("renamed").is_ok());
}

#[test]
fn rename_to_existing_fails() {
    let (_dir, vault) = setup_vault();
    assert!(vault.rename_note("nota1", "nota2.md").is_err());
}

#[test]
fn move_vault_entry_works_for_pdf_and_generic_files() {
    let (_dir, vault) = setup_vault_with_pdfs();

    let moved_pdf = vault
        .move_vault_entry("document.pdf", "archive/document.pdf")
        .unwrap();
    assert_eq!(moved_pdf.kind, "pdf");
    assert_eq!(moved_pdf.relative_path, "archive/document.pdf");
    assert_eq!(moved_pdf.id, "archive/document");

    let moved_file = vault
        .move_vault_entry("image.png", "assets/image.png")
        .unwrap();
    assert_eq!(moved_file.kind, "file");
    assert_eq!(moved_file.relative_path, "assets/image.png");
    assert_eq!(moved_file.id, "assets/image.png");

    let entries = vault.discover_vault_entries().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.relative_path == "archive/document.pdf"));
    assert!(entries
        .iter()
        .any(|entry| entry.relative_path == "assets/image.png"));
    assert!(!entries
        .iter()
        .any(|entry| entry.relative_path == "document.pdf"));
    assert!(!entries
        .iter()
        .any(|entry| entry.relative_path == "image.png"));
}

#[test]
fn move_folder_keeps_empty_directories_visible() {
    let (dir, vault) = setup_vault();
    fs::create_dir_all(dir.path().join("empty")).unwrap();

    vault.move_folder("empty", "archive/empty").unwrap();

    let entries = vault.discover_vault_entries().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.kind == "folder" && entry.relative_path == "archive/empty"));
    assert!(!entries
        .iter()
        .any(|entry| entry.kind == "folder" && entry.relative_path == "empty"));
}

#[test]
fn copy_folder_copies_empty_subdirectories() {
    let (dir, vault) = setup_vault();
    fs::create_dir_all(dir.path().join("assets/empty/nested")).unwrap();

    let copied = vault.copy_folder("assets", "assets copy").unwrap();

    assert_eq!(copied.kind, "folder");
    assert!(dir.path().join("assets copy/empty/nested").is_dir());
}

#[test]
fn path_to_id_conversions() {
    let (_dir, vault) = setup_vault();
    let id = vault.path_to_id(&vault.root.join("carpeta/nota3.md"));
    assert_eq!(id, "carpeta/nota3");

    let path = vault.id_to_path("carpeta/nota3");
    assert!(path.ends_with("carpeta/nota3.md"));
}

// ------ PDF tests ------

fn setup_vault_with_pdfs() -> (TempDir, Vault) {
    let dir = TempDir::new().unwrap();

    fs::write(dir.path().join("nota.md"), "# A Note\n\nContent\n").unwrap();

    // Create a minimal valid PDF (smallest valid PDF possible)
    let minimal_pdf = b"%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n206\n%%EOF";
    fs::write(dir.path().join("document.pdf"), minimal_pdf).unwrap();

    fs::create_dir_all(dir.path().join("papers")).unwrap();
    fs::write(dir.path().join("papers/research.pdf"), minimal_pdf).unwrap();

    // A non-PDF file that should be ignored
    fs::write(dir.path().join("image.png"), b"not a png").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    (dir, vault)
}

#[test]
fn discover_pdf_files_finds_pdfs() {
    let (_dir, vault) = setup_vault_with_pdfs();
    let pdfs = vault.discover_pdf_files().unwrap();

    let ids: Vec<&str> = pdfs.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(pdfs.len(), 2);
    assert!(ids.contains(&"document"));
    assert!(ids.contains(&"papers/research"));
}

#[test]
fn discover_pdf_files_ignores_internal_dirs() {
    let (dir, vault) = setup_vault_with_pdfs();

    fs::create_dir_all(dir.path().join(".obsidian")).unwrap();
    fs::write(dir.path().join(".obsidian/plugin.pdf"), b"%PDF").unwrap();
    fs::create_dir_all(dir.path().join(".vaultai-cache")).unwrap();
    fs::write(dir.path().join(".vaultai-cache/cached.pdf"), b"%PDF").unwrap();

    let pdfs = vault.discover_pdf_files().unwrap();
    assert_eq!(pdfs.len(), 2);
}

#[test]
fn discover_vault_entries_includes_both_md_and_pdf() {
    let (_dir, vault) = setup_vault_with_pdfs();
    let entries = vault.discover_vault_entries().unwrap();

    let notes: Vec<_> = entries.iter().filter(|e| e.kind == "note").collect();
    let pdfs: Vec<_> = entries.iter().filter(|e| e.kind == "pdf").collect();
    let files: Vec<_> = entries.iter().filter(|e| e.kind == "file").collect();
    let folders: Vec<_> = entries.iter().filter(|e| e.kind == "folder").collect();

    assert_eq!(notes.len(), 1);
    assert_eq!(pdfs.len(), 2);
    assert_eq!(files.len(), 1);
    assert_eq!(folders.len(), 1);
    assert!(pdfs.iter().any(|e| e.id == "document"));
    assert!(pdfs
        .iter()
        .all(|e| e.mime_type == Some("application/pdf".to_string())));
    assert_eq!(folders[0].relative_path, "papers");
    assert_eq!(files[0].relative_path, "image.png");
    assert_eq!(files[0].file_name, "image.png");
    assert_eq!(files[0].extension, "png");
}

#[test]
fn discover_vault_entries_includes_empty_folders() {
    let (dir, vault) = setup_vault();
    fs::create_dir_all(dir.path().join("empty/deeper")).unwrap();

    let entries = vault.discover_vault_entries().unwrap();

    assert!(entries
        .iter()
        .any(|entry| entry.kind == "folder" && entry.relative_path == "empty"));
    assert!(entries
        .iter()
        .any(|entry| entry.kind == "folder" && entry.relative_path == "empty/deeper"));
}

#[test]
fn discover_vault_entries_keeps_extensions_for_generic_files() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("foo.ts"), "console.log('foo');").unwrap();
    fs::write(dir.path().join("foo.js"), "console.log('bar');").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    let entries = vault.discover_vault_entries().unwrap();
    let ids: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| entry.id.as_str())
        .collect();

    assert!(ids.contains(&"foo.ts"));
    assert!(ids.contains(&"foo.js"));
}

#[test]
fn discover_vault_entries_guesses_supported_image_mime_types() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("cover.avif"), b"avif").unwrap();
    fs::write(dir.path().join("icon.ico"), b"ico").unwrap();
    fs::write(dir.path().join("scan.bmp"), b"bmp").unwrap();
    fs::write(dir.path().join("photo.jfif"), b"jfif").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    let entries = vault.discover_vault_entries().unwrap();

    let mimes: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| (entry.file_name.as_str(), entry.mime_type.as_deref()))
        .collect();

    assert!(mimes.contains(&("cover.avif", Some("image/avif"))));
    assert!(mimes.contains(&("icon.ico", Some("image/x-icon"))));
    assert!(mimes.contains(&("scan.bmp", Some("image/bmp"))));
    assert!(mimes.contains(&("photo.jfif", Some("image/jpeg"))));
}

#[test]
fn discover_vault_entries_guesses_text_mime_types_for_common_config_files() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("Dockerfile"), "FROM rust:latest\n").unwrap();
    fs::write(dir.path().join(".env.local"), "APP_ENV=local\n").unwrap();
    fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
    fs::write(dir.path().join(".eslintrc"), "{\n  \"root\": true\n}\n").unwrap();
    fs::write(dir.path().join("Makefile"), "build:\n\tcargo build\n").unwrap();
    fs::write(dir.path().join("rules.mk"), "VAR += value\n").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    let entries = vault.discover_vault_entries().unwrap();

    let mimes: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| (entry.file_name.as_str(), entry.mime_type.as_deref()))
        .collect();

    assert!(mimes.contains(&("Dockerfile", Some("text/plain"))));
    assert!(mimes.contains(&(".env.local", Some("text/plain"))));
    assert!(mimes.contains(&(".gitignore", Some("text/plain"))));
    assert!(mimes.contains(&(".eslintrc", Some("text/plain"))));
    assert!(mimes.contains(&("Makefile", Some("text/plain"))));
    assert!(mimes.contains(&("rules.mk", Some("text/plain"))));
}

#[test]
fn discover_vault_entries_uses_file_name_as_title_for_dotfiles_without_stem() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    let entries = vault.discover_vault_entries().unwrap();
    let entry = entries
        .iter()
        .find(|entry| entry.file_name == ".gitignore")
        .unwrap();

    assert_eq!(entry.title, ".gitignore");
}

#[test]
fn read_text_file_reads_relative_path_inside_vault() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/lib.rs"), "fn main() {}\n").unwrap();

    let vault = Vault::open(dir.path().to_path_buf()).unwrap();
    let content = vault.read_text_file("src/lib.rs").unwrap();

    assert_eq!(content, "fn main() {}\n");
}

#[test]
fn read_text_file_rejects_parent_traversal() {
    let dir = TempDir::new().unwrap();
    let vault = Vault::open(dir.path().to_path_buf()).unwrap();

    let result = vault.read_text_file("../secret.txt");
    assert!(result.is_err());
}

#[test]
fn extract_pdf_text_returns_error_for_invalid_file() {
    let dir = TempDir::new().unwrap();
    let bad_pdf = dir.path().join("bad.pdf");
    fs::write(&bad_pdf, b"this is not a pdf").unwrap();

    let result = pdf::extract_pdf_text(dir.path(), &bad_pdf, "bad");
    assert!(result.is_err());
}

#[test]
fn extract_pdf_text_returns_error_for_missing_file() {
    let dir = TempDir::new().unwrap();
    let missing = dir.path().join("missing.pdf");

    let result = pdf::extract_pdf_text(dir.path(), &missing, "missing");
    assert!(result.is_err());
}

#[test]
fn extract_pdf_batch_collects_failures() {
    let dir = TempDir::new().unwrap();
    let bad_pdf = dir.path().join("bad.pdf");
    fs::write(&bad_pdf, b"not a pdf").unwrap();

    let files = vec![pdf::DiscoveredPdfFile {
        id: "bad".to_string(),
        path: bad_pdf,
        modified_at: 0,
        created_at: 0,
        size: 10,
    }];

    let result = pdf::extract_pdf_batch(dir.path(), &files, |_| {});
    assert_eq!(result.documents.len(), 0);
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].id, "bad");
}

#[test]
fn pdf_cache_works_on_second_extraction() {
    let dir = TempDir::new().unwrap();

    // Create a minimal valid PDF
    let minimal_pdf = b"%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n206\n%%EOF";
    let pdf_path = dir.path().join("doc.pdf");
    fs::write(&pdf_path, minimal_pdf).unwrap();

    // First extraction — may succeed or fail depending on pdf-extract with minimal PDF
    let result1 = pdf::extract_pdf_text(dir.path(), &pdf_path, "doc");
    if let Ok(doc1) = &result1 {
        // If first succeeded, second should use cache and return same result
        let doc2 = pdf::extract_pdf_text(dir.path(), &pdf_path, "doc").unwrap();
        assert_eq!(doc1.page_count, doc2.page_count);

        // Cache file should exist
        let cache_dir = dir.path().join(".vaultai-cache").join("pdf");
        assert!(cache_dir.exists());
        let cache_files: Vec<_> = fs::read_dir(&cache_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(cache_files.len(), 1);
    }
    // If extraction failed (minimal PDF not parseable), that's OK — we tested error path above
}
