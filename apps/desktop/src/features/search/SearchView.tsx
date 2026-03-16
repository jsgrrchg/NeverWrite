import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { parseQuery } from "./queryParser";
import { toAdvancedSearchParams } from "./queryToParams";
import { QueryBuilder, Dropdown, type DropdownOption } from "./QueryBuilder";
import {
    getSearchHistory,
    addToSearchHistory,
    removeFromSearchHistory,
    clearSearchHistory,
} from "./searchHistory";
import { openVaultFileEntry } from "../../app/utils/vaultEntries";

interface ContentMatchDto {
    line_number: number;
    line_content: string;
    match_start: number;
    match_end: number;
    page?: number;
}

interface AdvancedSearchResultDto {
    id: string;
    path: string;
    title: string;
    kind?: string;
    score: number;
    tags: string[];
    modified_at: number;
    matches: ContentMatchDto[];
}

const DEBOUNCE_MS = 300;

type SortBy = "relevance" | "title" | "modified";

type SortOption = `${SortBy}:${"asc" | "desc"}`;

const SORT_OPTIONS: DropdownOption<SortOption>[] = [
    { value: "relevance:desc", label: "Relevance" },
    { value: "title:asc", label: "Title A-Z" },
    { value: "title:desc", label: "Title Z-A" },
    { value: "modified:desc", label: "Newest first" },
    { value: "modified:asc", label: "Oldest first" },
];

const OPERATORS = [
    { label: "file:", desc: "filename" },
    { label: "path:", desc: "file path" },
    { label: "tag:", desc: "note tag" },
    { label: "content:", desc: "note body" },
    { label: "line:", desc: "same line" },
    { label: "section:", desc: "heading section" },
    { label: "[status:]", desc: "property filter (e.g. [status:active])", insert: "[status:]" },
] as const;

