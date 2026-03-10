import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "../../app/store/settingsStore";
import { REVEAL_NOTE_IN_TREE_EVENT } from "../../app/utils/navigation";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";
import {
    buildFolderMoveOperations,
    buildNoteMoveOperations,
    canMoveFolderToTarget,
    getBaseName,
} from "./fileTreeMoves";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";

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
const VIRTUAL_OVERSCAN = 15;

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

// --- Tree building ---

interface TreeNode {
    name: string;
    children?: Record<string, TreeNode>;
    note?: NoteDto;
}

type FlatTreeRow =
    | { kind: "folder"; name: string; path: string; depth: number }
    | { kind: "note"; note: NoteDto; path: string; depth: number };

function buildTree(notes: NoteDto[]): Record<string, TreeNode> {
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

function flattenVisible(
    map: Record<string, TreeNode>,
    expandedFolders: Set<string>,
    sortMode: SortMode,
    prefix = "",
): NoteDto[] {
    const result: NoteDto[] = [];
    for (const [key, node] of sortedEntries(map, sortMode)) {
        const path = prefix ? `${prefix}/${key}` : key;
        if (node.note) {
            result.push(node.note);
        }
        if (node.children && expandedFolders.has(path)) {
            result.push(
                ...flattenVisible(
                    node.children,
                    expandedFolders,
                    sortMode,
                    path,
                ),
            );
        }
    }
    return result;
}

function flattenTreeRows(
    map: Record<string, TreeNode>,
    expandedFolders: Set<string>,
    sortMode: SortMode,
    prefix = "",
    depth = 0,
): FlatTreeRow[] {
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
            continue;
        }

        if (node.note) {
            rows.push({ kind: "note", note: node.note, path, depth });
        }
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
                return (b.note?.modified_at ?? 0) - (a.note?.modified_at ?? 0);
            case "modified_asc":
                return (a.note?.modified_at ?? 0) - (b.note?.modified_at ?? 0);
            case "created_desc":
                return (b.note?.created_at ?? 0) - (a.note?.created_at ?? 0);
            case "created_asc":
                return (a.note?.created_at ?? 0) - (b.note?.created_at ?? 0);
        }
    });
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
                    fill="var(--accent)"
                    opacity="0.7"
                />
                <path
                    d="M1 5.5h13l-1.5 7.5H2.5L1 5.5Z"
                    fill="var(--accent)"
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
                fill="var(--accent)"
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
    | { kind: "move-note"; note: NoteDto };

// --- Tree node ---

interface FlatTreeRowViewProps {
    row: FlatTreeRow;
    metrics: TreeMetrics;
    activeNoteId: string | null;
    expandedFolders: Set<string>;
    selectedNoteIds: Set<string>;
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
    onNoteMouseDown: (note: NoteDto, e: React.MouseEvent) => void;
    onNoteContextMenu: (e: React.MouseEvent, note: NoteDto) => void;
    renamingNoteId: string | null;
    onRenameConfirm: (note: NoteDto, newName: string) => void;
    onRenameCancel: () => void;
    stickyTop?: number;
}

