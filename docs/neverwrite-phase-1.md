# NeverWrite Phase 1 Canonical Naming

This document records the Phase 1 rebrand baseline for the product rename from `VaultAI` to `NeverWrite`.

## Canonical product naming

- Public product brand: `NeverWrite`
- Previous public brand to retire: `VaultAI`
- Domain term that stays: `vault`

Examples that remain valid:

- `Open vault`
- `Recent vaults`
- `VaultSwitcher`
- `vaultStore`
- `crates/vault`

## Phase 1 scope applied now

Phase 1 changes the visible product identity and public distribution naming:

- Desktop window titles, menus, onboarding, settings, and AI copy use `NeverWrite`
- Web clipper titles, labels, and user-facing desktop API messaging use `NeverWrite`
- Tauri `productName` is now `NeverWrite`
- Release titles and public installer names use `NeverWrite`
- Main repository docs now describe the product as `NeverWrite`

Phase 1 does not do a blind global rename of technical identifiers.

## Target technical identity for later phases

These are the intended technical targets once compatibility work is scheduled:

- Bundle identifier: `com.neverwrite`
- Deep-link scheme: `neverwrite://`
- Internal product directories: `.neverwrite` and `.neverwrite-cache`
- Storage prefixes: `neverwrite:*`
- Product env vars: `NEVERWRITE_*`
- Public integration headers and protocol branding: `NeverWrite` / `neverwrite`

## Temporary compatibility policy

Until the technical migration is executed, the app may continue reading legacy `VaultAI`-branded identifiers where they are part of local persistence or runtime contracts.

The practical rule for Phase 1 is:

- Write visible branding as `NeverWrite`
- Keep `vault` domain terminology intact
- Defer legacy technical identifiers when they affect persistence, IPC, runtime metadata, extension pairing, or updater compatibility

## Deferred Phase 2 migration debt

The following legacy identifiers remain intentionally deferred after Phase 1:

- Bundle identifiers such as `com.vaultai` and `com.vaultai.dev`
- Deep-link scheme and related runtime handling based on `vaultai://`
- Local folders such as `.vaultai` and `.vaultai-cache`
- Persisted browser/local storage keys prefixed with `vaultai:`
- Event names prefixed with `vaultai:`
- Environment variables prefixed with `VAULTAI_`
- Web clipper headers such as `X-VaultAI-*`
- Extension IDs and pairing identifiers tied to the current integration contract
- ACP metadata keys and event identifiers that still encode `vaultai`
- Crate, package, and workspace identifiers such as `vault-ai-*`

These identifiers should be migrated only with an explicit read/migrate/write plan and targeted validation.
