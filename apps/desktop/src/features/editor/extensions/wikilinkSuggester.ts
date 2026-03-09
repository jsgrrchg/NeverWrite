import type { EditorState } from "@codemirror/state";

type NoteLike = {
    id: string;
    title: string;
    path: string;
};

export type WikilinkContext = {
    wholeFrom: number;
    wholeTo: number;
    query: string;
};

export type WikilinkSuggestionItem = {
    id: string;
    title: string;
    subtitle: string;
    insertText: string;
};

function normalizeTarget(value: string): string {
    return value
        .replace(/\.md$/i, "")
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, "...")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getNoteInsertText(note: NoteLike) {
    return note.title?.trim() || note.id.split("/").pop()?.replace(/\.md$/i, "") || note.id;
}

function getLastSegment(note: NoteLike) {
    return note.id.split("/").pop()?.replace(/\.md$/i, "") || note.id;
}

export function getWikilinkContext(state: EditorState): WikilinkContext | null {
    if (state.selection.ranges.length !== 1) return null;

    const selection = state.selection.main;
    if (!selection.empty) return null;

    const pos = selection.from;
    const line = state.doc.lineAt(pos);
    const offset = pos - line.from;
    const before = line.text.slice(0, offset);
    const after = line.text.slice(offset);

    const openIndex = before.lastIndexOf("[[");
    if (openIndex === -1) return null;

    const closeBeforeIndex = before.lastIndexOf("]]");
    if (closeBeforeIndex > openIndex) return null;

    const closeAfterIndex = after.indexOf("]]");
    if (closeAfterIndex === -1) return null;

    const wholeFrom = line.from + openIndex;
    const wholeTo = pos + closeAfterIndex + 2;
    const query = state.sliceDoc(wholeFrom + 2, wholeTo - 2);

    if (/[#^|]/.test(query)) return null;

    return {
        wholeFrom,
        wholeTo,
        query,
    };
}

export function getWikilinkSuggestions(
    notes: NoteLike[],
    query: string,
    limit = 8,
): WikilinkSuggestionItem[] {
    const normalizedQuery = normalizeTarget(query);

    const ranked = notes
        .map((note) => {
            const insertText = getNoteInsertText(note);
            const title = insertText;
            const normalizedTitle = normalizeTarget(title);
            const lastSegment = getLastSegment(note);
            const normalizedLastSegment = normalizeTarget(lastSegment);

            let rank = Number.POSITIVE_INFINITY;

            if (!normalizedQuery) {
                rank = 1000;
            } else if (normalizedTitle.startsWith(normalizedQuery)) {
                rank = 0;
            } else if (normalizedLastSegment.startsWith(normalizedQuery)) {
                rank = 1;
            } else if (normalizedTitle.includes(normalizedQuery)) {
                rank = 2;
            } else if (normalizedLastSegment.includes(normalizedQuery)) {
                rank = 3;
            }

            return {
                id: note.id,
                title,
                subtitle: note.path,
                insertText,
                rank,
            };
        })
        .filter((item) => Number.isFinite(item.rank))
        .sort((left, right) => {
            if (left.rank !== right.rank) return left.rank - right.rank;
            return left.title.localeCompare(right.title, undefined, {
                sensitivity: "base",
            });
        });

    return ranked.slice(0, limit).map(({ id, title, subtitle, insertText }) => ({
        id,
        title,
        subtitle,
        insertText,
    }));
}
