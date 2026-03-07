import {
    useState,
    useRef,
    useEffect,
    useCallback,
    useMemo,
    useLayoutEffect,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../app/store/settingsStore";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { REVEAL_NOTE_IN_TREE_EVENT } from "../../app/utils/navigation";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

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

interface ContextMenuState {
    x: number;
    y: number;
    note: NoteDto;
}

function ContextMenu({
    menu,
    folders,
    onRename,
    onDelete,
    onMove,
    onClose,
}: {
    menu: ContextMenuState;
    folders: string[];
    onRename: () => void;
    onDelete: () => void;
    onMove: (targetFolder: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [showMoveList, setShowMoveList] = useState(false);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(menu.x, menu.y, rect.width, rect.height),
        );
    }, [menu.x, menu.y, showMoveList, folders.length]);

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

    const menuItemStyle = {
        color: "var(--text-primary)",
        background: "transparent",
    } as const;

    const menuItem = (label: string, action: () => void, danger = false) => (
        <button
            key={label}
            onClick={action}
            className="w-full text-left px-3 py-1.5 text-xs rounded"
            style={{
                ...menuItemStyle,
                color: danger ? "#ef4444" : menuItemStyle.color,
            }}
            onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")
            }
            onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "transparent")
            }
        >
            {label}
        </button>
    );

    const containerStyle = {
        position: "fixed" as const,
        top: position.y,
        left: position.x,
        zIndex: 9999,
        minWidth: 180,
        padding: 4,
        borderRadius: 8,
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    };

    if (showMoveList) {
        return (
            <div ref={ref} style={containerStyle}>
                {menuItem("← Back", () => setShowMoveList(false))}
                <div
                    style={{
                        borderTop: "1px solid var(--border)",
                        margin: "4px 0",
                    }}
                />
                {menuItem("/ Root", () => {
                    onMove("");
                    onClose();
                })}
                {folders.map((folder) =>
                    menuItem(folder, () => {
                        onMove(folder);
                        onClose();
                    }),
                )}
            </div>
        );
    }

    return (
        <div ref={ref} style={containerStyle}>
            {menuItem("Rename", () => {
                onRename();
                onClose();
            })}
            {menuItem("Move to…", () => setShowMoveList(true))}
            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    margin: "4px 0",
                }}
            />
            {menuItem(
                "Delete",
                () => {
                    onDelete();
                    onClose();
                },
                true,
            )}
        </div>
    );
}

// --- Tree node ---

interface TreeNodeViewProps {
    name: string;
    path: string;
    node: TreeNode;
    metrics: TreeMetrics;
    activeNoteId: string | null;
    depth: number;
    sortMode: SortMode;
    expandedFolders: Set<string>;
    selectedNoteIds: Set<string>;
    draggingNoteId: string | null;
    dragOverPath: string | null;
    onToggleFolder: (path: string) => void;
    onNoteClick: (
        note: NoteDto,
        modifiers: { cmd: boolean; shift: boolean },
    ) => void;
    onNoteMouseDown: (note: NoteDto, e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent, note: NoteDto) => void;
    renamingNoteId: string | null;
    onRenameConfirm: (note: NoteDto, newName: string) => void;
    onRenameCancel: () => void;
}

