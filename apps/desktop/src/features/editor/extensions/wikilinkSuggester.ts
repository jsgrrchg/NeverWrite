import type { EditorState } from "@codemirror/state";
import { useVaultStore } from "../../../app/store/vaultStore";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import { LruCache } from "../lruCache";

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

type WikilinkSuggestionDto = {
    id: string;
    title: string;
    subtitle: string;
    insert_text: string;
};

export const MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES = 256;

const suggestionCache = new LruCache<string, WikilinkSuggestionItem[]>(
    MAX_WIKILINK_SUGGESTION_CACHE_ENTRIES,
);

let cachedVaultPath: string | null = null;
let cachedResolverRevision: number | null = null;

function ensureFreshSuggestionCache() {
    const { vaultPath, resolverRevision } = useVaultStore.getState();
    if (
        cachedVaultPath === vaultPath &&
        cachedResolverRevision === resolverRevision
    ) {
        return resolverRevision;
    }

    suggestionCache.clear();
    cachedVaultPath = vaultPath;
    cachedResolverRevision = resolverRevision;
    return resolverRevision;
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

export async function getWikilinkSuggestions(
    noteId: string,
    query: string,
    limit = 8,
): Promise<WikilinkSuggestionItem[]> {
    const resolverRevision = ensureFreshSuggestionCache();
    const cacheKey = `${resolverRevision}\u0000${noteId}\u0000${limit}\u0000${query}`;
    const cached = suggestionCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const suggestions = await vaultInvoke<WikilinkSuggestionDto[]>(
        "suggest_wikilinks",
        {
            noteId,
            query,
            limit,
        },
    );

    const items = suggestions.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        insertText: item.insert_text,
    }));
    suggestionCache.set(cacheKey, items);
    return items;
}
