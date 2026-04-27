import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useDeferredValue,
    type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    useVaultStore,
    type NoteDto,
    type VaultEntryDto,
} from "../../app/store/vaultStore";
import {
    useEditorStore,
    isChatTab,
    isChatHistoryTab,
    isFileTab,
    isPdfTab,
    isNoteTab,
    selectEditorWorkspaceTabs,
    type ChatTab,
    type ChatHistoryTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useCommandStore } from "../command-palette/store/commandStore";
import { useVirtualList } from "../../app/hooks/useVirtualList";
import {
    getVaultEntryDisplayName,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useChatStore } from "../ai/store/chatStore";
import { getSessionTitle } from "../ai/sessionPresentation";

const QUICK_SWITCHER_ROW_HEIGHT = 34;

function fuzzyScore(query: string, text: string): number {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (q.length === 0) return 1;

    let qi = 0;
    let score = 0;
    let consecutive = 0;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            qi++;
            consecutive++;
            score += consecutive;
            if (ti === 0) score += 2;
        } else {
            consecutive = 0;
        }
    }

    return qi === q.length ? score : 0;
}

export function QuickSwitcher() {
    const activeModal = useCommandStore((s) => s.activeModal);
    if (activeModal !== "quick-switcher") return null;

    return <QuickSwitcherDialog />;
}

type QuickSwitcherItem =
    | {
          key: string;
          kind: "note";
          title: string;
          subtitle: string;
          note: NoteDto;
      }
    | {
          key: string;
          kind: "pdf" | "file";
          title: string;
          subtitle: string;
          entry: VaultEntryDto;
      }
    | {
          key: string;
          kind: "chat";
          title: string;
          subtitle: string;
          tab: ChatTab;
      }
    | {
          key: string;
          kind: "history";
          title: string;
          subtitle: string;
          tab: ChatHistoryTab;
      };