function TreeNodeView({
    name,
    path,
    node,
    metrics,
    activeNoteId,
    depth,
    sortMode,
    expandedFolders,
    selectedNoteIds,
    draggingNoteId,
    dragOverPath,
    onToggleFolder,
    onNoteClick,
    onNoteMouseDown,
    onContextMenu,
    renamingNoteId,
    onRenameConfirm,
    onRenameCancel,
}: TreeNodeViewProps) {
    const renameInputRef = useRef<HTMLInputElement>(null);

    const isDir = !!node.children;
    const isExpanded = expandedFolders.has(path);
    const isActive = node.note?.id === activeNoteId;
    const isSelected = !!node.note && selectedNoteIds.has(node.note.id);
    const isDragOver = dragOverPath === path;
    const isRenaming = node.note?.id === renamingNoteId;
    const label = node.note?.title || name;
    const paddingLeft = depth * metrics.indentStep + metrics.basePadding;
    const noteOffset = Math.round(14 * metrics.scale);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    if (isDir) {
        return (
            <div>
                <button
                    onClick={() => onToggleFolder(path)}
                    data-folder-path={path}
                    className="flex items-center gap-1.5 w-full text-left text-xs rounded"
                    style={{
                        position: "sticky",
                        top: depth * metrics.rowHeight,
                        zIndex: 200 - depth,
                        paddingLeft,
                        color: "var(--text-secondary)",
                        height: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        boxSizing: "border-box",
                        backgroundColor: isDragOver
                            ? "color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))"
                            : "var(--bg-secondary)",
                        outline: isDragOver
                            ? "1px solid var(--accent)"
                            : "none",
                        boxShadow:
                            depth === 0
                                ? "0 1px 0 color-mix(in srgb, var(--border) 88%, transparent)"
                                : "inset 0 -1px 0 color-mix(in srgb, var(--border) 72%, transparent)",
                    }}
                >
                    <ChevronIcon open={isExpanded} size={metrics.smallIcon} />
                    <FolderIcon
                        open={isExpanded || isDragOver}
                        size={metrics.mediumIcon}
                    />
                    <span className="truncate">{name}</span>
                </button>
                {isExpanded &&
                    sortedEntries(node.children!, sortMode).map(
                        ([key, child]) => (
                            <TreeNodeView
                                key={key}
                                name={key}
                                path={`${path}/${key}`}
                                node={child}
                                metrics={metrics}
                                activeNoteId={activeNoteId}
                                depth={depth + 1}
                                sortMode={sortMode}
                                expandedFolders={expandedFolders}
                                selectedNoteIds={selectedNoteIds}
                                draggingNoteId={draggingNoteId}
                                dragOverPath={dragOverPath}
                                onToggleFolder={onToggleFolder}
                                onNoteClick={onNoteClick}
                                onNoteMouseDown={onNoteMouseDown}
                                onContextMenu={onContextMenu}
                                renamingNoteId={renamingNoteId}
                                onRenameConfirm={onRenameConfirm}
                                onRenameCancel={onRenameCancel}
                            />
                        ),
                    )}
            </div>
        );
    }

    if (isRenaming && node.note) {
        const note = node.note;
        return (
            <div
                className="flex items-center gap-1.5 mx-1 py-0.5"
                style={{
                    paddingLeft: paddingLeft + noteOffset,
                    width: "calc(100% - 8px)",
                    fontSize: metrics.fontSize,
                }}
            >
                <NoteIcon size={metrics.smallIcon} />
                <input
                    ref={renameInputRef}
                    defaultValue={label}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            const v = e.currentTarget.value.trim();
                            if (v) onRenameConfirm(note, v);
                            else onRenameCancel();
                        }
                        if (e.key === "Escape") onRenameCancel();
                    }}
                    onBlur={() => {
                        const v = renameInputRef.current?.value.trim() ?? "";
                        if (v) onRenameConfirm(note, v);
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

    const bgColor = isActive
        ? "var(--accent)"
        : isSelected
          ? "color-mix(in srgb, var(--accent) 22%, transparent)"
          : "transparent";
    const textColor = isActive ? "#fff" : "var(--text-primary)";
    const isDraggingThis = draggingNoteId === node.note?.id;

    return (
        <div
            role="button"
            tabIndex={0}
            data-note-id={node.note?.id}
            onMouseDown={(e) => node.note && onNoteMouseDown(node.note, e)}
            onClick={(e) =>
                node.note &&
                onNoteClick(node.note, {
                    cmd: e.metaKey || e.ctrlKey,
                    shift: e.shiftKey,
                })
            }
            onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && node.note) {
                    e.preventDefault();
                    onNoteClick(node.note, { cmd: false, shift: false });
                }
            }}
            onContextMenu={(e) => node.note && onContextMenu(e, node.note)}
            className="flex items-center gap-1.5 w-full text-left py-1 text-xs rounded mx-1 cursor-pointer"
            style={{
                paddingLeft: paddingLeft + noteOffset,
                width: "calc(100% - 8px)",
                backgroundColor: bgColor,
                color: textColor,
                opacity: isDraggingThis ? 0.4 : 1,
                minHeight: metrics.rowHeight,
                fontSize: metrics.fontSize,
                boxSizing: "border-box",
            }}
        >
            <NoteIcon size={metrics.smallIcon} />
            <span className="truncate">{label}</span>
        </div>
    );
}

// --- Open vault form ---