const FlatTreeRowView = memo(function FlatTreeRowView({
    row,
    metrics,
    activeNoteId,
    expandedFolders,
    selectedNoteIds,
    draggingNoteIds,
    draggingFolderPath,
    dragOverPath,
    onFolderClick,
    onFolderMouseDown,
    onFolderContextMenu,
    onNoteClick,
    onNoteMouseDown,
    onNoteContextMenu,
    renamingNoteId,
    onRenameConfirm,
    onRenameCancel,
    stickyTop,
}: FlatTreeRowViewProps) {
    const renameInputRef = useRef<HTMLInputElement>(null);
    const paddingLeft = row.depth * metrics.indentStep + metrics.basePadding;
    const noteOffset = Math.round(14 * metrics.scale);

    const isFolder = row.kind === "folder";
    const isDragOver = dragOverPath === row.path;
    const isDraggingFolder =
        row.kind === "folder" && draggingFolderPath === row.path;
    const isExpanded = row.kind === "folder" && expandedFolders.has(row.path);
    const isRenaming = row.kind === "note" && row.note.id === renamingNoteId;

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    if (isFolder) {
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
                className="flex items-center gap-1.5 w-full text-left text-xs rounded"
                style={{
                    paddingLeft,
                    color: "var(--text-secondary)",
                    height: metrics.rowHeight,
                    fontSize: metrics.fontSize,
                    boxSizing: "border-box",
                    backgroundColor: isDragOver
                        ? "color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))"
                        : stickyTop != null
                          ? "var(--bg-secondary)"
                          : "transparent",
                    outline: isDragOver ? "1px solid var(--accent)" : "none",
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
                <span className="truncate">{row.name}</span>
            </button>
        );
    }

    const note = row.note;
    const isActive = note.id === activeNoteId;
    const isSelected = selectedNoteIds.has(note.id);
    const isDraggingThis = draggingNoteIds.has(note.id);

    if (isRenaming) {
        return (
            <div
                className="flex items-center gap-1.5 mx-1 py-0.5"
                style={{
                    paddingLeft: paddingLeft + noteOffset,
                    width: "calc(100% - 8px)",
                    fontSize: metrics.fontSize,
                    minHeight: metrics.rowHeight,
                }}
            >
                <NoteIcon size={metrics.smallIcon} />
                <input
                    ref={renameInputRef}
                    defaultValue={note.title}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            const value = e.currentTarget.value.trim();
                            if (value) onRenameConfirm(note, value);
                            else onRenameCancel();
                        }
                        if (e.key === "Escape") onRenameCancel();
                    }}
                    onBlur={() => {
                        const value =
                            renameInputRef.current?.value.trim() ?? "";
                        if (value) onRenameConfirm(note, value);
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
            onMouseDown={(e) => onNoteMouseDown(note, e)}
            onClick={(e) =>
                onNoteClick(note, {
                    cmd: e.metaKey || e.ctrlKey,
                    shift: e.shiftKey,
                })
            }
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
            className="flex items-center gap-1.5 w-full text-left py-1 text-xs rounded mx-1 cursor-pointer"
            style={{
                paddingLeft: paddingLeft + noteOffset,
                width: "calc(100% - 8px)",
                backgroundColor: isSelected
                    ? "color-mix(in srgb, var(--accent) 22%, transparent)"
                    : "transparent",
                color: "var(--text-primary)",
                boxShadow: isActive
                    ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)"
                    : "none",
                opacity: isDraggingThis ? 0.4 : 1,
                minHeight: metrics.rowHeight,
                fontSize: metrics.fontSize,
                boxSizing: "border-box",
            }}
        >
            <NoteIcon size={metrics.smallIcon} />
            <span className="truncate">{note.title}</span>
        </div>
    );
}, (prev, next) => {
    // Custom comparator: only re-render when the row's visual state changes.
    // Callback props are stable (ref-backed) so they don't need comparison.
    if (prev.row !== next.row) return false;
    if (prev.metrics !== next.metrics) return false;
    if (prev.stickyTop !== next.stickyTop) return false;
    if (prev.renamingNoteId !== next.renamingNoteId) return false;

    const path = prev.row.path;

    if (prev.row.kind === "folder") {
        if (prev.expandedFolders.has(path) !== next.expandedFolders.has(path))
            return false;
        if ((prev.dragOverPath === path) !== (next.dragOverPath === path))
            return false;
        if (
            (prev.draggingFolderPath === path) !==
            (next.draggingFolderPath === path)
        )
            return false;
        return true;
    }

    const noteId = prev.row.note.id;
    if ((prev.activeNoteId === noteId) !== (next.activeNoteId === noteId))
        return false;
    if (prev.selectedNoteIds.has(noteId) !== next.selectedNoteIds.has(noteId))
        return false;
    if (prev.draggingNoteIds.has(noteId) !== next.draggingNoteIds.has(noteId))
        return false;
    if ((prev.dragOverPath === path) !== (next.dragOverPath === path))
        return false;

    return true;
});


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
        | { kind: "folder"; path: string };
    startX: number;
    startY: number;
    active: boolean;
}

// --- Main FileTree ---

