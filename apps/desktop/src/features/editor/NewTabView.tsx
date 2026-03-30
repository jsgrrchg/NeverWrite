import {
    useMemo,
    useState,
    useCallback,
    useRef,
    useEffect,
    useDeferredValue,
} from "react";
import {
    useVaultStore,
    getRecentVaults,
    togglePinVault,
    removeVaultFromList,
    type RecentVault,
} from "../../app/store/vaultStore";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { emitFileTreeNoteDrag } from "../../features/ai/dragEvents";
import { openVaultFileEntry } from "../../app/utils/vaultEntries";

interface SearchResultDto {
    id: string;
    path: string;
    title: string;
    kind?: string;
    score: number;
}

function getSearchResultDisplayTitle(
    result: SearchResultDto,
    showExtensions: boolean,
    fileTreeContentMode: "notes_only" | "all_files",
) {
    const fileName = result.path.split("/").pop() ?? result.title;
    if (result.kind === "pdf" || result.kind === "file") {
        return showExtensions ? fileName : result.title;
    }
    if (fileTreeContentMode !== "all_files") {
        return result.title;
    }
    return showExtensions ? fileName : fileName.replace(/\.md$/i, "");
}

function getSearchResultSubtitle(
    result: SearchResultDto,
    fileTreeContentMode: "notes_only" | "all_files",
) {
    if (result.kind === "pdf" || result.kind === "file") {
        return result.path.split("/vault/").pop() ?? result.path;
    }
    if (fileTreeContentMode !== "all_files") {
        return result.id;
    }

    const fileName = result.path.split("/").pop()?.replace(/\.md$/i, "");
    if (fileName && fileName !== result.title) {
        return `${result.title} · ${result.id}`;
    }
    return result.id;
}

function formatRelativeTime(unixSeconds: number): string {
    const diff = Date.now() / 1000 - unixSeconds;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(unixSeconds * 1000).toLocaleDateString();
}

function PinIcon({ pinned }: { pinned: boolean }) {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill={pinned ? "var(--accent)" : "none"}
            stroke={pinned ? "var(--accent)" : "var(--text-secondary)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M9.5 2.5L13.5 6.5L10 8L8 14L6 10L2 8L8 6L9.5 2.5Z" />
            <line x1="2" y1="14" x2="5.5" y2="10.5" />
        </svg>
    );
}

