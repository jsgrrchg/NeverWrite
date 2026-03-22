import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    canOpenVaultFileEntryInApp,
    closeOpenTabsForVaultPath,
    getVaultEntryDisplayName,
    isImageLikeVaultEntry,
    moveVaultEntryToTrash,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { useSettingsStore } from "../../app/store/settingsStore";
import { REVEAL_NOTE_IN_TREE_EVENT } from "../../app/utils/navigation";
import {
    useVaultStore,
    type NoteDto,
    type VaultEntryDto,
} from "../../app/store/vaultStore";
import {
    useEditorStore,
    isFileTab,
    isNoteTab,
    isPdfTab,
    type NoteTab,
} from "../../app/store/editorStore";
import {
    buildEntryMovePath,
    buildNoteMoveOperations,
    canMoveFolderToTarget,
    getBaseName,
    getParentPath,
} from "./fileTreeMoves";
import {
    buildCopiedFolderPath,
    buildCopiedNotePath,
    canPasteFolderClipboard,
    readFileTreeClipboard,
    writeFileTreeClipboard,
} from "./fileTreeClipboard";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import { perfMeasure, perfNow } from "../../app/utils/perfInstrumentation";

// --- Sort ---

type SortMode =
    | "name_asc"
    | "name_desc"
    | "modified_desc"
    | "modified_asc"
    | "created_desc"
    | "created_asc";

const SORT_KEY = "vaultai:sort-mode";
const REVEAL_KEY = "vaultai:reveal-active";
const VIRTUAL_OVERSCAN = 40;

const SORT_OPTIONS: { id: SortMode; label: string }[] = [
    { id: "name_asc", label: "Name (A–Z)" },
    { id: "name_desc", label: "Name (Z–A)" },
    { id: "modified_desc", label: "Date modified (newest)" },
    { id: "modified_asc", label: "Date modified (oldest)" },
    { id: "created_desc", label: "Created (newest)" },
    { id: "created_asc", label: "Created (oldest)" },
];

interface TreeMetrics {
    scale: number;
    rowHeight: number;
    fontSize: number;
    indentStep: number;
    basePadding: number;
    smallIcon: number;
    mediumIcon: number;
    toolbarButton: number;
    toolbarIconScale: number;
    inputFontSize: number;
}

const TREE_VIEWPORT_SIDE_PADDING_PX = 4;
const TREE_LAYER_BOX_STYLE = {
    width: "100%",
    minWidth: "100%",
    boxSizing: "border-box" as const,
};
const TREE_ROW_BOX_STYLE = {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box" as const,
};
const TREE_LABEL_CLASSNAME =
    "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap";

// --- Tree building ---

interface TreeNode {
    name: string;
    children?: Record<string, TreeNode>;
    note?: NoteDto;
    entry?: VaultEntryDto;
}

type FlatTreeRow =
    | { kind: "folder"; name: string; path: string; depth: number }
    | { kind: "note"; note: NoteDto; path: string; depth: number }
    | { kind: "pdf"; entry: VaultEntryDto; path: string; depth: number }
    | { kind: "file"; entry: VaultEntryDto; path: string; depth: number }
    | {
          kind: "create";
          mode: "note" | "folder";
          parentPath: string;
          path: string;
          depth: number;
      };

type TreeSelectionState = {
    noteIds: Set<string>;
    entryPaths: Set<string>;
};

function getSelectableRowKey(row: FlatTreeRow): string | null {
    if (row.kind === "note") {
        return `note:${row.note.id}`;
    }
    if (row.kind === "pdf" || row.kind === "file") {
        return `entry:${row.entry.path}`;
    }
    return null;
}

function buildSelectionFromRows(rows: FlatTreeRow[]): TreeSelectionState {
    const noteIds = new Set<string>();
    const entryPaths = new Set<string>();

    for (const row of rows) {
        if (row.kind === "note") {
            noteIds.add(row.note.id);
            continue;
        }
        if (row.kind === "pdf" || row.kind === "file") {
            entryPaths.add(row.entry.path);
        }
    }

    return { noteIds, entryPaths };
}

function buildTree(
    notes: NoteDto[],
    fileEntries: VaultEntryDto[],
): Record<string, TreeNode> {
    const startMs = perfNow();
    const root: Record<string, TreeNode> = {};

    for (const note of notes) {
        const parts = note.id.split("/");
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!current[part]) current[part] = { name: part };
            if (i === parts.length - 1) {
                current[part].note = note;
            } else {
                if (!current[part].children) current[part].children = {};
                current = current[part].children!;
            }
        }
    }

    for (const entry of fileEntries) {
        const parts = entry.relative_path.split("/");
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!current[part]) current[part] = { name: part };
            if (i === parts.length - 1) {
                if (entry.kind === "folder") {
                    if (!current[part].children) current[part].children = {};
                } else {
                    current[part].entry = entry;
                }
            } else {
                if (!current[part].children) current[part].children = {};
                current = current[part].children!;
            }
        }
    }

    perfMeasure("vault.fileTree.buildTree", startMs, {
        noteCount: notes.length,
        entryCount: fileEntries.length,
        rootNodeCount: Object.keys(root).length,
    });
    return root;
}

function getAllFolderPaths(
    map: Record<string, TreeNode>,
    prefix = "",
): string[] {
    const paths: string[] = [];
    for (const [key, node] of Object.entries(map)) {
        if (node.children) {
            const p = prefix ? `${prefix}/${key}` : key;
            paths.push(p);
            paths.push(...getAllFolderPaths(node.children, p));
        }
    }
    return paths;
}

function flattenTreeRows(
    map: Record<string, TreeNode>,
    expandedFolders: Set<string>,
    sortMode: SortMode,
    prefix = "",
    depth = 0,
): FlatTreeRow[] {
    const startMs = prefix === "" && depth === 0 ? perfNow() : null;
    const rows: FlatTreeRow[] = [];

    for (const [key, node] of sortedEntries(map, sortMode)) {
        const path = prefix ? `${prefix}/${key}` : key;

        if (node.children) {
            rows.push({ kind: "folder", name: key, path, depth });
            if (expandedFolders.has(path)) {
                rows.push(
                    ...flattenTreeRows(
                        node.children,
                        expandedFolders,
                        sortMode,
                        path,
                        depth + 1,
                    ),
                );
            }
            // A node can have both children (folder) and a note/entry
            // at the same path — render both so neither is invisible.
            if (node.note) {
                rows.push({ kind: "note", note: node.note, path, depth });
            } else if (node.entry) {
                rows.push({
                    kind: node.entry.kind === "pdf" ? "pdf" : "file",
                    entry: node.entry,
                    path,
                    depth,
                });
            }
            continue;
        }

        if (node.note) {
            rows.push({ kind: "note", note: node.note, path, depth });
        } else if (node.entry) {
            rows.push({
                kind: node.entry.kind === "pdf" ? "pdf" : "file",
                entry: node.entry,
                path,
                depth,
            });
        }
    }

    if (prefix === "" && depth === 0) {
        perfMeasure("vault.fileTree.flattenRows", startMs, {
            rowCount: rows.length,
            expandedFolderCount: expandedFolders.size,
            sortMode,
        });
    }

    return rows;
}

function sortedEntries(
    map: Record<string, TreeNode>,
    sortMode: SortMode,
): [string, TreeNode][] {
    return Object.entries(map).sort(([, a], [, b]) => {
        const aIsDir = !!a.children;
        const bIsDir = !!b.children;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        if (aIsDir && bIsDir) return a.name.localeCompare(b.name);
        switch (sortMode) {
            case "name_asc":
                return a.name.localeCompare(b.name);
            case "name_desc":
                return b.name.localeCompare(a.name);
            case "modified_desc":
                return (
                    (b.note?.modified_at ?? b.entry?.modified_at ?? 0) -
                    (a.note?.modified_at ?? a.entry?.modified_at ?? 0)
                );
            case "modified_asc":
                return (
                    (a.note?.modified_at ?? a.entry?.modified_at ?? 0) -
                    (b.note?.modified_at ?? b.entry?.modified_at ?? 0)
                );
            case "created_desc":
                return (
                    (b.note?.created_at ?? b.entry?.created_at ?? 0) -
                    (a.note?.created_at ?? a.entry?.created_at ?? 0)
                );
            case "created_asc":
                return (
                    (a.note?.created_at ?? a.entry?.created_at ?? 0) -
                    (b.note?.created_at ?? b.entry?.created_at ?? 0)
                );
        }
    });
}

function movePathPrefix(
    path: string,
    sourcePrefix: string,
    targetPrefix: string,
) {
    if (path === sourcePrefix) return targetPrefix;
    if (!path.startsWith(`${sourcePrefix}/`)) return path;
    return `${targetPrefix}/${path.slice(sourcePrefix.length + 1)}`;
}

function getNoteDisplayName(note: NoteDto, showExtensions: boolean) {
    if (!showExtensions) return note.title;
    return note.path.split("/").pop() ?? `${note.title}.md`;
}

// --- Icons ---

function ChevronIcon({ open, size = 13 }: { open: boolean; size?: number }) {
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

function FolderIcon({ open, size = 15 }: { open: boolean; size?: number }) {
    if (open) {
        return (
            <svg
                width={size}
                height={size}
                viewBox="0 0 16 16"
                fill="none"
                style={{ flexShrink: 0 }}
            >
                <path
                    d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.5 1.5h5a1 1 0 0 1 1 1V5H2.5V3.5Z"
                    fill="#000000"
                    opacity="0.7"
                />
                <path
                    d="M1 5.5h13l-1.5 7.5H2.5L1 5.5Z"
                    fill="#000000"
                    opacity="0.5"
                />
            </svg>
        );
    }
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0 }}
        >
            <path
                d="M2 3a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Z"
                fill="#000000"
                opacity="0.5"
            />
        </svg>
    );
}

function NoteIcon({ size = 13 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.45 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M6 8h4M6 10.5h3"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

function PdfIcon({ size = 13 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.6 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="#e24b3b"
                strokeWidth="1"
            />
            <path
                d="M9.5 1.5V5H13"
                stroke="#e24b3b"
                strokeWidth="0.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <text
                x="5"
                y="12"
                fontSize="4.5"
                fontWeight="700"
                fill="#e24b3b"
                fontFamily="sans-serif"
            >
                PDF
            </text>
        </svg>
    );
}

function GenericFileIcon({ size = 13 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.58 }}
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M9.5 1.5V5H13"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function MapFileIcon({ size = 13 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.58 }}
        >
            <rect
                x="2"
                y="2"
                width="12"
                height="12"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1"
            />
            <circle cx="8" cy="5.5" r="1.3" fill="currentColor" />
            <circle cx="5" cy="10.5" r="1.3" fill="currentColor" />
            <circle cx="11" cy="10.5" r="1.3" fill="currentColor" />
            <path
                d="M7.15 6.65 5.7 9.3M8.85 6.65l1.45 2.65"
                stroke="currentColor"
                strokeWidth="0.85"
                strokeLinecap="round"
            />
        </svg>
    );
}

function ImageFileIcon({ size = 13 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.58 }}
        >
            <rect
                x="2"
                y="2.5"
                width="12"
                height="11"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1"
            />
            <circle
                cx="5.5"
                cy="5.8"
                r="1.2"
                stroke="currentColor"
                strokeWidth="0.8"
            />
            <path
                d="M2.5 11l3-3.5 2.5 2.5 1.5-1.5 4 3.5"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

// --- Toolbar button ---

function ToolbarBtn({
    title,
    active,
    onClick,
    size = 26,
    iconScale = 1,
    children,
}: {
    title: string;
    active?: boolean;
    onClick: () => void;
    size?: number;
    iconScale?: number;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            style={{
                width: size,
                height: size,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 4,
                flexShrink: 0,
                color: active ? "var(--accent)" : "var(--text-secondary)",
                opacity: active ? 1 : 0.55,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) =>
                (e.currentTarget.style.opacity = active ? "1" : "0.55")
            }
        >
            <span
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: `scale(${iconScale})`,
                    transformOrigin: "center",
                }}
            >
                {children}
            </span>
        </button>
    );
}

// --- Sort menu ---

