# Ethics

NeverWrite is built as a human-centric knowledge workspace. AI can assist,
suggest, transform, and accelerate work, but the user must remain the final
authority over their own vault. This principle is not a temporary product
detail; it is a core design constraint.

The most important expression of that constraint is NeverWrite's change-control
layer. As new ACP providers are added, and as existing providers change their
runtime behavior, NeverWrite will continue to prioritize reviewable file edits:
no hidden writes, no silent mutation of user content, and no provider integration
that bypasses the user's ability to inspect, accept, or reject changes.

NeverWrite is also file-centric. User knowledge should not be trapped inside an
opaque service, database, or proprietary workspace. Users should be able to take
their files with them, inspect them directly, back them up with their own tools,
and decide which external services, if any, may receive their content.

NeverWrite is and will remain open source under the terms required by the
Apache-2.0 license. NeverWrite contributors strongly believe this should be the
standard way to distribute personal knowledge applications, because the
information users keep in their vaults is often private, sensitive, and
irreplaceable. Users deserve software whose behavior can be inspected, audited,
and improved in public.

Last updated: May 11, 2026.