export function NewTabView() {
    const notes = useVaultStore((s) => s.notes);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const openVault = useVaultStore((s) => s.openVault);
    const createNote = useVaultStore((s) => s.createNote);
    const openNote = useEditorStore((s) => s.openNote);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);

    const entries = useVaultStore((s) => s.entries);
    const showExtensions = useSettingsStore((s) => s.fileTreeShowExtensions);
    const fileTreeContentMode = useSettingsStore((s) => s.fileTreeContentMode);
    const openPdf = useEditorStore((s) => s.openPdf);

    const [recentVaults, setRecentVaults] = useState<RecentVault[]>(() =>
        getRecentVaults(),
    );
    const [noteMenu, setNoteMenu] = useState<ContextMenuState<{
        id: string;
        title: string;
        path: string;
    }> | null>(null);
    const [vaultMenu, setVaultMenu] =
        useState<ContextMenuState<RecentVault> | null>(null);

    // Quick search state
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResultDto[]>([]);
    const [hasSearched, setHasSearched] = useState(false);
    const deferredSearchQuery = useDeferredValue(searchQuery);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRequestIdRef = useRef(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [searchResultMenu, setSearchResultMenu] =
        useState<ContextMenuState<SearchResultDto> | null>(null);

    const isSearching = searchQuery.trim().length > 0;

    const doSearch = useCallback(
        async (q: string) => {
            const trimmed = q.trim();
            const requestId = ++searchRequestIdRef.current;
            if (!trimmed) return;
            try {
                const res = await vaultInvoke<SearchResultDto[]>(
                    "search_notes",
                    {
                        query: trimmed,
                        preferFileName: fileTreeContentMode === "all_files",
                    },
                );
                if (requestId !== searchRequestIdRef.current) return;
                setSearchResults(res);
                setHasSearched(true);
            } catch {
                if (requestId !== searchRequestIdRef.current) return;
                setSearchResults([]);
                setHasSearched(true);
            }
        },
        [fileTreeContentMode],
    );

    useEffect(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        if (!deferredSearchQuery.trim()) {
            searchRequestIdRef.current += 1;
            return;
        }
        searchTimerRef.current = setTimeout(
            () => doSearch(deferredSearchQuery),
            200,
        );
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [deferredSearchQuery, doSearch]);

    const handleSearchQueryChange = (next: string) => {
        if (!next.trim()) {
            searchRequestIdRef.current += 1;
            setSearchResults([]);
            setHasSearched(false);
        }
        setSearchQuery(next);
    };

    const handleOpenSearchResult = async (result: SearchResultDto) => {
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
        await handleOpen(result.id, result.title);
    };

    const handleOpenSearchResultInNewTab = async (result: SearchResultDto) => {
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
        await handleOpenInNewTab(result.id, result.title);
    };

    // Mouse-based drag for notes → AI composer
    const dragRef = useRef<{
        note: { id: string; title: string; path: string };
        startX: number;
        startY: number;
        active: boolean;
    } | null>(null);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const s = dragRef.current;
            if (!s) return;

            if (!s.active) {
                const dx = e.clientX - s.startX;
                const dy = e.clientY - s.startY;
                if (Math.sqrt(dx * dx + dy * dy) < 5) return;
                s.active = true;
                emitFileTreeNoteDrag({
                    phase: "start",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [
                        {
                            id: s.note.id,
                            title: s.note.title,
                            path: s.note.path,
                        },
                    ],
                });
            }

            emitFileTreeNoteDrag({
                phase: "move",
                x: e.clientX,
                y: e.clientY,
                notes: [
                    { id: s.note.id, title: s.note.title, path: s.note.path },
                ],
            });
        };

        const onUp = (e: MouseEvent) => {
            const s = dragRef.current;
            dragRef.current = null;
            if (!s?.active) return;
            emitFileTreeNoteDrag({
                phase: "end",
                x: e.clientX,
                y: e.clientY,
                notes: [
                    { id: s.note.id, title: s.note.title, path: s.note.path },
                ],
            });
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    const recentNotes = useMemo(
        () =>
            [...notes]
                .sort((a, b) => b.modified_at - a.modified_at)
                .slice(0, 10),
        [notes],
    );

    const pinnedVaults = recentVaults.filter((v) => v.pinned);
    const unpinnedVaults = recentVaults.filter((v) => !v.pinned);
    const vaultsToShow = [
        ...pinnedVaults,
        ...unpinnedVaults.slice(0, Math.max(0, 5 - pinnedVaults.length)),
    ];

    const handleOpen = async (id: string, title: string) => {
        const tabs = useEditorStore.getState().tabs;
        const existing = tabs.find(
            (t): t is NoteTab => isNoteTab(t) && t.noteId === id,
        );
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

    const handleNewNote = async () => {
        if (!vaultPath) return;
        const { notes: currentNotes } = useVaultStore.getState();
        let name = "Untitled";
        let i = 1;
        while (
            currentNotes.some((n) => n.id === name || n.id.endsWith(`/${name}`))
        ) {
            name = `Untitled ${i++}`;
        }
        const note = await createNote(name);
        if (note) {
            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: note.id,
                title: note.title,
                content: "",
            });
        }
    };

    const handleOpenSearch = () => {
        useLayoutStore.getState().setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    };

    const handleOpenInNewTab = async (id: string, title: string) => {
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: id,
            });
            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: id,
                title,
                content: detail.content,
            });
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const handleTogglePin = useCallback((path: string, e: React.MouseEvent) => {
        e.stopPropagation();
        togglePinVault(path);
        setRecentVaults(getRecentVaults());
    }, []);

    return (
        <>
            <div
                className="h-full w-full overflow-auto flex items-start justify-center"
                style={{ backgroundColor: "var(--bg-primary)" }}
            >
                <div className="w-full max-w-lg px-8 py-16">
                    {/* Header */}
                    <div className="mb-6">
                        <div
                            className="text-[11px] uppercase tracking-[0.16em] mb-1"
                            style={{ color: "var(--accent)" }}
                        >
                            VaultAI
                        </div>
                        <h1
                            className="text-2xl font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            New Tab
                        </h1>
                    </div>

                    {/* Quick search bar */}
                    {vaultPath && (
                        <div className="mb-8">
                            <div
                                className="flex items-center gap-2.5 px-3.5 rounded-xl"
                                style={{
                                    backgroundColor: "var(--bg-secondary)",
                                    border: "1px solid var(--border)",
                                    height: 42,
                                }}
                            >
                                <svg
                                    width="15"
                                    height="15"
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
                                    ref={searchInputRef}
                                    type="text"
                                    placeholder="Quick search files and notes..."
                                    value={searchQuery}
                                    onChange={(e) =>
                                        handleSearchQueryChange(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Escape" && searchQuery) {
                                            handleSearchQueryChange("");
                                            e.stopPropagation();
                                        }
                                    }}
                                    className="flex-1 bg-transparent text-sm outline-none"
                                    style={{ color: "var(--text-primary)" }}
                                    autoFocus
                                />
                                {searchQuery && (
                                    <button
                                        onClick={() =>
                                            handleSearchQueryChange("")
                                        }
                                        className="shrink-0 opacity-50 hover:opacity-100"
                                        style={{
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
                                        >
                                            <path d="M4 4l8 8M4 12l8-8" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Search results (replaces everything below when searching) */}
                    {isSearching ? (
                        <div>
                            <div
                                className="text-xs uppercase tracking-[0.12em] mb-3"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                {hasSearched
                                    ? `${searchResults.length} result${searchResults.length !== 1 ? "s" : ""}`
                                    : "Searching..."}
                            </div>

                            {hasSearched && searchResults.length === 0 && (
                                <div
                                    className="text-sm py-8 text-center"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    No results for &ldquo;
                                    {searchQuery.trim()}&rdquo;
                                </div>
                            )}

                            {searchResults.length > 0 && (
                                <div
                                    className="rounded-xl overflow-hidden"
                                    style={{
                                        border: "1px solid var(--border)",
                                    }}
                                >
                                    {searchResults.map((r, i) => (
                                        <button
                                            key={`${r.id}-${r.kind ?? "note"}`}
                                            onClick={() =>
                                                void handleOpenSearchResult(r)
                                            }
                                            onAuxClick={(e) => {
                                                if (e.button !== 1) return;
                                                e.preventDefault();
                                                void handleOpenSearchResultInNewTab(
                                                    r,
                                                );
                                            }}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                setSearchResultMenu({
                                                    x: e.clientX,
                                                    y: e.clientY,
                                                    payload: r,
                                                });
                                            }}
                                            className="w-full text-left px-4 py-2.5 flex items-center gap-3"
                                            style={{
                                                backgroundColor:
                                                    "var(--bg-secondary)",
                                                borderTop:
                                                    i > 0
                                                        ? "1px solid var(--border)"
                                                        : "none",
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
                                            {/* Icon */}
                                            <span
                                                className="shrink-0"
                                                style={{
                                                    color: "var(--text-secondary)",
                                                }}
                                            >
                                                {r.kind === "pdf" ? (
                                                    <svg
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="1.3"
                                                    >
                                                        <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Z" />
                                                        <path d="M9 1v4h4" />
                                                        <text
                                                            x="5"
                                                            y="12"
                                                            fontSize="4.5"
                                                            fill="currentColor"
                                                            stroke="none"
                                                            fontWeight="bold"
                                                        >
                                                            PDF
                                                        </text>
                                                    </svg>
                                                ) : r.kind === "file" ? (
                                                    <svg
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="1.3"
                                                    >
                                                        <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Z" />
                                                        <path d="M9 1v4h4" />
                                                    </svg>
                                                ) : (
                                                    <svg
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="1.3"
                                                    >
                                                        <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Z" />
                                                        <path d="M9 1v4h4" />
                                                        <path d="M5 8h6M5 10.5h4" />
                                                    </svg>
                                                )}
                                            </span>
                                            {/* Title + path */}
                                            <div className="min-w-0 flex-1">
                                                <div
                                                    className="text-sm truncate"
                                                    style={{
                                                        color: "var(--text-primary)",
                                                    }}
                                                >
                                                    {getSearchResultDisplayTitle(
                                                        r,
                                                        showExtensions,
                                                        fileTreeContentMode,
                                                    )}
                                                </div>
                                                <div
                                                    className="text-[11px] truncate mt-0.5"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    {getSearchResultSubtitle(
                                                        r,
                                                        fileTreeContentMode,
                                                    )}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Quick actions */}
                            <div className="grid grid-cols-2 gap-2 mb-8">
                                <button
                                    onClick={() => void handleNewNote()}
                                    className="rounded-xl px-4 py-3 text-left"
                                    style={{
                                        border: "1px solid var(--border)",
                                        backgroundColor: "var(--bg-secondary)",
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.borderColor =
                                            "var(--accent)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.borderColor =
                                            "var(--border)")
                                    }
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            stroke="var(--accent)"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <path d="M8 3v10M3 8h10" />
                                        </svg>
                                        <span
                                            className="text-sm font-medium"
                                            style={{
                                                color: "var(--text-primary)",
                                            }}
                                        >
                                            New Note
                                        </span>
                                    </div>
                                    <span
                                        className="text-xs"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        Create a new note in the vault
                                    </span>
                                </button>

                                <button
                                    onClick={handleOpenSearch}
                                    className="rounded-xl px-4 py-3 text-left"
                                    style={{
                                        border: "1px solid var(--border)",
                                        backgroundColor: "var(--bg-secondary)",
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.borderColor =
                                            "var(--accent)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.borderColor =
                                            "var(--border)")
                                    }
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            stroke="var(--accent)"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <circle cx="7" cy="7" r="4.5" />
                                            <path d="M10.5 10.5L14 14" />
                                        </svg>
                                        <span
                                            className="text-sm font-medium"
                                            style={{
                                                color: "var(--text-primary)",
                                            }}
                                        >
                                            Search
                                        </span>
                                    </div>
                                    <span
                                        className="text-xs"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        Search across all notes
                                    </span>
                                </button>
                            </div>

                            {/* Recent notes */}
                            {recentNotes.length > 0 && (
                                <div className="mb-8">
                                    <div
                                        className="text-xs uppercase tracking-[0.12em] mb-3"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        Recent
                                    </div>
                                    <div
                                        className="rounded-xl overflow-hidden"
                                        style={{
                                            border: "1px solid var(--border)",
                                        }}
                                    >
                                        {recentNotes.map((note, i) => (
                                            <button
                                                key={note.id}
                                                onClick={() =>
                                                    void handleOpen(
                                                        note.id,
                                                        note.title,
                                                    )
                                                }
                                                onMouseDown={(e) => {
                                                    if (e.button !== 0) return;
                                                    dragRef.current = {
                                                        note: {
                                                            id: note.id,
                                                            title: note.title,
                                                            path: note.path,
                                                        },
                                                        startX: e.clientX,
                                                        startY: e.clientY,
                                                        active: false,
                                                    };
                                                }}
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    setNoteMenu({
                                                        x: e.clientX,
                                                        y: e.clientY,
                                                        payload: {
                                                            id: note.id,
                                                            title: note.title,
                                                            path: note.path,
                                                        },
                                                    });
                                                }}
                                                className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-4"
                                                style={{
                                                    backgroundColor:
                                                        "var(--bg-secondary)",
                                                    borderTop:
                                                        i > 0
                                                            ? "1px solid var(--border)"
                                                            : "none",
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
                                                <div className="min-w-0 flex-1">
                                                    <div
                                                        className="text-sm truncate"
                                                        style={{
                                                            color: "var(--text-primary)",
                                                        }}
                                                    >
                                                        {note.title}
                                                    </div>
                                                    {note.id.includes("/") && (
                                                        <div
                                                            className="text-[11px] truncate mt-0.5"
                                                            style={{
                                                                color: "var(--text-secondary)",
                                                            }}
                                                        >
                                                            {note.id
                                                                .split("/")
                                                                .slice(0, -1)
                                                                .join("/")}
                                                        </div>
                                                    )}
                                                </div>
                                                <span
                                                    className="text-[11px] shrink-0"
                                                    style={{
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    {formatRelativeTime(
                                                        note.modified_at,
                                                    )}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Vaults */}
                            {vaultsToShow.length > 0 && (
                                <div className="mb-8">
                                    <div
                                        className="text-xs uppercase tracking-[0.12em] mb-3"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        Vaults
                                    </div>
                                    <div
                                        className="rounded-xl overflow-hidden"
                                        style={{
                                            border: "1px solid var(--border)",
                                        }}
                                    >
                                        {vaultsToShow.map((vault, i) => (
                                            <div
                                                key={vault.path}
                                                className="flex items-center"
                                                style={{
                                                    backgroundColor:
                                                        "var(--bg-secondary)",
                                                    borderTop:
                                                        i > 0
                                                            ? "1px solid var(--border)"
                                                            : "none",
                                                }}
                                                onMouseEnter={(e) =>
                                                    (e.currentTarget.style.backgroundColor =
                                                        "var(--bg-tertiary)")
                                                }
                                                onMouseLeave={(e) =>
                                                    (e.currentTarget.style.backgroundColor =
                                                        "var(--bg-secondary)")
                                                }
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    setVaultMenu({
                                                        x: e.clientX,
                                                        y: e.clientY,
                                                        payload: vault,
                                                    });
                                                }}
                                            >
                                                <button
                                                    onClick={() =>
                                                        void openVault(
                                                            vault.path,
                                                        )
                                                    }
                                                    className="flex-1 text-left px-4 py-2.5 min-w-0"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <svg
                                                            width="13"
                                                            height="13"
                                                            viewBox="0 0 16 16"
                                                            fill="none"
                                                            stroke="var(--text-secondary)"
                                                            strokeWidth="1.4"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        >
                                                            <path d="M2 4h5l1.5 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
                                                        </svg>
                                                        <span
                                                            className="text-sm truncate"
                                                            style={{
                                                                color: "var(--text-primary)",
                                                                fontWeight:
                                                                    vault.pinned
                                                                        ? 500
                                                                        : 400,
                                                            }}
                                                        >
                                                            {vault.name}
                                                        </span>
                                                    </div>
                                                    <div
                                                        className="text-[11px] truncate mt-0.5 pl-5"
                                                        style={{
                                                            color: "var(--text-secondary)",
                                                        }}
                                                        title={vault.path}
                                                    >
                                                        {vault.path}
                                                    </div>
                                                </button>
                                                <button
                                                    onClick={(e) =>
                                                        handleTogglePin(
                                                            vault.path,
                                                            e,
                                                        )
                                                    }
                                                    title={
                                                        vault.pinned
                                                            ? "Unpin vault"
                                                            : "Pin vault"
                                                    }
                                                    className="shrink-0 px-3 py-2.5 opacity-40 hover:opacity-100"
                                                >
                                                    <PinIcon
                                                        pinned={!!vault.pinned}
                                                    />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {noteMenu && (
                <ContextMenu
                    menu={noteMenu}
                    onClose={() => setNoteMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () =>
                                void handleOpen(
                                    noteMenu.payload.id,
                                    noteMenu.payload.title,
                                ),
                        },
                        {
                            label: "Open in New Tab",
                            action: () =>
                                void handleOpenInNewTab(
                                    noteMenu.payload.id,
                                    noteMenu.payload.title,
                                ),
                        },
                        { type: "separator" },
                        {
                            label: "Add to Chat",
                            action: () =>
                                emitFileTreeNoteDrag({
                                    phase: "attach",
                                    x: 0,
                                    y: 0,
                                    notes: [
                                        {
                                            id: noteMenu.payload.id,
                                            title: noteMenu.payload.title,
                                            path: noteMenu.payload.path,
                                        },
                                    ],
                                }),
                        },
                    ]}
                />
            )}

            {searchResultMenu && (
                <ContextMenu
                    menu={searchResultMenu}
                    onClose={() => setSearchResultMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () =>
                                void handleOpenSearchResult(
                                    searchResultMenu.payload,
                                ),
                        },
                        {
                            label: "Open in New Tab",
                            action: () =>
                                void handleOpenSearchResultInNewTab(
                                    searchResultMenu.payload,
                                ),
                        },
                        { type: "separator" },
                        {
                            label: "Add to Chat",
                            action: () =>
                                emitFileTreeNoteDrag({
                                    phase: "attach",
                                    x: 0,
                                    y: 0,
                                    notes: [
                                        {
                                            id: searchResultMenu.payload.id,
                                            title: searchResultMenu.payload
                                                .title,
                                            path: searchResultMenu.payload.path,
                                        },
                                    ],
                                }),
                        },
                    ]}
                />
            )}

            {vaultMenu && (
                <ContextMenu
                    menu={vaultMenu}
                    onClose={() => setVaultMenu(null)}
                    entries={[
                        {
                            label: "Open Vault",
                            action: () =>
                                void openVault(vaultMenu.payload.path),
                        },
                        { type: "separator" },
                        {
                            label: vaultMenu.payload.pinned ? "Unpin" : "Pin",
                            action: () => {
                                togglePinVault(vaultMenu.payload.path);
                                setRecentVaults(getRecentVaults());
                            },
                        },
                        {
                            label: "Remove from List",
                            danger: true,
                            action: () => {
                                void removeVaultFromList(
                                    vaultMenu.payload.path,
                                );
                                setRecentVaults(
                                    getRecentVaults().filter(
                                        (v) =>
                                            v.path !== vaultMenu.payload.path,
                                    ),
                                );
                            },
                        },
                    ]}
                />
            )}
        </>
    );
}