function OpenVaultForm() {
    const openVault = useVaultStore((s) => s.openVault);
    const isLoading = useVaultStore((s) => s.isLoading);
    const error = useVaultStore((s) => s.error);

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
    note: NoteDto;
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
    const tabs = useEditorStore((s) => s.tabs);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const openNote = useEditorStore((s) => s.openNote);
    const closeTab = useEditorStore((s) => s.closeTab);
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
    const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
    const [dragOverPath, setDragOverPath] = useState<string | null>(null);
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(
        null,
    );
    const [sortMenuOpen, setSortMenuOpen] = useState(false);
    const [creatingMode, setCreatingMode] = useState<"note" | "folder" | null>(
        null,
    );
    const [newItemName, setNewItemName] = useState("");
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
        null,
    );
    const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);

    const inputRef = useRef<HTMLInputElement>(null);
    const treeScrollRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef<DragState | null>(null);
    const dragOverPathRef = useRef<string | null>(null);
    const wasJustDraggingRef = useRef(false);

    const activeTab = tabs.find((t) => t.id === activeTabId);
    const activeNoteId = activeTab?.noteId ?? null;
    const tree = buildTree(notes);
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
        const next = new Set(expandedFolders);
        revealedFolders.forEach((path) => next.add(path));
        return next;
    }, [expandedFolders, revealedFolders]);
    const canCollapseAll = expandedFolders.size > 0;
    const treeScale = fileTreeScale / 100;
    const metrics: TreeMetrics = {
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
    };

    // Reveal active: keep the active note roughly centered once parent folders are visible.
    useEffect(() => {
        if (!revealActive) return;
        if (!activeNoteId) return;

        const centerActiveNote = () => {
            const container = treeScrollRef.current;
            if (!container) return;

            const el = container.querySelector<HTMLElement>(
                `[data-note-id="${CSS.escape(activeNoteId)}"]`,
            );
            if (!el) return;

            const targetTop =
                el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
            const maxScrollTop = Math.max(
                0,
                container.scrollHeight - container.clientHeight,
            );
            const nextScrollTop = Math.min(
                maxScrollTop,
                Math.max(0, targetTop),
            );

            container.scrollTo({
                top: nextScrollTop,
                behavior: "smooth",
            });
        };

        const raf1 = requestAnimationFrame(() => {
            centerActiveNote();
            requestAnimationFrame(centerActiveNote);
        });

        return () => cancelAnimationFrame(raf1);
    }, [activeNoteId, revealActive]);

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

            requestAnimationFrame(() => {
                const container = treeScrollRef.current;
                if (!container) return;
                const el = container.querySelector<HTMLElement>(
                    `[data-note-id="${CSS.escape(noteId)}"]`,
                );
                if (!el) return;
                const targetTop =
                    el.offsetTop -
                    container.clientHeight / 2 +
                    el.clientHeight / 2;
                const maxScrollTop = Math.max(
                    0,
                    container.scrollHeight - container.clientHeight,
                );
                container.scrollTo({
                    top: Math.min(maxScrollTop, Math.max(0, targetTop)),
                    behavior: "smooth",
                });
            });
        };

        window.addEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
        return () =>
            window.removeEventListener(REVEAL_NOTE_IN_TREE_EVENT, handleReveal);
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
                setDraggingNoteId(s.note.id);
            }

            setDragPos({ x: e.clientX, y: e.clientY });

            const els = document.elementsFromPoint(e.clientX, e.clientY);
            const folderEl = els.find((el) =>
                el.hasAttribute("data-folder-path"),
            );
            const folder = folderEl?.getAttribute("data-folder-path") ?? null;
            dragOverPathRef.current = folder;
            setDragOverPath(folder);
        };

        const onUp = async () => {
            const s = dragStateRef.current;
            dragStateRef.current = null;

            if (!s?.active) return;

            wasJustDraggingRef.current = true;
            requestAnimationFrame(() => {
                wasJustDraggingRef.current = false;
            });

            setDragPos(null);
            setDraggingNoteId(null);

            const folder = dragOverPathRef.current;
            dragOverPathRef.current = null;
            setDragOverPath(null);

            if (folder === null) return;

            const note = s.note;
            const filename = note.id.split("/").pop()!;
            const currentParent = note.id.includes("/")
                ? note.id.split("/").slice(0, -1).join("/")
                : "";
            if (currentParent === folder) return;

            const newPath = folder ? `${folder}/${filename}` : filename;
            const updated = await useVaultStore
                .getState()
                .renameNote(note.id, newPath);
            if (updated) {
                useEditorStore.setState((st) => ({
                    tabs: st.tabs.map((t) =>
                        t.noteId === note.id
                            ? { ...t, noteId: updated.id, title: updated.title }
                            : t,
                    ),
                }));
            }
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    const handleToggleFolder = (path: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const handleSortSelect = (mode: SortMode) => {
        setSortMode(mode);
        localStorage.setItem(SORT_KEY, mode);
        setSortMenuOpen(false);
    };

    const handleRevealToggle = () => {
        const next = !revealActive;
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
            dragStateRef.current = {
                note,
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [],
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

        const existing = tabs.find((t) => t.noteId === note.id);
        if (existing) {
            openNote(note.id, note.title, existing.content);
            return;
        }
        try {
            const detail = await invoke<{ content: string }>("read_note", {
                noteId: note.id,
            });
            openNote(note.id, note.title, detail.content);
        } catch (e) {
            console.error(e);
        }
    };

    const handleContextMenu = (e: React.MouseEvent, note: NoteDto) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, note });
    };

    const applyMove = async (note: NoteDto, targetFolder: string) => {
        const filename = note.id.split("/").pop()!;
        const currentParent = note.id.includes("/")
            ? note.id.split("/").slice(0, -1).join("/")
            : "";
        if (currentParent === targetFolder) return;
        const newPath = targetFolder ? `${targetFolder}/${filename}` : filename;
        const updated = await renameNote(note.id, newPath);
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

    const handleContextMove = async (targetFolder: string) => {
        if (!contextMenu) return;
        await applyMove(contextMenu.note, targetFolder);
    };

    const startCreating = (mode: "note" | "folder") => {
        setNewItemName("");
        setCreatingMode(mode);
        setTimeout(() => inputRef.current?.focus(), 0);
    };

    const confirmCreate = async () => {
        const name = newItemName.trim();
        const mode = creatingMode;
        setCreatingMode(null);
        setNewItemName("");
        setSelectedNoteIds(new Set());
        if (!name || !mode) return;

        if (mode === "folder") {
            const { notes: currentNotes } = useVaultStore.getState();
            let noteName = "Untitled";
            let i = 1;
            while (currentNotes.some((n) => n.id === `${name}/${noteName}`)) {
                noteName = `Untitled ${i++}`;
            }
            const note = await createNote(`${name}/${noteName}`);
            if (note) {
                openNote(note.id, note.title, "");
                setExpandedFolders((prev) => new Set([...prev, name]));
            }
        } else {
            const note = await createNote(name);
            if (note) openNote(note.id, note.title, "");
        }
    };

    const cancelCreate = () => {
        setCreatingMode(null);
        setNewItemName("");
    };

    const handleRenameStart = () => {
        if (!contextMenu) return;
        setRenamingNoteId(contextMenu.note.id);
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

    const handleDelete = async () => {
        if (!contextMenu) return;
        const { note } = contextMenu;
        const tab = tabs.find((t) => t.noteId === note.id);
        if (tab) closeTab(tab.id);
        await deleteNote(note.id);
    };

    if (!vaultPath) return <OpenVaultForm />;

    const draggingNote = draggingNoteId
        ? notes.find((n) => n.id === draggingNoteId)
        : null;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div
                className="flex items-center justify-center gap-1 flex-shrink-0"
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
                    className="px-2 py-1 flex-shrink-0"
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

            {/* Tree */}
            <div
                ref={treeScrollRef}
                className="flex-1 overflow-y-auto pb-1 px-1"
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
                    sortedEntries(tree, sortMode).map(([key, node]) => (
                        <TreeNodeView
                            key={key}
                            name={key}
                            path={key}
                            node={node}
                            metrics={metrics}
                            activeNoteId={activeTab?.noteId ?? null}
                            depth={0}
                            sortMode={sortMode}
                            expandedFolders={visibleExpandedFolders}
                            selectedNoteIds={selectedNoteIds}
                            draggingNoteId={draggingNoteId}
                            dragOverPath={dragOverPath}
                            onToggleFolder={handleToggleFolder}
                            onNoteClick={handleNoteClick}
                            onNoteMouseDown={handleNoteMouseDown}
                            onContextMenu={handleContextMenu}
                            renamingNoteId={renamingNoteId}
                            onRenameConfirm={handleRenameConfirm}
                            onRenameCancel={() => setRenamingNoteId(null)}
                        />
                    ))
                )}
            </div>

            {/* Drag ghost */}
            {dragPos && draggingNote && (
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
                    {draggingNote.title}
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    folders={getAllFolderPaths(tree)}
                    onRename={handleRenameStart}
                    onDelete={handleDelete}
                    onMove={handleContextMove}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
