import { useState, useMemo, useRef, useCallback } from "react";
import {
    useVaultStore,
    type NoteDto,
    type VaultEntryDto,
} from "../../app/store/vaultStore";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import {
    useBookmarkStore,
    type BookmarkFolder,
    type BookmarkItem,
} from "../../app/store/bookmarkStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { useVirtualList } from "../../app/hooks/useVirtualList";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    canOpenVaultFileEntryInApp,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { openDetachedNoteWindow } from "../../app/detachedWindows";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 28;

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

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            width="12"
            height="12"
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

function NoteIcon() {
    return (
        <svg
            width="11"
            height="11"
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

function PdfIcon() {
    return (
        <svg
            width="11"
            height="11"
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

function FileIcon() {
    return (
        <svg
            width="11"
            height="11"
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

function FolderIcon() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.45 }}
        >
            <path
                d="M2 4h4.5l1.5 1.5H14v8H2z"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function itemIcon(kind: BookmarkItem["kind"]) {
    switch (kind) {
        case "note":
            return <NoteIcon />;
        case "pdf":
            return <PdfIcon />;
        case "file":
            return <FileIcon />;
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

    const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

    // Build flat rows
    const rows = useMemo(
        () => flattenRows(folders, items, expanded),
        [folders, items, expanded],
    );
    const virtual = useVirtualList(listRef, rows.length, ROW_HEIGHT, 10);
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
                const { tabs } = useEditorStore.getState();
                const existing = tabs.find(
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
                    const { tabs } = useEditorStore.getState();
                    const existing = tabs.find(
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
                const { tabs } = useEditorStore.getState();
                const existing = tabs.find(
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
                        No bookmarks yet. Right-click a note in the file tree to
                        add one.
                    </p>
                ) : (
                    <div
                        style={{
                            position: "relative",
                            height:
                                virtual.totalHeight +
                                (creatingFolder ? ROW_HEIGHT : 0),
                        }}
                    >
                        {/* Create folder input */}
                        {creatingFolder && (
                            <div
                                className="flex items-center gap-1.5 px-2"
                                style={{ height: ROW_HEIGHT }}
                            >
                                <FolderIcon />
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
                                    className="flex-1 bg-transparent text-xs outline-none"
                                    style={{
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
                                    (creatingFolder ? ROW_HEIGHT : 0),
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
                                            className="flex items-center gap-1.5 w-full text-left py-1 px-2 text-xs rounded"
                                            style={{
                                                color: "var(--text-primary)",
                                                minHeight: ROW_HEIGHT,
                                            }}
                                        >
                                            <ChevronIcon open={isExpanded} />
                                            <FolderIcon />
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
                                                    className="flex-1 bg-transparent text-xs outline-none"
                                                    style={{
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
                                                className="text-xs tabular-nums"
                                                style={{
                                                    color: "var(--text-secondary)",
                                                    fontSize: "0.65rem",
                                                }}
                                            >
                                                {row.itemCount}
                                            </span>
                                        </button>
                                    );
                                }

                                // Item row
                                const title = resolveItemTitle(row.item);
                                const indent = row.depth > 0 ? 20 : 0;

                                return (
                                    <button
                                        key={`item:${row.item.id}`}
                                        data-bookmark-row
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
                                        className="flex items-center gap-1.5 w-full text-left py-0.5 text-xs rounded mx-1"
                                        style={{
                                            paddingLeft: 8 + indent,
                                            width: "calc(100% - 8px)",
                                            color: "var(--text-secondary)",
                                            minHeight: ROW_HEIGHT,
                                        }}
                                        onMouseEnter={(e) =>
                                            (e.currentTarget.style.color =
                                                "var(--text-primary)")
                                        }
                                        onMouseLeave={(e) =>
                                            (e.currentTarget.style.color =
                                                "var(--text-secondary)")
                                        }
                                    >
                                        {itemIcon(row.item.kind)}
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
