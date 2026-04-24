import { useState, useMemo, useRef, useCallback } from "react";
import {
    useVaultStore,
    type NoteDto,
    type VaultEntryDto,
} from "../../app/store/vaultStore";
import {
    useEditorStore,
    isNoteTab,
    isPdfTab,
    isFileTab,
    selectEditorWorkspaceTabs,
    selectFocusedEditorTab,
    type NoteTab,
} from "../../app/store/editorStore";
import {
    useBookmarkStore,
    type BookmarkFolder,
    type BookmarkItem,
} from "../../app/store/bookmarkStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { SidebarFilterInput } from "../../components/layout/SidebarFilterInput";
import { useVirtualList } from "../../app/hooks/useVirtualList";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    canOpenVaultFileEntryInApp,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { openDetachedNoteWindow } from "../../app/detachedWindows";

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

type BookmarkRow =
    | {
          kind: "folder";
          folder: BookmarkFolder;
          itemCount: number;
          depth: number;
      }
    | { kind: "item"; item: BookmarkItem; depth: number };

function flattenRows(
    folders: BookmarkFolder[],
    items: BookmarkItem[],
    expanded: Set<string>,
): BookmarkRow[] {
    const rows: BookmarkRow[] = [];

    // Root-level items (folderId === null), sorted by sortOrder
    const rootItems = items
        .filter((i) => i.folderId === null)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const item of rootItems) {
        rows.push({ kind: "item", item, depth: 0 });
    }

    // Folders sorted by sortOrder, with their children
    const sortedFolders = [...folders].sort(
        (a, b) => a.sortOrder - b.sortOrder,
    );
    for (const folder of sortedFolders) {
        const folderItems = items.filter((i) => i.folderId === folder.id);
        rows.push({
            kind: "folder",
            folder,
            itemCount: folderItems.length,
            depth: 0,
        });
        if (expanded.has(folder.id)) {
            const sorted = [...folderItems].sort(
                (a, b) => a.sortOrder - b.sortOrder,
            );
            for (const item of sorted) {
                rows.push({ kind: "item", item, depth: 1 });
            }
        }
    }

    return rows;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms ease",
                flexShrink: 0,
                opacity: 0.5,
            }}
        >
            <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function NoteIcon({ size = 11 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.4 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
        </svg>
    );
}

function PdfIcon({ size = 11 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.4 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M5.5 9h5M5.5 11h3"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

function FileIcon({ size = 11 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.4 }}
        >
            <rect
                x="3"
                y="2"
                width="10"
                height="12"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1"
            />
        </svg>
    );
}

function FolderIcon({ size = 15 }: { size?: number }) {
    const fill = "var(--icon-muted)";
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, transform: "translateY(0.5px)" }}
        >
            <path
                d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                fill={fill}
                opacity="0.65"
            />
        </svg>
    );
}

function itemIcon(kind: BookmarkItem["kind"], size?: number) {
    switch (kind) {
        case "note":
            return <NoteIcon size={size} />;
        case "pdf":
            return <PdfIcon size={size} />;
        case "file":
            return <FileIcon size={size} />;
    }
}

// ---------------------------------------------------------------------------
// Context menu payload types
// ---------------------------------------------------------------------------