function QuickSwitcherDialog() {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const closeModal = useCommandStore((s) => s.closeModal);
    const notes = useVaultStore((s) => s.notes);
    const entries = useVaultStore((s) => s.entries);
    const openNote = useEditorStore((s) => s.openNote);
    const openPdf = useEditorStore((s) => s.openPdf);
    const fileTreeContentMode = useSettingsStore((s) => s.fileTreeContentMode);
    const showExtensions = useSettingsStore((s) => s.fileTreeShowExtensions);
    const deferredQuery = useDeferredValue(query);
    const noteMap = useMemo(
        () => new Map(notes.map((note) => [note.id, note])),
        [notes],
    );
    const entryMap = useMemo(
        () => new Map(entries.map((entry) => [entry.path, entry])),
        [entries],
    );
    const orderedTabs = useEditorStore(useShallow(selectEditorWorkspaceTabs));
    const tabsById = useEditorStore((state) => state.tabsById);
    const switchTab = useEditorStore((state) => state.switchTab);
    const chatSessionsById = useChatStore((state) => state.sessionsById);
    const openTabs = useMemo(() => Object.values(tabsById), [tabsById]);

    const buildNoteItem = useCallback(
        (note: NoteDto): QuickSwitcherItem => ({
            key: `note:${note.id}`,
            kind: "note",
            title: getNoteQuickSwitcherTitle(
                note,
                fileTreeContentMode,
                showExtensions,
            ),
            subtitle: note.id,
            note,
        }),
        [fileTreeContentMode, showExtensions],
    );

    const buildEntryItem = useCallback(
        (entry: VaultEntryDto): QuickSwitcherItem => ({
            key: `${entry.kind}:${entry.relative_path}`,
            kind: entry.kind === "pdf" ? "pdf" : "file",
            title: getVaultEntryDisplayName(entry, showExtensions),
            subtitle: entry.relative_path,
            entry,
        }),
        [showExtensions],
    );

    const buildChatItem = useCallback(
        (tab: ChatTab): QuickSwitcherItem => {
            const session = chatSessionsById[tab.sessionId];
            return {
                key: `chat:${tab.id}`,
                kind: "chat",
                title: session ? getSessionTitle(session) : tab.title,
                subtitle: tab.sessionId,
                tab,
            };
        },
        [chatSessionsById],
    );

    const buildHistoryItem = useCallback(
        (tab: ChatHistoryTab): QuickSwitcherItem => ({
            key: `history:${tab.id}`,
            kind: "history",
            title: tab.title,
            subtitle: "Chat history",
            tab,
        }),
        [],
    );

    const results = useMemo(() => {
        const searchableEntries = entries.filter(
            (entry) => entry.kind !== "note" && entry.kind !== "folder",
        );

        if (!deferredQuery.trim()) {
            const ordered = orderedTabs
                .map((tab) => {
                    if (isChatTab(tab)) {
                        return buildChatItem(tab);
                    }
                    if (isChatHistoryTab(tab)) {
                        return buildHistoryItem(tab);
                    }
                    if (isPdfTab(tab)) {
                        const entry = entryMap.get(tab.path);
                        return entry ? buildEntryItem(entry) : null;
                    }
                    if (isFileTab(tab)) {
                        const entry = entryMap.get(tab.path);
                        return entry
                            ? buildEntryItem(entry)
                            : {
                                  key: `file:${tab.relativePath}`,
                                  kind: "file" as const,
                                  title: tab.title,
                                  subtitle: tab.relativePath,
                                  entry: {
                                      id: tab.relativePath,
                                      path: tab.path,
                                      relative_path: tab.relativePath,
                                      title: tab.title.replace(/\.[^/.]+$/, ""),
                                      file_name: tab.title,
                                      extension:
                                          tab.relativePath.split(".").pop() ??
                                          "",
                                      kind: "file",
                                      modified_at: 0,
                                      created_at: 0,
                                      size: 0,
                                      mime_type: tab.mimeType,
                                  },
                              };
                    }
                    if (!isNoteTab(tab)) return null;
                    const note = noteMap.get(tab.noteId);
                    return note ? buildNoteItem(note) : null;
                })
                .filter((item): item is QuickSwitcherItem => item !== null);

            const remainingNotes = notes
                .filter(
                    (note) =>
                        !ordered.some((item) => item.key === `note:${note.id}`),
                )
                .map(buildNoteItem);
            const remainingEntries = searchableEntries
                .filter(
                    (entry) =>
                        !ordered.some(
                            (item) =>
                                item.key ===
                                `${entry.kind}:${entry.relative_path}`,
                        ),
                )
                .map(buildEntryItem);

            return [...ordered, ...remainingNotes, ...remainingEntries];
        }

        return [
            ...openTabs
                .filter((tab): tab is ChatTab => isChatTab(tab))
                .map((tab) => {
                    const item = buildChatItem(tab);
                    return {
                        item,
                        score: Math.max(
                            fuzzyScore(deferredQuery, item.title),
                            fuzzyScore(deferredQuery, tab.sessionId),
                        ),
                    };
                }),
            ...openTabs
                .filter(
                    (tab): tab is ChatHistoryTab => isChatHistoryTab(tab),
                )
                .map((tab) => {
                    const item = buildHistoryItem(tab);
                    return {
                        item,
                        score: Math.max(
                            fuzzyScore(deferredQuery, item.title),
                            fuzzyScore(deferredQuery, item.subtitle),
                        ),
                    };
                }),
            ...notes.map((note) => ({
                item: buildNoteItem(note),
                score: Math.max(
                    fuzzyScore(
                        deferredQuery,
                        getNoteQuickSwitcherTitle(
                            note,
                            fileTreeContentMode,
                            showExtensions,
                        ),
                    ),
                    fuzzyScore(deferredQuery, note.path),
                    fuzzyScore(deferredQuery, note.id),
                    fuzzyScore(deferredQuery, note.title),
                ),
            })),
            ...searchableEntries.map((entry) => ({
                item: buildEntryItem(entry),
                score: Math.max(
                    fuzzyScore(
                        deferredQuery,
                        getVaultEntryDisplayName(entry, true),
                    ),
                    fuzzyScore(deferredQuery, entry.relative_path),
                ),
            })),
        ]
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ item }) => item);
    }, [
        buildEntryItem,
        buildChatItem,
        buildHistoryItem,
        buildNoteItem,
        deferredQuery,
        entries,
        entryMap,
        fileTreeContentMode,
        noteMap,
        notes,
        openTabs,
        orderedTabs,
        showExtensions,
    ]);
    const virtual = useVirtualList(
        listRef,
        Math.min(results.length, 200),
        QUICK_SWITCHER_ROW_HEIGHT,
        6,
    );
    const maxVisibleResults = Math.min(results.length, 200);
    const boundedSelectedIndex = Math.min(
        selectedIndex,
        Math.max(0, maxVisibleResults - 1),
    );
    const visibleResults = results
        .slice(0, 200)
        .slice(virtual.startIndex, virtual.endIndex);

    useEffect(() => {
        const frame = window.setTimeout(() => inputRef.current?.focus(), 0);
        return () => window.clearTimeout(frame);
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const itemTop = boundedSelectedIndex * QUICK_SWITCHER_ROW_HEIGHT;
        const itemBottom = itemTop + QUICK_SWITCHER_ROW_HEIGHT;
        const viewportTop = list.scrollTop;
        const viewportBottom = viewportTop + list.clientHeight;
        let nextScrollTop: number | null = null;

        if (itemTop < viewportTop) {
            nextScrollTop = itemTop;
        } else if (itemBottom > viewportBottom) {
            nextScrollTop = itemBottom - list.clientHeight;
        }

        if (nextScrollTop === null || nextScrollTop === viewportTop) return;

        list.scrollTop = nextScrollTop;
        list.dispatchEvent(new Event("scroll"));
    }, [boundedSelectedIndex]);

    const openItemAndClose = useCallback(
        async (item: QuickSwitcherItem) => {
            closeModal();
            if (item.kind === "chat" || item.kind === "history") {
                switchTab(item.tab.id);
                return;
            }
            if (item.kind === "pdf") {
                const existing = openTabs.find(
                    (tab) => isPdfTab(tab) && tab.entryId === item.entry.id,
                );
                if (existing) {
                    switchTab(existing.id);
                    return;
                }
                openPdf(item.entry.id, item.entry.title, item.entry.path);
                return;
            }
            if (item.kind === "file") {
                const existing = openTabs.find(
                    (tab) =>
                        isFileTab(tab) &&
                        tab.relativePath === item.entry.relative_path,
                );
                if (existing) {
                    switchTab(existing.id);
                    return;
                }
                try {
                    await openVaultFileEntry(item.entry);
                } catch (error) {
                    console.error("Error opening file:", error);
                }
                return;
            }

            if (item.kind !== "note") return;
            const note = item.note;
            const existing = openTabs.find(
                (t): t is NoteTab => isNoteTab(t) && t.noteId === note.id,
            );
            if (existing) {
                switchTab(existing.id);
                return;
            }
            try {
                const detail = await vaultInvoke<{ content: string }>(
                    "read_note",
                    {
                        noteId: note.id,
                    },
                );
                openNote(note.id, note.title, detail.content);
            } catch (e) {
                console.error("Error reading note:", e);
            }
        },
        [closeModal, openNote, openPdf, openTabs, switchTab],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const maxIndex = Math.max(0, maxVisibleResults - 1);
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex(
                    boundedSelectedIndex >= maxIndex
                        ? 0
                        : boundedSelectedIndex + 1,
                );
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(
                    boundedSelectedIndex <= 0
                        ? maxIndex
                        : boundedSelectedIndex - 1,
                );
            } else if (e.key === "Home") {
                e.preventDefault();
                setSelectedIndex(0);
            } else if (e.key === "End") {
                e.preventDefault();
                setSelectedIndex(maxIndex);
            } else if (e.key === "Enter") {
                e.preventDefault();
                const item = results[boundedSelectedIndex];
                if (item) void openItemAndClose(item);
            } else if (e.key === "Escape") {
                e.preventDefault();
                closeModal();
            }
        },
        [
            boundedSelectedIndex,
            closeModal,
            maxVisibleResults,
            openItemAndClose,
            results,
        ],
    );

    const vaultName = useVaultStore((s) => {
        if (!s.vaultPath) return null;
        const parts = s.vaultPath.split(/[\\/]/).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : s.vaultPath;
    });
    const placeholder = vaultName
        ? `Search files in ${vaultName}\u2026`
        : "Search files by name or path\u2026";
    const isEmptyQuery = query.trim().length === 0;
    const showLoader = !isEmptyQuery && query !== deferredQuery;

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center px-5 pt-[min(12vh,88px)]"
            style={{
                background:
                    "color-mix(in srgb, var(--bg-primary) 72%, transparent)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
            }}
            onClick={closeModal}
        >
            <div
                className="flex w-full flex-col overflow-hidden rounded-xl"
                style={{
                    maxWidth: 620,
                    background: "var(--bg-elevated)",
                    border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                    boxShadow:
                        "0 24px 80px rgba(0, 0, 0, 0.22), 0 0 0 1px color-mix(in srgb, var(--border) 40%, transparent)",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setSelectedIndex(0);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="w-full bg-transparent px-3.5 py-2.5 text-[14px] outline-none"
                    style={{
                        color: "var(--text-primary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                />
                <div
                    ref={listRef}
                    data-testid="quick-switcher-list"
                    className="overflow-y-auto py-1"
                    style={{ maxHeight: "min(56vh, 480px)" }}
                >
                    {results.length === 0 ? (
                        <div
                            className="px-3.5 py-6 text-center text-[12px]"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            {isEmptyQuery
                                ? vaultName
                                    ? "Type to search your vault"
                                    : "Open a vault to start searching"
                                : "No matching items"}
                        </div>
                    ) : (
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
                                {visibleResults.map((item, localIndex) => {
                                    const i = virtual.startIndex + localIndex;
                                    const isSelected =
                                        i === boundedSelectedIndex;
                                    return (
                                        <button
                                            key={item.key}
                                            type="button"
                                            onMouseEnter={() =>
                                                setSelectedIndex(i)
                                            }
                                            onClick={() =>
                                                void openItemAndClose(item)
                                            }
                                            className="flex w-full items-center gap-2.5 px-3.5 text-left"
                                            style={{
                                                height: QUICK_SWITCHER_ROW_HEIGHT,
                                                background: isSelected
                                                    ? "color-mix(in srgb, var(--accent) 14%, var(--bg-primary))"
                                                    : "transparent",
                                                color: "var(--text-primary)",
                                            }}
                                        >
                                            <span
                                                className="flex shrink-0 items-center justify-center"
                                                style={{
                                                    width: 15,
                                                    height: 15,
                                                    opacity: isSelected
                                                        ? 0.92
                                                        : 0.62,
                                                    color: "var(--text-primary)",
                                                }}
                                            >
                                                {renderQuickSwitcherIcon(item)}
                                            </span>

                                            <span
                                                className="truncate text-[13px] font-medium"
                                                style={{
                                                    color: "var(--text-primary)",
                                                }}
                                            >
                                                {item.title}
                                            </span>

                                            <span
                                                className="min-w-0 flex-1 truncate font-mono text-[11px]"
                                                style={{
                                                    color: "color-mix(in srgb, var(--text-secondary) 70%, transparent)",
                                                }}
                                            >
                                                {formatItemSubtitle(item)}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
                <div
                    className="flex items-center justify-between px-3.5 py-1.5 text-[11px]"
                    style={{
                        borderTop: "1px solid var(--border)",
                        color: "color-mix(in srgb, var(--text-secondary) 70%, transparent)",
                    }}
                >
                    <span>
                        {showLoader
                            ? "Searching\u2026"
                            : "\u2191\u2193 Navigate \u00b7 Enter Open \u00b7 Esc Close"}
                    </span>
                    {results.length > 0 && (
                        <span>
                            {boundedSelectedIndex + 1} / {results.length}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function getNoteFileName(note: NoteDto): string {
    return note.path.split(/[\\/]/).pop() ?? `${note.title}.md`;
}

function getNoteQuickSwitcherTitle(
    note: NoteDto,
    fileTreeContentMode: "notes_only" | "all_files",
    showExtensions: boolean,
): string {
    if (fileTreeContentMode === "all_files" && showExtensions) {
        return getNoteFileName(note);
    }
    return note.title;
}

function formatItemSubtitle(item: QuickSwitcherItem): string {
    // Non-path subtitles (chat session id, "Chat history" label) stay as-is;
    // path-like subtitles display the full path so the user sees where the
    // item lives inside the vault.
    return item.subtitle;
}

function renderQuickSwitcherIcon(item: QuickSwitcherItem): ReactNode {
    const commonProps = {
        width: 15,
        height: 15,
        viewBox: "0 0 16 16",
        fill: "none" as const,
        stroke: "currentColor",
        strokeWidth: 1.1,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };

    if (item.kind === "pdf") {
        return (
            <svg {...commonProps} stroke="#e24b3b" strokeWidth={1}>
                <path d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z" />
                <path d="M9.5 1.5V5H13" strokeWidth={0.8} />
                <text
                    x="5"
                    y="12"
                    fontSize="4.5"
                    fontWeight="700"
                    fill="#e24b3b"
                    stroke="none"
                    fontFamily="sans-serif"
                >
                    PDF
                </text>
            </svg>
        );
    }

    if (item.kind === "file") {
        return (
            <svg {...commonProps}>
                <path d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z" />
                <path d="M9.5 1.5V5H13" strokeWidth={0.85} />
            </svg>
        );
    }

    if (item.kind === "chat") {
        return (
            <svg {...commonProps}>
                <path d="M2 3h12v8H5l-3 3V3z" />
            </svg>
        );
    }

    if (item.kind === "history") {
        return (
            <svg {...commonProps}>
                <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />
                <path d="M8 5.2v3.1l2.1 1.2" />
            </svg>
        );
    }

    // note
    return (
        <svg {...commonProps}>
            <path d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z" />
            <path d="M9.5 1.5V5H13" strokeWidth={0.85} />
            <path d="M5.5 8.5h5M5.5 10.8h3.2" strokeWidth={0.85} />
        </svg>
    );
}
