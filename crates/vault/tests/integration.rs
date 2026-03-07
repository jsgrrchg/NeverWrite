use std::fs;
use tempfile::TempDir;
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
fn path_to_id_conversions() {
    let (_dir, vault) = setup_vault();
    let id = vault.path_to_id(&vault.root.join("carpeta/nota3.md"));
    assert_eq!(id, "carpeta/nota3");

    let path = vault.id_to_path("carpeta/nota3");
    assert!(path.ends_with("carpeta/nota3.md"));
}
