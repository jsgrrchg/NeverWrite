## NeverWrite Phase 5

This document records the clean-cut completion of the technical rebrand.

### Final policy

- NeverWrite is the only canonical technical identity in the product.
- Local persistence, app identity, deep links, headers, metadata, env vars, and release docs use a single naming convention.
- New code and documentation use the canonical NeverWrite names only. Retired aliases are not part of the documented contract.

### What changed

- Desktop, Electron, frontend persistence helpers, and web clipper contracts now operate only with `neverwrite*` naming.
- Runtime and build overrides are documented with `NEVERWRITE_*` environment variables.
- App support paths, hidden state directories, storage keys, and file-preview schemes now use the canonical NeverWrite names only.
- ACP metadata, diff metadata, status identifiers, and user-input payload prefixes now use the canonical NeverWrite contract end to end.
- Workspace crate/package identifiers and related imports were renamed to the NeverWrite namespace.
- Release/appcast examples, workflow expectations, and test fixtures now point to the NeverWrite repository and Pages topology.

### Validation

- Desktop Rust build/test surface
- Desktop frontend tests
- Web clipper compile + tests
- Repo-wide eradication audit for retired technical naming.

### Notes

- Historical local development state that still lives under retired hidden directories is intentionally outside the runtime contract and can be discarded manually.
