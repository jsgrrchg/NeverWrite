# Copyright & Licenses

Copyright © 2024–2026 VaultAI Contributors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---

## Third-Party Dependencies

VaultAI is built upon open-source software. Below is a summary of the licenses
governing our direct and transitive dependencies, grouped by license type.

### License Summary
| License              | Scope                                                    |
| -------------------- | -------------------------------------------------------- |
| MIT                  | Majority of frontend and backend dependencies            |
| Apache-2.0           | TypeScript, pdfjs-dist, Tauri (dual), agent-client-protocol |
| MIT OR Apache-2.0    | Most Rust crates (serde, tokio, regex, etc.)             |
| MPL-2.0              | cssparser, selectors, spellbook                          |
| Unicode-3.0          | ICU libraries (icu_*, zerovec, yoke, litemap)            |
| ISC                  | ring (partial), rustls-webpki, libloading                |
| BSD-3-Clause         | subtle, alloc-no-stdlib, brotli (dual)                   |
| Zlib                 | foldhash, tinyvec, dispatch2                             |
| CC0-1.0              | notify                                                   |
| Unlicense OR MIT     | aho-corasick, memchr, walkdir, byteorder                 |

No GPL or strong-copyleft dependencies are used in this project.

---

## Frontend Dependencies (npm)

### Core Framework

| Package                        | License            |
| ------------------------------ | ------------------ |
| react, react-dom               | MIT                |
| zustand                        | MIT                |
| tailwindcss, @tailwindcss/vite | MIT                |
| vite, @vitejs/plugin-react     | MIT                |
| typescript                     | Apache-2.0         |

### Tauri

| Package                        | License               |
| ------------------------------ | --------------------- |
| @tauri-apps/api                | Apache-2.0 OR MIT     |
| @tauri-apps/cli                | Apache-2.0 OR MIT     |
| @tauri-apps/plugin-dialog      | MIT OR Apache-2.0     |
| @tauri-apps/plugin-opener      | MIT OR Apache-2.0     |

### Editor (CodeMirror 6)

| Package                        | License |
| ------------------------------ | ------- |
| @codemirror/commands           | MIT     |
| @codemirror/lang-markdown      | MIT     |
| @codemirror/lang-javascript    | MIT     |
| @codemirror/lang-python        | MIT     |
| @codemirror/lang-rust          | MIT     |
| @codemirror/lang-css           | MIT     |
| @codemirror/lang-html          | MIT     |
| @codemirror/lang-json          | MIT     |
| @codemirror/lang-yaml          | MIT     |
| @codemirror/lang-java          | MIT     |
| @codemirror/lang-cpp           | MIT     |
| @codemirror/lang-php           | MIT     |
| @codemirror/lang-sql           | MIT     |
| @codemirror/language           | MIT     |
| @codemirror/legacy-modes       | MIT     |
| @codemirror/merge              | MIT     |
| @codemirror/search             | MIT     |
| @codemirror/state              | MIT     |
| @codemirror/view               | MIT     |
| @codemirror/theme-one-dark     | MIT     |

### Features

| Package                        | License     |
| ------------------------------ | ----------- |
| @excalidraw/excalidraw         | MIT         |
| @xterm/xterm                   | MIT         |
| @xterm/addon-fit               | MIT         |
| @xterm/addon-search            | MIT         |
| @xterm/addon-web-links         | MIT         |
| katex                          | MIT         |
| pdfjs-dist                     | Apache-2.0  |
| react-force-graph-2d           | MIT         |
| react-force-graph-3d           | MIT         |
| @chenglou/pretext              | MIT         |

### Dev Dependencies

| Package                              | License     |
| ------------------------------------ | ----------- |
| eslint                               | MIT         |
| eslint-plugin-react-hooks            | MIT         |
| eslint-plugin-react-refresh          | MIT         |
| typescript-eslint                    | MIT         |
| vitest                               | MIT         |
| jsdom                                | MIT         |
| @testing-library/react              | MIT         |
| @testing-library/jest-dom           | MIT         |
| @testing-library/user-event         | MIT         |

---

## Web Clipper Dependencies (npm)

| Package          | License |
| ---------------- | ------- |
| defuddle         | MIT     |
| dompurify        | MIT     |
| react-markdown   | MIT     |
| remark-gfm       | MIT     |
| wxt              | MIT     |

---

## Backend Dependencies (Rust crates)

### Core

| Crate                      | License               |
| -------------------------- | --------------------- |
| tauri                      | Apache-2.0 OR MIT     |
| tauri-build                | Apache-2.0 OR MIT     |
| tauri-plugin-dialog        | Apache-2.0 OR MIT     |
| tauri-plugin-opener        | Apache-2.0 OR MIT     |
| serde, serde_json          | MIT OR Apache-2.0     |
| tokio                      | MIT                   |
| tokio-util                 | MIT                   |
| async-trait                | MIT OR Apache-2.0     |
| reqwest                    | MIT OR Apache-2.0     |

