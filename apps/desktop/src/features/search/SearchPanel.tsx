import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useDeferredValue,
} from "react";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useEditorStore } from "../../app/store/editorStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { revealNoteInTree } from "../../app/utils/navigation";
import { useVirtualList } from "../../app/hooks/useVirtualList";

interface SearchResultDto {
    id: string;
    path: string;
    title: string;
    score: number;
}

const DEBOUNCE_MS = 300;
const SEARCH_ROW_HEIGHT = 44;

export function SearchPanel({ autoFocus }: { autoFocus?: boolean }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResultDto[]>([]);
    const [hasSearched, setHasSearched] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<SearchResultDto> | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRequestIdRef = useRef(0);
    const resultsRef = useRef<HTMLDivElement>(null);
    const deferredQuery = useDeferredValue(query);

    const openNote = useEditorStore((s) => s.openNote);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);

    const doSearch = useCallback(async (q: string) => {
        const trimmed = q.trim();
        const requestId = ++searchRequestIdRef.current;
        if (!trimmed) return;
        try {
            const res = await vaultInvoke<SearchResultDto[]>("search_notes", {
                query: trimmed,
            });
            if (requestId !== searchRequestIdRef.current) return;
            setResults(res);
            setHasSearched(true);
        } catch {
            if (requestId !== searchRequestIdRef.current) return;
            setResults([]);
            setHasSearched(true);
        }
    }, []);

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (!deferredQuery.trim()) {
            searchRequestIdRef.current += 1;
            return;
        }
        timerRef.current = setTimeout(
            () => doSearch(deferredQuery),
            DEBOUNCE_MS,
        );
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [deferredQuery, doSearch]);

    useEffect(() => {
        if (autoFocus) inputRef.current?.focus();
    }, [autoFocus]);

    const handleQueryChange = (nextQuery: string) => {
        if (!nextQuery.trim()) {
            searchRequestIdRef.current += 1;
            setResults([]);
            setHasSearched(false);
        }
        setQuery(nextQuery);
    };

    const handleOpen = async (id: string, title: string) => {
        const tabs = useEditorStore.getState().tabs;
        const existing = tabs.find((t) => t.noteId === id);
        if (existing) {
            openNote(id, title, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: id,
            });
            openNote(id, title, detail.content);
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const handleOpenInNewTab = async (result: SearchResultDto) => {
        try {
            const tabs = useEditorStore.getState().tabs;
            const existing = tabs.find((tab) => tab.noteId === result.id);
            const content =
                existing?.content ??
                (
                    await vaultInvoke<{ content: string }>("read_note", {
                        noteId: result.id,
                    })
                ).content;

            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: result.id,
                title: result.title,
                content,
            });
        } catch (error) {
            console.error("Error opening search result in new tab:", error);
        }
    };

    const virtual = useVirtualList(
        resultsRef,
        results.length,
        SEARCH_ROW_HEIGHT,
        8,
    );
    const visibleResults = results.slice(virtual.startIndex, virtual.endIndex);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Search input */}
            <div className="px-3 pt-3 pb-2 flex items-center gap-1.5">
                <div
                    className="flex-1 flex items-center gap-2 px-2 rounded-md"
                    style={{
                        backgroundColor: "var(--bg-primary)",
                        border: "1px solid var(--border)",
                        height: 30,
                    }}
                >
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--text-secondary)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <circle cx="7" cy="7" r="5" />
                        <path d="M11 11l3.5 3.5" />
                    </svg>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search notes..."
                        value={query}
                        onChange={(e) => handleQueryChange(e.target.value)}
                        className="flex-1 bg-transparent text-xs outline-none"
                        style={{ color: "var(--text-primary)" }}
                    />
                    {query && (
                        <button
                            onClick={() => handleQueryChange("")}
                            className="shrink-0 opacity-50 hover:opacity-100"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M4 4l8 8M4 12l8-8" />
                            </svg>
                        </button>
                    )}
                </div>
                <button
                    onClick={() => {
                        const { tabs, insertExternalTab, openNote } = useEditorStore.getState();
                        const existing = tabs.find((t) => t.noteId === "__search__");
                        if (existing) {
                            openNote("__search__", "Search", "");
                        } else {
                            insertExternalTab({
                                id: crypto.randomUUID(),
                                noteId: "__search__",
                                title: "Search",
                                content: "",
                            });
                        }
                    }}
                    title="Open advanced search"
                    className="shrink-0 flex items-center justify-center rounded-md hover:brightness-110"
                    style={{
                        backgroundColor: "var(--bg-primary)",
                        border: "1px solid var(--border)",
                        width: 30,
                        height: 30,
                        color: "var(--text-secondary)",
                    }}
                >
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M14 14l-3-3" />
                        <circle cx="7" cy="7" r="5" />
                        <path d="M5 7h4M7 5v4" />
                    </svg>
                </button>
            </div>

            {/* Results */}
            <div ref={resultsRef} className="flex-1 overflow-y-auto overflow-x-hidden px-1">
                {!query.trim() && (
                    <div
                        className="px-3 py-4 text-xs text-center"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Type to search
                    </div>
                )}

                {query.trim() && hasSearched && results.length === 0 && (
                    <div
                        className="px-3 py-4 text-xs text-center"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No results for &ldquo;{query.trim()}&rdquo;
                    </div>
                )}

                {results.length > 0 && (
                    <div
                        style={{
                            position: "relative",
                            height: virtual.totalHeight,
                        }}
                    >
                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: virtual.offsetTop,
                            }}
                        >
                            {visibleResults.map((r) => (
                                <button
                                    key={r.id}
                                    onClick={() => void handleOpen(r.id, r.title)}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        setContextMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            payload: r,
                                        });
                                    }}
                                    className="w-full text-left px-3 py-1.5 flex flex-col gap-0.5 rounded-sm"
                                    style={{
                                        color: "var(--text-primary)",
                                        minHeight: SEARCH_ROW_HEIGHT,
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.backgroundColor =
                                            "var(--bg-tertiary)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.backgroundColor =
                                            "transparent")
                                    }
                                >
                                    <span className="text-xs truncate">{r.title}</span>
                                    <span
                                        className="text-xs truncate"
                                        style={{
                                            color: "var(--text-secondary)",
                                            fontSize: 10,
                                        }}
                                    >
                                        {r.id}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () =>
                                void handleOpen(
                                    contextMenu.payload.id,
                                    contextMenu.payload.title,
                                ),
                        },
                        {
                            label: "Open in New Tab",
                            action: () =>
                                void handleOpenInNewTab(contextMenu.payload),
                        },
                        { type: "separator" },
                        {
                            label: "Reveal in File Tree",
                            action: () =>
                                revealNoteInTree(contextMenu.payload.id),
                        },
                        {
                            label: "Copy Note Path",
                            action: () =>
                                void navigator.clipboard.writeText(
                                    contextMenu.payload.id,
                                ),
                        },
                    ]}
                />
            )}
        </div>
    );
}
