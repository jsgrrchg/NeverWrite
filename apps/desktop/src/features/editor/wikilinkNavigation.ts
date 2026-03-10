import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { findNoteByWikilink } from "./wikilinkResolution";

export function navigateWikilink(target: string) {
    const note = findNoteByWikilink(target);
    if (note) {
        const { tabs, openNote } = useEditorStore.getState();
        const existing = tabs.find((t) => t.noteId === note.id);
        if (existing) {
            openNote(note.id, note.title, existing.content);
            return;
        }
        void invoke<{ content: string }>("read_note", { noteId: note.id })
            .then((detail) => {
                useEditorStore
                    .getState()
                    .openNote(note.id, note.title, detail.content);
            })
            .catch((e) => console.error("Error reading linked note:", e));
    } else {
        // Broken link: create the note
        const { createNote } = useVaultStore.getState();
        void createNote(target).then((created) => {
            if (created) {
                useEditorStore
                    .getState()
                    .openNote(created.id, created.title, "");
            }
        });
    }
}

export function openWikilinkInNewTab(target: string) {
    const note = findNoteByWikilink(target);
    if (!note) return;

    const { tabs, insertExternalTab } = useEditorStore.getState();
    const existing = tabs.find((tab) => tab.noteId === note.id);

    if (existing) {
        insertExternalTab({
            id: crypto.randomUUID(),
            noteId: note.id,
            title: note.title,
            content: existing.content,
        });
        return;
    }

    void invoke<{ content: string }>("read_note", { noteId: note.id })
        .then((detail) => {
            useEditorStore.getState().insertExternalTab({
                id: crypto.randomUUID(),
                noteId: note.id,
                title: note.title,
                content: detail.content,
            });
        })
        .catch((error) =>
            console.error("Error opening linked note in new tab:", error),
        );
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
    const activeNoteId =
        useEditorStore.getState().tabs.find((tab) => tab.id === activeTabId)
            ?.noteId ?? null;

    const resolvedPath = resolveRelativeNotePath(
        activeNoteId,
        normalizedTarget,
    );
    if (resolvedPath && findNoteByWikilink(resolvedPath)) {
        return resolvedPath;
    }

    const directTarget = normalizedTarget.replace(/^\/+/, "");
    if (directTarget && findNoteByWikilink(directTarget)) {
        return directTarget;
    }

    return resolvedPath || directTarget || normalizedTarget;
}