type ContextPayload =
    | { kind: "blank" }
    | { kind: "folder"; folder: BookmarkFolder; expanded: boolean }
    | { kind: "item"; item: BookmarkItem };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BookmarksPanel() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const notes = useVaultStore((s) => s.notes);
    const entries = useVaultStore((s) => s.entries);
    const openNote = useEditorStore((s) => s.openNote);
    const openPdf = useEditorStore((s) => s.openPdf);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);

    const folders = useBookmarkStore((s) => s.folders);
    const items = useBookmarkStore((s) => s.items);
    const createFolder = useBookmarkStore((s) => s.createFolder);
    const renameFolder = useBookmarkStore((s) => s.renameFolder);
    const deleteFolder = useBookmarkStore((s) => s.deleteFolder);
    const removeBookmark = useBookmarkStore((s) => s.removeBookmark);
    const fileTreeScale = useSettingsStore((s) => s.fileTreeScale);

    // Active tab info for highlight
    const activeNoteId = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return isNoteTab(tab) ? tab.noteId : null;
    });
    const activeEntryPath = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return isPdfTab(tab) || isFileTab(tab) ? tab.path : null;
    });

    const m = useMemo(() => {
        const s = fileTreeScale / 100;
        return {
            rowHeight: Math.round(28 * s),
            fontSize: Math.max(12, Math.round(12 * s)),
            smallIcon: Math.max(11, Math.round(11 * s)),
            chevronIcon: Math.max(12, Math.round(12 * s)),
            folderIcon: Math.max(15, Math.round(15 * s)),
            indent: Math.round(20 * s),
        };
    }, [fileTreeScale]);

    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [filterText, setFilterText] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(
        null,
    );
    const [renameValue, setRenameValue] = useState("");
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [createFolderName, setCreateFolderName] = useState("");
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ContextPayload> | null>(null);

    const listRef = useRef<HTMLDivElement>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);
    const createInputRef = useRef<HTMLInputElement>(null);

    // Lookup maps
    const noteMap = useMemo(
        () => new Map(notes.map((n) => [n.id, n])),
        [notes],
    );
    const entryMap = useMemo(
        () => new Map(entries.map((e) => [e.relative_path, e])),
        [entries],
    );

    // Build flat rows. When a filter is active we narrow `items` to matches
    // and auto-expand every folder that still contains any — so hits stay
    // visible without the user opening each folder. Folders whose name
    // matches are kept whole (children not trimmed) to preserve context.
    const rows = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        if (!q) return flattenRows(folders, items, expanded);

        const resolveTitle = (item: BookmarkItem): string => {
            if (item.kind === "note" && item.noteId) {
                return noteMap.get(item.noteId)?.title ?? item.noteId;
            }
            if (item.entryPath) {
                const entry = entryMap.get(item.entryPath);
                return (
                    entry?.title ??
                    item.entryPath.split("/").pop() ??
                    item.entryPath
                );
            }
            return "";
        };

        const folderMatches = new Set(
            folders
                .filter((f) => f.name.toLowerCase().includes(q))
                .map((f) => f.id),
        );
        const filteredItems = items.filter((item) => {
            if (item.folderId && folderMatches.has(item.folderId)) return true;
            return resolveTitle(item).toLowerCase().includes(q);
        });
        const folderIdsWithHits = new Set(
            filteredItems
                .map((item) => item.folderId)
                .filter((id): id is string => id !== null),
        );
        const filteredFolders = folders.filter(
            (f) => folderMatches.has(f.id) || folderIdsWithHits.has(f.id),
        );
        const expandedForFilter = new Set(filteredFolders.map((f) => f.id));
        return flattenRows(filteredFolders, filteredItems, expandedForFilter);
    }, [folders, items, expanded, filterText, noteMap, entryMap]);
    const virtual = useVirtualList(listRef, rows.length, m.rowHeight, 10);
    const visibleRows = rows.slice(virtual.startIndex, virtual.endIndex);

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    const resolveItemTitle = useCallback(
        (item: BookmarkItem): string => {
            if (item.kind === "note" && item.noteId) {
                return noteMap.get(item.noteId)?.title ?? item.noteId;
            }
            if (item.entryPath) {
                const entry = entryMap.get(item.entryPath);
                return (
                    entry?.title ??
                    item.entryPath.split("/").pop() ??
                    item.entryPath
                );
            }
            return "Unknown";
        },
        [noteMap, entryMap],
    );

    const resolveNote = useCallback(
        (noteId: string): NoteDto | undefined => noteMap.get(noteId),
        [noteMap],
    );

    const resolveEntry = useCallback(
        (path: string): VaultEntryDto | undefined => entryMap.get(path),
        [entryMap],
    );

    // ---------------------------------------------------------------------------
    // Click handlers
    // ---------------------------------------------------------------------------

    const handleItemClick = useCallback(
        async (item: BookmarkItem) => {
            if (item.kind === "note" && item.noteId) {
                const note = resolveNote(item.noteId);
                if (!note) return;
                const existing = selectEditorWorkspaceTabs(
                    useEditorStore.getState(),
                ).find(
                    (t): t is NoteTab =>
                        isNoteTab(t) && t.noteId === item.noteId,
                );
                if (existing) {
                    openNote(note.id, note.title, existing.content);
                    return;
                }
                try {
                    const detail = await vaultInvoke<{ content: string }>(
                        "read_note",
                        { noteId: item.noteId },
                    );
                    openNote(note.id, note.title, detail.content);
                } catch (e) {
                    console.error("Error opening bookmarked note:", e);
                }
            } else if (item.kind === "pdf" && item.entryPath) {
                const entry = resolveEntry(item.entryPath);
                if (!entry) return;
                openPdf(entry.id, entry.title, entry.path);
            } else if (item.kind === "file" && item.entryPath) {
                const entry = resolveEntry(item.entryPath);
                if (!entry) return;
                void openVaultFileEntry(entry);
            }
        },
        [openNote, openPdf, resolveNote, resolveEntry],
    );

    const handleOpenItemInNewTab = useCallback(
        async (item: BookmarkItem) => {
            if (item.kind === "note" && item.noteId) {
                const note = resolveNote(item.noteId);
                if (!note) return;
                try {
                    const existing = selectEditorWorkspaceTabs(
                        useEditorStore.getState(),
                    ).find(
                        (t): t is NoteTab =>
                            isNoteTab(t) && t.noteId === item.noteId,
                    );
                    const content =
                        existing?.content ??
                        (
                            await vaultInvoke<{ content: string }>(
                                "read_note",
                                {
                                    noteId: item.noteId,
                                },
                            )
                        ).content;
                    insertExternalTab({
                        id: crypto.randomUUID(),
                        noteId: note.id,
                        title: note.title,
                        content,
                    });
                } catch (e) {
                    console.error("Error opening bookmark in new tab:", e);
                }
            } else if (item.kind === "pdf" && item.entryPath) {
                const entry = resolveEntry(item.entryPath);
                if (!entry) return;
                insertExternalTab({
                    id: crypto.randomUUID(),
                    kind: "pdf",
                    entryId: entry.id,
                    title: entry.title,
                    path: entry.path,
                    page: 1,
                    zoom: 1,
                    viewMode: "continuous",
                });
            } else if (item.kind === "file" && item.entryPath) {
                const entry = resolveEntry(item.entryPath);
                if (!entry || !canOpenVaultFileEntryInApp(entry)) return;
                void openVaultFileEntry(entry, { newTab: true });
            }
        },
        [insertExternalTab, resolveNote, resolveEntry],
    );

    const handleOpenItemInNewWindow = useCallback(
        async (item: BookmarkItem) => {
            if (item.kind !== "note" || !item.noteId) return;
            const note = resolveNote(item.noteId);
            if (!note || !vaultPath) return;
            try {
                const existing = selectEditorWorkspaceTabs(
                    useEditorStore.getState(),
                ).find(
                    (t): t is NoteTab =>
                        isNoteTab(t) && t.noteId === item.noteId,
                );
                const content =
                    existing?.content ??
                    (
                        await vaultInvoke<{ content: string }>("read_note", {
                            noteId: item.noteId,
                        })
                    ).content;
                const detachedTab: NoteTab = existing
                    ? {
                          ...existing,
                          noteId: note.id,
                          title: note.title,
                          content,
                          history:
                              existing.history.length > 0
                                  ? existing.history.map((entry, index) =>
                                        index === existing.historyIndex &&
                                        entry.kind === "note"
                                            ? {
                                                  ...entry,
                                                  noteId: note.id,
                                                  title: note.title,
                                                  content,
                                              }
                                            : entry,
                                    )
                                  : [
                                        {
                                            kind: "note",
                                            noteId: note.id,
                                            title: note.title,
                                            content,
                                        },
                                    ],
                          historyIndex:
                              existing.history.length > 0
                                  ? Math.min(
                                        Math.max(existing.historyIndex, 0),
                                        existing.history.length - 1,
                                    )
                                  : 0,
                      }
                    : {
                          id: crypto.randomUUID(),
                          kind: "note",
                          noteId: note.id,
                          title: note.title,
                          content,
                          history: [
                              {
                                  kind: "note",
                                  noteId: note.id,
                                  title: note.title,
                                  content,
                              },
                          ],
                          historyIndex: 0,
                      };
                void openDetachedNoteWindow(
                    {
                        tabs: [detachedTab],
                        activeTabId: null,
                        vaultPath,
                    },
                    { title: note.title },
                );
            } catch (e) {
                console.error("Error opening bookmark in new window:", e);
            }
        },
        [resolveNote, vaultPath],
    );

    const handleOpenAllInTabs = useCallback(
        async (folderId: string) => {
            const folderItems = items
                .filter((i) => i.folderId === folderId)
                .sort((a, b) => a.sortOrder - b.sortOrder);
            for (const item of folderItems) {
                await handleOpenItemInNewTab(item);
            }
        },
        [items, handleOpenItemInNewTab],
    );

    const toggleFolder = (folderId: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(folderId)) next.delete(folderId);
            else next.add(folderId);
            return next;
        });
    };

    const handleFolderDoubleClick = (folderId: string) => {
        void handleOpenAllInTabs(folderId);
    };

    // ---------------------------------------------------------------------------
    // Folder creation
    // ---------------------------------------------------------------------------

    const startCreatingFolder = () => {
        setCreatingFolder(true);
        setCreateFolderName("");
        requestAnimationFrame(() => createInputRef.current?.focus());
    };

    const confirmCreateFolder = () => {
        const name = createFolderName.trim();
        if (name) {
            const id = createFolder(name);
            setExpanded((prev) => new Set(prev).add(id));
        }
        setCreatingFolder(false);
        setCreateFolderName("");
    };

    const cancelCreateFolder = () => {
        setCreatingFolder(false);
        setCreateFolderName("");
    };

    // ---------------------------------------------------------------------------
    // Folder rename
    // ---------------------------------------------------------------------------

    const startRename = (folder: BookmarkFolder) => {
        setRenamingFolderId(folder.id);
        setRenameValue(folder.name);
        requestAnimationFrame(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        });
    };

    const confirmRename = () => {
        if (renamingFolderId) {
            const name = renameValue.trim();
            if (name) renameFolder(renamingFolderId, name);
        }
        setRenamingFolderId(null);
        setRenameValue("");
    };

    const cancelRename = () => {
        setRenamingFolderId(null);
        setRenameValue("");
    };

    // ---------------------------------------------------------------------------
    // Context menu entries
    // ---------------------------------------------------------------------------

    const contextMenuEntries = useMemo<ContextMenuEntry[]>(() => {
        if (!contextMenu) return [];

        switch (contextMenu.payload.kind) {
            case "blank":
                return [
                    {
                        label: "New Folder",
                        action: startCreatingFolder,
                    },
                ];
            case "folder": {
                const { folder, expanded: isExpanded } = contextMenu.payload;
                const folderItemCount = items.filter(
                    (i) => i.folderId === folder.id,
                ).length;
                return [
                    {
                        label: isExpanded ? "Collapse" : "Expand",
                        action: () => toggleFolder(folder.id),
                    },
                    {
                        label: "Open All in Tabs",
                        action: () => void handleOpenAllInTabs(folder.id),
                        disabled: folderItemCount === 0,
                    },
                    { type: "separator" },
                    {
                        label: "Rename",
                        action: () => startRename(folder),
                    },
                    {
                        label: "Delete Folder",
                        action: () => deleteFolder(folder.id),
                        danger: true,
                    },
                ];
            }
            case "item": {
                const { item } = contextMenu.payload;
                const isNote = item.kind === "note";
                return [
                    {
                        label: "Open",
                        action: () => void handleItemClick(item),
                    },
                    {
                        label: "Open in New Tab",
                        action: () => void handleOpenItemInNewTab(item),
                    },
                    ...(isNote
                        ? [
                              {
                                  label: "Open in New Window",
                                  action: () =>
                                      void handleOpenItemInNewWindow(item),
                              } as ContextMenuEntry,
                          ]
                        : []),
                    { type: "separator" as const },
                    {
                        label: "Remove from Bookmarks",
                        action: () => removeBookmark(item.id),
                        danger: true,
                    },
                ];
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contextMenu, items]);

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div
                className="shrink-0"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <div className="flex items-center justify-between px-3 py-2">
                    <span
                        className="text-xs font-semibold uppercase tracking-wider"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Bookmarks
                    </span>
                    <button
                        onClick={startCreatingFolder}
                        title="New Folder"
                        className="flex items-center justify-center rounded transition-opacity"
                        style={{
                            width: 18,
                            height: 18,
                            color: "var(--text-secondary)",
                            opacity: 0.5,
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.opacity = "1")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.opacity = "0.5")
                        }
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        >
                            <path d="M8 3v10M3 8h10" />
                        </svg>
                    </button>
                </div>
                <div className="px-2 pb-2">
                    <SidebarFilterInput
                        value={filterText}
                        onChange={setFilterText}
                        placeholder="Filter bookmarks..."
                    />
                </div>
            </div>

            {/* Content */}
            <div
                ref={listRef}
                className="flex-1 overflow-y-auto py-1 px-1"
                onContextMenu={(e) => {
                    // Only handle if clicking on empty area (not on a row)
                    if (
                        (e.target as HTMLElement).closest("[data-bookmark-row]")
                    )
                        return;
                    e.preventDefault();
                    setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        payload: { kind: "blank" },
                    });
                }}
            >
                {!vaultPath ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No vault open
                    </p>
                ) : rows.length === 0 && !creatingFolder ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {filterText.trim()
                            ? `No bookmarks match "${filterText}"`
                            : "No bookmarks yet. Right-click a note in the file tree to add one."}
                    </p>
                ) : (
                    <div
                        style={{
                            position: "relative",
                            height:
                                virtual.totalHeight +
                                (creatingFolder ? m.rowHeight : 0),
                        }}
                    >
                        {/* Create folder input */}
                        {creatingFolder && (
                            <div
                                className="flex items-center gap-1.5 px-2"
                                style={{ height: m.rowHeight }}
                            >
                                <FolderIcon size={m.folderIcon} />
                                <input
                                    ref={createInputRef}
                                    type="text"
                                    value={createFolderName}
                                    onChange={(e) =>
                                        setCreateFolderName(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            confirmCreateFolder();
                                        if (e.key === "Escape")
                                            cancelCreateFolder();
                                    }}
                                    onBlur={confirmCreateFolder}
                                    placeholder="Folder name…"
                                    className="flex-1 bg-transparent outline-none"
                                    style={{
                                        fontSize: m.fontSize,
                                        color: "var(--text-primary)",
                                        border: "1px solid var(--accent)",
                                        borderRadius: 3,
                                        padding: "1px 4px",
                                    }}
                                    spellCheck={false}
                                />
                            </div>
                        )}

                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top:
                                    virtual.offsetTop +
                                    (creatingFolder ? m.rowHeight : 0),
                            }}
                        >
                            {visibleRows.map((row) => {
                                if (row.kind === "folder") {
                                    const isExpanded = expanded.has(
                                        row.folder.id,
                                    );
                                    const isRenaming =
                                        renamingFolderId === row.folder.id;

                                    return (
                                        <button
                                            key={`folder:${row.folder.id}`}
                                            data-bookmark-row
                                            onClick={() =>
                                                toggleFolder(row.folder.id)
                                            }
                                            onDoubleClick={() =>
                                                handleFolderDoubleClick(
                                                    row.folder.id,
                                                )
                                            }
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                setContextMenu({
                                                    x: e.clientX,
                                                    y: e.clientY,
                                                    payload: {
                                                        kind: "folder",
                                                        folder: row.folder,
                                                        expanded: isExpanded,
                                                    },
                                                });
                                            }}
                                            className="flex items-center gap-1.5 w-full text-left py-1 px-2 rounded"
                                            style={{
                                                fontSize: m.fontSize,
                                                color: "var(--text-primary)",
                                                minHeight: m.rowHeight,
                                            }}
                                        >
                                            <ChevronIcon
                                                open={isExpanded}
                                                size={m.chevronIcon}
                                            />
                                            <FolderIcon size={m.folderIcon} />
                                            {isRenaming ? (
                                                <input
                                                    ref={renameInputRef}
                                                    type="text"
                                                    value={renameValue}
                                                    onChange={(e) => {
                                                        e.stopPropagation();
                                                        setRenameValue(
                                                            e.target.value,
                                                        );
                                                    }}
                                                    onClick={(e) =>
                                                        e.stopPropagation()
                                                    }
                                                    onDoubleClick={(e) =>
                                                        e.stopPropagation()
                                                    }
                                                    onKeyDown={(e) => {
                                                        e.stopPropagation();
                                                        if (e.key === "Enter")
                                                            confirmRename();
                                                        if (e.key === "Escape")
                                                            cancelRename();
                                                    }}
                                                    onBlur={confirmRename}
                                                    className="flex-1 bg-transparent outline-none"
                                                    style={{
                                                        fontSize: m.fontSize,
                                                        color: "var(--text-primary)",
                                                        border: "1px solid var(--accent)",
                                                        borderRadius: 3,
                                                        padding: "1px 4px",
                                                    }}
                                                    spellCheck={false}
                                                />
                                            ) : (
                                                <span className="flex-1 truncate">
                                                    {row.folder.name}
                                                </span>
                                            )}
                                            <span
                                                className="tabular-nums"
                                                style={{
                                                    color: "var(--text-secondary)",
                                                    fontSize: Math.round(
                                                        m.fontSize * 0.85,
                                                    ),
                                                }}
                                            >
                                                {row.itemCount}
                                            </span>
                                        </button>
                                    );
                                }

                                // Item row
                                const title = resolveItemTitle(row.item);
                                const indent = row.depth > 0 ? m.indent : 0;
                                const isActive =
                                    (row.item.noteId != null &&
                                        row.item.noteId === activeNoteId) ||
                                    (row.item.entryPath != null &&
                                        row.item.entryPath === activeEntryPath);

                                return (
                                    <button
                                        key={`item:${row.item.id}`}
                                        data-bookmark-row
                                        data-active={
                                            isActive ? "true" : "false"
                                        }
                                        onClick={() =>
                                            void handleItemClick(row.item)
                                        }
                                        onAuxClick={(e) => {
                                            if (e.button !== 1) return;
                                            e.preventDefault();
                                            e.stopPropagation();
                                            void handleOpenItemInNewTab(
                                                row.item,
                                            );
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            setContextMenu({
                                                x: e.clientX,
                                                y: e.clientY,
                                                payload: {
                                                    kind: "item",
                                                    item: row.item,
                                                },
                                            });
                                        }}
                                        className="bookmark-item-row flex items-center gap-1.5 w-full text-left py-0.5 rounded mx-1"
                                        style={{
                                            fontSize: m.fontSize,
                                            paddingLeft: 8 + indent,
                                            width: "calc(100% - 8px)",
                                            color: isActive
                                                ? "var(--text-primary)"
                                                : "var(--text-secondary)",
                                            backgroundColor: isActive
                                                ? "color-mix(in srgb, var(--accent) 22%, transparent)"
                                                : undefined,
                                            boxShadow: isActive
                                                ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)"
                                                : "none",
                                            minHeight: m.rowHeight,
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.color =
                                                "var(--text-primary)";
                                            if (!isActive)
                                                e.currentTarget.style.backgroundColor =
                                                    "var(--bg-tertiary)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.color =
                                                isActive
                                                    ? "var(--text-primary)"
                                                    : "var(--text-secondary)";
                                            if (!isActive)
                                                e.currentTarget.style.backgroundColor =
                                                    "";
                                        }}
                                    >
                                        {itemIcon(row.item.kind, m.smallIcon)}
                                        <span className="truncate">
                                            {title}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Context menus */}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={contextMenuEntries}
                />
            )}
        </div>
    );
}
