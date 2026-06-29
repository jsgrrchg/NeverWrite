import {
    useEditorStore,
    isNoteTab,
    selectEditorWorkspaceTabs,
} from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";

// Shared source of truth for rendering a short preview of a note's content.
// Both the inline `![[embed]]` widget and the wikilink hover preview read a
// note's content (cached, with async fetch) and render a few markdown lines to
// a safe DocumentFragment. Keeping the reader + renderer here avoids
// duplicating cache and markdown-to-DOM logic across the two call sites.

const NOTE_PREVIEW_CACHE_LIMIT = 64;

const notePreviewContentCache = new Map<string, string>();
const notePreviewRequestCache = new Map<string, Promise<string | null>>();

function rememberNotePreviewContent(noteId: string, content: string) {
    if (notePreviewContentCache.has(noteId)) {
        notePreviewContentCache.delete(noteId);
    }
    notePreviewContentCache.set(noteId, content);

    while (notePreviewContentCache.size > NOTE_PREVIEW_CACHE_LIMIT) {
        const oldestKey = notePreviewContentCache.keys().next().value;
        if (oldestKey === undefined) break;
        notePreviewContentCache.delete(oldestKey);
    }
}

export function invalidateNotePreviewCache(noteId: string | null | undefined) {
    if (!noteId) return;
    notePreviewContentCache.delete(noteId);
    notePreviewRequestCache.delete(noteId);
}

export async function loadNotePreviewContent(noteId: string) {
    const cached = notePreviewContentCache.get(noteId);
    if (cached !== undefined) return cached;

    const pending = notePreviewRequestCache.get(noteId);
    if (pending) return pending;

    const request = vaultInvoke<{ content: string }>("read_note", { noteId })
        .then((detail) => {
            rememberNotePreviewContent(noteId, detail.content);
            notePreviewRequestCache.delete(noteId);
            return detail.content;
        })
        .catch(() => {
            notePreviewRequestCache.delete(noteId);
            return null;
        });

    notePreviewRequestCache.set(noteId, request);
    return request;
}

export interface PreviewNote {
    id: string;
    title: string;
    path: string;
}

/** Resolve a wikilink target to a note entry in the current vault, if any. */
export function findPreviewNote(target: string): PreviewNote | null {
    const note = useVaultStore
        .getState()
        .notes.find(
            (entry) =>
                entry.id === target ||
                entry.title === target ||
                entry.id.replace(/\.md$/i, "") === target,
        );
    return note
        ? { id: note.id, title: note.title, path: note.path }
        : null;
}

export interface NotePreviewContentState {
    /** Content available synchronously (open tab or warm cache), else null. */
    content: string | null;
    /** Loader for async fetch when no synchronous content is available. */
    load: (() => Promise<string | null>) | null;
}

/**
 * Resolve a note's content for previewing. Prefers a live open-tab buffer,
 * then a warm cache, and otherwise exposes an async loader. Mirrors the
 * embed widget's original openTab → cache → fetch ordering.
 */
export function getNotePreviewContentState(
    note: PreviewNote | null,
    target: string,
): NotePreviewContentState {
    const openTab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (tab) =>
            (isNoteTab(tab) && tab.noteId === note?.id) ||
            (isNoteTab(tab) && tab.noteId === target) ||
            tab.title === target,
    );

    const fullContent =
        openTab && isNoteTab(openTab) ? openTab.content : null;
    if (fullContent !== null) {
        if (note?.id) {
            rememberNotePreviewContent(note.id, fullContent);
        }
        return { content: fullContent, load: null };
    }

    const cachedContent = note?.id
        ? (notePreviewContentCache.get(note.id) ?? null)
        : null;
    if (cachedContent !== null) {
        return { content: cachedContent, load: null };
    }

    const noteId = note?.id ?? null;
    return {
        content: null,
        load: noteId ? () => loadNotePreviewContent(noteId) : null,
    };
}

/**
 * Append inline-formatted text to a parent element using DOM nodes (no
 * innerHTML). Handles **bold**, *italic*, `code`, and [[wikilinks|label]].
 */
export function appendFormattedInline(parent: HTMLElement, text: string): void {
    const re =
        /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[\[([^\]|]+?)(?:\|([^\]]+))?\]\])/g;
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
            parent.appendChild(
                document.createTextNode(text.slice(last, m.index)),
            );
        }
        if (m[2]) {
            const el = document.createElement("strong");
            el.textContent = m[2];
            parent.appendChild(el);
        } else if (m[3]) {
            const el = document.createElement("em");
            el.textContent = m[3];
            parent.appendChild(el);
        } else if (m[4]) {
            const el = document.createElement("code");
            el.textContent = m[4];
            parent.appendChild(el);
        } else if (m[5]) {
            const el = document.createElement("span");
            el.className = "cm-note-embed-wikilink";
            el.textContent = m[6] ?? m[5];
            parent.appendChild(el);
        }
        last = m.index + m[0].length;
    }

    if (last < text.length) {
        parent.appendChild(document.createTextNode(text.slice(last)));
    }
}

/** Render a few lines of markdown content into a DocumentFragment (safe DOM). */
export function renderEmbedPreview(
    text: string,
    maxLines: number,
): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const lines = text
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, maxLines);

    for (const line of lines) {
        const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (hMatch) {
            const div = document.createElement("div");
            div.className = `cm-note-embed-h${hMatch[1].length}`;
            appendFormattedInline(div, hMatch[2]);
            fragment.appendChild(div);
            continue;
        }

        const liMatch = line.match(/^\s*[-*+]\s+(.+)$/);
        if (liMatch) {
            const div = document.createElement("div");
            div.className = "cm-note-embed-li";
            appendFormattedInline(div, liMatch[1]);
            fragment.appendChild(div);
            continue;
        }

        const div = document.createElement("div");
        appendFormattedInline(div, line);
        fragment.appendChild(div);
    }

    return fragment;
}

/**
 * Extract content under a specific heading until the next heading of the same
 * or higher level.
 */
export function extractSection(content: string, heading: string): string {
    const lines = content.split("\n");
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "i");
    const startIdx = lines.findIndex((l) => headingRe.test(l));
    if (startIdx < 0) return "";

    const level = lines[startIdx].match(/^(#+)/)?.[1].length ?? 1;
    let endIdx = startIdx + 1;
    while (endIdx < lines.length) {
        const lm = lines[endIdx].match(/^(#+)\s/);
        if (lm && lm[1].length <= level) break;
        endIdx++;
    }

    return lines.slice(startIdx, endIdx).join("\n");
}