function SortMenu({
    current,
    onSelect,
    onClose,
}: {
    current: SortMode;
    onSelect: (mode: SortMode) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node))
                onClose();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [onClose]);

    return (
        <div
            ref={ref}
            style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                zIndex: 9999,
                marginTop: 2,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                padding: 4,
            }}
        >
            {SORT_OPTIONS.map((opt) => (
                <button
                    key={opt.id}
                    onClick={() => onSelect(opt.id)}
                    className="w-full text-left px-3 py-1.5 text-xs rounded flex items-center gap-2"
                    style={{ color: "var(--text-primary)" }}
                    onMouseEnter={(e) =>
                        (e.currentTarget.style.backgroundColor =
                            "var(--bg-tertiary)")
                    }
                    onMouseLeave={(e) =>
                        (e.currentTarget.style.backgroundColor = "transparent")
                    }
                >
                    <span
                        style={{
                            width: 12,
                            flexShrink: 0,
                            color: "var(--accent)",
                        }}
                    >
                        {opt.id === current ? "✓" : ""}
                    </span>
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

// --- Context menu ---

type FileTreeContextPayload =
    | { kind: "blank" }
    | { kind: "folder"; path: string; expanded: boolean }
    | { kind: "note"; note: NoteDto }
    | { kind: "move-note"; note: NoteDto }
    | { kind: "pdf"; entry: VaultEntryDto }
    | { kind: "file"; entry: VaultEntryDto };

// --- Tree node ---

interface FlatTreeRowViewProps {
    row: FlatTreeRow;
    metrics: TreeMetrics;
    activeNoteId: string | null;
    activeEntryPath: string | null;
    expandedFolders: Set<string>;
    selectedNoteIds: Set<string>;
    selectedEntryPaths: Set<string>;
    contextMenuFolderPath: string | null;
    draggingNoteIds: Set<string>;
    draggingFolderPath: string | null;
    dragOverPath: string | null;
    onFolderClick: (path: string) => void;
    onFolderMouseDown: (path: string, e: React.MouseEvent) => void;
    onFolderContextMenu: (e: React.MouseEvent, path: string) => void;
    onNoteClick: (
        note: NoteDto,
        modifiers: { cmd: boolean; shift: boolean },
    ) => void;
    onNoteAuxClick: (note: NoteDto, e: React.MouseEvent) => void;
    onNoteMouseDown: (note: NoteDto, e: React.MouseEvent) => void;
    onNoteContextMenu: (e: React.MouseEvent, note: NoteDto) => void;
    onPdfClick: (
        entry: VaultEntryDto,
        modifiers: { cmd: boolean; shift: boolean },
    ) => void;
    onPdfAuxClick: (entry: VaultEntryDto, e: React.MouseEvent) => void;
    onPdfMouseDown: (entry: VaultEntryDto, e: React.MouseEvent) => void;
    onPdfContextMenu: (e: React.MouseEvent, entry: VaultEntryDto) => void;
    onFileClick: (
        entry: VaultEntryDto,
        modifiers: { cmd: boolean; shift: boolean },
    ) => void;
    onFileAuxClick: (entry: VaultEntryDto, e: React.MouseEvent) => void;
    onFileMouseDown: (entry: VaultEntryDto, e: React.MouseEvent) => void;
    onFileContextMenu: (e: React.MouseEvent, entry: VaultEntryDto) => void;
    renamingNoteId: string | null;
    renamingFolderPath: string | null;
    renamingEntryPath: string | null;
    creatingMode: "note" | "folder" | null;
    newItemName: string;
    onNewItemNameChange: (value: string) => void;
    onCreateConfirm: () => void;
    onCreateCancel: () => void;
    onRenameNoteConfirm: (note: NoteDto, newName: string) => void;
    onRenameFolderConfirm: (path: string, newName: string) => void;
    onRenameEntryConfirm: (entry: VaultEntryDto, newName: string) => void;
    onRenameCancel: () => void;
    showExtensions: boolean;
    stickyTop?: number;
}

const FlatTreeRowView = memo(
    function FlatTreeRowView({
        row,
        metrics,
        activeNoteId,
        activeEntryPath,
        expandedFolders,
        selectedNoteIds,
        selectedEntryPaths,
        contextMenuFolderPath,
        draggingNoteIds,
        draggingFolderPath,
        dragOverPath,
        onFolderClick,
        onFolderMouseDown,
        onFolderContextMenu,
        onNoteClick,
        onNoteAuxClick,
        onNoteMouseDown,
        onNoteContextMenu,
        onPdfClick,
        onPdfAuxClick,
        onPdfMouseDown,
        onPdfContextMenu,
        onFileClick,
        onFileAuxClick,
        onFileMouseDown,
        onFileContextMenu,
        renamingNoteId,
        renamingFolderPath,
        renamingEntryPath,
        creatingMode,
        newItemName,
        onNewItemNameChange,
        onCreateConfirm,
        onCreateCancel,
        onRenameNoteConfirm,
        onRenameFolderConfirm,
        onRenameEntryConfirm,
        onRenameCancel,
        showExtensions,
        stickyTop,
    }: FlatTreeRowViewProps) {
        const renameInputRef = useRef<HTMLInputElement>(null);
        const createInputRef = useRef<HTMLInputElement>(null);
        const paddingLeft =
            row.depth * metrics.indentStep + metrics.basePadding;
        const noteOffset = Math.round(14 * metrics.scale);

        const isFolder = row.kind === "folder";
        const isDragOver = dragOverPath === row.path;
        const isDraggingFolder =
            row.kind === "folder" && draggingFolderPath === row.path;
        const isExpanded =
            row.kind === "folder" && expandedFolders.has(row.path);
        const isRenamingFolder =
            row.kind === "folder" && row.path === renamingFolderPath;
        const isRenamingEntry =
            row.kind === "file" && row.entry.path === renamingEntryPath;
        const isRenamingNote =
            row.kind === "note" && row.note.id === renamingNoteId;

        useEffect(() => {
            if (
                (isRenamingFolder || isRenamingEntry || isRenamingNote) &&
                renameInputRef.current
            ) {
                renameInputRef.current.focus();
                renameInputRef.current.select();
            }
        }, [isRenamingEntry, isRenamingFolder, isRenamingNote]);

        useEffect(() => {
            if (
                row.kind === "create" &&
                creatingMode === row.mode &&
                createInputRef.current
            ) {
                createInputRef.current.focus();
                createInputRef.current.select();
            }
        }, [creatingMode, row]);

        if (isFolder) {
            if (isRenamingFolder) {
                return (
                    <div
                        className="flex items-center gap-1.5 py-0.5"
                        style={{
                            paddingLeft,
                            fontSize: metrics.fontSize,
                            minHeight: metrics.rowHeight,
                            ...TREE_ROW_BOX_STYLE,
                        }}
                    >
                        <ChevronIcon
                            open={!!isExpanded}
                            size={metrics.smallIcon}
                        />
                        <FolderIcon
                            open={!!isExpanded}
                            size={metrics.mediumIcon}
                        />
                        <input
                            ref={renameInputRef}
                            defaultValue={row.name}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    const value =
                                        event.currentTarget.value.trim();
                                    if (value) {
                                        onRenameFolderConfirm(row.path, value);
                                    } else {
                                        onRenameCancel();
                                    }
                                }
                                if (event.key === "Escape") {
                                    onRenameCancel();
                                }
                            }}
                            onBlur={() => {
                                const value =
                                    renameInputRef.current?.value.trim() ?? "";
                                if (value) {
                                    onRenameFolderConfirm(row.path, value);
                                } else {
                                    onRenameCancel();
                                }
                            }}
                            className="flex-1 text-xs px-1.5 py-0.5 rounded outline-none min-w-0"
                            style={{
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--accent)",
                                color: "var(--text-primary)",
                                fontSize: metrics.inputFontSize,
                            }}
                        />
                    </div>
                );
            }

            return (
                <button
                    onMouseDown={(event) => onFolderMouseDown(row.path, event)}
                    onClick={() => onFolderClick(row.path)}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFolderContextMenu(event, row.path);
                    }}
                    data-folder-path={row.path}
                    data-drag-over={isDragOver ? "true" : "false"}
                    data-selected={
                        contextMenuFolderPath === row.path ? "true" : "false"
                    }
                    className="file-tree-row flex items-center gap-1.5 text-left text-xs rounded"
                    style={{
                        paddingLeft,
                        color: "var(--text-secondary)",
                        height: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        ...TREE_ROW_BOX_STYLE,
                        ...(isDragOver
                            ? {
                                  backgroundColor:
                                      "color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))",
                              }
                            : contextMenuFolderPath === row.path
                              ? {
                                    backgroundColor:
                                        "color-mix(in srgb, var(--accent) 22%, transparent)",
                                }
                              : stickyTop != null
                                ? { backgroundColor: "var(--bg-secondary)" }
                                : {}),
                        outline: isDragOver
                            ? "1px solid var(--accent)"
                            : "none",
                        opacity: isDraggingFolder ? 0.4 : 1,
                        ...(stickyTop != null && {
                            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                        }),
                    }}
                >
                    <ChevronIcon open={!!isExpanded} size={metrics.smallIcon} />
                    <FolderIcon
                        open={!!isExpanded || isDragOver}
                        size={metrics.mediumIcon}
                    />
                    <span className={TREE_LABEL_CLASSNAME}>{row.name}</span>
                </button>
            );
        }

        if (row.kind === "create") {
            const createOffset = Math.round(14 * metrics.scale);
            return (
                <div
                    className="flex items-center gap-1.5 py-0.5"
                    style={{
                        paddingLeft: paddingLeft + createOffset,
                        fontSize: metrics.fontSize,
                        minHeight: metrics.rowHeight,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    {row.mode === "folder" ? (
                        <FolderIcon open={false} size={metrics.mediumIcon} />
                    ) : (
                        <NoteIcon size={metrics.smallIcon} />
                    )}
                    <input
                        ref={createInputRef}
                        value={newItemName}
                        onChange={(event) =>
                            onNewItemNameChange(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === "Enter") onCreateConfirm();
                            if (event.key === "Escape") onCreateCancel();
                        }}
                        onBlur={onCreateConfirm}
                        placeholder={
                            row.mode === "folder" ? "New folder" : "New note"
                        }
                        className="flex-1 text-xs px-1.5 py-0.5 rounded outline-none min-w-0"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            border: "1px solid var(--accent)",
                            color: "var(--text-primary)",
                            fontSize: metrics.inputFontSize,
                        }}
                    />
                </div>
            );
        }

        if (row.kind === "pdf") {
            const entry = row.entry;
            const isActive = activeEntryPath === entry.path;
            const isSelected = selectedEntryPaths.has(entry.path);
            return (
                <div
                    role="button"
                    tabIndex={0}
                    data-note-id={entry.id}
                    data-selected={isSelected ? "true" : "false"}
                    data-active={isActive ? "true" : "false"}
                    onMouseDown={(e) => onPdfMouseDown(entry, e)}
                    onClick={(e) =>
                        onPdfClick(entry, {
                            cmd: e.metaKey || e.ctrlKey,
                            shift: e.shiftKey,
                        })
                    }
                    onAuxClick={(e) => onPdfAuxClick(entry, e)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onPdfClick(entry, { cmd: false, shift: false });
                        }
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onPdfContextMenu(event, entry);
                    }}
                    className="file-tree-row flex items-center gap-1.5 text-left py-1 text-xs rounded cursor-pointer"
                    style={{
                        paddingLeft: paddingLeft + noteOffset,
                        ...(isSelected
                            ? {
                                  backgroundColor:
                                      "color-mix(in srgb, var(--accent) 22%, transparent)",
                              }
                            : {}),
                        color: "var(--text-primary)",
                        boxShadow: isActive
                            ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)"
                            : "none",
                        minHeight: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <PdfIcon size={metrics.smallIcon} />
                    <span className={TREE_LABEL_CLASSNAME}>
                        {getVaultEntryDisplayName(entry, showExtensions)}
                    </span>
                </div>
            );
        }

        if (row.kind === "file") {
            const entry = row.entry;
            const isActive = activeEntryPath === entry.path;
            const isSelected = selectedEntryPaths.has(entry.path);

            if (isRenamingEntry) {
                return (
                    <div
                        className="flex items-center gap-1.5 py-0.5"
                        style={{
                            paddingLeft: paddingLeft + noteOffset,
                            fontSize: metrics.fontSize,
                            minHeight: metrics.rowHeight,
                            ...TREE_ROW_BOX_STYLE,
                        }}
                    >
                        {entry.extension.toLowerCase() === "excalidraw" ? (
                            <MapFileIcon size={metrics.smallIcon} />
                        ) : isImageLikeVaultEntry(entry) ? (
                            <ImageFileIcon size={metrics.smallIcon} />
                        ) : (
                            <GenericFileIcon size={metrics.smallIcon} />
                        )}
                        <input
                            ref={renameInputRef}
                            defaultValue={entry.file_name}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    const value =
                                        event.currentTarget.value.trim();
                                    if (value) {
                                        onRenameEntryConfirm(entry, value);
                                    } else {
                                        onRenameCancel();
                                    }
                                }
                                if (event.key === "Escape") {
                                    onRenameCancel();
                                }
                            }}
                            onBlur={() => {
                                const value =
                                    renameInputRef.current?.value.trim() ?? "";
                                if (value) {
                                    onRenameEntryConfirm(entry, value);
                                } else {
                                    onRenameCancel();
                                }
                            }}
                            className="flex-1 text-xs px-1.5 py-0.5 rounded outline-none min-w-0"
                            style={{
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--accent)",
                                color: "var(--text-primary)",
                                fontSize: metrics.inputFontSize,
                            }}
                        />
                    </div>
                );
            }

            return (
                <div
                    role="button"
                    tabIndex={0}
                    data-file-path={entry.relative_path}
                    data-selected={isSelected ? "true" : "false"}
                    data-active={isActive ? "true" : "false"}
                    onMouseDown={(e) => onFileMouseDown(entry, e)}
                    onClick={(e) =>
                        onFileClick(entry, {
                            cmd: e.metaKey || e.ctrlKey,
                            shift: e.shiftKey,
                        })
                    }
                    onAuxClick={(e) => onFileAuxClick(entry, e)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onFileClick(entry, { cmd: false, shift: false });
                        }
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFileContextMenu(event, entry);
                    }}
                    className="file-tree-row flex items-center gap-1.5 text-left py-1 text-xs rounded cursor-pointer"
                    style={{
                        paddingLeft: paddingLeft + noteOffset,
                        ...(isSelected
                            ? {
                                  backgroundColor:
                                      "color-mix(in srgb, var(--accent) 22%, transparent)",
                              }
                            : {}),
                        color: "var(--text-primary)",
                        boxShadow: isActive
                            ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)"
                            : "none",
                        minHeight: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    {entry.extension.toLowerCase() === "excalidraw" ? (
                        <MapFileIcon size={metrics.smallIcon} />
                    ) : isImageLikeVaultEntry(entry) ? (
                        <ImageFileIcon size={metrics.smallIcon} />
                    ) : (
                        <GenericFileIcon size={metrics.smallIcon} />
                    )}
                    <span className={TREE_LABEL_CLASSNAME}>
                        {getVaultEntryDisplayName(entry, showExtensions)}
                    </span>
                </div>
            );
        }

        const note = row.note;
        const isActive = note.id === activeNoteId;
        const isSelected = selectedNoteIds.has(note.id);
        const isDraggingThis = draggingNoteIds.has(note.id);

        if (isRenamingNote) {
            return (
                <div
                    className="flex items-center gap-1.5 py-0.5"
                    style={{
                        paddingLeft: paddingLeft + noteOffset,
                        fontSize: metrics.fontSize,
                        minHeight: metrics.rowHeight,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <NoteIcon size={metrics.smallIcon} />
                    <input
                        ref={renameInputRef}
                        defaultValue={note.title}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                const value = e.currentTarget.value.trim();
                                if (value) onRenameNoteConfirm(note, value);
                                else onRenameCancel();
                            }
                            if (e.key === "Escape") onRenameCancel();
                        }}
                        onBlur={() => {
                            const value =
                                renameInputRef.current?.value.trim() ?? "";
                            if (value) onRenameNoteConfirm(note, value);
                            else onRenameCancel();
                        }}
                        className="flex-1 text-xs px-1.5 py-0.5 rounded outline-none min-w-0"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            border: "1px solid var(--accent)",
                            color: "var(--text-primary)",
                            fontSize: metrics.inputFontSize,
                        }}
                    />
                </div>
            );
        }

        return (
            <div
                role="button"
                tabIndex={0}
                data-note-id={note.id}
                data-folder-path={getParentPath(note.id)}
                data-selected={isSelected ? "true" : "false"}
                data-active={isActive ? "true" : "false"}
                data-drag-over={isDragOver ? "true" : "false"}
                onMouseDown={(e) => onNoteMouseDown(note, e)}
                onClick={(e) =>
                    onNoteClick(note, {
                        cmd: e.metaKey || e.ctrlKey,
                        shift: e.shiftKey,
                    })
                }
                onAuxClick={(e) => onNoteAuxClick(note, e)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNoteClick(note, { cmd: false, shift: false });
                    }
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onNoteContextMenu(event, note);
                }}
                className="file-tree-row flex items-center gap-1.5 text-left py-1 text-xs rounded cursor-pointer"
                style={{
                    paddingLeft: paddingLeft + noteOffset,
                    ...(isSelected
                        ? {
                              backgroundColor:
                                  "color-mix(in srgb, var(--accent) 22%, transparent)",
                          }
                        : {}),
                    color: "var(--text-primary)",
                    boxShadow: isActive
                        ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)"
                        : "none",
                    opacity: isDraggingThis ? 0.4 : 1,
                    minHeight: metrics.rowHeight,
                    fontSize: metrics.fontSize,
                    ...TREE_ROW_BOX_STYLE,
                }}
            >
                <NoteIcon size={metrics.smallIcon} />
                <span className={TREE_LABEL_CLASSNAME}>
                    {getNoteDisplayName(note, showExtensions)}
                </span>
            </div>
        );
    },
    (prev, next) => {
        // Custom comparator: only re-render when the row's visual state changes.
        // Callback props are stable (ref-backed) so they don't need comparison.
        if (prev.row !== next.row) return false;
        if (prev.metrics !== next.metrics) return false;
        if (prev.stickyTop !== next.stickyTop) return false;
        if (prev.renamingNoteId !== next.renamingNoteId) return false;
        if (prev.renamingFolderPath !== next.renamingFolderPath) return false;
        if (prev.renamingEntryPath !== next.renamingEntryPath) return false;
        if (prev.creatingMode !== next.creatingMode) return false;
        if (prev.newItemName !== next.newItemName) return false;
        if (prev.showExtensions !== next.showExtensions) return false;

        const path = prev.row.path;

        if (prev.row.kind === "folder") {
            if (
                prev.expandedFolders.has(path) !==
                next.expandedFolders.has(path)
            )
                return false;
            if ((prev.dragOverPath === path) !== (next.dragOverPath === path))
                return false;
            if (
                (prev.contextMenuFolderPath === path) !==
                (next.contextMenuFolderPath === path)
            )
                return false;
            if (
                (prev.draggingFolderPath === path) !==
                (next.draggingFolderPath === path)
            )
                return false;
            return true;
        }

        if (prev.row.kind === "create") {
            return true;
        }

        if (prev.row.kind === "pdf" || prev.row.kind === "file") {
            const entryPath = prev.row.entry.path;
            if (
                (prev.activeEntryPath === entryPath) !==
                (next.activeEntryPath === entryPath)
            ) {
                return false;
            }
            if (
                prev.selectedEntryPaths.has(entryPath) !==
                next.selectedEntryPaths.has(entryPath)
            ) {
                return false;
            }
            return true;
        }

        const noteId = prev.row.note.id;
        if ((prev.activeNoteId === noteId) !== (next.activeNoteId === noteId))
            return false;
        if (
            prev.selectedNoteIds.has(noteId) !==
            next.selectedNoteIds.has(noteId)
        )
            return false;
        if (
            prev.draggingNoteIds.has(noteId) !==
            next.draggingNoteIds.has(noteId)
        )
            return false;
        if ((prev.dragOverPath === path) !== (next.dragOverPath === path))
            return false;

        return true;
    },
);