export function FileTree() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const notes = useVaultStore((s) => s.notes);
    const createNote = useVaultStore((s) => s.createNote);
    const deleteNote = useVaultStore((s) => s.deleteNote);
    const renameNote = useVaultStore((s) => s.renameNote);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchVault = useVaultStore((s) => s.touchVault);
    const activeNoteId = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.noteId ?? null,
    );
    const openNote = useEditorStore((s) => s.openNote);
    const closeTab = useEditorStore((s) => s.closeTab);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const fileTreeScale = useSettingsStore((s) => s.fileTreeScale);

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
    const [lastClickedNoteId, setLastClickedNoteId] = useState<string | null>(
        null,
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

    const inputRef = useRef<HTMLInputElement>(null);
    const treeScrollRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef<DragState | null>(null);
    const dragOverPathRef = useRef<string | null>(null);
    const wasJustDraggingRef = useRef(false);
    const rafScrollRef = useRef(0);
    const pendingRevealRef = useRef<string | null>(null);

    // Virtualization state
    const [viewportHeight, setViewportHeight] = useState(600);
    const [scrollTop, setScrollTop] = useState(0);

    // activeNoteId comes from the targeted store selector above
    const visibleSelectedNoteIds = useMemo(() => {
        if (!activeNoteId) return new Set<string>();
        if (selectedNoteIds.size <= 1) return new Set([activeNoteId]);
        return selectedNoteIds;
    }, [activeNoteId, selectedNoteIds]);
    const tree = useMemo(() => buildTree(notes), [notes]);
    const allFolderPaths = useMemo(() => getAllFolderPaths(tree), [tree]);
    const revealedFolders = useMemo(() => {
        if (!revealActive || !activeNoteId) return [];
        const parts = activeNoteId.split("/");
        return parts
            .slice(0, -1)
            .map((_, i) => parts.slice(0, i + 1).join("/"));
    }, [activeNoteId, revealActive]);
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
    const canCollapseAll = expandedFolders.size > 0;
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

    const contentHeight = flatRows.length * metrics.rowHeight;
    const bottomScrollBuffer =
        contentHeight > viewportHeight
            ? Math.max(
                  metrics.rowHeight * 4,
                  Math.min(
                      Math.round(viewportHeight * 0.22),
                      metrics.rowHeight * 8,
                  ),
              )
            : 0;
    const totalHeight = contentHeight + bottomScrollBuffer;
    const startIdx = Math.max(
        0,
        Math.floor(scrollTop / metrics.rowHeight) - VIRTUAL_OVERSCAN,
    );
    const endIdx = Math.min(
        flatRows.length,
        Math.ceil((scrollTop + viewportHeight) / metrics.rowHeight) +
            VIRTUAL_OVERSCAN,
    );
    const visibleRows = flatRows.slice(startIdx, endIdx);
    const offsetY = startIdx * metrics.rowHeight;

    // --- Sticky folder overlay ---

    // Precompute: for each folder row index, what's the index of its last descendant?
    const folderLastDescendant = useMemo(() => {
        const map = new Map<number, number>();
        const stack: number[] = [];
        for (let i = 0; i < flatRows.length; i++) {
            while (
                stack.length > 0 &&
                flatRows[stack[stack.length - 1]].depth >= flatRows[i].depth
            ) {
                map.set(stack.pop()!, i - 1);
            }
            if (flatRows[i].kind === "folder") {
                stack.push(i);
            }
        }
        while (stack.length > 0) {
            map.set(stack.pop()!, flatRows.length - 1);
        }
        return map;
    }, [flatRows]);

    // Compute which folders should appear as sticky overlay headers
    const stickyFolders = useMemo(() => {
        if (flatRows.length === 0) return [];

        const result: {
            row: FlatTreeRow & { kind: "folder" };
            top: number;
        }[] = [];
        let searchStart = 0;
        let searchEnd = flatRows.length - 1;

        for (let depth = 0; depth < 50; depth++) {
            const stickyPosition = depth * metrics.rowHeight;
            let best: {
                row: FlatTreeRow & { kind: "folder" };
                idx: number;
                lastIdx: number;
            } | null = null;

            for (let i = searchStart; i <= searchEnd; i++) {
                const row = flatRows[i];
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
    }, [flatRows, scrollTop, metrics.rowHeight, folderLastDescendant]);

    const stickyFolderPaths = useMemo(
        () => new Set(stickyFolders.map((f) => f.row.path)),
        [stickyFolders],
    );

    // Track viewport size
    useEffect(() => {
        const el = treeScrollRef.current;
        if (!el) return;
        const syncViewportHeight = () => {
            setViewportHeight(el.clientHeight);
        };

        syncViewportHeight();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", syncViewportHeight);
            return () =>
                window.removeEventListener("resize", syncViewportHeight);
        }

        const ro = new ResizeObserver(([entry]) => {
            setViewportHeight(Math.round(entry.contentRect.height));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // RAF-batched scroll handler
    const handleTreeScroll = useCallback(() => {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = requestAnimationFrame(() => {
            const el = treeScrollRef.current;
            if (el) setScrollTop(el.scrollTop);
        });
    }, []);

    const handleRenameCancel = useCallback(
        () => setRenamingNoteId(null),
        [],
    );

    // Scroll to row by index helper
    const scrollToRow = useCallback(
        (rowIdx: number, behavior: ScrollBehavior = "smooth") => {
            const container = treeScrollRef.current;
            if (!container) return;
            const rowTop = rowIdx * metrics.rowHeight;
            const targetScrollTop =
                rowTop -
                container.clientHeight / 2 +
                metrics.rowHeight / 2;
            const maxScrollTop = Math.max(
                0,
                totalHeight - container.clientHeight,
            );
            container.scrollTo({
                top: Math.min(maxScrollTop, Math.max(0, targetScrollTop)),
                behavior,
            });
        },
        [metrics.rowHeight, totalHeight],
    );

    // Reveal active: scroll to active note using index-based calculation
    useEffect(() => {
        if (!revealActive || !activeNoteId) return;

        const rowIdx = flatRows.findIndex(
            (r) => r.kind === "note" && r.note.id === activeNoteId,
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
    }, [activeNoteId, revealActive, flatRows, scrollToRow, metrics.rowHeight]);

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
            setLastClickedNoteId(noteId);
            pendingRevealRef.current = noteId;
        };

        window.addEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
        return () =>
            window.removeEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
    }, []);

    // Scroll to pending reveal note after flatRows updates
    useEffect(() => {
        const noteId = pendingRevealRef.current;
        if (!noteId) return;

        const rowIdx = flatRows.findIndex(
            (r) => r.kind === "note" && r.note.id === noteId,
        );
        if (rowIdx === -1) return;

        pendingRevealRef.current = null;
        requestAnimationFrame(() => scrollToRow(rowIdx));
    }, [flatRows, scrollToRow]);

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
        setLastClickedNoteId((prev) =>
            prev ? (movedIds.get(prev) ?? prev) : prev,
        );
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
                        tab.noteId === operation.fromId
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

    const getDragTargetFolder = useCallback(
        (item: DragState["item"], hoveredFolder: string | null) => {
            if (hoveredFolder === null) return null;

            if (item.kind === "folder") {
                return canMoveFolderToTarget(item.path, hoveredFolder)
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
                } else {
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

        const onUp = async () => {
            const s = dragStateRef.current;
            dragStateRef.current = null;

            if (!s?.active) return;

            if (dragPos) {
                if (s.item.kind === "notes") {
                    emitFileTreeNoteDrag({
                        phase: "end",
                        x: dragPos.x,
                        y: dragPos.y,
                        notes: s.item.notes.map((note) => ({
                            id: note.id,
                            title: note.title,
                            path: note.path,
                        })),
                    });
                } else {
                    emitFileTreeNoteDrag({
                        phase: "end",
                        x: dragPos.x,
                        y: dragPos.y,
                        notes: [],
                        folder: {
                            path: s.item.path,
                            name: getBaseName(s.item.path),
                        },
                    });
                }
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
                const folderPath = s.item.path;
                const operations = buildFolderMoveOperations(
                    useVaultStore.getState().notes,
                    folderPath,
                    folder,
                );
                const movedIds = await applyMoveOperations(operations);
                if (movedIds.size === 0) return;

                const folderName = getBaseName(folderPath);
                const nextFolderPath = folder
                    ? `${folder}/${folderName}`
                    : folderName;
                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    for (const path of prev) {
                        if (
                            path === folderPath ||
                            path.startsWith(`${folderPath}/`)
                        ) {
                            next.delete(path);
                            next.add(
                                path === folderPath
                                    ? nextFolderPath
                                    : `${nextFolderPath}/${path.slice(folderPath.length + 1)}`,
                            );
                        }
                    }
                    return next;
                });
                return;
            }

            await applyMoveOperations(
                buildNoteMoveOperations(s.item.notes, folder),
            );
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [applyMoveOperations, dragPos, getDragTargetFolder, resetDragState]);

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
        handleToggleFolder(path);
    }, []);

    const handleSortSelect = (mode: SortMode) => {
        setSortMode(mode);
        localStorage.setItem(SORT_KEY, mode);
        setSortMenuOpen(false);
    };

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

    const readNoteContent = useCallback(
        (noteId: string) =>
            invoke<{ content: string }>("read_note", { noteId }),
        [],
    );

    const openTreeNote = useCallback(
        async (note: NoteDto) => {
            const { tabs: currentTabs } = useEditorStore.getState();
            const existing = currentTabs.find(
                (tab) => tab.noteId === note.id,
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
                    (tab) => tab.noteId === note.id,
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

        if (modifiers.cmd) {
            setSelectedNoteIds((prev) => {
                const next = new Set(prev);
                if (next.has(note.id)) next.delete(note.id);
                else next.add(note.id);
                return next;
            });
            setLastClickedNoteId(note.id);
            return;
        }

        if (modifiers.shift && lastClickedNoteId) {
            const visible = flattenVisible(
                tree,
                visibleExpandedFolders,
                sortMode,
            );
            const lastIdx = visible.findIndex(
                (n) => n.id === lastClickedNoteId,
            );
            const currIdx = visible.findIndex((n) => n.id === note.id);
            if (lastIdx !== -1 && currIdx !== -1) {
                const [start, end] =
                    lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
                const range = visible.slice(start, end + 1).map((n) => n.id);
                setSelectedNoteIds((prev) => {
                    const next = new Set(prev);
                    range.forEach((id) => next.add(id));
                    return next;
                });
            }
            return;
        }

        setSelectedNoteIds(new Set([note.id]));
        setLastClickedNoteId(note.id);
        await openTreeNote(note);
    };

    const handleNoteContextMenu = (e: React.MouseEvent, note: NoteDto) => {
        e.preventDefault();

        const preserveSelection =
            selectedNoteIds.size > 1 && selectedNoteIds.has(note.id);

        if (!preserveSelection) {
            setSelectedNoteIds(new Set([note.id]));
            setLastClickedNoteId(note.id);
        }

        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            payload: { kind: "note", note },
        });
    };

    const handleFolderContextMenu = (e: React.MouseEvent, path: string) => {
        e.preventDefault();
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

    const startCreating = useCallback(
        (mode: "note" | "folder", parentPath = "") => {
            setNewItemName("");
            setCreatingParentPath(parentPath);
            setCreatingMode(mode);
            setTimeout(() => inputRef.current?.focus(), 0);
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
            const { notes: currentNotes } = useVaultStore.getState();
            let noteName = "Untitled";
            let i = 1;
            while (
                currentNotes.some(
                    (note) => note.id === `${folderPath}/${noteName}.md`,
                )
            ) {
                noteName = `Untitled ${i++}`;
            }
            const note = await createNote(`${folderPath}/${noteName}`);
            if (note) {
                openNote(note.id, note.title, "");
                setExpandedFolders((prev) => {
                    const next = new Set(prev);
                    if (parentPath) next.add(parentPath);
                    next.add(folderPath);
                    return next;
                });
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
        setRenamingNoteId(note.id);
    };

    const handleRenameConfirm = async (note: NoteDto, newName: string) => {
        setRenamingNoteId(null);
        const updated = await renameNote(note.id, newName);
        if (updated) {
            useEditorStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                    t.noteId === note.id
                        ? { ...t, noteId: updated.id, title: updated.title }
                        : t,
                ),
            }));
        }
    };

    const handleDelete = useCallback(
        async (notesToDelete: NoteDto[]) => {
            const noteIds = new Set(notesToDelete.map((note) => note.id));

            const { tabs: currentTabs } = useEditorStore.getState();
            currentTabs.forEach((tab) => {
                if (noteIds.has(tab.noteId)) {
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
            setLastClickedNoteId((prev) =>
                prev && noteIds.has(prev) ? null : prev,
            );
        },
        [closeTab, deleteNote],
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
                    (tab) => tab.noteId === note.id,
                );
                const content =
                    existing?.content ??
                    (await readNoteContent(note.id)).content;
                const created = await createNote(copyPath);
                if (!created) return;

                const detail = await invoke<{ title: string; path: string }>(
                    "save_note",
                    {
                        noteId: created.id,
                        content,
                    },
                );

                updateNoteMetadata(created.id, {
                    title: detail.title,
                    path: detail.path,
                    modified_at: Math.floor(Date.now() / 1000),
                });
                touchVault();
            } catch (error) {
                console.error("Error duplicating note:", error);
            }
        },
        [
            createNote,
            notes,
            readNoteContent,
            touchVault,
            updateNoteMetadata,
        ],
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
                        label: expanded ? "Collapse" : "Expand",
                        action: () => handleToggleFolder(path),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => handleRevealFolderInFinder(path),
                    },
                    {
                        label: "Copy Folder Path",
                        action: () => void navigator.clipboard.writeText(path),
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
        handleDelete,
        handleDuplicateNote,
        handleOpenNoteInNewTab,
        handleRevealFolderInFinder,
        handleRevealNoteInFinder,
        openMoveMenu,
        openTreeNote,
        startCreating,
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
    const stableRenameConfirm = useCallback(
        (note: NoteDto, newName: string) =>
            renameConfirmRef.current(note, newName),
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

            {/* New item input */}
            {creatingMode && (
                <div
                    className="px-2 py-1 shrink-0"
                    style={{ borderBottom: "1px solid var(--border)" }}
                >
                    <input
                        ref={inputRef}
                        value={newItemName}
                        onChange={(e) => setNewItemName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void confirmCreate();
                            if (e.key === "Escape") cancelCreate();
                        }}
                        onBlur={() => void confirmCreate()}
                        placeholder={
                            creatingMode === "folder"
                                ? "folder-name"
                                : "note-name"
                        }
                        className="w-full text-xs px-2 py-1 rounded outline-none"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            border: "1px solid var(--accent)",
                            color: "var(--text-primary)",
                            fontSize: metrics.inputFontSize,
                        }}
                    />
                </div>
            )}

            {/* Tree (virtualized) */}
            <div
                ref={treeScrollRef}
                data-folder-path=""
                className="flex-1 overflow-y-auto px-1"
                onScroll={handleTreeScroll}
                onContextMenu={(event) => {
                    if (event.target !== event.currentTarget) return;
                    handleBlankContextMenu(event);
                }}
                style={{
                    backgroundColor:
                        dragOverPath === ""
                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                            : undefined,
                    outline:
                        dragOverPath === ""
                            ? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
                            : "none",
                    outlineOffset: dragOverPath === "" ? -1 : 0,
                }}
            >
                {notes.length === 0 ? (
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
                                style={{
                                    position: "sticky",
                                    top: 0,
                                    height: 0,
                                    zIndex: 10,
                                    overflow: "visible",
                                }}
                            >
                                {stickyFolders.map(({ row, top }) => (
                                    <div
                                        key={`sticky:${row.path}`}
                                        style={{
                                            position: "absolute",
                                            top,
                                            left: 0,
                                            right: 0,
                                            zIndex: 20 - row.depth,
                                        }}
                                    >
                                        <FlatTreeRowView
                                            row={row}
                                            stickyTop={0}
                                            metrics={metrics}
                                            activeNoteId={activeNoteId}
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
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
                                            onNoteMouseDown={
                                                stableNoteMouseDown
                                            }
                                            onNoteContextMenu={
                                                stableNoteContextMenu
                                            }
                                            renamingNoteId={renamingNoteId}
                                            onRenameConfirm={
                                                stableRenameConfirm
                                            }
                                            onRenameCancel={handleRenameCancel}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* Virtualized rows */}
                        <div
                            style={{
                                height: contentHeight,
                                minHeight: "100%",
                                position: "relative",
                            }}
                        >
                            <div
                                style={{
                                    position: "absolute",
                                    top: offsetY,
                                    left: 0,
                                    right: 0,
                                }}
                            >
                                {visibleRows.map((row) => {
                                    const key =
                                        row.kind === "folder"
                                            ? `folder:${row.path}`
                                            : `note:${row.note.id}`;
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
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
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
                                            onNoteMouseDown={
                                                stableNoteMouseDown
                                            }
                                            onNoteContextMenu={
                                                stableNoteContextMenu
                                            }
                                            renamingNoteId={renamingNoteId}
                                            onRenameConfirm={
                                                stableRenameConfirm
                                            }
                                            onRenameCancel={handleRenameCancel}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                        {bottomScrollBuffer > 0 && (
                            <div
                                aria-hidden="true"
                                style={{
                                    height: bottomScrollBuffer,
                                    pointerEvents: "none",
                                }}
                            />
                        )}
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
