import type { VaultChangeOrigin, VaultNoteChange } from "../store/vaultStore";

export type VaultChangeSyncStrategy =
    | "ignore"
    | "apply-note-change-and-refresh-entries"
    | "refresh-entries"
    | "refresh-structure";

const LIVE_FILESYSTEM_ORIGINS = new Set<VaultChangeOrigin>([
    "agent",
    "external",
    "unknown",
]);

export function getVaultChangeSyncStrategy(
    change: VaultNoteChange,
): VaultChangeSyncStrategy {
    if (!LIVE_FILESYSTEM_ORIGINS.has(change.origin)) {
        return "ignore";
    }

    if (isSpecificNoteChange(change)) {
        return "apply-note-change-and-refresh-entries";
    }

    if (isNonFolderEntryUpsert(change)) {
        return "refresh-entries";
    }

    return "refresh-structure";
}

function isSpecificNoteChange(change: VaultNoteChange) {
    if (change.kind === "upsert") {
        return Boolean(change.note?.id);
    }

    // Delete events can be ambiguous because the backend infers note_id from
    // the removed path suffix; a deleted folder named "Archive.md" looks like a
    // note delete after the filesystem entry is gone.
    return false;
}

function isNonFolderEntryUpsert(change: VaultNoteChange) {
    return (
        change.kind === "upsert" &&
        Boolean(change.entry) &&
        (change.entry?.kind === "file" || change.entry?.kind === "pdf")
    );
}