// --- Open vault form ---

function OpenVaultForm() {
    const openVault = useVaultStore((s) => s.openVault);
    const cancelOpenVault = useVaultStore((s) => s.cancelOpenVault);
    const isLoading = useVaultStore((s) => s.isLoading);
    const vaultOpenState = useVaultStore((s) => s.vaultOpenState);
    const error = useVaultStore((s) => s.error);
    const progressUnit = vaultOpenState.message.toLowerCase().includes("link")
        ? "links"
        : "notes";

    const handleOpen = async () => {
        const selected = await open({
            directory: true,
            title: "Select vault",
        });
        if (selected) openVault(selected);
    };

    return (
        <div className="p-4 flex flex-col gap-3">
            <p
                className="text-sm font-medium"
                style={{ color: "var(--text-primary)" }}
            >
                Open vault
            </p>
            <button
                onClick={handleOpen}
                disabled={isLoading}
                className="text-sm py-1.5 rounded font-medium cursor-pointer"
                style={{ backgroundColor: "var(--accent)", color: "#fff" }}
            >
                {isLoading ? "Opening…" : "Select folder"}
            </button>
            {isLoading && (
                <div
                    className="rounded-md p-3 text-xs"
                    style={{
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                    }}
                >
                    <div style={{ color: "var(--text-primary)" }}>
                        {vaultOpenState.message || "Preparing vault..."}
                    </div>
                    <div className="mt-1">
                        {vaultOpenState.total > 0
                            ? `${vaultOpenState.processed.toLocaleString()} / ${vaultOpenState.total.toLocaleString()} ${progressUnit}`
                            : "Calculating progress..."}
                    </div>
                    <button
                        type="button"
                        onClick={() => void cancelOpenVault()}
                        className="mt-3 text-xs py-1 px-2 rounded"
                        style={{
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                        }}
                    >
                        Cancel
                    </button>
                </div>
            )}
            {error && (
                <p className="text-xs" style={{ color: "#ef4444" }}>
                    {error}
                </p>
            )}
        </div>
    );
}

// --- Drag state ---

interface DragState {
    item:
        | { kind: "notes"; notes: NoteDto[] }
        | { kind: "folder"; path: string }
        | { kind: "pdf"; entry: VaultEntryDto }
        | { kind: "file"; entry: VaultEntryDto };
    startX: number;
    startY: number;
    active: boolean;
}

// --- Main FileTree ---

