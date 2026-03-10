# Árbol del Proyecto VaultAI

```
VaultAI/
├── CLAUDE.md                          # Instrucciones para Claude Code
├── AGENTS.md                          # Config para agentes AI
├── Cargo.toml                         # Workspace Rust (monorepo)
│
├── apps/desktop/                      # ── APP PRINCIPAL (Tauri + React) ──
│   ├── package.json                   # Dependencias npm del frontend
│   ├── index.html                     # Entry point HTML para Vite
│   ├── vite.config.ts                 # Config de Vite (bundler)
│   ├── eslint.config.js               # Reglas de linting
│   ├── tsconfig.json                  # Config base TypeScript
│   │
│   ├── src-tauri/                     # ── BACKEND RUST (Tauri) ──
│   │   ├── Cargo.toml                 # Dependencias del backend
│   │   ├── tauri.conf.json            # Config Tauri (ventana, plugins, permisos)
│   │   ├── build.rs                   # Build script (sidecar codex-acp)
│   │   ├── capabilities/default.json  # Permisos de la app Tauri
│   │   ├── binaries/codex-acp         # Binario sidecar del agente AI
│   │   └── src/
│   │       ├── main.rs                # Entry point Rust
│   │       ├── lib.rs                 # Setup Tauri: registra comandos, macro lock!, helpers DTO
│   │       └── ai/                    # ── Módulo AI backend ──
│   │           ├── mod.rs             # Re-exports del módulo
│   │           ├── manager.rs         # AiSessionManager: ciclo de vida de sesiones AI
│   │           ├── commands.rs        # Comandos Tauri expuestos al frontend (send_message, etc.)
│   │           ├── persistence.rs     # Guardar/cargar historial de chat en disco
│   │           ├── emit.rs            # Emitir eventos Tauri al frontend
│   │           └── codex/             # ── Integración OpenAI Codex ──
│   │               ├── mod.rs         # Re-exports
│   │               ├── client.rs      # Cliente ACP: comunicación con proceso codex
│   │               ├── process.rs     # Spawn/kill del proceso sidecar codex-acp
│   │               └── setup.rs       # Config inicial del agente Codex
│   │
│   └── src/                           # ── FRONTEND REACT ──
│       ├── main.tsx                   # Entry point React (monta <App/>)
│       ├── App.tsx                    # Componente raíz: layout + providers
│       ├── index.css                  # CSS global: variables, dark mode, estilos base
│       │
│       ├── app/                       # ── Infraestructura de la app ──
│       │   ├── detachedWindows.ts     # Lógica para ventanas desprendidas
│       │   ├── hooks/
│       │   │   └── useVirtualList.ts  # Hook para listas virtualizadas
│       │   ├── store/                 # ── Stores Zustand ──
│       │   │   ├── editorStore.ts     # Estado del editor: tabs, nota activa, EditorState por tab
│       │   │   ├── vaultStore.ts      # Estado del vault: notas, búsqueda, backlinks
│       │   │   ├── themeStore.ts      # Tema claro/oscuro + tema de color
│       │   │   ├── layoutStore.ts     # Estado de paneles: sidebar, right panel, widths
│       │   │   └── settingsStore.ts   # Preferencias del usuario
│       │   ├── themes/                # ── Temas de color ──
│       │   │   ├── index.ts           # Registry de temas disponibles
│       │   │   ├── default.ts         # Tema por defecto
│       │   │   ├── nord.ts            # Tema Nord
│       │   │   ├── catppuccin.ts      # Tema Catppuccin
│       │   │   ├── gruvbox.ts         # Tema Gruvbox
│       │   │   ├── tokyoNight.ts      # Tema Tokyo Night
│       │   │   ├── solarized.ts       # Tema Solarized
│       │   │   ├── ocean.ts           # Tema Ocean
│       │   │   ├── forest.ts          # Tema Forest
│       │   │   ├── rose.ts            # Tema Rose
│       │   │   ├── lavender.ts        # Tema Lavender
│       │   │   ├── amber.ts           # Tema Amber
│       │   │   └── sunset.ts          # Tema Sunset
│       │   └── utils/
│       │       ├── wikilinks.ts       # Parser de [[wikilinks]] compartido
│       │       ├── navigation.ts      # Helpers de navegación entre notas
│       │       └── menuPosition.ts    # Posicionamiento de menús contextuales
│       │
│       ├── components/                # ── Componentes compartidos ──
│       │   ├── context-menu/
│       │   │   └── ContextMenu.tsx    # Menú contextual genérico
│       │   └── layout/
│       │       ├── AppLayout.tsx       # Layout 3 paneles resizables (sidebar | editor | right)
│       │       ├── ActivityBar.tsx     # Barra lateral izquierda con íconos de navegación
│       │       └── StatusBar.tsx       # Barra inferior de estado
│       │
│       ├── features/                  # ── Features por dominio ──
│       │   ├── vault/                 # ── Gestión del vault ──
│       │   │   ├── FileTree.tsx       # Árbol de archivos con drag & drop
│       │   │   ├── VaultSwitcher.tsx   # Selector de vaults
│       │   │   └── fileTreeMoves.ts   # Lógica de mover archivos/carpetas
│       │   │
│       │   ├── editor/                # ── Editor Markdown (CodeMirror 6) ──
│       │   │   ├── Editor.tsx         # Componente principal: monta CodeMirror
│       │   │   ├── EditorHeader.tsx    # Cabecera del editor (breadcrumb)
│       │   │   ├── UnifiedBar.tsx      # Barra superior: tabs + controles del editor
│       │   │   ├── FloatingSelectionToolbar.tsx # Toolbar flotante al seleccionar texto
│       │   │   ├── FrontmatterPanel.tsx        # Panel para editar frontmatter YAML
│       │   │   ├── WikilinkSuggester.tsx       # Autocomplete de [[wikilinks]]
│       │   │   ├── LinkContextMenu.tsx          # Menú contextual para links
│       │   │   ├── editorExtensions.ts          # Configuración de extensiones CodeMirror
│       │   │   ├── editorSelectionHelpers.ts    # Helpers para selección de texto
│       │   │   ├── selectionTransforms.ts       # Transformaciones (bold, italic, etc.)
│       │   │   ├── markdownLists.ts             # Lógica de listas markdown (enter, indent)
│       │   │   ├── noteTitleHelpers.ts          # Helpers para título de nota
│       │   │   ├── tabStrip.ts                  # Lógica de la barra de tabs
│       │   │   ├── useTabDragReorder.ts         # Hook para reordenar tabs con drag
│       │   │   ├── wikilinkNavigation.ts        # Navegación al hacer click en wikilink
│       │   │   ├── wikilinkResolution.ts        # Resolver wikilink → nota
│       │   │   ├── youtube.ts                   # Embed de videos YouTube
│       │   │   └── extensions/                  # ── Extensiones CodeMirror ──
│       │   │       ├── livePreview.ts           # Orquestador: tooltip, clicks, registro de extensiones
│       │   │       ├── livePreviewInline.ts     # ViewPlugin inline: bold, italic, code, links, blockquotes, callouts, footnotes, tasks
│       │   │       ├── livePreviewBlocks.ts     # StateFields: imágenes, tablas, code blocks, math, embeds
│       │   │       ├── livePreviewHelpers.ts    # Helpers: link resolution, linkReferenceField, utilidades
│       │   │       ├── livePreviewTheme.ts      # Estilos CSS: live preview, tooltips, embeds, blockquotes
│       │   │       ├── markdownAutopair.ts      # Auto-cerrar pares MD (**, __)
│       │   │       ├── searchTheme.ts           # Estilos del search & replace
│       │   │       ├── selectionActivity.ts     # Detectar actividad de selección
│       │   │       ├── urlLinks.ts              # Links URL clickables
│       │   │       ├── wikilinks.ts             # Extensión wikilinks en CodeMirror
│       │   │       └── wikilinkSuggester.ts     # Extensión autocomplete wikilinks
│       │   │
│       │   ├── ai/                    # ── Chat AI ──
│       │   │   ├── AIChatPanel.tsx     # Panel principal del chat AI
│       │   │   ├── api.ts             # Capa de comunicación con backend AI
│       │   │   ├── types.ts           # Tipos TypeScript del módulo AI
│       │   │   ├── composerParts.ts   # Lógica de partes del composer (texto, notas)
│       │   │   ├── dragEvents.ts      # Drag & drop de notas al chat
│       │   │   ├── mockData.ts        # Datos mock para desarrollo
│       │   │   ├── sessionPresentation.ts # Formateo/presentación de sesiones
│       │   │   ├── store/
│       │   │   │   └── chatStore.ts    # Store Zustand del chat AI
│       │   │   └── components/
│       │   │       ├── AIChatHeader.tsx         # Header del panel AI
│       │   │       ├── AIChatComposer.tsx       # Input de mensajes
│       │   │       ├── AIChatMessageList.tsx    # Lista de mensajes
│       │   │       ├── AIChatMessageItem.tsx    # Mensaje individual (user/assistant)
│       │   │       ├── AIChatSessionList.tsx    # Lista de sesiones/historial
│       │   │       ├── AIChatContextBar.tsx     # Barra de contexto (notas adjuntas)
│       │   │       ├── AIChatMentionPicker.tsx  # Picker de @menciones de notas
│       │   │       ├── AIChatNotePicker.tsx     # Picker para seleccionar notas
│       │   │       ├── AIChatCommandPicker.tsx  # Picker de /comandos
│       │   │       ├── AIChatAgentControls.tsx  # Controles del agente (stop, status)
│       │   │       ├── AIChatOnboardingCard.tsx # Card de bienvenida/setup
│       │   │       ├── AIChatRuntimeBanner.tsx  # Banner de estado del runtime
│       │   │       └── MarkdownContent.tsx      # Renderizar markdown en mensajes
│       │   │
│       │   ├── notes/                 # ── Panel de notas/links ──
│       │   │   ├── LinksPanel.tsx      # Panel derecho: backlinks + outgoing links
│       │   │   ├── BacklinksPanel.tsx  # Panel de backlinks (legacy)
│       │   │   └── OutlinePanel.tsx    # Panel de outline/tabla de contenidos
│       │   │
│       │   ├── command-palette/       # ── Command Palette (Cmd+K) ──
│       │   │   ├── CommandPalette.tsx  # UI del command palette
│       │   │   └── store/
│       │   │       └── commandStore.ts # Store de comandos registrados
│       │   │
│       │   ├── quick-switcher/        # ── Quick Switcher (Cmd+O) ──
│       │   │   └── QuickSwitcher.tsx   # Búsqueda rápida de notas
│       │   │
│       │   ├── search/                # ── Búsqueda global ──
│       │   │   └── SearchPanel.tsx     # Panel de búsqueda en vault
│       │   │
│       │   ├── tags/                  # ── Tags ──
│       │   │   └── TagsPanel.tsx       # Panel de exploración por tags
│       │   │
│       │   └── settings/              # ── Configuración ──
│       │       ├── SettingsPanel.tsx   # Panel de settings (tema, API key, etc.)
│       │       └── index.ts           # Re-export
│       │
│       └── test/                      # ── Test infrastructure ──
│           ├── setup.ts               # Setup global de Vitest (mocks Tauri)
│           └── test-utils.tsx         # Utilities para tests (render helpers)
│
├── crates/                            # ── CRATES RUST (lógica de dominio) ──
│   ├── types/                         # Tipos compartidos
│   │   └── src/
│   │       ├── lib.rs                 # Re-exports
│   │       ├── domain.rs              # Note, NoteId, Tag — modelos de dominio
│   │       └── dto.rs                 # NoteDto, NoteDetailDto — DTOs para el frontend
│   │
│   ├── vault/                         # Operaciones sobre el vault (filesystem)
│   │   └── src/
│   │       ├── lib.rs                 # Re-exports
│   │       ├── vault.rs              # Vault: abrir, listar, CRUD de notas
│   │       ├── note.rs               # Leer/escribir archivos .md
│   │       ├── watcher.rs            # File watcher (hot-reload cambios externos)
│   │       ├── error.rs              # Tipos de error del vault
│   │       └── parser/
│   │           ├── mod.rs             # Re-exports del parser
│   │           ├── frontmatter.rs     # Parser de YAML frontmatter
│   │           ├── wikilinks.rs       # Parser de [[wikilinks]]
│   │           └── tags.rs            # Parser de #tags
│   │
│   ├── index/                         # Índice de búsqueda
│   │   └── src/
│   │       ├── lib.rs                 # Re-exports
│   │       ├── index.rs              # Índice invertido para búsqueda full-text
│   │       ├── search.rs             # Motor de búsqueda con ranking
│   │       └── resolve.rs            # Resolver wikilinks a notas
│   │
│   ├── state/                         # Estado global de la app (Rust)
│   │   └── src/
│   │       └── lib.rs                 # AppState: Mutex<Vault> + Mutex<Index>
│   │
│   ├── ai/                            # Dominio AI
│   │   └── src/
│   │       ├── lib.rs                 # Re-exports
│   │       └── domain.rs             # Tipos del dominio AI (ChatMessage, Session)
│   │
│   └── diff/                          # Diff de texto (futuro)
│       └── src/
│           └── lib.rs                 # Placeholder para diff overlay
│
└── vendor/codex-acp/                  # ── VENDOR: OpenAI Codex ACP (fork) ──
    └── src/
        ├── main.rs                    # Entry point del proceso sidecar
        ├── lib.rs                     # Re-exports
        ├── codex_agent.rs             # Lógica del agente Codex
        ├── local_spawner.rs           # Spawner local de subprocesos
        ├── prompt_args.rs             # Parsing de argumentos del prompt
        ├── thread.rs                  # Manejo de threads de conversación
        └── prompt_for_init_command.md # Prompt template inicial
```

## Resumen por capa

- **`crates/`** — Lógica de dominio pura en Rust: tipos, vault (CRUD archivos), índice de búsqueda, estado global, AI
- **`src-tauri/`** — Bridge Tauri: expone los crates como comandos al frontend + gestión del proceso AI (Codex sidecar)
- **`src/`** — Frontend React: stores (Zustand), editor (CodeMirror 6), chat AI, file tree, paneles de navegación
- **`vendor/codex-acp/`** — Fork del agente Codex de OpenAI, corre como proceso sidecar
