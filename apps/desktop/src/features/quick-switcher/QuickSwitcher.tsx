import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useDeferredValue,
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
    isFileTab,
    isPdfTab,
    isNoteTab,
    selectEditorWorkspaceTabs,
    type ChatTab,
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

const QUICK_SWITCHER_ROW_HEIGHT = 48;

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
            title: note.title,
            subtitle: note.id,
            note,
        }),
        [],
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
            ...notes.map((note) => ({
                item: buildNoteItem(note),
                score: Math.max(
                    fuzzyScore(deferredQuery, note.title),
                    fuzzyScore(deferredQuery, note.id),
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
        buildNoteItem,
        deferredQuery,
        entries,
        entryMap,
        noteMap,
        notes,
        openTabs,
        orderedTabs,
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
            if (item.kind === "chat") {
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
                setSelectedIndex(Math.min(boundedSelectedIndex + 1, maxIndex));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(Math.max(boundedSelectedIndex - 1, 0));
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

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center"
            style={{ paddingTop: "20vh" }}
            onClick={closeModal}
        >
            <div
                className="w-full max-w-md rounded-lg shadow-2xl overflow-hidden"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
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
                    placeholder="Search files and notes..."
                    className="w-full px-4 py-3 text-sm outline-none"
                    style={{
                        backgroundColor: "transparent",
                        color: "var(--text-primary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                />
                <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
                    {results.length === 0 ? (
                        <div
                            className="px-4 py-3 text-sm"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            No files or notes found
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
                                    return (
                                        <button
                                            key={item.key}
                                            onClick={() =>
                                                void openItemAndClose(item)
                                            }
                                            className="w-full text-left px-4 py-2 text-sm"
                                            style={{
                                                backgroundColor:
                                                    i === boundedSelectedIndex
                                                        ? "var(--accent)"
                                                        : "transparent",
                                                color:
                                                    i === selectedIndex
                                                        ? "#fff"
                                                        : "var(--text-primary)",
                                                minHeight:
                                                    QUICK_SWITCHER_ROW_HEIGHT,
                                            }}
                                        >
                                            <div className="truncate">
                                                {item.title}
                                            </div>
                                            <div
                                                className="text-xs truncate"
                                                style={{
                                                    opacity:
                                                        i === selectedIndex
                                                            ? 0.7
                                                            : 0.5,
                                                }}
                                            >
                                                {item.subtitle}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
