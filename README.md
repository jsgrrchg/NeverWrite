# VaultAI

Aplicación de gestión de notas inspirada en Obsidian, construida con Tauri 2, React 19 y TypeScript.

## Stack Técnico

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite
- **Desktop**: Tauri 2
- **Backend**: Rust
- **State Management**: Zustand
- **Editor**: CodeMirror 6

## Requisitos

- Node.js (v18+)
- Rust (para compilar Tauri)
- npm o yarn

## Instalación

```bash
npm install
```

## Desarrollo

```bash
Para ejecutar la aplicación en modo desarrollo:
 npm run tauri dev
```

```bash
npm run tauri dev

```

Este comando inicia simultáneamente:
- El servidor de desarrollo de Vite en `http://localhost:5173`
- La aplicación desktop de Tauri

## Build

Para compilar la aplicación:

```bash
cd apps/desktop
npm run build
```

## Estructura del Proyecto

```
.
├── apps/
│   └── desktop/               # Aplicación principal
│       ├── src/               # Código React
│       └── src-tauri/         # Backend de Tauri
├── crates/                    # Librerías Rust
│   ├── types/                 # Tipos compartidos
│   ├── vault/                 # Lógica del vault
│   ├── index/                 # Indexación
│   ├── diff/                  # Gestión de diffs
│   ├── ai/                    # Integración IA
│   └── state/                 # State management
└── .IDEAS/                    # Documentación del proyecto
```

## Documentación

Consulta `.IDEAS/` para:
- `Visión.md` - Visión del producto
- `Arquitectura.md` - Arquitectura técnica
- `plans/` - Planes de implementación por etapa