export function SearchView() {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<AdvancedSearchResultDto[]>([]);
    const [hasSearched, setHasSearched] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [sortBy, setSortBy] = useState<SortBy>("relevance");
    const [sortAsc, setSortAsc] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [showBuilder, setShowBuilder] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRequestIdRef = useRef(0);

    const openNote = useEditorStore((s) => s.openNote);
    const openPdf = useEditorStore((s) => s.openPdf);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const entries = useVaultStore((s) => s.entries);
    const showExtensions = useSettingsStore((s) => s.fileTreeShowExtensions);

    const parsed = useMemo(() => parseQuery(query), [query]);

    useEffect(() => {
        inputRef.current?.focus();
        setHistory(getSearchHistory());
    }, []);

    const doSearch = useCallback(
        async (q: string, sort: SortBy, asc: boolean) => {
            const trimmed = q.trim();
            const requestId = ++searchRequestIdRef.current;
            if (!trimmed) return;

            setIsSearching(true);
            try {
                const p = parseQuery(trimmed);
                const params = toAdvancedSearchParams(p, sort, asc);
                const res = await vaultInvoke<AdvancedSearchResultDto[]>(
                    "advanced_search",
                    { params },
                );
                if (requestId !== searchRequestIdRef.current) return;
                setResults(res);
                setHasSearched(true);
                addToSearchHistory(trimmed);
                setHistory(getSearchHistory());
            } catch {
                if (requestId !== searchRequestIdRef.current) return;
                setResults([]);
                setHasSearched(true);
            } finally {
                if (requestId === searchRequestIdRef.current) {
                    setIsSearching(false);
                }
            }
        },
        [],
    );

    useEffect(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (!query.trim()) {
            searchRequestIdRef.current += 1;
            return;
        }
        timerRef.current = setTimeout(
            () => doSearch(query, sortBy, sortAsc),
            DEBOUNCE_MS,
        );
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [query, sortBy, sortAsc, doSearch]);

    const handleQueryChange = (next: string) => {
        if (!next.trim()) {
            searchRequestIdRef.current += 1;
            setResults([]);
            setHasSearched(false);
        }
        setQuery(next);
    };

    const handleOpen = async (result: AdvancedSearchResultDto) => {
        if (result.kind === "pdf") {
            openPdf(result.id, result.title, result.path);
            return;
        }
        if (result.kind === "file") {
            const entry = entries.find((item) => item.path === result.path);
            if (!entry) return;
            await openVaultFileEntry(entry);
            return;
        }
        const tabs = useEditorStore.getState().tabs;
        const existing = tabs.find(
            (t): t is NoteTab => isNoteTab(t) && t.noteId === result.id,
        );
        if (existing) {
            openNote(result.id, result.title, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: result.id,
            });
            openNote(result.id, result.title, detail.content);
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const handleOpenInNewTab = async (result: AdvancedSearchResultDto) => {
        if (result.kind === "pdf") {
            openPdf(result.id, result.title, result.path);
            return;
        }
        if (result.kind === "file") {
            const entry = entries.find((item) => item.path === result.path);
            if (!entry) return;
            await openVaultFileEntry(entry, { newTab: true });
            return;
        }
        try {
            const tabs = useEditorStore.getState().tabs;
            const existing = tabs.find(
                (t): t is NoteTab => isNoteTab(t) && t.noteId === result.id,
            );
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
        } catch (e) {
            console.error("Error opening in new tab:", e);
        }
    };

    const handleInsertOperator = (op: string) => {
        const input = inputRef.current;
        if (!input) return;
        const start = input.selectionStart ?? query.length;
        const before = query.slice(0, start);
        const after = query.slice(start);
        const needsSpace = before.length > 0 && !before.endsWith(" ");
        const newQuery = `${before}${needsSpace ? " " : ""}${op}${after}`;
        setQuery(newQuery);
        requestAnimationFrame(() => {
            const cursor = before.length + (needsSpace ? 1 : 0) + op.length;
            input.focus();
            input.setSelectionRange(cursor, cursor);
        });
    };

    const handleCopyResults = () => {
        const text = results
            .map((r) =>
                r.kind === "file" || r.kind === "pdf"
                    ? `- ${r.path}`
                    : `- [[${r.title}]] — ${r.id}`,
            )
            .join("\n");
        void navigator.clipboard.writeText(text);
    };

    const formatDate = (ts: number) => {
        if (!ts) return "";
        const d = new Date(ts * 1000);
        return d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    };

    return (
        <div
            className="h-full w-full overflow-auto"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            <div className="w-full max-w-2xl mx-auto px-6 py-6">
                {/* Header */}
                <div className="mb-4">
                    <h1
                        className="text-lg font-semibold"
                        style={{ color: "var(--text-primary)" }}
                    >
                        Advanced Search
                    </h1>
                </div>

                {/* Search input */}
                <div
                    className="flex items-center gap-3 px-3 rounded-lg"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        height: 38,
                    }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--text-secondary)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="M10.5 10.5L14 14" />
                    </svg>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search files and notes... (e.g. tag:project content:react)"
                        value={query}
                        onChange={(e) => handleQueryChange(e.target.value)}
                        className="flex-1 bg-transparent text-[13px] outline-none"
                        style={{ color: "var(--text-primary)" }}
                        spellCheck={false}
                    />
                    {isSearching && (
                        <div
                            className="shrink-0 w-3 h-3 rounded-full animate-pulse"
                            style={{ backgroundColor: "var(--accent)" }}
                        />
                    )}
                    {query && !isSearching && (
                        <button
                            onClick={() => handleQueryChange("")}
                            className="shrink-0 opacity-50 hover:opacity-100"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M4 4l8 8M4 12l8-8" />
                            </svg>
                        </button>
                    )}
                    <button
                        onClick={() => setShowBuilder((v) => !v)}
                        title="Toggle query builder"
                        className="shrink-0 p-0.5 rounded transition-colors"
                        style={{
                            color: showBuilder ? "var(--accent)" : "var(--text-secondary)",
                            opacity: showBuilder ? 1 : 0.5,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.opacity = showBuilder ? "1" : "0.5")
                        }
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M2 4h12M4 8h8M6 12h4" />
                        </svg>
                    </button>
                </div>

                {/* Explain banner */}
                {parsed.explanation && query.trim() && (
                    <div
                        className="mt-2 px-3 py-1.5 rounded text-[11px] flex items-center gap-1.5"
                        style={{
                            backgroundColor: "var(--bg-tertiary)",
                            color: "var(--text-secondary)",
                        }}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="shrink-0"
                        >
                            <circle cx="8" cy="8" r="6" />
                            <path d="M8 7v4M8 5v.5" />
                        </svg>
                        <span className="truncate">{parsed.explanation}</span>
                    </div>
                )}

                {/* Query Builder panel */}
                {showBuilder && (
                    <div className="mt-3">
                        <QueryBuilder
                            query={query}
                            onQueryChange={handleQueryChange}
                        />
                    </div>
                )}

                {/* Operator chips */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                    {OPERATORS.map((op) => (
                        <button
                            key={op.label}
                            onClick={() => handleInsertOperator("insert" in op ? op.insert : op.label)}
                            className="px-2 py-0.5 rounded text-[11px] transition-colors"
                            style={{
                                backgroundColor: "var(--bg-secondary)",
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border)",
                            }}
                            onMouseEnter={(e) =>
                                (e.currentTarget.style.borderColor =
                                    "var(--accent)")
                            }
                            onMouseLeave={(e) =>
                                (e.currentTarget.style.borderColor =
                                    "var(--border)")
                            }
                            title={op.desc}
                        >
                            {op.label}
                        </button>
                    ))}
                    <span
                        className="px-1 py-0.5 text-[10px]"
                        style={{ color: "var(--text-secondary)", opacity: 0.6 }}
                    >
                        OR &middot; -exclude &middot;
                        &quot;exact phrase&quot; &middot; /regex/
                    </span>
                </div>

                {/* Toolbar */}
                {hasSearched && query.trim() && (
                    <div
                        className="flex items-center justify-between mt-4 mb-2 px-1"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        <span className="text-[11px]">
                            {results.length} result
                            {results.length !== 1 ? "s" : ""}
                        </span>
                        <div className="flex items-center gap-2">
                            <Dropdown
                                value={`${sortBy}:${sortAsc ? "asc" : "desc"}` as SortOption}
                                options={SORT_OPTIONS}
                                onChange={(v) => {
                                    const [s, o] = v.split(":");
                                    setSortBy(s as SortBy);
                                    setSortAsc(o === "asc");
                                }}
                            />
                            {results.length > 0 && (
                                <button
                                    onClick={handleCopyResults}
                                    title="Copy results as markdown"
                                    className="p-1 rounded opacity-60 hover:opacity-100"
                                >
                                    <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <rect
                                            x="5"
                                            y="5"
                                            width="9"
                                            height="9"
                                            rx="1"
                                        />
                                        <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Empty state with history */}
                {!query.trim() && (
                    <div className="mt-6">
                        {history.length > 0 ? (
                            <div>
                                <div
                                    className="flex items-center justify-between mb-2"
                                    style={{
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    <span className="text-[11px] uppercase tracking-wider">
                                        Recent searches
                                    </span>
                                    <button
                                        onClick={() => {
                                            clearSearchHistory();
                                            setHistory([]);
                                        }}
                                        className="text-[10px] opacity-50 hover:opacity-100"
                                    >
                                        Clear
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {history.map((h) => (
                                        <button
                                            key={h}
                                            onClick={() => setQuery(h)}
                                            className="group flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] transition-colors"
                                            style={{
                                                backgroundColor:
                                                    "var(--bg-secondary)",
                                                color: "var(--text-secondary)",
                                                border: "1px solid var(--border)",
                                            }}
                                            onMouseEnter={(e) =>
                                                (e.currentTarget.style.backgroundColor =
                                                    "var(--bg-tertiary)")
                                            }
                                            onMouseLeave={(e) =>
                                                (e.currentTarget.style.backgroundColor =
                                                    "var(--bg-secondary)")
                                            }
                                        >
                                            <span className="truncate max-w-[200px]">
                                                {h}
                                            </span>
                                            <span
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    removeFromSearchHistory(h);
                                                    setHistory(
                                                        getSearchHistory(),
                                                    );
                                                }}
                                                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 ml-0.5"
                                            >
                                                <svg
                                                    width="10"
                                                    height="10"
                                                    viewBox="0 0 16 16"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <path d="M4 4l8 8M4 12l8-8" />
                                                </svg>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div
                                className="text-[13px] text-center py-8"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Use operators to search across your vault
                            </div>
                        )}
                    </div>
                )}

                {/* No results */}
                {query.trim() && hasSearched && results.length === 0 && (
                    <div
                        className="text-[13px] text-center py-8"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No results for &ldquo;{query.trim()}&rdquo;
                    </div>
                )}

                {/* Results */}
                {results.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {results.map((r) => (
                            <div
                                key={r.id}
                                className="group rounded-lg overflow-hidden"
                                style={{
                                    border: "1px solid var(--border)",
                                }}
                            >
                                {/* Result header */}
                                <div
                                    className="flex items-start"
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.backgroundColor =
                                            "var(--bg-tertiary)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.backgroundColor =
                                            "var(--bg-secondary)")
                                    }
                                >
                                    <button
                                        onClick={() =>
                                            void handleOpen(r)
                                        }
                                        onAuxClick={(event) => {
                                            if (event.button !== 1) return;
                                            event.preventDefault();
                                            event.stopPropagation();
                                            void handleOpenInNewTab(r);
                                        }}
                                        className="flex-1 text-left px-3 py-2 min-w-0"
                                    >
                                        <div className="flex items-center gap-2">
                                            {r.kind === "pdf" && (
                                                <svg
                                                    width="14"
                                                    height="14"
                                                    viewBox="0 0 16 16"
                                                    fill="none"
                                                    stroke="var(--accent)"
                                                    strokeWidth="1.5"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    className="shrink-0"
                                                >
                                                    <path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
                                                    <path d="M10 1v4h4" />
                                                    <text x="4.5" y="12.5" fontSize="5" fill="var(--accent)" stroke="none" fontWeight="bold">PDF</text>
                                                </svg>
                                            )}
                                            {r.kind === "file" && (
                                                <svg
                                                    width="14"
                                                    height="14"
                                                    viewBox="0 0 16 16"
                                                    fill="none"
                                                    stroke="var(--text-secondary)"
                                                    strokeWidth="1.5"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    className="shrink-0"
                                                >
                                                    <path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
                                                    <path d="M10 1v4h4" />
                                                </svg>
                                            )}
                                            <span
                                                className="text-[13px] font-medium truncate"
                                                style={{
                                                    color: "var(--text-primary)",
                                                }}
                                            >
                                                {showExtensions &&
                                                (r.kind === "pdf" ||
                                                    r.kind === "file")
                                                    ? (r.path.split("/").pop() ??
                                                        r.title)
                                                    : r.title}
                                            </span>
                                            {r.modified_at > 0 && (
                                                <span
                                                    className="text-[10px] shrink-0"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                        opacity: 0.6,
                                                    }}
                                                >
                                                    {formatDate(r.modified_at)}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span
                                                className="text-[11px] truncate"
                                                style={{
                                                    color: "var(--text-secondary)",
                                                }}
                                            >
                                                {r.kind === "pdf" ||
                                                r.kind === "file"
                                                    ? (r.path.split("/vault/").pop() ??
                                                        r.path)
                                                    : r.id}
                                            </span>
                                            {r.tags.length > 0 && (
                                                <span className="flex gap-1 shrink-0">
                                                    {r.tags
                                                        .slice(0, 3)
                                                        .map((t) => (
                                                            <span
                                                                key={t}
                                                                className="text-[10px] px-1.5 py-0 rounded"
                                                                style={{
                                                                    backgroundColor:
                                                                        "var(--bg-primary)",
                                                                    color: "var(--accent)",
                                                                }}
                                                            >
                                                                #{t}
                                                            </span>
                                                        ))}
                                                    {r.tags.length > 3 && (
                                                        <span
                                                            className="text-[10px]"
                                                            style={{
                                                                color: "var(--text-secondary)",
                                                            }}
                                                        >
                                                            +{r.tags.length - 3}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                    <button
                                        onClick={() =>
                                            void handleOpenInNewTab(r)
                                        }
                                        title="Open in new tab"
                                        className="shrink-0 px-2.5 py-2.5 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                                        style={{
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
                                            <rect
                                                x="2"
                                                y="2"
                                                width="8"
                                                height="8"
                                                rx="1"
                                            />
                                            <path d="M10 6h4v8H6v-4" />
                                        </svg>
                                    </button>
                                </div>

                                {/* Content matches */}
                                {r.matches.length > 0 && (
                                    <div
                                        className="px-3 py-1.5"
                                        style={{
                                            backgroundColor:
                                                "var(--bg-primary)",
                                            borderTop:
                                                "1px solid var(--border)",
                                        }}
                                    >
                                        {r.matches.map((m, i) => (
                                            <div
                                                key={i}
                                                className="flex items-start gap-2 py-0.5"
                                            >
                                                <span
                                                    className="text-[10px] shrink-0 mt-0.5 font-mono"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                        opacity: 0.5,
                                                        minWidth: 28,
                                                        textAlign: "right",
                                                    }}
                                                >
                                                    {m.page ? `P${m.page}:` : ""}L{m.line_number}
                                                </span>
                                                <span
                                                    className="text-[11px] break-all"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    <HighlightedLine
                                                        line={m.line_content}
                                                        start={m.match_start}
                                                        end={m.match_end}
                                                    />
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function HighlightedLine({
    line,
    start,
    end,
}: {
    line: string;
    start: number;
    end: number;
}) {
    if (start >= end || start >= line.length) {
        return <>{line}</>;
    }
    const before = line.slice(0, start);
    const match = line.slice(start, end);
    const after = line.slice(end);
    return (
        <>
            {before}
            <span
                style={{
                    backgroundColor: "var(--highlight-bg)",
                    color: "var(--highlight-text)",
                    borderRadius: 2,
                    padding: "0 1px",
                }}
            >
                {match}
            </span>
            {after}
        </>
    );
}
