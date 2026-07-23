# NeverWrite

<p align="center">
  <img width="100%" alt="NeverWrite workspace" src="https://github.com/user-attachments/assets/83968dc3-cfb9-41b5-ad99-bfea4305447b" />
</p>

<p align="center">
  <strong>A local-first workspace for writing and thinking with AI agents.</strong><br />
  Keep your vault, documents, agents, review, and research in the same place.
</p>

<p align="center">
  <a href="https://github.com/jsgrrchg/NeverWrite/issues">Report a bug</a>
  ·
  <a href="https://github.com/jsgrrchg/NeverWrite/discussions">Discuss</a>
  ·
  <a href="LICENSE">Apache-2.0</a>
</p>

## Your knowledge stays local

NeverWrite is an agentic markdown workspace for people who work with a local vaults and multiple AI agents. It combines a Markdown-first editor, knowledge navigation, agent sessions, and explicit change review in one multipane app.

## Built for the whole thinking loop

- **Write in the format that fits.** Edit Markdown, Mermaid, CSV, text/code files, PDFs, images, and Excalidraw concept maps in the same workspace.
- **Navigate connected knowledge.** Follow wikilinks, backlinks, tags, advanced search, bookmarks, and 2D or 3D graph views.
- **Work with your preferred agent.** Run Codex, Claude, GitHub Copilot, Grok, Kilo, or OpenCode sessions with attachments, saved transcripts, and local history.
- **Review AI changes deliberately.** Inspect tracked edits inline, in chat, or in a dedicated review tab, then keep or reject complete files and individual hunks.
- **Capture the web into your vault.** Use the companion browser extension to clip pages, selections, or URLs directly to the desktop app.

## Get started

### Requirements

- Node.js 22.12 or later and npm
- Rust and Cargo
- pnpm 10.33.0 for the web clipper

### Run locally

```bash
git clone https://github.com/jsgrrchg/NeverWrite.git
cd NeverWrite/apps/desktop
npm install
npm run dev
```

Local development runs as **NeverWrite Dev** with its own application profile, so an installed NeverWrite release can remain open at the same time. Files and hidden state inside a vault remain shared when both variants open that vault; use a disposable vault when testing write or review flows concurrently.

The first start builds the native backend. Configure your preferred agent from the app settings; some providers require their own CLI login or API key.

## Development

```bash
cd apps/desktop && npm test
cd apps/web-clipper && pnpm check
cargo test
```

## Star History

<a href="https://www.star-history.com/?repos=jsgrrchg%2FNeverWrite&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jsgrrchg/NeverWrite&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jsgrrchg/NeverWrite&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jsgrrchg/NeverWrite&type=date&legend=top-left" />
  </picture>
</a>

<a href="https://trendshift.io/repositories/27680?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-27680" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/27680/daily?language=TypeScript" alt="jsgrrchg%2FNeverWrite | Trendshift" width="250" height="55" /></a>

## License

NeverWrite is released under the [Apache License 2.0](LICENSE).
