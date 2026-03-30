import type { EditorState } from "@codemirror/state";
import { useVaultStore } from "../../../app/store/vaultStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { isTextLikeVaultEntry } from "../../../app/utils/vaultEntries";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import { LruCache } from "../lruCache";

export type WikilinkContext = {
    wholeFrom: number;
    wholeTo: number;
    query: string;
};

export type WikilinkSuggestionItem = {
    id: string;
    kind: "note" | "file";
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

function normalizeForSearch(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function getFileSuggestions(
    query: string,
    limit: number,
): WikilinkSuggestionItem[] {
    const normalizedQuery = normalizeForSearch(query);

    return useVaultStore
        .getState()
        .entries.filter(
            (entry) => entry.kind === "file" && isTextLikeVaultEntry(entry),
        )
        .map((entry) => {
            const normalizedFileName = normalizeForSearch(entry.file_name);
            const normalizedPath = normalizeForSearch(entry.relative_path);
            const rank = !normalizedQuery
                ? 100
                : normalizedFileName.startsWith(normalizedQuery)
                  ? 0
                  : normalizedPath.startsWith(normalizedQuery)
                    ? 1
                    : normalizedFileName.includes(normalizedQuery)
                      ? 2
                      : normalizedPath.includes(normalizedQuery)
                        ? 3
                        : Number.POSITIVE_INFINITY;

            return {
                id: entry.id,
                kind: "file" as const,
                title: entry.file_name,
                subtitle: entry.relative_path,
                insertText: `/${entry.relative_path}`,
                rank,
            };
        })
        .filter((item) => Number.isFinite(item.rank))
        .sort((left, right) => {
            if (left.rank !== right.rank) {
                return left.rank - right.rank;
            }

            return left.subtitle.localeCompare(right.subtitle);
        })
        .slice(0, limit)
        .map(({ rank: _rank, ...item }) => item);
}

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
    const preferFileName =
        useSettingsStore.getState().fileTreeContentMode === "all_files";
    const cacheKey = `${resolverRevision}\u0000${noteId}\u0000${limit}\u0000${Number(preferFileName)}\u0000${query}`;
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
            preferFileName,
        },
    );

    const items = suggestions.map((item) => ({
        id: item.id,
        kind: "note" as const,
        title: item.title,
        subtitle: item.subtitle,
        insertText: item.insert_text,
    }));

    const merged = preferFileName
        ? [...items, ...getFileSuggestions(query, limit)]
              .map((item) => {
                  const normalizedTitle = normalizeForSearch(item.title);
                  const normalizedSubtitle = normalizeForSearch(item.subtitle);
                  const normalizedBaseName = normalizeForSearch(
                      item.subtitle.split("/").pop() ?? item.title,
                  );
                  const rank = !query
                      ? 100
                      : normalizedBaseName.startsWith(normalizeForSearch(query))
                        ? 0
                        : normalizedSubtitle.startsWith(
                                normalizeForSearch(query),
                            )
                          ? 1
                          : normalizedBaseName.includes(
                                  normalizeForSearch(query),
                              )
                            ? 2
                            : normalizedSubtitle.includes(
                                    normalizeForSearch(query),
                                )
                              ? 3
                              : normalizedTitle.includes(
                                      normalizeForSearch(query),
                                  )
                                ? 4
                                : 5;

                  return { item, rank };
              })
              .sort((left, right) => {
                  if (left.rank !== right.rank) {
                      return left.rank - right.rank;
                  }

                  return left.item.subtitle.localeCompare(right.item.subtitle);
              })
              .slice(0, limit)
              .map(({ item }) => item)
        : items;

    suggestionCache.set(cacheKey, merged);
    return merged;
}