### Vault & Index

| Crate          | License               |
| -------------- | --------------------- |
| walkdir        | Unlicense OR MIT      |
| notify         | CC0-1.0               |
| regex          | MIT OR Apache-2.0     |
| thiserror      | MIT OR Apache-2.0     |
| serde_yaml     | MIT OR Apache-2.0     |
| pdf-extract    | Apache-2.0            |

### Diff

| Crate          | License           |
| -------------- | ----------------- |
| imara-diff     | Apache-2.0        |
| wasm-bindgen   | MIT OR Apache-2.0 |

### Security & Crypto

| Crate              | License                        |
| ------------------ | ------------------------------ |
| keyring            | MIT OR Apache-2.0              |
| sha2               | MIT OR Apache-2.0              |
| ring               | Apache-2.0 AND ISC             |
| rustls             | MIT OR Apache-2.0 AND ISC      |
| aws-lc-rs          | ISC AND (Apache-2.0 OR ISC)   |

### Platform (macOS)

| Crate                  | License                     |
| ---------------------- | --------------------------- |
| objc2                  | MIT                         |
| objc2-app-kit          | Zlib OR Apache-2.0 OR MIT  |
| objc2-foundation       | Zlib OR Apache-2.0 OR MIT  |

### Terminal

| Crate          | License |
| -------------- | ------- |
| portable-pty   | MIT     |

### HTTP

| Crate          | License           |
| -------------- | ----------------- |
| tiny_http      | MIT OR Apache-2.0 |
| base64         | MIT OR Apache-2.0 |

### Internationalization (Unicode)

| Crate               | License     |
| -------------------- | ----------- |
| icu_collections      | Unicode-3.0 |
| icu_locale_core      | Unicode-3.0 |
| icu_normalizer       | Unicode-3.0 |
| icu_properties       | Unicode-3.0 |
| zerovec              | Unicode-3.0 |
| yoke                 | Unicode-3.0 |
| litemap              | Unicode-3.0 |

### CSS Parsing (MPL-2.0)

| Crate           | License |
| --------------- | ------- |
| cssparser        | MPL-2.0 |
| selectors        | MPL-2.0 |
| spellbook        | MPL-2.0 |

> **Note:** MPL-2.0 is a weak copyleft license. Modifications to these specific
> files must be released under MPL-2.0, but this does not affect the rest of
> the codebase.

---

## Vendored Dependencies

| Package                          | License     | Source                                  |
| -------------------------------- | ----------- | --------------------------------------- |
| codex-acp                        | Apache-2.0  | github.com/zed-industries/codex         |
| Claude-agent-acp-upstream        | Apache-2.0  | Anthropic                               |
| @anthropic-ai/claude-agent-sdk   | Apache-2.0  | Anthropic                               |
| @agentclientprotocol/sdk         | Apache-2.0  | Agent Client Protocol                   |

---

## Modified Vendored Code

The following vendored packages have been modified by VaultAI contributors.
As required by the Apache-2.0 license, modifications are documented below.

### `vendor/codex-acp` — Zed Industries (Apache-2.0)

Original source: https://github.com/zed-industries/codex

| File                  | Nature of changes                                              |
| --------------------- | -------------------------------------------------------------- |
| `src/thread.rs`       | Extended to support AI review flow, multi-vault sessions, and custom diff streaming |
| `src/codex_agent.rs`  | Adapted for Agent Client Protocol 0.10.0 compatibility        |

### `vendor/Claude-agent-acp-upstream` — Anthropic (Apache-2.0)

| File                  | Nature of changes                                              |
| --------------------- | -------------------------------------------------------------- |
| `src/acp-agent.ts`    | Extended with model relabeling, custom tool handling, and integration with VaultAI's agent orchestration |

> All original copyright notices and license headers have been preserved.
> The full text of the Apache-2.0 license is available at
> https://www.apache.org/licenses/LICENSE-2.0

---

## License Compliance Notes

1. **MIT** — Requires preserving copyright notices in distributed copies.
2. **Apache-2.0** — Requires preserving copyright notices, stating changes made,
   and including the full license text in distributed copies.
3. **MPL-2.0** — Modifications to MPL-licensed files must be shared under MPL-2.0.
   Does not apply to files that merely use these libraries.
4. **Unicode-3.0** — Requires preserving copyright notices. Permissive.
5. **ISC** — Functionally equivalent to MIT. Requires preserving copyright notices.
6. **CC0-1.0** — Public domain dedication. No restrictions.
7. **Zlib** — Permissive. Requires preserving copyright notices; modified versions
   must be marked as such.

---

*This file is auto-generated from project dependency metadata. Last updated: 2026-03-30.*
