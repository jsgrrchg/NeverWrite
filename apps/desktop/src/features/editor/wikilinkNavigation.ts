import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { openVaultFileEntry } from "../../app/utils/vaultEntries";
import { findWikilinkResource } from "./wikilinkResolution";

export async function navigateWikilink(target: string) {
    const resource = await findWikilinkResource(target);
    if (resource?.kind === "note") {
        const { tabs, openNote } = useEditorStore.getState();
        const existing = tabs.find(
            (t): t is NoteTab => isNoteTab(t) && t.noteId === resource.id,
        );
        if (existing) {
            openNote(resource.id, resource.title ?? target, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: resource.id,
            });
            useEditorStore
                .getState()
                .openNote(
                    resource.id,
                    resource.title ?? target,
                    detail.content,
                );
        } catch (e) {
            console.error("Error reading linked note:", e);
        }
    } else if (resource?.kind === "file") {
        const entry =
            useVaultStore
                .getState()
                .entries.find(
                    (candidate) =>
                        candidate.kind === "file" &&
                        candidate.relative_path === resource.relativePath,
                ) ?? null;
        if (entry) {
            await openVaultFileEntry(entry);
        }
    } else {
        // Broken link: create the note
        const { createNote } = useVaultStore.getState();
        const created = await createNote(target);
        if (created) {
            useEditorStore.getState().openNote(created.id, created.title, "");
        }
    }
}

export async function openWikilinkInNewTab(target: string) {
    const resource = await findWikilinkResource(target);
    if (!resource) return;

    if (resource.kind === "file") {
        const entry =
            useVaultStore
                .getState()
                .entries.find(
                    (candidate) =>
                        candidate.kind === "file" &&
                        candidate.relative_path === resource.relativePath,
                ) ?? null;
        if (entry) {
            await openVaultFileEntry(entry, { newTab: true });
        }
        return;
    }

    const { tabs, insertExternalTab } = useEditorStore.getState();
    const existing = tabs.find(
        (tab): tab is NoteTab => isNoteTab(tab) && tab.noteId === resource.id,
    );

    if (existing) {
        insertExternalTab({
            id: crypto.randomUUID(),
            noteId: resource.id,
            title: resource.title ?? target,
            content: existing.content,
        });
        return;
    }

    try {
        const detail = await vaultInvoke<{ content: string }>("read_note", {
            noteId: resource.id,
        });
        useEditorStore.getState().insertExternalTab({
            id: crypto.randomUUID(),
            noteId: resource.id,
            title: resource.title ?? target,
            content: detail.content,
        });
    } catch (error) {
        console.error("Error opening linked note in new tab:", error);
    }
}

export function resolveRelativeNotePath(
    baseNoteId: string | null,
    href: string,
): string {
    const cleanedHref = href.replace(/\\/g, "/");
    const segments = cleanedHref.startsWith("/")
        ? []
        : (baseNoteId?.split("/").slice(0, -1) ?? []);

    for (const segment of cleanedHref.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
            if (segments.length > 0) segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments.join("/");
}

export function getNoteLinkTarget(href: string): string | null {
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
    if (trimmed.startsWith("//")) return null;

    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        decoded = trimmed;
    }

    const normalizedTarget = decoded.split(/[?#]/, 1)[0].trim();

    if (!normalizedTarget) return null;

    const activeTabId = useEditorStore.getState().activeTabId;
    const activeTab = useEditorStore
        .getState()
        .tabs.find((tab) => tab.id === activeTabId);
    const activeNoteId =
        activeTab && isNoteTab(activeTab) ? activeTab.noteId : null;

    const resolvedPath = resolveRelativeNotePath(
        activeNoteId,
        normalizedTarget,
    );
    const directTarget = normalizedTarget.replace(/^\/+/, "");
    return resolvedPath || directTarget || normalizedTarget;
}