export function FileTree() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const notes = useVaultStore((s) => s.notes);
    const entries = useVaultStore((s) => s.entries ?? []);
    const structureRevision = useVaultStore((s) => s.structureRevision);
    const contentRevision = useVaultStore((s) => s.contentRevision);
    const createNote = useVaultStore((s) => s.createNote);
    const createFolder = useVaultStore((s) => s.createFolder);
    const deleteNote = useVaultStore((s) => s.deleteNote);
    const deleteFolder = useVaultStore((s) => s.deleteFolder);
    const renameNote = useVaultStore((s) => s.renameNote);
    const refreshStructure = useVaultStore((s) => s.refreshStructure);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchContent = useVaultStore((s) => s.touchContent);
    const activeNoteId = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeEntryPath = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        if (tab && (isPdfTab(tab) || isFileTab(tab))) {
            return tab.path;
        }
        return null;
    });
    const openNote = useEditorStore((s) => s.openNote);
    const closeTab = useEditorStore((s) => s.closeTab);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const fileTreeScale = useSettingsStore((s) => s.fileTreeScale);
    const fileTreeContentMode = useSettingsStore((s) => s.fileTreeContentMode);
    const fileTreeShowExtensions = useSettingsStore(
        (s) => s.fileTreeShowExtensions,
    );

    const [sortMode, setSortMode] = useState<SortMode>(
        () => (localStorage.getItem(SORT_KEY) as SortMode | null) ?? "name_asc",
    );
    const [revealActive, setRevealActive] = useState(
        () => localStorage.getItem(REVEAL_KEY) === "true",
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        new Set(),
    );
    const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(
        new Set(),
    );
    const [selectedEntryPaths, setSelectedEntryPaths] = useState<Set<string>>(
        new Set(),
    );
    const [draggingNoteIds, setDraggingNoteIds] = useState<Set<string>>(
        new Set(),
    );
    const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(
        null,
    );
    const [dragOverPath, setDragOverPath] = useState<string | null>(null);
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(
        null,
    );
    const [dragLabel, setDragLabel] = useState<string | null>(null);
    const [sortMenuOpen, setSortMenuOpen] = useState(false);
    const [creatingMode, setCreatingMode] = useState<"note" | "folder" | null>(
        null,
    );
    const [newItemName, setNewItemName] = useState("");
    const [creatingParentPath, setCreatingParentPath] = useState("");
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<FileTreeContextPayload> | null>(null);
    const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
    const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(
        null,
    );
    const [renamingEntryPath, setRenamingEntryPath] = useState<string | null>(
        null,
    );
    const [, setClipboardVersion] = useState(0);
    const [focusedFolderPath, setFocusedFolderPath] = useState("");

    const treeScrollRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef<DragState | null>(null);
    const dragOverPathRef = useRef<string | null>(null);
    const wasJustDraggingRef = useRef(false);
    const rafScrollRef = useRef(0);
    const pendingRevealRef = useRef<string | null>(null);
    const lastClickedEntryPathRef = useRef<string | null>(null);
    const lastClickedRowKeyRef = useRef<string | null>(null);
    const flatRowsRef = useRef<FlatTreeRow[]>([]);
    const renameGuardRef = useRef(false);

    // Virtualization state
    const [viewportHeight, setViewportHeight] = useState(600);
    const [scrollTop, setScrollTop] = useState(0);

    const activeTreePath = useMemo(() => {
        if (activeNoteId) return activeNoteId;
        if (!activeEntryPath) return null;
        return (
            entries.find((entry) => entry.path === activeEntryPath)
                ?.relative_path ?? null
        );
    }, [activeEntryPath, activeNoteId, entries]);

    const visibleSelectedNoteIds = useMemo(() => {
        // Explicit selection (1+): show it
        if (selectedNoteIds.size > 0) return selectedNoteIds;
        // No explicit selection: follow the active note
        if (!activeNoteId) return new Set<string>();
        return new Set([activeNoteId]);
    }, [activeNoteId, selectedNoteIds]);
    const visibleSelectedEntryPaths = useMemo(() => {
        if (selectedEntryPaths.size > 0) return selectedEntryPaths;
        if (!activeEntryPath) return new Set<string>();
        return new Set([activeEntryPath]);
    }, [activeEntryPath, selectedEntryPaths]);
    const treeRevision =
        sortMode === "modified_desc" || sortMode === "modified_asc"
            ? `${structureRevision}:${contentRevision}`
            : structureRevision;
    const visibleEntries = useMemo(
        () =>
            entries.filter((entry) => {
                if (entry.kind === "note") return false;
                if (entry.kind === "folder") return true;
                if (fileTreeContentMode === "all_files") return true;
                return entry.kind === "pdf";
            }),
        [entries, fileTreeContentMode],
    );
    // Intentionally keyed by revisions instead of the full notes array to avoid
    // rebuilding the folder tree for content-only updates.
    const tree = useMemo(
        () => buildTree(notes, visibleEntries),
        // visibleEntries changes only when entries/settings change
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [treeRevision, visibleEntries],
    );
    const allFolderPaths = useMemo(() => getAllFolderPaths(tree), [tree]);
    const revealedFolders = useMemo(() => {
        if (!revealActive || !activeTreePath) return [];
        const parts = activeTreePath.split("/");
        return parts
            .slice(0, -1)
            .map((_, i) => parts.slice(0, i + 1).join("/"));
    }, [activeTreePath, revealActive]);
    const visibleExpandedFolders = useMemo(() => {
        if (revealedFolders.length === 0) return expandedFolders;
        // If all revealed folders are already expanded, keep same reference
        if (revealedFolders.every((p) => expandedFolders.has(p)))
            return expandedFolders;
        const next = new Set(expandedFolders);
        revealedFolders.forEach((path) => next.add(path));
        return next;
    }, [expandedFolders, revealedFolders]);
    const flatRows = useMemo(
        () => flattenTreeRows(tree, visibleExpandedFolders, sortMode),
        [sortMode, tree, visibleExpandedFolders],
    );
    flatRowsRef.current = flatRows;
    const displayRows = useMemo(() => {
        if (!creatingMode) return flatRows;

        const createRow: FlatTreeRow = {
            kind: "create",
            mode: creatingMode,
            parentPath: creatingParentPath,
            path: creatingParentPath
                ? `${creatingParentPath}/__creating__`
                : "__creating__",
            depth: creatingParentPath
                ? creatingParentPath.split("/").length
                : 0,
        };

        if (!creatingParentPath) {
            return [createRow, ...flatRows];
        }

        const folderIndex = flatRows.findIndex(
            (row) => row.kind === "folder" && row.path === creatingParentPath,
        );
        if (folderIndex === -1) {
            return [createRow, ...flatRows];
        }

        return [
            ...flatRows.slice(0, folderIndex + 1),
            createRow,
            ...flatRows.slice(folderIndex + 1),
        ];
    }, [creatingMode, creatingParentPath, flatRows]);
    const canCollapseAll = expandedFolders.size > 0;
    const treeClipboard = readFileTreeClipboard(vaultPath);
    const treeScale = fileTreeScale / 100;
    const metrics: TreeMetrics = useMemo(
        () => ({
            scale: treeScale,
            rowHeight: Math.round(28 * treeScale),
            fontSize: Math.max(12, Math.round(12 * treeScale)),
            indentStep: Math.round(16 * treeScale),
            basePadding: Math.round(8 * treeScale),
            smallIcon: Math.max(13, Math.round(13 * treeScale)),
            mediumIcon: Math.max(15, Math.round(15 * treeScale)),
            toolbarButton: Math.max(26, Math.round(26 * treeScale)),
            toolbarIconScale: treeScale,
            inputFontSize: Math.max(12, Math.round(12 * treeScale)),
        }),
        [treeScale],
    );
    // --- Virtualization ---

    const contentHeight = displayRows.length * metrics.rowHeight;
    const bottomScrollBuffer = metrics.rowHeight * 0.75;
    const totalHeight = contentHeight + bottomScrollBuffer;
    const startIdx = Math.max(
        0,
        Math.floor(scrollTop / metrics.rowHeight) - VIRTUAL_OVERSCAN,
    );
    const endIdx = Math.min(
        displayRows.length,
        Math.ceil((scrollTop + viewportHeight) / metrics.rowHeight) +
            VIRTUAL_OVERSCAN,
    );
    const visibleRows = displayRows.slice(startIdx, endIdx);
    const offsetY = startIdx * metrics.rowHeight;

    // --- Sticky folder overlay ---

    // Precompute: for each folder row index, what's the index of its last descendant?
    const folderLastDescendant = useMemo(() => {
        const map = new Map<number, number>();
        const stack: number[] = [];
        for (let i = 0; i < displayRows.length; i++) {
            while (
                stack.length > 0 &&
                displayRows[stack[stack.length - 1]].depth >=
                    displayRows[i].depth
            ) {
                map.set(stack.pop()!, i - 1);
            }
            if (displayRows[i].kind === "folder") {
                stack.push(i);
            }
        }
        while (stack.length > 0) {
            map.set(stack.pop()!, displayRows.length - 1);
        }
        return map;
    }, [displayRows]);

    const contextMenuFolderPath =
        contextMenu?.payload.kind === "folder"
            ? contextMenu.payload.path
            : null;

    // Compute which folders should appear as sticky overlay headers
    const stickyFolders = useMemo(() => {
        if (displayRows.length === 0) return [];

        const result: {
            row: FlatTreeRow & { kind: "folder" };
            top: number;
        }[] = [];
        let searchStart = 0;
        let searchEnd = displayRows.length - 1;

        for (let depth = 0; depth < 50; depth++) {
            const stickyPosition = depth * metrics.rowHeight;
            let best: {
                row: FlatTreeRow & { kind: "folder" };
                idx: number;
                lastIdx: number;
            } | null = null;

            for (let i = searchStart; i <= searchEnd; i++) {
                const row = displayRows[i];
                if (row.kind !== "folder" || row.depth !== depth) continue;

                const rowTop = i * metrics.rowHeight;
                if (rowTop > scrollTop + stickyPosition) break;

                const lastIdx = folderLastDescendant.get(i) ?? i;
                const sectionBottom = (lastIdx + 1) * metrics.rowHeight;

                if (
                    sectionBottom >
                    scrollTop + stickyPosition + metrics.rowHeight
                ) {
                    best = {
                        row: row as FlatTreeRow & { kind: "folder" },
                        idx: i,
                        lastIdx,
                    };
                }
            }

            if (!best) break;

            const sectionBottom = (best.lastIdx + 1) * metrics.rowHeight;
            const maxTop = sectionBottom - scrollTop - metrics.rowHeight;
            const top = Math.min(stickyPosition, maxTop);

            result.push({ row: best.row, top });

            searchStart = best.idx + 1;
            searchEnd = best.lastIdx;
        }

        return result;
    }, [displayRows, scrollTop, metrics.rowHeight, folderLastDescendant]);

    const stickyFolderPaths = useMemo(
        () => new Set(stickyFolders.map((f) => f.row.path)),
        [stickyFolders],
    );

    // Track viewport size
    useEffect(() => {
        const el = treeScrollRef.current;
        if (!el) return;
        const syncViewportMetrics = () => {
            setViewportHeight(el.clientHeight);
            setScrollTop(el.scrollTop);
        };

        syncViewportMetrics();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", syncViewportMetrics);
            return () =>
                window.removeEventListener("resize", syncViewportMetrics);
        }

        const ro = new ResizeObserver(() => {
            syncViewportMetrics();
        });
        ro.observe(el);
        window.addEventListener("resize", syncViewportMetrics);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", syncViewportMetrics);
        };
    }, []);

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== "vaultai.fileTree.clipboard") return;
            setClipboardVersion((value) => value + 1);
        };

        window.addEventListener("storage", handleStorage);
        return () => window.removeEventListener("storage", handleStorage);
    }, []);

    useEffect(() => {
        const el = treeScrollRef.current;
        if (!el) return;

        const maxScrollTop = Math.max(0, totalHeight - el.clientHeight);
        if (el.scrollTop > maxScrollTop) {
            el.scrollTop = maxScrollTop;
        }

        if (scrollTop !== el.scrollTop) {
            setScrollTop(el.scrollTop);
        }
    }, [
        scrollTop,
        totalHeight,
        viewportHeight,
        displayRows.length,
        metrics.rowHeight,
    ]);

    // RAF-batched scroll handler
    const handleTreeScroll = useCallback(() => {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = requestAnimationFrame(() => {
            const el = treeScrollRef.current;
            if (el) setScrollTop(el.scrollTop);
        });
    }, []);

    const handleRenameCancel = useCallback(() => {
        setRenamingNoteId(null);
        setRenamingFolderPath(null);
        setRenamingEntryPath(null);
    }, []);

    // Scroll to row by index helper
    const scrollToRow = useCallback(
        (rowIdx: number, behavior: ScrollBehavior = "smooth") => {
            const container = treeScrollRef.current;
            if (!container) return;
            const rowTop = rowIdx * metrics.rowHeight;
            const nextScrollTop =
                rowTop - container.clientHeight / 2 + metrics.rowHeight / 2;
            const maxScrollTop = Math.max(
                0,
                totalHeight - container.clientHeight,
            );
            const top = Math.min(maxScrollTop, Math.max(0, nextScrollTop));
            if (typeof container.scrollTo === "function") {
                container.scrollTo({ top, behavior });
                return;
            }
            container.scrollTop = top;
        },
        [metrics.rowHeight, totalHeight],
    );

    // Clear stale single-item selection when the active file changes
    // (e.g. user switched tabs, navigated via wikilink, Quick Switcher, etc.)
    // Multi-selections (2+) are preserved until user action clears them.
    useEffect(() => {
        setSelectedNoteIds((prev) => (prev.size <= 1 ? new Set() : prev));
        setSelectedEntryPaths((prev) => (prev.size <= 1 ? new Set() : prev));
    }, [activeNoteId, activeEntryPath]);

    // Reveal active: scroll to the active tree row using index-based calculation
    useEffect(() => {
        if (!revealActive || !activeTreePath) return;

        const rowIdx = displayRows.findIndex(
            (row) =>
                row.kind !== "folder" &&
                row.kind !== "create" &&
                row.path === activeTreePath,
        );
        if (rowIdx === -1) return;

        // Skip scroll if the row is already within the visible viewport
        const container = treeScrollRef.current;
        if (container) {
            const rowTop = rowIdx * metrics.rowHeight;
            const rowBottom = rowTop + metrics.rowHeight;
            const visibleTop = container.scrollTop;
            const visibleBottom = visibleTop + container.clientHeight;
            if (rowTop >= visibleTop && rowBottom <= visibleBottom) return;
        }

        // Defer to next frame so the DOM has the correct totalHeight
        const raf = requestAnimationFrame(() => scrollToRow(rowIdx, "instant"));
        return () => cancelAnimationFrame(raf);
    }, [
        activeTreePath,
        revealActive,
        displayRows,
        scrollToRow,
        metrics.rowHeight,
    ]);

    // Handle REVEAL_NOTE_IN_TREE_EVENT: expand folders + defer scroll
    useEffect(() => {
        const handleReveal = (event: Event) => {
            const noteId = (event as CustomEvent<{ noteId?: string }>).detail
                ?.noteId;
            if (!noteId) return;

            const parts = noteId.split("/");
            const folders = parts
                .slice(0, -1)
                .map((_, i) => parts.slice(0, i + 1).join("/"));

            setExpandedFolders((prev) => new Set([...prev, ...folders]));
            setSelectedNoteIds(new Set([noteId]));
            lastClickedRowKeyRef.current = `note:${noteId}`;
            pendingRevealRef.current = noteId;
        };

        window.addEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
        return () =>
            window.removeEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
    }, []);

    // Scroll to pending reveal note after visible tree rows update
    useEffect(() => {
        const noteId = pendingRevealRef.current;
        if (!noteId) return;

        const rowIdx = displayRows.findIndex(
            (r) => r.kind === "note" && r.note.id === noteId,
        );
        if (rowIdx === -1) return;

        pendingRevealRef.current = null;
        requestAnimationFrame(() => scrollToRow(rowIdx));
    }, [displayRows, scrollToRow]);

    const applyMovedIds = useCallback((movedIds: Map<string, string>) => {
        if (movedIds.size === 0) return;

        setSelectedNoteIds((prev) => {
            const next = new Set(prev);
            for (const [fromId, toId] of movedIds) {
                if (!next.delete(fromId)) continue;
                next.add(toId);
            }
            return next;
        });
        const currentAnchor = lastClickedRowKeyRef.current;
        if (currentAnchor?.startsWith("note:")) {
            const noteId = currentAnchor.slice("note:".length);
            lastClickedRowKeyRef.current = `note:${movedIds.get(noteId) ?? noteId}`;
        }
    }, []);

    const applyMoveOperations = useCallback(
        async (
            operations: { fromId: string; note: NoteDto; toPath: string }[],
        ) => {
            const movedIds = new Map<string, string>();

            for (const operation of operations) {
                const updated = await renameNote(
                    operation.fromId,
                    operation.toPath,
                );
                if (!updated) continue;

                movedIds.set(operation.fromId, updated.id);
                useEditorStore.setState((s) => ({
                    tabs: s.tabs.map((tab) =>
                        isNoteTab(tab) && tab.noteId === operation.fromId
                            ? {
                                  ...tab,
                                  noteId: updated.id,
                                  title: updated.title,
                              }
                            : tab,
                    ),
                }));
            }

            applyMovedIds(movedIds);
            return movedIds;
        },
        [applyMovedIds, renameNote],
    );

    const relocateFolder = useCallback(
        async (folderPath: string, nextFolderPath: string) => {
            if (folderPath === nextFolderPath) return null;
            const sourceAbsolutePath = vaultPath
                ? `${vaultPath}/${folderPath}`
                : folderPath;
            const nextAbsolutePath = vaultPath
                ? `${vaultPath}/${nextFolderPath}`
                : nextFolderPath;

            try {
                await vaultInvoke("move_folder", {
                    relativePath: folderPath,
                    newRelativePath: nextFolderPath,
                });

                useEditorStore.setState((state) => ({
                    tabs: state.tabs.map((tab) => {
                        if (
                            isNoteTab(tab) &&
                            (tab.noteId === folderPath ||
                                tab.noteId.startsWith(`${folderPath}/`))
                        ) {
                            return {
                                ...tab,
                                noteId: movePathPrefix(
                                    tab.noteId,
                                    folderPath,
                                    nextFolderPath,
                                ),
                            };
                        }

                        if (
                            isPdfTab(tab) &&
                            (tab.path === sourceAbsolutePath ||
                                tab.path.startsWith(`${sourceAbsolutePath}/`))
                        ) {
                            return {
                                ...tab,
                                entryId: movePathPrefix(
                                    tab.entryId,
                                    folderPath,
                                    nextFolderPath,
                                ),
                                path: movePathPrefix(
                                    tab.path,
                                    sourceAbsolutePath,
                                    nextAbsolutePath,
                                ),
                            };
                        }

                        if (
                            isFileTab(tab) &&
                            (tab.relativePath === folderPath ||
                                tab.relativePath.startsWith(`${folderPath}/`))
                        ) {
                            const nextRelativePath = movePathPrefix(
                                tab.relativePath,
                                folderPath,
                                nextFolderPath,
                            );
                            return {
                                ...tab,
                                relativePath: nextRelativePath,
                                path: movePathPrefix(
                                    tab.path,
                                    sourceAbsolutePath,
                                    nextAbsolutePath,
                                ),
                                title:
                                    nextRelativePath.split("/").pop() ??
                                    tab.title,
                            };
                        }

                        return tab;
                    }),
                }));

                setSelectedNoteIds((prev) => {
                    const next = new Set<string>();
                    for (const noteId of prev) {
                        next.add(
                            movePathPrefix(noteId, folderPath, nextFolderPath),
                        );
                    }
                    return next;
                });
                setSelectedEntryPaths((prev) => {
                    const next = new Set<string>();
                    for (const entryPath of prev) {
                        next.add(
                            movePathPrefix(
                                entryPath,
                                sourceAbsolutePath,
                                nextAbsolutePath,
                            ),
                        );
                    }
                    return next;
                });
                setFocusedFolderPath(nextFolderPath);

                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    for (const path of prev) {
                        if (
                            path === folderPath ||
                            path.startsWith(`${folderPath}/`)
                        ) {
                            next.delete(path);
                            next.add(
                                movePathPrefix(
                                    path,
                                    folderPath,
                                    nextFolderPath,
                                ),
                            );
                        }
                    }
                    return next;
                });

                await refreshStructure();
                return nextFolderPath;
            } catch (error) {
                console.error("Error moving folder:", error);
                return null;
            }
        },
        [refreshStructure, vaultPath],
    );

    const moveFolder = useCallback(
        (folderPath: string, targetFolder: string) => {
            const folderName = getBaseName(folderPath);
            const nextFolderPath = targetFolder
                ? `${targetFolder}/${folderName}`
                : folderName;
            return relocateFolder(folderPath, nextFolderPath);
        },
        [relocateFolder],
    );

    const relocateVaultEntry = useCallback(
        async (entry: VaultEntryDto, nextRelativePath: string) => {
            if (!nextRelativePath || nextRelativePath === entry.relative_path) {
                return entry;
            }

            try {
                const updated = await vaultInvoke<VaultEntryDto>(
                    "move_vault_entry",
                    {
                        relativePath: entry.relative_path,
                        newRelativePath: nextRelativePath,
                    },
                );

                useEditorStore.setState((state) => ({
                    tabs: state.tabs.map((tab) => {
                        if (isPdfTab(tab) && tab.path === entry.path) {
                            return {
                                ...tab,
                                entryId: updated.id,
                                title: updated.title,
                                path: updated.path,
                            };
                        }

                        if (isFileTab(tab) && tab.path === entry.path) {
                            return {
                                ...tab,
                                relativePath: updated.relative_path,
                                title: updated.file_name,
                                path: updated.path,
                                mimeType: updated.mime_type,
                            };
                        }

                        return tab;
                    }),
                }));

                setSelectedEntryPaths(new Set([updated.path]));
                setFocusedFolderPath(getParentPath(updated.relative_path));
                await useVaultStore.getState().refreshEntries();
                return updated;
            } catch (error) {
                console.error("Error moving vault entry:", error);
                return null;
            }
        },
        [],
    );

    const moveVaultEntry = useCallback(
        async (entry: VaultEntryDto, targetFolder: string) => {
            const nextRelativePath = buildEntryMovePath(entry, targetFolder);
            if (!nextRelativePath) return null;
            return relocateVaultEntry(entry, nextRelativePath);
        },
        [relocateVaultEntry],
    );

    const getDragTargetFolder = useCallback(
        (item: DragState["item"], hoveredFolder: string | null) => {
            if (hoveredFolder === null) return null;

            if (item.kind === "folder") {
                return canMoveFolderToTarget(item.path, hoveredFolder)
                    ? hoveredFolder
                    : null;
            }

            if (item.kind === "pdf" || item.kind === "file") {
                return buildEntryMovePath(item.entry, hoveredFolder) !== null
                    ? hoveredFolder
                    : null;
            }

            return buildNoteMoveOperations(item.notes, hoveredFolder).length > 0
                ? hoveredFolder
                : null;
        },
        [],
    );

    const resetDragState = useCallback(() => {
        setDragPos(null);
        setDraggingNoteIds(new Set());
        setDraggingFolderPath(null);
        setDragLabel(null);
        emitFileTreeNoteDrag({
            phase: "cancel",
            x: 0,
            y: 0,
            notes: [],
        });
    }, []);

    // Mouse-based drag and drop
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const s = dragStateRef.current;
            if (!s) return;

            if (!s.active) {
                const dx = e.clientX - s.startX;
                const dy = e.clientY - s.startY;
                if (Math.sqrt(dx * dx + dy * dy) < 5) return;
                s.active = true;
                if (s.item.kind === "folder") {
                    setDraggingFolderPath(s.item.path);
                    setDragLabel(getBaseName(s.item.path));
                    emitFileTreeNoteDrag({
                        phase: "start",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        folder: {
                            path: s.item.path,
                            name: getBaseName(s.item.path),
                        },
                    });
                } else if (s.item.kind === "pdf") {
                    setDragLabel(s.item.entry.file_name);
                    emitFileTreeNoteDrag({
                        phase: "start",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        files: [
                            {
                                filePath: s.item.entry.path,
                                fileName: s.item.entry.file_name,
                                mimeType: "application/pdf",
                            },
                        ],
                    });
                } else if (s.item.kind === "file") {
                    setDragLabel(s.item.entry.file_name);
                    emitFileTreeNoteDrag({
                        phase: "start",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        files: [
                            {
                                filePath: s.item.entry.path,
                                fileName: s.item.entry.file_name,
                                mimeType:
                                    s.item.entry.mime_type ??
                                    "application/octet-stream",
                            },
                        ],
                    });
                } else {
                    setDraggingNoteIds(
                        new Set(s.item.notes.map((note) => note.id)),
                    );
                    setDragLabel(
                        s.item.notes.length > 1
                            ? `${s.item.notes.length} notes`
                            : (s.item.notes[0]?.title ?? null),
                    );
                    emitFileTreeNoteDrag({
                        phase: "start",
                        x: e.clientX,
                        y: e.clientY,
                        notes: s.item.notes.map((note) => ({
                            id: note.id,
                            title: note.title,
                            path: note.path,
                        })),
                    });
                }
            }

            setDragPos({ x: e.clientX, y: e.clientY });
            if (s.active) {
                if (s.item.kind === "notes") {
                    emitFileTreeNoteDrag({
                        phase: "move",
                        x: e.clientX,
                        y: e.clientY,
                        notes: s.item.notes.map((note) => ({
                            id: note.id,
                            title: note.title,
                            path: note.path,
                        })),
                    });
                } else if (s.item.kind === "folder") {
                    emitFileTreeNoteDrag({
                        phase: "move",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        folder: {
                            path: s.item.path,
                            name: getBaseName(s.item.path),
                        },
                    });
                } else if (s.item.kind === "pdf") {
                    emitFileTreeNoteDrag({
                        phase: "move",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        files: [
                            {
                                filePath: s.item.entry.path,
                                fileName: s.item.entry.file_name,
                                mimeType: "application/pdf",
                            },
                        ],
                    });
                } else if (s.item.kind === "file") {
                    emitFileTreeNoteDrag({
                        phase: "move",
                        x: e.clientX,
                        y: e.clientY,
                        notes: [],
                        files: [
                            {
                                filePath: s.item.entry.path,
                                fileName: s.item.entry.file_name,
                                mimeType:
                                    s.item.entry.mime_type ??
                                    "application/octet-stream",
                            },
                        ],
                    });
                }
            }

            const els = document.elementsFromPoint(e.clientX, e.clientY);
            const folderEl = els.find((el) =>
                el.hasAttribute("data-folder-path"),
            );
            const hoveredFolder =
                folderEl?.getAttribute("data-folder-path") ?? null;
            const folder = getDragTargetFolder(s.item, hoveredFolder);
            dragOverPathRef.current = folder;
            setDragOverPath(folder);
        };

        const onUp = async (e: MouseEvent) => {
            const s = dragStateRef.current;
            dragStateRef.current = null;

            if (!s?.active) return;

            if (s.item.kind === "notes") {
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: e.clientX,
                    y: e.clientY,
                    notes: s.item.notes.map((note) => ({
                        id: note.id,
                        title: note.title,
                        path: note.path,
                    })),
                });
            } else if (s.item.kind === "folder") {
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [],
                    folder: {
                        path: s.item.path,
                        name: getBaseName(s.item.path),
                    },
                });
            } else if (s.item.kind === "pdf") {
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [],
                    files: [
                        {
                            filePath: s.item.entry.path,
                            fileName: s.item.entry.file_name,
                            mimeType: "application/pdf",
                        },
                    ],
                });
            } else if (s.item.kind === "file") {
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [],
                    files: [
                        {
                            filePath: s.item.entry.path,
                            fileName: s.item.entry.file_name,
                            mimeType:
                                s.item.entry.mime_type ??
                                "application/octet-stream",
                        },
                    ],
                });
            }

            wasJustDraggingRef.current = true;
            requestAnimationFrame(() => {
                wasJustDraggingRef.current = false;
            });

            resetDragState();

            const folder = dragOverPathRef.current;
            dragOverPathRef.current = null;
            setDragOverPath(null);

            if (folder === null) return;

            if (s.item.kind === "folder") {
                await moveFolder(s.item.path, folder);
                return;
            }

            if (s.item.kind === "notes") {
                await applyMoveOperations(
                    buildNoteMoveOperations(s.item.notes, folder),
                );
                return;
            }

            if (s.item.kind === "pdf" || s.item.kind === "file") {
                await moveVaultEntry(s.item.entry, folder);
            }
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [
        applyMoveOperations,
        getDragTargetFolder,
        moveFolder,
        moveVaultEntry,
        resetDragState,
    ]);

    const handleToggleFolder = (path: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const handleFolderClick = useCallback((path: string) => {
        if (wasJustDraggingRef.current) return;
        setFocusedFolderPath(path);
        setSelectedEntryPaths(new Set());
        setSelectedNoteIds(new Set());
        handleToggleFolder(path);
    }, []);

    const handleSortSelect = (mode: SortMode) => {
        setSortMode(mode);
        localStorage.setItem(SORT_KEY, mode);
        setSortMenuOpen(false);
    };

    const applySelectionState = useCallback((selection: TreeSelectionState) => {
        setSelectedNoteIds(selection.noteIds);
        setSelectedEntryPaths(selection.entryPaths);
    }, []);

    const extendSelectionState = useCallback(
        (selection: TreeSelectionState) => {
            setSelectedNoteIds((prev) => {
                const next = new Set(prev);
                selection.noteIds.forEach((noteId) => next.add(noteId));
                return next;
            });
            setSelectedEntryPaths((prev) => {
                const next = new Set(prev);
                selection.entryPaths.forEach((entryPath) =>
                    next.add(entryPath),
                );
                return next;
            });
        },
        [],
    );

    const selectRowRange = useCallback(
        (targetKey: string, append: boolean) => {
            const anchorKey = lastClickedRowKeyRef.current;
            if (!anchorKey) {
                return false;
            }

            const rows = flatRowsRef.current;
            const startIndex = rows.findIndex(
                (row) => getSelectableRowKey(row) === anchorKey,
            );
            const endIndex = rows.findIndex(
                (row) => getSelectableRowKey(row) === targetKey,
            );
            if (startIndex === -1 || endIndex === -1) {
                return false;
            }

            const [from, to] =
                startIndex < endIndex
                    ? [startIndex, endIndex]
                    : [endIndex, startIndex];
            const selection = buildSelectionFromRows(rows.slice(from, to + 1));
            if (append) {
                extendSelectionState(selection);
            } else {
                applySelectionState(selection);
            }
            return true;
        },
        [applySelectionState, extendSelectionState],
    );

    const handleRevealToggle = () => {
        const next = !revealActive;
        if (!next) {
            // Preserve the currently visible tree state so nothing collapses
            setExpandedFolders(new Set(visibleExpandedFolders));
        }
        setRevealActive(next);
        localStorage.setItem(REVEAL_KEY, String(next));
    };

    const handleCollapseExpandAll = () => {
        if (canCollapseAll) {
            setExpandedFolders(new Set());
        } else {
            setExpandedFolders(new Set(allFolderPaths));
        }
    };

    const handleNoteMouseDown = useCallback(
        (note: NoteDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault(); // prevent text selection during drag
            const dragNotes =
                selectedNoteIds.size > 1 && selectedNoteIds.has(note.id)
                    ? notes.filter((item) => selectedNoteIds.has(item.id))
                    : [note];
            dragStateRef.current = {
                item: { kind: "notes", notes: dragNotes },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [notes, selectedNoteIds],
    );

    const handleFolderMouseDown = useCallback(
        (path: string, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragStateRef.current = {
                item: { kind: "folder", path },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [],
    );

    const openPdf = useEditorStore((s) => s.openPdf);

    const handlePdfClick = useCallback(
        (entry: VaultEntryDto, modifiers: { cmd: boolean; shift: boolean }) => {
            if (wasJustDraggingRef.current) return;
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const rowKey = `entry:${entry.path}`;
            if (modifiers.shift && selectRowRange(rowKey, modifiers.cmd)) {
                return;
            }
            if (modifiers.cmd) {
                const currentActiveEntry = activeEntryPath;
                setSelectedEntryPaths((prev) => {
                    const base =
                        prev.size === 0 && currentActiveEntry
                            ? new Set([currentActiveEntry])
                            : new Set(prev);
                    if (base.has(entry.path)) base.delete(entry.path);
                    else base.add(entry.path);
                    return base;
                });
                lastClickedEntryPathRef.current = entry.path;
                lastClickedRowKeyRef.current = rowKey;
                return;
            }
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set([entry.path]));
            lastClickedEntryPathRef.current = entry.path;
            lastClickedRowKeyRef.current = rowKey;
            openPdf(entry.id, entry.title, entry.path);
        },
        [activeEntryPath, openPdf, selectRowRange],
    );

    const handlePdfMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragStateRef.current = {
                item: { kind: "pdf", entry },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [],
    );

    const handlePdfContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) => {
            e.preventDefault();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const preserveSelection =
                selectedEntryPaths.size > 1 &&
                selectedEntryPaths.has(entry.path);
            if (!preserveSelection) {
                setSelectedNoteIds(new Set());
                setSelectedEntryPaths(new Set([entry.path]));
            }
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                payload: { kind: "pdf", entry },
            });
        },
        [selectedEntryPaths],
    );

    const handleOpenPdfInNewTab = useCallback(
        (entry: VaultEntryDto) => {
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
        },
        [insertExternalTab],
    );

    const handlePdfAuxClick = useCallback(
        (entry: VaultEntryDto, event: React.MouseEvent) => {
            if (event.button !== 1) return;
            if (wasJustDraggingRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set([entry.path]));
            lastClickedEntryPathRef.current = entry.path;
            handleOpenPdfInNewTab(entry);
        },
        [handleOpenPdfInNewTab],
    );

    const handleFileClick = useCallback(
        (entry: VaultEntryDto, modifiers: { cmd: boolean; shift: boolean }) => {
            if (wasJustDraggingRef.current) return;
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const rowKey = `entry:${entry.path}`;
            if (modifiers.shift && selectRowRange(rowKey, modifiers.cmd)) {
                return;
            }
            if (modifiers.cmd) {
                const currentActiveEntry = activeEntryPath;
                setSelectedEntryPaths((prev) => {
                    const base =
                        prev.size === 0 && currentActiveEntry
                            ? new Set([currentActiveEntry])
                            : new Set(prev);
                    if (base.has(entry.path)) base.delete(entry.path);
                    else base.add(entry.path);
                    return base;
                });
                lastClickedEntryPathRef.current = entry.path;
                lastClickedRowKeyRef.current = rowKey;
                return;
            }
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set([entry.path]));
            lastClickedEntryPathRef.current = entry.path;
            lastClickedRowKeyRef.current = rowKey;
            void openVaultFileEntry(entry);
        },
        [activeEntryPath, selectRowRange],
    );

    const handleFileMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragStateRef.current = {
                item: { kind: "file", entry },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [],
    );

    const handleFileContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) => {
            e.preventDefault();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const preserveSelection =
                selectedEntryPaths.size > 1 &&
                selectedEntryPaths.has(entry.path);
            if (!preserveSelection) {
                setSelectedNoteIds(new Set());
                setSelectedEntryPaths(new Set([entry.path]));
            }
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                payload: { kind: "file", entry },
            });
        },
        [selectedEntryPaths],
    );

    const handleOpenFileInNewTab = useCallback(async (entry: VaultEntryDto) => {
        try {
            await openVaultFileEntry(entry, { newTab: true });
        } catch (error) {
            console.error("Error opening file in new tab:", error);
        }
    }, []);

    const handleFileAuxClick = useCallback(
        (entry: VaultEntryDto, event: React.MouseEvent) => {
            if (event.button !== 1) return;
            if (wasJustDraggingRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set([entry.path]));
            lastClickedEntryPathRef.current = entry.path;
            void handleOpenFileInNewTab(entry);
        },
        [handleOpenFileInNewTab],
    );

    const handleMoveEntryToTrash = useCallback(async (entry: VaultEntryDto) => {
        const approved = await confirm(`Move "${entry.file_name}" to Trash?`, {
            title: "Move File to Trash",
            kind: "warning",
        });
        if (!approved) return;

        try {
            await moveVaultEntryToTrash(entry.relative_path);
            closeOpenTabsForVaultPath(entry.path);
            await useVaultStore.getState().refreshEntries();
        } catch (error) {
            console.error("Error moving vault entry to trash:", error);
        }
    }, []);

    const clearEntrySelection = useCallback(() => {
        setSelectedEntryPaths(new Set());
    }, []);

    const handleAddPdfToChat = useCallback((entry: VaultEntryDto) => {
        emitFileTreeNoteDrag({
            phase: "attach",
            x: 0,
            y: 0,
            notes: [],
            files: [
                {
                    filePath: entry.path,
                    fileName: entry.file_name,
                    mimeType: "application/pdf",
                },
            ],
        });
    }, []);

    const handleAddFileToChat = useCallback((entry: VaultEntryDto) => {
        emitFileTreeNoteDrag({
            phase: "attach",
            x: 0,
            y: 0,
            notes: [],
            files: [
                {
                    filePath: entry.path,
                    fileName: entry.file_name,
                    mimeType: entry.mime_type ?? "application/octet-stream",
                },
            ],
        });
    }, []);

    const readNoteContent = useCallback(
        (noteId: string) =>
            vaultInvoke<{ content: string }>("read_note", { noteId }),
        [],
    );

    const openTreeNote = useCallback(
        async (note: NoteDto) => {
            const { tabs: currentTabs } = useEditorStore.getState();
            const existing = currentTabs.find(
                (tab): tab is NoteTab =>
                    isNoteTab(tab) && tab.noteId === note.id,
            );
            if (existing) {
                openNote(note.id, note.title, existing.content);
                return;
            }
            try {
                const detail = await readNoteContent(note.id);
                openNote(note.id, note.title, detail.content);
            } catch (error) {
                console.error("Error opening tree note:", error);
            }
        },
        [openNote, readNoteContent],
    );

    const handleOpenNoteInNewTab = useCallback(
        async (note: NoteDto) => {
            try {
                const { tabs: currentTabs } = useEditorStore.getState();
                const existing = currentTabs.find(
                    (tab): tab is NoteTab =>
                        isNoteTab(tab) && tab.noteId === note.id,
                );
                const content =
                    existing?.content ??
                    (await readNoteContent(note.id)).content;

                insertExternalTab({
                    id: crypto.randomUUID(),
                    noteId: note.id,
                    title: note.title,
                    content,
                });
            } catch (error) {
                console.error("Error opening tree note in new tab:", error);
            }
        },
        [insertExternalTab, readNoteContent],
    );

    const handleNoteClick = async (
        note: NoteDto,
        modifiers: { cmd: boolean; shift: boolean },
    ) => {
        if (wasJustDraggingRef.current) return;
        setFocusedFolderPath(getParentPath(note.id));
        const rowKey = `note:${note.id}`;

        if (modifiers.shift && selectRowRange(rowKey, modifiers.cmd)) {
            return;
        }

        if (modifiers.cmd) {
            setSelectedNoteIds((prev) => {
                const next = new Set(prev);
                if (next.has(note.id)) next.delete(note.id);
                else next.add(note.id);
                return next;
            });
            lastClickedRowKeyRef.current = rowKey;
            return;
        }

        clearEntrySelection();
        setSelectedNoteIds(new Set([note.id]));
        lastClickedRowKeyRef.current = rowKey;
        await openTreeNote(note);
    };

    const handleNoteAuxClick = useCallback(
        (note: NoteDto, event: React.MouseEvent) => {
            if (event.button !== 1) return;
            if (wasJustDraggingRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            setSelectedNoteIds(new Set([note.id]));
            lastClickedRowKeyRef.current = `note:${note.id}`;
            void handleOpenNoteInNewTab(note);
        },
        [handleOpenNoteInNewTab],
    );

    const handleNoteContextMenu = (e: React.MouseEvent, note: NoteDto) => {
        e.preventDefault();
        setFocusedFolderPath(getParentPath(note.id));

        const preserveSelection =
            selectedNoteIds.size > 1 && selectedNoteIds.has(note.id);

        if (!preserveSelection) {
            clearEntrySelection();
            setSelectedNoteIds(new Set([note.id]));
            lastClickedRowKeyRef.current = `note:${note.id}`;
        }

        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            payload: { kind: "note", note },
        });
    };

    const handleFolderContextMenu = (e: React.MouseEvent, path: string) => {
        e.preventDefault();
        setFocusedFolderPath(path);
        clearEntrySelection();
        setSelectedNoteIds(new Set());
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            payload: {
                kind: "folder",
                path,
                expanded: visibleExpandedFolders.has(path),
            },
        });
    };

    const handleBlankContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setFocusedFolderPath("");
        clearEntrySelection();
        setSelectedNoteIds(new Set());
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            payload: { kind: "blank" },
        });
    };

    const getContextTargetNotes = useCallback(
        (note: NoteDto) => {
            if (selectedNoteIds.size > 1 && selectedNoteIds.has(note.id)) {
                return notes.filter((item) => selectedNoteIds.has(item.id));
            }
            return [note];
        },
        [notes, selectedNoteIds],
    );

    const applyMove = useCallback(
        async (notesToMove: NoteDto[], targetFolder: string) => {
            await applyMoveOperations(
                buildNoteMoveOperations(notesToMove, targetFolder),
            );
        },
        [applyMoveOperations],
    );

    const handleCopyNotes = useCallback(
        (notesToCopy: NoteDto[]) => {
            if (!vaultPath || notesToCopy.length === 0) return;
            writeFileTreeClipboard({
                kind: "notes",
                vaultPath,
                noteIds: notesToCopy.map((note) => note.id),
            });
            setClipboardVersion((value) => value + 1);
        },
        [vaultPath],
    );

    const handleCopyFolder = useCallback(
        (folderPath: string) => {
            if (!vaultPath || !folderPath) return;
            writeFileTreeClipboard({
                kind: "folder",
                vaultPath,
                folderPath,
            });
            setClipboardVersion((value) => value + 1);
            setFocusedFolderPath(folderPath);
        },
        [vaultPath],
    );

    const persistCopiedNote = useCallback(
        async (note: NoteDto, targetPath: string) => {
            const { tabs: currentTabs } = useEditorStore.getState();
            const existing = currentTabs.find(
                (tab): tab is NoteTab =>
                    isNoteTab(tab) && tab.noteId === note.id,
            );
            const content =
                existing?.content ?? (await readNoteContent(note.id)).content;
            const created = await createNote(targetPath);
            if (!created) return null;

            const detail = await vaultInvoke<{
                title: string;
                path: string;
            }>("save_note", {
                noteId: created.id,
                content,
            });

            updateNoteMetadata(created.id, {
                title: detail.title,
                path: detail.path,
                modified_at: Math.floor(Date.now() / 1000),
            });
            touchContent();
            return created;
        },
        [createNote, readNoteContent, touchContent, updateNoteMetadata],
    );

    const handlePasteIntoFolder = useCallback(
        async (targetFolder: string) => {
            const clipboard = readFileTreeClipboard(vaultPath);
            if (!clipboard) return;

            const currentNotes = useVaultStore.getState().notes;
            const reservedNoteIds = new Set(
                currentNotes.map((note) => note.id),
            );

            if (clipboard.kind === "notes") {
                const notesToCopy = clipboard.noteIds
                    .map((noteId) =>
                        currentNotes.find((note) => note.id === noteId),
                    )
                    .filter((note): note is NoteDto => Boolean(note));

                for (const note of notesToCopy) {
                    const nextPath = buildCopiedNotePath(
                        note.id,
                        targetFolder,
                        reservedNoteIds,
                    );
                    const created = await persistCopiedNote(note, nextPath);
                    if (!created) continue;
                    reservedNoteIds.add(created.id);
                }
                return;
            }

            if (!canPasteFolderClipboard(clipboard, targetFolder)) {
                return;
            }
            const reservedFolderPaths = new Set([
                ...allFolderPaths,
                ...currentNotes.map((note) => note.id),
            ]);
            const rootFolderPath = buildCopiedFolderPath(
                clipboard.folderPath,
                targetFolder,
                reservedFolderPaths,
            );

            try {
                await vaultInvoke("copy_folder", {
                    relativePath: clipboard.folderPath,
                    newRelativePath: rootFolderPath,
                });
                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    if (targetFolder) next.add(targetFolder);
                    next.add(rootFolderPath);
                    return next;
                });
                setFocusedFolderPath(rootFolderPath);
                await refreshStructure();
            } catch (error) {
                console.error("Error copying folder:", error);
            }
        },
        [allFolderPaths, refreshStructure, persistCopiedNote, vaultPath],
    );

    const startCreating = useCallback(
        (mode: "note" | "folder", parentPath = "") => {
            if (parentPath) {
                setExpandedFolders((prev) => {
                    if (prev.has(parentPath)) return prev;
                    const next = new Set(prev);
                    next.add(parentPath);
                    return next;
                });
            }
            setNewItemName("");
            setCreatingParentPath(parentPath);
            setCreatingMode(mode);
        },
        [],
    );

    const confirmCreate = async () => {
        const name = newItemName.trim();
        const mode = creatingMode;
        const parentPath = creatingParentPath.trim();
        setCreatingMode(null);
        setCreatingParentPath("");
        setNewItemName("");
        setSelectedNoteIds(new Set());
        if (!name || !mode) return;

        if (mode === "folder") {
            const folderPath = parentPath ? `${parentPath}/${name}` : name;
            const folder = await createFolder(folderPath);
            if (folder) {
                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    if (parentPath) next.add(parentPath);
                    next.add(folderPath);
                    return next;
                });
                setFocusedFolderPath(folder.relative_path);
            }
            return;
        }

        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        const note = await createNote(fullPath);
        if (note) openNote(note.id, note.title, "");
    };

    const cancelCreate = () => {
        setCreatingMode(null);
        setCreatingParentPath("");
        setNewItemName("");
    };

    const handleRenameStart = (note: NoteDto) => {
        setRenamingFolderPath(null);
        setRenamingEntryPath(null);
        setRenamingNoteId(note.id);
    };

    const handleRenameConfirm = async (note: NoteDto, newName: string) => {
        if (renameGuardRef.current) return;
        renameGuardRef.current = true;
        try {
            setRenamingNoteId(null);
            const updated = await renameNote(note.id, newName);
            if (updated) {
                useEditorStore.setState((s) => ({
                    tabs: s.tabs.map((t) =>
                        isNoteTab(t) && t.noteId === note.id
                            ? {
                                  ...t,
                                  noteId: updated.id,
                                  title: updated.title,
                              }
                            : t,
                    ),
                }));
            }
        } finally {
            renameGuardRef.current = false;
        }
    };

    const handleFolderRenameStart = useCallback((path: string) => {
        setRenamingNoteId(null);
        setRenamingEntryPath(null);
        setRenamingFolderPath(path);
    }, []);

    const handleFolderRenameConfirm = useCallback(
        async (folderPath: string, newName: string) => {
            if (renameGuardRef.current) return;
            renameGuardRef.current = true;
            try {
                setRenamingFolderPath(null);
                const parentPath = getParentPath(folderPath);
                const nextFolderPath = parentPath
                    ? `${parentPath}/${newName}`
                    : newName;
                await relocateFolder(folderPath, nextFolderPath);
            } finally {
                renameGuardRef.current = false;
            }
        },
        [relocateFolder],
    );

    const handleEntryRenameStart = useCallback((entry: VaultEntryDto) => {
        setRenamingNoteId(null);
        setRenamingFolderPath(null);
        setRenamingEntryPath(entry.path);
    }, []);

    const handleEntryRenameConfirm = useCallback(
        async (entry: VaultEntryDto, newName: string) => {
            if (renameGuardRef.current) return;
            renameGuardRef.current = true;
            try {
                setRenamingEntryPath(null);
                const parentPath = getParentPath(entry.relative_path);
                const nextRelativePath = parentPath
                    ? `${parentPath}/${newName}`
                    : newName;
                await relocateVaultEntry(entry, nextRelativePath);
            } finally {
                renameGuardRef.current = false;
            }
        },
        [relocateVaultEntry],
    );

    const handleDelete = useCallback(
        async (notesToDelete: NoteDto[]) => {
            const noteIds = new Set(notesToDelete.map((note) => note.id));

            const { tabs: currentTabs } = useEditorStore.getState();
            currentTabs.forEach((tab) => {
                if (isNoteTab(tab) && noteIds.has(tab.noteId)) {
                    closeTab(tab.id);
                }
            });

            for (const note of notesToDelete) {
                await deleteNote(note.id);
            }

            setSelectedNoteIds((prev) => {
                const next = new Set(prev);
                noteIds.forEach((noteId) => next.delete(noteId));
                return next;
            });
            const currentAnchor = lastClickedRowKeyRef.current;
            if (
                currentAnchor?.startsWith("note:") &&
                noteIds.has(currentAnchor.slice("note:".length))
            ) {
                lastClickedRowKeyRef.current = null;
            }
        },
        [closeTab, deleteNote],
    );

    const handleDeleteFolder = useCallback(
        async (relativePath: string, folderName: string) => {
            const approved = await confirm(
                `Delete folder "${folderName}" and all its contents?`,
                { title: "Delete Folder", kind: "warning" },
            );
            if (!approved) return;

            const { tabs: currentTabs } = useEditorStore.getState();
            const prefix = relativePath + "/";
            const sourceAbsolutePath = vaultPath
                ? `${vaultPath}/${relativePath}`
                : relativePath;
            currentTabs.forEach((tab) => {
                if (
                    isNoteTab(tab) &&
                    (tab.noteId === relativePath ||
                        tab.noteId.startsWith(prefix))
                ) {
                    closeTab(tab.id);
                    return;
                }

                if (
                    isPdfTab(tab) &&
                    (tab.entryId === relativePath ||
                        tab.entryId.startsWith(prefix) ||
                        tab.path === sourceAbsolutePath ||
                        tab.path.startsWith(`${sourceAbsolutePath}/`))
                ) {
                    closeTab(tab.id);
                    return;
                }

                if (
                    isFileTab(tab) &&
                    (tab.relativePath === relativePath ||
                        tab.relativePath.startsWith(prefix) ||
                        tab.path === sourceAbsolutePath ||
                        tab.path.startsWith(`${sourceAbsolutePath}/`))
                ) {
                    closeTab(tab.id);
                }
            });

            try {
                await deleteFolder(relativePath);
                setSelectedEntryPaths((prev) => {
                    const next = new Set(prev);
                    next.forEach((entryPath) => {
                        if (
                            entryPath === sourceAbsolutePath ||
                            entryPath.startsWith(`${sourceAbsolutePath}/`)
                        ) {
                            next.delete(entryPath);
                        }
                    });
                    return next;
                });
                setFocusedFolderPath((prev) =>
                    prev === relativePath || prev.startsWith(`${relativePath}/`)
                        ? getParentPath(relativePath)
                        : prev,
                );
                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    next.forEach((path) => {
                        if (
                            path === relativePath ||
                            path.startsWith(`${relativePath}/`)
                        ) {
                            next.delete(path);
                        }
                    });
                    return next;
                });
            } catch (error) {
                console.error("Error deleting folder:", error);
            }
        },
        [closeTab, deleteFolder, vaultPath],
    );

    const handleDuplicateNote = useCallback(
        async (note: NoteDto) => {
            const noteIdWithoutExt = note.id.replace(/\.md$/i, "");
            const lastSlash = noteIdWithoutExt.lastIndexOf("/");
            const parentPath =
                lastSlash === -1 ? "" : noteIdWithoutExt.slice(0, lastSlash);
            const baseName =
                lastSlash === -1
                    ? noteIdWithoutExt
                    : noteIdWithoutExt.slice(lastSlash + 1);

            let copyPath = parentPath
                ? `${parentPath}/${baseName} copy`
                : `${baseName} copy`;
            let counter = 2;
            while (notes.some((item) => item.id === `${copyPath}.md`)) {
                copyPath = parentPath
                    ? `${parentPath}/${baseName} copy ${counter}`
                    : `${baseName} copy ${counter}`;
                counter += 1;
            }

            try {
                const { tabs: currentTabs } = useEditorStore.getState();
                const existing = currentTabs.find(
                    (tab): tab is NoteTab =>
                        isNoteTab(tab) && tab.noteId === note.id,
                );
                const content =
                    existing?.content ??
                    (await readNoteContent(note.id)).content;
                const created = await createNote(copyPath);
                if (!created) return;

                const detail = await vaultInvoke<{
                    title: string;
                    path: string;
                }>("save_note", {
                    noteId: created.id,
                    content,
                });

                updateNoteMetadata(created.id, {
                    title: detail.title,
                    path: detail.path,
                    modified_at: Math.floor(Date.now() / 1000),
                });
                touchContent();
            } catch (error) {
                console.error("Error duplicating note:", error);
            }
        },
        [createNote, notes, readNoteContent, touchContent, updateNoteMetadata],
    );

    const handleRevealNoteInFinder = useCallback((note: NoteDto) => {
        if (!note.path) return;
        void revealItemInDir(note.path);
    }, []);

    const handleRevealFolderInFinder = useCallback(
        (path: string) => {
            if (!vaultPath) return;
            void revealItemInDir(path ? `${vaultPath}/${path}` : vaultPath);
        },
        [vaultPath],
    );

    const handleTreeKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            const target = event.target;
            if (target instanceof HTMLInputElement) return;
            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.altKey) return;

            const lowerKey = event.key.toLowerCase();
            if (lowerKey === "c") {
                if (selectedNoteIds.size > 0) {
                    const notesToCopy = notes.filter((note) =>
                        selectedNoteIds.has(note.id),
                    );
                    if (notesToCopy.length > 0) {
                        event.preventDefault();
                        handleCopyNotes(notesToCopy);
                    }
                    return;
                }

                if (focusedFolderPath) {
                    event.preventDefault();
                    handleCopyFolder(focusedFolderPath);
                }
                return;
            }

            if (lowerKey === "v" && treeClipboard) {
                if (
                    treeClipboard.kind === "folder" &&
                    !canPasteFolderClipboard(treeClipboard, focusedFolderPath)
                ) {
                    return;
                }

                event.preventDefault();
                void handlePasteIntoFolder(focusedFolderPath);
            }
        },
        [
            focusedFolderPath,
            handleCopyFolder,
            handleCopyNotes,
            handlePasteIntoFolder,
            notes,
            selectedNoteIds,
            treeClipboard,
        ],
    );

    const openMoveMenu = useCallback(
        (menu: ContextMenuState<FileTreeContextPayload>) => {
            if (menu.payload.kind !== "note") return;
            const note = menu.payload.note;
            queueMicrotask(() => {
                setContextMenu({
                    ...menu,
                    payload: { kind: "move-note", note },
                });
            });
        },
        [],
    );

    const contextMenuEntries = useMemo<ContextMenuEntry[]>(() => {
        if (!contextMenu) return [];

        switch (contextMenu.payload.kind) {
            case "blank":
                return [
                    { label: "New Note", action: () => startCreating("note") },
                    {
                        label: "New Folder",
                        action: () => startCreating("folder"),
                    },
                    { type: "separator" },
                    {
                        label: "Paste",
                        action: () => void handlePasteIntoFolder(""),
                        disabled:
                            !treeClipboard ||
                            (treeClipboard.kind === "folder" &&
                                !canPasteFolderClipboard(treeClipboard, "")),
                    },
                    { type: "separator" },
                    {
                        label: "Expand All",
                        action: () =>
                            setExpandedFolders(new Set(allFolderPaths)),
                        disabled: allFolderPaths.length === 0,
                    },
                    {
                        label: "Collapse All",
                        action: () => setExpandedFolders(new Set()),
                        disabled: expandedFolders.size === 0,
                    },
                ];
            case "folder": {
                const { path, expanded } = contextMenu.payload;
                const folderName = path.split("/").pop() ?? path;
                return [
                    {
                        label: "New Note Here",
                        action: () => startCreating("note", path),
                    },
                    {
                        label: "New Folder Here",
                        action: () => startCreating("folder", path),
                    },
                    { type: "separator" },
                    {
                        label: "Copy",
                        action: () => handleCopyFolder(path),
                    },
                    {
                        label: "Paste Here",
                        action: () => void handlePasteIntoFolder(path),
                        disabled:
                            !treeClipboard ||
                            (treeClipboard.kind === "folder" &&
                                !canPasteFolderClipboard(treeClipboard, path)),
                    },
                    { type: "separator" },
                    {
                        label: expanded ? "Collapse" : "Expand",
                        action: () => handleToggleFolder(path),
                    },
                    {
                        label: "Rename",
                        action: () => handleFolderRenameStart(path),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => handleRevealFolderInFinder(path),
                    },
                    {
                        label: "Copy Folder Path",
                        action: () => void navigator.clipboard.writeText(path),
                    },
                    { type: "separator" },
                    {
                        label: "Delete Folder",
                        action: () => void handleDeleteFolder(path, folderName),
                        danger: true,
                    },
                ];
            }
            case "note": {
                const { note } = contextMenu.payload;
                const contextTargetNotes = getContextTargetNotes(note);
                const deleteTargets = contextTargetNotes;
                const deleteLabel =
                    deleteTargets.length > 1
                        ? "Delete Selected Notes"
                        : "Delete Note";
                const moveLabel =
                    contextTargetNotes.length > 1
                        ? "Move Selected Notes to…"
                        : "Move Note to…";

                return [
                    {
                        label: "Open",
                        action: () => void openTreeNote(note),
                    },
                    {
                        label: "Open in New Tab",
                        action: () => void handleOpenNoteInNewTab(note),
                    },
                    { type: "separator" },
                    {
                        label:
                            contextTargetNotes.length > 1
                                ? "Copy Selected Notes"
                                : "Copy Note",
                        action: () => handleCopyNotes(contextTargetNotes),
                    },
                    {
                        label: "Paste in Parent Folder",
                        action: () =>
                            void handlePasteIntoFolder(getParentPath(note.id)),
                        disabled:
                            !treeClipboard ||
                            (treeClipboard.kind === "folder" &&
                                !canPasteFolderClipboard(
                                    treeClipboard,
                                    getParentPath(note.id),
                                )),
                    },
                    { type: "separator" },
                    {
                        label: "Rename",
                        action: () => handleRenameStart(note),
                    },
                    {
                        label: moveLabel,
                        action: () => openMoveMenu(contextMenu),
                        disabled: allFolderPaths.length === 0,
                    },
                    {
                        label: "Duplicate",
                        action: () => void handleDuplicateNote(note),
                    },
                    { type: "separator" },
                    {
                        label: "Reveal in Finder",
                        action: () => handleRevealNoteInFinder(note),
                    },
                    {
                        label: "Copy Note Path",
                        action: () =>
                            void navigator.clipboard.writeText(note.id),
                    },
                    { type: "separator" },
                    {
                        label: deleteLabel,
                        action: () => void handleDelete(deleteTargets),
                        danger: true,
                    },
                ];
            }
            case "pdf": {
                const { entry } = contextMenu.payload;
                return [
                    {
                        label: "Open",
                        action: () =>
                            handlePdfClick(entry, {
                                cmd: false,
                                shift: false,
                            }),
                    },
                    {
                        label: "Open in New Tab",
                        action: () => handleOpenPdfInNewTab(entry),
                    },
                    { type: "separator" },
                    {
                        label: "Open Externally",
                        action: () => void openPath(entry.path),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => void revealItemInDir(entry.path),
                    },
                    {
                        label: "Copy Path",
                        action: () =>
                            void navigator.clipboard.writeText(entry.path),
                    },
                    { type: "separator" },
                    {
                        label: "Move File to Trash",
                        action: () => void handleMoveEntryToTrash(entry),
                        danger: true,
                    },
                    { type: "separator" },
                    {
                        label: "Add to Chat",
                        action: () => handleAddPdfToChat(entry),
                    },
                ];
            }
            case "file": {
                const { entry } = contextMenu.payload;
                const canOpenInApp = canOpenVaultFileEntryInApp(entry);
                return [
                    {
                        label: "Open",
                        action: () => void openVaultFileEntry(entry),
                    },
                    {
                        label: "Open in New Tab",
                        action: () =>
                            void openVaultFileEntry(entry, { newTab: true }),
                        disabled: !canOpenInApp,
                    },
                    { type: "separator" },
                    {
                        label: "Open Externally",
                        action: () => void openPath(entry.path),
                    },
                    {
                        label: "Rename",
                        action: () => handleEntryRenameStart(entry),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => void revealItemInDir(entry.path),
                    },
                    {
                        label: "Copy Path",
                        action: () =>
                            void navigator.clipboard.writeText(
                                entry.relative_path,
                            ),
                    },
                    { type: "separator" },
                    {
                        label: "Move File to Trash",
                        action: () => void handleMoveEntryToTrash(entry),
                        danger: true,
                    },
                    { type: "separator" },
                    {
                        label: "Add to Chat",
                        action: () => handleAddFileToChat(entry),
                    },
                ];
            }
            case "move-note": {
                const { note } = contextMenu.payload;
                const moveTargets = getContextTargetNotes(note);
                const firstParent = moveTargets[0]?.id.includes("/")
                    ? moveTargets[0].id.split("/").slice(0, -1).join("/")
                    : "";
                const sameParent = moveTargets.every((item) => {
                    const parent = item.id.includes("/")
                        ? item.id.split("/").slice(0, -1).join("/")
                        : "";
                    return parent === firstParent;
                });
                const currentParent = sameParent ? firstParent : null;
                const folderTargets =
                    currentParent === null
                        ? allFolderPaths
                        : allFolderPaths.filter(
                              (folder) => folder !== currentParent,
                          );

                return [
                    {
                        label: "Back",
                        action: () =>
                            setContextMenu({
                                ...contextMenu,
                                payload: {
                                    kind: "note",
                                    note,
                                },
                            }),
                    },
                    { type: "separator" },
                    {
                        label: "/ Root",
                        action: () => void applyMove(moveTargets, ""),
                        disabled:
                            currentParent !== null && currentParent === "",
                    },
                    ...folderTargets.map((folder) => ({
                        label: folder,
                        action: () => void applyMove(moveTargets, folder),
                    })),
                ];
            }
        }
    }, [
        allFolderPaths,
        applyMove,
        contextMenu,
        expandedFolders.size,
        getContextTargetNotes,
        handleCopyFolder,
        handleCopyNotes,
        handleDelete,
        handleDeleteFolder,
        handleDuplicateNote,
        handleEntryRenameStart,
        handleFolderRenameStart,
        handleAddFileToChat,
        handleAddPdfToChat,
        handleMoveEntryToTrash,
        handlePdfClick,
        handleOpenPdfInNewTab,
        handleOpenNoteInNewTab,
        handlePasteIntoFolder,
        handleRevealFolderInFinder,
        handleRevealNoteInFinder,
        openMoveMenu,
        openTreeNote,
        startCreating,
        treeClipboard,
    ]);

    // Ref-backed stable callbacks so memo'd FlatTreeRowView stays fresh
    const noteClickRef = useRef(handleNoteClick);
    noteClickRef.current = handleNoteClick;
    const stableNoteClick = useCallback(
        (note: NoteDto, modifiers: { cmd: boolean; shift: boolean }) =>
            noteClickRef.current(note, modifiers),
        [],
    );

    const noteMouseDownRef = useRef(handleNoteMouseDown);
    noteMouseDownRef.current = handleNoteMouseDown;
    const stableNoteMouseDown = useCallback(
        (note: NoteDto, e: React.MouseEvent) =>
            noteMouseDownRef.current(note, e),
        [],
    );

    const noteContextMenuRef = useRef(handleNoteContextMenu);
    noteContextMenuRef.current = handleNoteContextMenu;
    const stableNoteContextMenu = useCallback(
        (e: React.MouseEvent, note: NoteDto) =>
            noteContextMenuRef.current(e, note),
        [],
    );

    const folderContextMenuRef = useRef(handleFolderContextMenu);
    folderContextMenuRef.current = handleFolderContextMenu;
    const stableFolderContextMenu = useCallback(
        (e: React.MouseEvent, path: string) =>
            folderContextMenuRef.current(e, path),
        [],
    );

    const renameConfirmRef = useRef(handleRenameConfirm);
    renameConfirmRef.current = handleRenameConfirm;
    const stableRenameNoteConfirm = useCallback(
        (note: NoteDto, newName: string) =>
            renameConfirmRef.current(note, newName),
        [],
    );

    const renameFolderConfirmRef = useRef(handleFolderRenameConfirm);
    renameFolderConfirmRef.current = handleFolderRenameConfirm;
    const stableRenameFolderConfirm = useCallback(
        (path: string, newName: string) =>
            renameFolderConfirmRef.current(path, newName),
        [],
    );

    const renameEntryConfirmRef = useRef(handleEntryRenameConfirm);
    renameEntryConfirmRef.current = handleEntryRenameConfirm;
    const stableRenameEntryConfirm = useCallback(
        (entry: VaultEntryDto, newName: string) =>
            renameEntryConfirmRef.current(entry, newName),
        [],
    );

    const pdfClickRef = useRef(handlePdfClick);
    pdfClickRef.current = handlePdfClick;
    const stablePdfClick = useCallback(
        (entry: VaultEntryDto, modifiers: { cmd: boolean; shift: boolean }) =>
            pdfClickRef.current(entry, modifiers),
        [],
    );

    const pdfMouseDownRef = useRef(handlePdfMouseDown);
    pdfMouseDownRef.current = handlePdfMouseDown;
    const stablePdfMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) =>
            pdfMouseDownRef.current(entry, e),
        [],
    );

    const pdfContextMenuRef = useRef(handlePdfContextMenu);
    pdfContextMenuRef.current = handlePdfContextMenu;
    const stablePdfContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) =>
            pdfContextMenuRef.current(e, entry),
        [],
    );

    const fileClickRef = useRef(handleFileClick);
    fileClickRef.current = handleFileClick;
    const stableFileClick = useCallback(
        (entry: VaultEntryDto, modifiers: { cmd: boolean; shift: boolean }) =>
            fileClickRef.current(entry, modifiers),
        [],
    );

    const fileMouseDownRef = useRef(handleFileMouseDown);
    fileMouseDownRef.current = handleFileMouseDown;
    const stableFileMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) =>
            fileMouseDownRef.current(entry, e),
        [],
    );

    const fileContextMenuRef = useRef(handleFileContextMenu);
    fileContextMenuRef.current = handleFileContextMenu;
    const stableFileContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) =>
            fileContextMenuRef.current(e, entry),
        [],
    );

    if (!vaultPath) return <OpenVaultForm />;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div
                className="flex items-center justify-center gap-1 shrink-0"
                style={{
                    height: Math.max(36, Math.round(36 * treeScale)),
                    borderBottom: "1px solid var(--border)",
                    position: "relative",
                }}
            >
                <ToolbarBtn
                    title="New note"
                    onClick={() => startCreating("note")}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M11.5 2.5a1.5 1.5 0 0 1 2.1 2.1L5 13.2l-3 .8.8-3 8.7-8.5Z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </ToolbarBtn>

                <ToolbarBtn
                    title="New folder"
                    onClick={() => startCreating("folder")}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M1 3.5a1 1 0 0 1 1-1h4l1.5 1.5H14a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3.5Z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                        />
                        <path
                            d="M7.5 7.5v3M6 9h3"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                        />
                    </svg>
                </ToolbarBtn>

                <ToolbarBtn
                    title="Sort order"
                    active={sortMenuOpen}
                    onClick={() => setSortMenuOpen((v) => !v)}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M5 3v10M3 6l2-3 2 3M10 13V3M8 10l2 3 2-3"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </ToolbarBtn>

                <ToolbarBtn
                    title={
                        revealActive
                            ? "Don't reveal active file"
                            : "Reveal active file"
                    }
                    active={revealActive}
                    onClick={handleRevealToggle}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                        <circle
                            cx="8"
                            cy="8"
                            r="5.5"
                            stroke="currentColor"
                            strokeWidth="1.2"
                        />
                        <circle
                            cx="8"
                            cy="8"
                            r="2"
                            stroke="currentColor"
                            strokeWidth="1.2"
                        />
                        <path
                            d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                        />
                    </svg>
                </ToolbarBtn>

                <ToolbarBtn
                    title={canCollapseAll ? "Collapse all" : "Expand all"}
                    onClick={handleCollapseExpandAll}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    {canCollapseAll ? (
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                        >
                            <path
                                d="M3 9l5-5 5 5M3 13l5-5 5 5"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    ) : (
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                        >
                            <path
                                d="M3 3l5 5 5-5M3 7l5 5 5-5"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    )}
                </ToolbarBtn>

                {sortMenuOpen && (
                    <SortMenu
                        current={sortMode}
                        onSelect={handleSortSelect}
                        onClose={() => setSortMenuOpen(false)}
                    />
                )}
            </div>

            {/* Tree (virtualized) */}
            <div
                ref={treeScrollRef}
                data-testid="file-tree-viewport"
                data-folder-path=""
                className="flex-1 overflow-auto"
                tabIndex={0}
                onScroll={handleTreeScroll}
                onKeyDown={handleTreeKeyDown}
                onMouseDown={(event) => {
                    const target = event.target;
                    if (
                        target instanceof HTMLElement &&
                        target.closest(
                            "input, textarea, select, [contenteditable='true']",
                        )
                    ) {
                        return;
                    }
                    treeScrollRef.current?.focus();
                }}
                onContextMenu={(event) => {
                    if (event.target !== event.currentTarget) return;
                    handleBlankContextMenu(event);
                }}
                style={{
                    backgroundColor:
                        dragOverPath === ""
                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                            : "var(--bg-secondary)",
                    outline:
                        dragOverPath === ""
                            ? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
                            : "none",
                    outlineOffset: dragOverPath === "" ? -1 : 0,
                    paddingInline: TREE_VIEWPORT_SIDE_PADDING_PX,
                    boxSizing: "border-box",
                }}
            >
                {displayRows.length === 0 ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: metrics.fontSize,
                        }}
                    >
                        No notes
                    </p>
                ) : (
                    <>
                        {/* Sticky folder overlay */}
                        {stickyFolders.length > 0 && (
                            <div
                                data-testid="file-tree-sticky-layer"
                                style={{
                                    position: "sticky",
                                    top: 0,
                                    height: 0,
                                    zIndex: 10,
                                    overflow: "visible",
                                    ...TREE_LAYER_BOX_STYLE,
                                }}
                            >
                                {stickyFolders.map(({ row, top }) => (
                                    <div
                                        key={`sticky:${row.path}`}
                                        style={{
                                            position: "absolute",
                                            top,
                                            left: 0,
                                            ...TREE_LAYER_BOX_STYLE,
                                            zIndex: 20 - row.depth,
                                        }}
                                    >
                                        <FlatTreeRowView
                                            row={row}
                                            stickyTop={0}
                                            metrics={metrics}
                                            activeNoteId={activeNoteId}
                                            activeEntryPath={activeEntryPath}
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
                                            }
                                            selectedEntryPaths={
                                                visibleSelectedEntryPaths
                                            }
                                            contextMenuFolderPath={
                                                contextMenuFolderPath
                                            }
                                            draggingNoteIds={draggingNoteIds}
                                            draggingFolderPath={
                                                draggingFolderPath
                                            }
                                            dragOverPath={dragOverPath}
                                            onFolderClick={handleFolderClick}
                                            onFolderMouseDown={
                                                handleFolderMouseDown
                                            }
                                            onFolderContextMenu={
                                                stableFolderContextMenu
                                            }
                                            onNoteClick={stableNoteClick}
                                            onNoteAuxClick={handleNoteAuxClick}
                                            onNoteMouseDown={
                                                stableNoteMouseDown
                                            }
                                            onNoteContextMenu={
                                                stableNoteContextMenu
                                            }
                                            onPdfClick={stablePdfClick}
                                            onPdfAuxClick={handlePdfAuxClick}
                                            onPdfMouseDown={stablePdfMouseDown}
                                            onPdfContextMenu={
                                                stablePdfContextMenu
                                            }
                                            onFileClick={stableFileClick}
                                            onFileAuxClick={handleFileAuxClick}
                                            onFileMouseDown={
                                                stableFileMouseDown
                                            }
                                            onFileContextMenu={
                                                stableFileContextMenu
                                            }
                                            renamingNoteId={renamingNoteId}
                                            renamingFolderPath={
                                                renamingFolderPath
                                            }
                                            renamingEntryPath={
                                                renamingEntryPath
                                            }
                                            creatingMode={creatingMode}
                                            newItemName={newItemName}
                                            onNewItemNameChange={setNewItemName}
                                            onCreateConfirm={() =>
                                                void confirmCreate()
                                            }
                                            onCreateCancel={cancelCreate}
                                            onRenameNoteConfirm={
                                                stableRenameNoteConfirm
                                            }
                                            onRenameFolderConfirm={
                                                stableRenameFolderConfirm
                                            }
                                            onRenameEntryConfirm={
                                                stableRenameEntryConfirm
                                            }
                                            onRenameCancel={handleRenameCancel}
                                            showExtensions={
                                                fileTreeShowExtensions
                                            }
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* Virtualized rows */}
                        <div
                            data-testid="file-tree-virtual-canvas"
                            style={{
                                height: totalHeight,
                                position: "relative",
                                ...TREE_LAYER_BOX_STYLE,
                            }}
                        >
                            <div
                                data-testid="file-tree-rows-layer"
                                style={{
                                    position: "absolute",
                                    top: offsetY,
                                    left: 0,
                                    ...TREE_LAYER_BOX_STYLE,
                                }}
                            >
                                {visibleRows.map((row) => {
                                    const key =
                                        row.kind === "folder"
                                            ? `folder:${row.path}`
                                            : row.kind === "note"
                                              ? `note:${row.note.id}`
                                              : row.kind === "pdf" ||
                                                  row.kind === "file"
                                                ? `${row.kind}:${row.entry.relative_path}`
                                                : `create:${row.path}`;
                                    if (
                                        row.kind === "folder" &&
                                        stickyFolderPaths.has(row.path)
                                    ) {
                                        return (
                                            <div
                                                key={key}
                                                aria-hidden="true"
                                                style={{
                                                    height: metrics.rowHeight,
                                                }}
                                            />
                                        );
                                    }
                                    return (
                                        <FlatTreeRowView
                                            key={key}
                                            row={row}
                                            metrics={metrics}
                                            activeNoteId={activeNoteId}
                                            activeEntryPath={activeEntryPath}
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
                                            }
                                            selectedEntryPaths={
                                                visibleSelectedEntryPaths
                                            }
                                            contextMenuFolderPath={
                                                contextMenuFolderPath
                                            }
                                            draggingNoteIds={draggingNoteIds}
                                            draggingFolderPath={
                                                draggingFolderPath
                                            }
                                            dragOverPath={dragOverPath}
                                            onFolderClick={handleFolderClick}
                                            onFolderMouseDown={
                                                handleFolderMouseDown
                                            }
                                            onFolderContextMenu={
                                                stableFolderContextMenu
                                            }
                                            onNoteClick={stableNoteClick}
                                            onNoteAuxClick={handleNoteAuxClick}
                                            onNoteMouseDown={
                                                stableNoteMouseDown
                                            }
                                            onNoteContextMenu={
                                                stableNoteContextMenu
                                            }
                                            onPdfClick={stablePdfClick}
                                            onPdfAuxClick={handlePdfAuxClick}
                                            onPdfMouseDown={stablePdfMouseDown}
                                            onPdfContextMenu={
                                                stablePdfContextMenu
                                            }
                                            onFileClick={stableFileClick}
                                            onFileAuxClick={handleFileAuxClick}
                                            onFileMouseDown={
                                                stableFileMouseDown
                                            }
                                            onFileContextMenu={
                                                stableFileContextMenu
                                            }
                                            renamingNoteId={renamingNoteId}
                                            renamingFolderPath={
                                                renamingFolderPath
                                            }
                                            renamingEntryPath={
                                                renamingEntryPath
                                            }
                                            creatingMode={creatingMode}
                                            newItemName={newItemName}
                                            onNewItemNameChange={setNewItemName}
                                            onCreateConfirm={() =>
                                                void confirmCreate()
                                            }
                                            onCreateCancel={cancelCreate}
                                            onRenameNoteConfirm={
                                                stableRenameNoteConfirm
                                            }
                                            onRenameFolderConfirm={
                                                stableRenameFolderConfirm
                                            }
                                            onRenameEntryConfirm={
                                                stableRenameEntryConfirm
                                            }
                                            onRenameCancel={handleRenameCancel}
                                            showExtensions={
                                                fileTreeShowExtensions
                                            }
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* Drag ghost */}
            {dragPos && dragLabel && (
                <div
                    style={{
                        position: "fixed",
                        left: dragPos.x + 14,
                        top: dragPos.y + 14,
                        pointerEvents: "none",
                        zIndex: 9999,
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "3px 10px",
                        fontSize: metrics.fontSize,
                        color: "var(--text-primary)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {dragLabel}
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={contextMenuEntries}
                    minWidth={160}
                />
            )}
        </div>
    );
}
