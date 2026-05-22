import {
    useState,
    useRef,
    useEffect,
    useLayoutEffect,
    useCallback,
    useMemo,
    memo,
} from "react";
import { createPortal } from "react-dom";
import { confirm, open } from "@neverwrite/runtime";
import { openPath, revealItemInDir } from "@neverwrite/runtime";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    canOpenVaultFileEntryInApp,
    closeOpenTabsForVaultPath,
    getVaultEntryDisplayName,
    moveVaultEntryToTrash,
    openVaultFileEntry,
    shouldIncludeMarkdownNotesInFileScope,
    shouldShowVaultEntryInFileTree,
} from "../../app/utils/vaultEntries";
import { useSettingsStore } from "../../app/store/settingsStore";
import {
    CLEAR_FILE_TREE_SELECTION_EVENT,
    REVEAL_NOTE_IN_TREE_EVENT,
} from "../../app/utils/navigation";
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
    selectEditorWorkspaceTabs,
    selectFocusedEditorTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import {
    buildEntryMovePath,
    buildNoteMoveOperations,
    canMoveTargetsToFolder,
    getBaseName,
    getMoveTargetCount,
    getParentPath,
    normalizeMoveTargets,
    type MoveTargets,
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
import { FileTypeIcon } from "../../components/icons/FileTypeIcon";
import { FolderTypeIcon } from "../../components/icons/FolderTypeIcon";
import {
    EXTERNAL_FILE_TREE_DRAG_EVENT,
    emitFileTreeAttachToNewChat,
    emitFileTreeNoteDrag,
    type ExternalFileTreeDragDetail,
    type FileTreeNoteDragDetail,
} from "../ai/dragEvents";
import { getPreferredWorkspaceChatSessionId } from "../ai/chatWorkspaceSelectors";
import { SidebarFilterInput } from "../../components/layout/SidebarFilterInput";
import { useBookmarkStore } from "../../app/store/bookmarkStore";
import { perfMeasure, perfNow } from "../../app/utils/perfInstrumentation";
import {
    safeStorageGetItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../../app/utils/safeStorage";
import { logError } from "../../app/utils/runtimeLog";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { matchesShortcutAction } from "../../app/shortcuts/registry";

// --- Sort ---

type SortMode =
    | "name_asc"
    | "name_desc"
    | "modified_desc"
    | "modified_asc"
    | "created_desc"
    | "created_asc";

const SORT_KEY = "neverwrite:sort-mode";
const REVEAL_KEY = "neverwrite:reveal-active";
const EXPANDED_FOLDERS_KEY_PREFIX = "neverwrite:file-tree-expanded-folders:";
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
    toolbarHeight: number;
    toolbarButton: number;
    toolbarIconScale: number;
    inputFontSize: number;
}

const TREE_VIEWPORT_SIDE_PADDING_PX = 4;
const TREE_CONTENT_BOX_STYLE = {
    width: "max-content",
    minWidth: "100%",
    boxSizing: "border-box" as const,
};
const TREE_STICKY_CHROME_STYLE = {
    left: -TREE_VIEWPORT_SIDE_PADDING_PX,
    width: `calc(100% + ${TREE_VIEWPORT_SIDE_PADDING_PX * 2}px)`,
    minWidth: `calc(100% + ${TREE_VIEWPORT_SIDE_PADDING_PX * 2}px)`,
    boxSizing: "border-box" as const,
    overflow: "hidden" as const,
};
const TREE_ROW_BOX_STYLE = {
    width: "max-content",
    minWidth: "100%",
    boxSizing: "border-box" as const,
};
// Sticky chrome must read as a distinct "frosted plate" floating above the
// panel. Without enough opacity contrast it shares the sidebar's translucent
// tint (82% bg-primary) and blends in, making the backdrop-filter invisible
// at rest. Sit at 96% bg-primary so the plate is clearly above the panel
// while still letting a hint of frosted material reach through.
const TREE_STICKY_CHROME_BACKGROUND =
    "color-mix(in srgb, var(--bg-primary) 96%, transparent)";
const TREE_STICKY_CHROME_BACKDROP_FILTER = "blur(18px) saturate(150%)";
// Drop shadow applied only to the deepest sticky folder wrapper,
// not to individual rows — avoids stacking noise.
const TREE_STICKY_EDGE_SHADOW = "0 2px 6px rgba(0,0,0,0.18)";
const TREE_LABEL_CLASSNAME = "shrink-0 whitespace-nowrap";
const TREE_GUIDE_COLOR = "var(--tree-guide-color)";
const FILE_TREE_CONTEXT_MENU_VIEWPORT_MARGIN = 32;
const FILE_TREE_CONTEXT_MENU_MIN_HEIGHT = 180;
const FILE_TREE_SCROLL_RESTORE_MAX_ATTEMPTS = 12;

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
    folderPaths: Set<string>;
};

type ChatContextTargets = {
    notes: NoteDto[];
    entries: VaultEntryDto[];
    folderPaths: string[];
};

type MovePickerState = {
    x: number;
    y: number;
    targets: MoveTargets;
};

function getSelectableRowKey(row: FlatTreeRow): string | null {
    if (row.kind === "folder") {
        return `folder:${row.path}`;
    }
    if (row.kind === "note") {
        return `note:${row.note.id}`;
    }
    if (row.kind === "pdf" || row.kind === "file") {
        return `entry:${row.entry.path}`;
    }
    return null;
}

function getFlatTreeRowFilterText(row: FlatTreeRow): string {
    if (row.kind === "folder") {
        return `${row.name}\n${row.path}`.toLowerCase();
    }
    if (row.kind === "note") return getNoteFilterText(row.note);
    if (row.kind === "pdf" || row.kind === "file") {
        return getVaultEntryFilterText(row.entry);
    }
    return "";
}

function filterFlatTreeRows(rows: FlatTreeRow[], normalizedFilter: string) {
    if (!normalizedFilter) return rows;

    const keepExactPaths = new Set<string>();
    const keepSubtreePrefixes: string[] = [];
    for (const row of rows) {
        if (row.kind === "create") continue;
        if (!getFlatTreeRowFilterText(row).includes(normalizedFilter)) {
            continue;
        }
        keepExactPaths.add(row.path);
        const parts = row.path.split("/");
        for (let i = 1; i < parts.length; i++) {
            keepExactPaths.add(parts.slice(0, i).join("/"));
        }
        if (row.kind === "folder") {
            keepSubtreePrefixes.push(`${row.path}/`);
        }
    }
    if (keepExactPaths.size === 0) return [];

    return rows.filter((row) => {
        if (keepExactPaths.has(row.path)) return true;
        return keepSubtreePrefixes.some((prefix) => row.path.startsWith(prefix));
    });
}

function canKeyboardOpenRow(row: FlatTreeRow) {
    return row.kind === "note" || row.kind === "pdf" || row.kind === "file";
}

function isEditableKeyboardTarget(target: EventTarget | null) {
    return (
        target instanceof HTMLElement &&
        Boolean(
            target.closest(
                "input, textarea, select, [contenteditable='true']",
            ),
        )
    );
}

function buildSelectionFromRows(rows: FlatTreeRow[]): TreeSelectionState {
    const noteIds = new Set<string>();
    const entryPaths = new Set<string>();
    const folderPaths = new Set<string>();

    for (const row of rows) {
        if (row.kind === "folder") {
            folderPaths.add(row.path);
            continue;
        }
        if (row.kind === "note") {
            noteIds.add(row.note.id);
            continue;
        }
        if (row.kind === "pdf" || row.kind === "file") {
            entryPaths.add(row.entry.path);
        }
    }

    return { noteIds, entryPaths, folderPaths };
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

function getExpandedFoldersStorageKey(vaultPath: string | null) {
    return `${EXPANDED_FOLDERS_KEY_PREFIX}${encodeURIComponent(vaultPath ?? "")}`;
}

function readExpandedFolders(vaultPath: string | null) {
    if (!vaultPath) return new Set<string>();
    try {
        const parsed = JSON.parse(
            safeStorageGetItem(getExpandedFoldersStorageKey(vaultPath)) ??
                "[]",
        );
        if (!Array.isArray(parsed)) return new Set<string>();
        return new Set(
            parsed.filter((path): path is string => typeof path === "string"),
        );
    } catch {
        return new Set<string>();
    }
}

function writeExpandedFolders(vaultPath: string | null, expanded: Set<string>) {
    if (!vaultPath) return;
    safeStorageSetItem(
        getExpandedFoldersStorageKey(vaultPath),
        JSON.stringify([...expanded].sort()),
    );
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

function getNoteRenameValue(note: NoteDto, showExtensions: boolean) {
    return getNoteDisplayName(note, showExtensions);
}

function getNoteFilterText(note: NoteDto) {
    return [note.title, note.id, note.path.split("/").pop(), note.path]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
}

function getVaultEntryFilterText(entry: VaultEntryDto) {
    return [entry.title, entry.file_name, entry.relative_path, entry.path]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
}

function isMarkdownLeafName(name: string) {
    return name.toLowerCase().endsWith(".md");
}

function shouldConvertRenamedNoteToFile(name: string) {
    const leafName = getBaseName(name.trim());
    if (!leafName) return false;
    if (leafName.startsWith(".") && leafName.length > 1) {
        return !isMarkdownLeafName(leafName);
    }
    if (!leafName.includes(".")) {
        return false;
    }
    return !isMarkdownLeafName(leafName);
}

function isAbsolutePath(path: string) {
    const normalized = path.replace(/\\/g, "/");
    return (
        normalized.startsWith("/") ||
        normalized.startsWith("//") ||
        /^[A-Za-z]:\//.test(normalized)
    );
}

function getAbsoluteVaultPath(vaultPath: string | null, path: string) {
    if (!path || isAbsolutePath(path)) return path;
    if (!vaultPath) return path;
    return `${vaultPath.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function getDraggedVaultFile(entry: VaultEntryDto) {
    return {
        filePath: entry.path,
        fileName: entry.file_name,
        mimeType:
            entry.kind === "pdf"
                ? "application/pdf"
                : (entry.mime_type ?? "application/octet-stream"),
    };
}

function getDraggedVaultFolder(path: string) {
    return {
        path,
        name: getBaseName(path),
    };
}

function isChatAttachableEntry(entry: VaultEntryDto) {
    return entry.kind === "pdf" || entry.kind === "file";
}

function emitFileTreeAttachment(
    detail: FileTreeNoteDragDetail,
    target: "current-chat" | "new-chat",
) {
    if (target === "new-chat") {
        emitFileTreeAttachToNewChat(detail);
        return;
    }

    const targetSessionId = getPreferredWorkspaceChatSessionId();
    emitFileTreeNoteDrag(
        targetSessionId ? { ...detail, targetSessionId } : detail,
    );
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

function TreeIndentGuides({
    depth,
    metrics,
    offsetX = 0,
}: {
    depth: number;
    metrics: TreeMetrics;
    offsetX?: number;
}) {
    if (depth <= 0) {
        return null;
    }

    return (
        <span
            aria-hidden="true"
            data-tree-indent-guides="true"
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
            }}
        >
            {Array.from({ length: depth }, (_, level) => {
                const guideX =
                    metrics.basePadding +
                    Math.round(
                        level * metrics.indentStep + metrics.indentStep / 2,
                    ) +
                    offsetX;
                return (
                    <span
                        key={level}
                        data-tree-guide-line="true"
                        style={{
                            position: "absolute",
                            left: guideX,
                            top: 0,
                            bottom: 0,
                            width: 1,
                            backgroundColor: TREE_GUIDE_COLOR,
                        }}
                    />
                );
            })}
        </span>
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
                borderRadius: 6,
                flexShrink: 0,
                position: "relative",
                color: active ? "var(--accent)" : "var(--text-secondary)",
                opacity: active ? 1 : 0.65,
                backgroundColor: active
                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                    : "transparent",
                transition:
                    "opacity 100ms ease, background-color 100ms ease, color 100ms ease",
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                if (!active)
                    e.currentTarget.style.backgroundColor =
                        "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.opacity = active ? "1" : "0.65";
                e.currentTarget.style.backgroundColor = active
                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                    : "transparent";
            }}
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
            {active && (
                <span
                    style={{
                        position: "absolute",
                        bottom: 1,
                        left: "50%",
                        transform: "translateX(-50%)",
                        width: 4,
                        height: 4,
                        borderRadius: "50%",
                        backgroundColor: "var(--accent)",
                        opacity: 0.8,
                    }}
                />
            )}
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
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [focusedIndex, setFocusedIndex] = useState(() =>
        Math.max(
            0,
            SORT_OPTIONS.findIndex((option) => option.id === current),
        ),
    );

    useEffect(() => {
        optionRefs.current[focusedIndex]?.focus();
    }, [focusedIndex]);

    useEffect(() => {
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node))
                onClose();
        };
        document.addEventListener("mousedown", handleDown);
        return () => {
            document.removeEventListener("mousedown", handleDown);
        };
    }, [onClose]);

    const focusOption = (index: number) => {
        const lastIndex = SORT_OPTIONS.length - 1;
        setFocusedIndex(Math.min(lastIndex, Math.max(0, index)));
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                focusOption((focusedIndex + 1) % SORT_OPTIONS.length);
                break;
            case "ArrowUp":
                event.preventDefault();
                focusOption(
                    focusedIndex === 0
                        ? SORT_OPTIONS.length - 1
                        : focusedIndex - 1,
                );
                break;
            case "Home":
                event.preventDefault();
                focusOption(0);
                break;
            case "End":
                event.preventDefault();
                focusOption(SORT_OPTIONS.length - 1);
                break;
            case "Enter":
            case " ":
                event.preventDefault();
                onSelect(SORT_OPTIONS[focusedIndex].id);
                break;
            case "Escape":
                event.preventDefault();
                onClose();
                break;
        }
    };

    return (
        <div
            ref={ref}
            role="menu"
            aria-label="Sort order"
            onKeyDown={handleKeyDown}
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
            {SORT_OPTIONS.map((opt, index) => (
                <button
                    key={opt.id}
                    ref={(element) => {
                        optionRefs.current[index] = element;
                    }}
                    role="menuitemradio"
                    aria-checked={opt.id === current}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    onClick={() => onSelect(opt.id)}
                    onFocus={() => setFocusedIndex(index)}
                    className="w-full text-left px-3 py-1.5 text-xs rounded flex items-center gap-2"
                    style={{ color: "var(--text-primary)" }}
                    onMouseEnter={(e) => {
                        setFocusedIndex(index);
                        (e.currentTarget.style.backgroundColor =
                            "var(--bg-tertiary)");
                    }}
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
    | { kind: "pdf"; entry: VaultEntryDto }
    | { kind: "file"; entry: VaultEntryDto };

// --- Tree node ---

interface FlatTreeRowViewProps {
    row: FlatTreeRow;
    metrics: TreeMetrics;
    activeNoteId: string | null;
    activeEntryPath: string | null;
    keyboardCursorKey: string | null;
    expandedFolders: Set<string>;
    selectedNoteIds: Set<string>;
    selectedEntryPaths: Set<string>;
    selectedFolderPaths: Set<string>;
    contextMenuFolderPath: string | null;
    draggingNoteIds: Set<string>;
    draggingFolderPath: string | null;
    dragOverPath: string | null;
    onFolderClick: (
        path: string,
        modifiers: { cmd: boolean; shift: boolean },
    ) => void;
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
    stickyContentOffsetX?: number;
}

const FlatTreeRowView = memo(
    function FlatTreeRowView({
        row,
        metrics,
        activeNoteId,
        activeEntryPath,
        keyboardCursorKey,
        expandedFolders,
        selectedNoteIds,
        selectedEntryPaths,
        selectedFolderPaths,
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
        stickyContentOffsetX = 0,
    }: FlatTreeRowViewProps) {
        const renameInputRef = useRef<HTMLInputElement>(null);
        const createInputRef = useRef<HTMLInputElement>(null);
        const paddingLeft =
            row.depth * metrics.indentStep +
            metrics.basePadding +
            stickyContentOffsetX;
        const noteOffset = Math.round(14 * metrics.scale);

        const isFolder = row.kind === "folder";
        const isSelectedFolder =
            row.kind === "folder" && selectedFolderPaths.has(row.path);
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
        const rowKey = getSelectableRowKey(row);
        const hasKeyboardCursor =
            rowKey !== null && rowKey === keyboardCursorKey;
        const keyboardCursorOutline = hasKeyboardCursor
            ? "1px solid color-mix(in srgb, var(--accent) 58%, transparent)"
            : undefined;
        const keyboardCursorStyle: React.CSSProperties = hasKeyboardCursor
            ? {
                  outline: keyboardCursorOutline,
                  outlineOffset: -1,
              }
            : {};

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
                            position: "relative",
                            paddingLeft,
                            fontSize: metrics.fontSize,
                            minHeight: metrics.rowHeight,
                            ...TREE_ROW_BOX_STYLE,
                        }}
                    >
                        <TreeIndentGuides
                            depth={row.depth}
                            metrics={metrics}
                            offsetX={stickyContentOffsetX}
                        />
                        <ChevronIcon
                            open={!!isExpanded}
                            size={metrics.smallIcon}
                        />
                        <FolderTypeIcon
                            folderName={row.path}
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
                    onMouseDown={(event) =>
                        onFolderMouseDown(row.path, event)
                    }
                    onClick={(event) =>
                        onFolderClick(row.path, {
                            cmd: event.metaKey || event.ctrlKey,
                            shift: event.shiftKey,
                        })
                    }
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFolderContextMenu(event, row.path);
                    }}
                    data-folder-path={row.path}
                    data-drag-over={isDragOver ? "true" : "false"}
                    data-selected={
                        isSelectedFolder || contextMenuFolderPath === row.path
                            ? "true"
                            : "false"
                    }
                    data-keyboard-focus={hasKeyboardCursor ? "true" : "false"}
                    className="file-tree-row flex items-center gap-1.5 text-left text-xs rounded"
                    style={{
                        position: "relative",
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
                            : isSelectedFolder ||
                                contextMenuFolderPath === row.path
                              ? {
                                    backgroundColor:
                                        "color-mix(in srgb, var(--accent) 22%, transparent)",
                                }
                              : {}),
                        outline: isDragOver
                            ? "1px solid var(--accent)"
                            : (keyboardCursorOutline ?? "none"),
                        outlineOffset: hasKeyboardCursor ? -1 : undefined,
                        opacity: isDraggingFolder ? 0.4 : 1,
                    }}
                >
                    <TreeIndentGuides
                        depth={row.depth}
                        metrics={metrics}
                        offsetX={stickyContentOffsetX}
                    />
                    <ChevronIcon open={!!isExpanded} size={metrics.smallIcon} />
                    <FolderTypeIcon
                        folderName={row.path}
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
                        position: "relative",
                        paddingLeft: paddingLeft + createOffset,
                        fontSize: metrics.fontSize,
                        minHeight: metrics.rowHeight,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <TreeIndentGuides
                        depth={row.depth}
                        metrics={metrics}
                        offsetX={stickyContentOffsetX}
                    />
                    {row.mode === "folder" ? (
                        <FolderTypeIcon
                            folderName={row.path}
                            open={false}
                            size={metrics.mediumIcon}
                        />
                    ) : (
                        <FileTypeIcon
                            fileName="New note.md"
                            kind="note"
                            size={metrics.smallIcon}
                        />
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
                    data-folder-path={getParentPath(entry.relative_path)}
                    data-selected={isSelected ? "true" : "false"}
                    data-active={isActive ? "true" : "false"}
                    data-keyboard-focus={hasKeyboardCursor ? "true" : "false"}
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
                        position: "relative",
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
                        ...keyboardCursorStyle,
                        minHeight: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <TreeIndentGuides
                        depth={row.depth}
                        metrics={metrics}
                        offsetX={stickyContentOffsetX}
                    />
                    <FileTypeIcon
                        fileName={entry.relative_path}
                        kind="pdf"
                        mimeType={entry.mime_type}
                        size={metrics.smallIcon}
                    />
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
                            position: "relative",
                            paddingLeft: paddingLeft + noteOffset,
                            fontSize: metrics.fontSize,
                            minHeight: metrics.rowHeight,
                            ...TREE_ROW_BOX_STYLE,
                        }}
                    >
                        <TreeIndentGuides
                            depth={row.depth}
                            metrics={metrics}
                            offsetX={stickyContentOffsetX}
                        />
                        <FileTypeIcon
                            fileName={entry.relative_path}
                            mimeType={entry.mime_type}
                            size={metrics.smallIcon}
                        />
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
                    data-folder-path={getParentPath(entry.relative_path)}
                    data-file-path={entry.relative_path}
                    data-selected={isSelected ? "true" : "false"}
                    data-active={isActive ? "true" : "false"}
                    data-keyboard-focus={hasKeyboardCursor ? "true" : "false"}
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
                        position: "relative",
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
                        ...keyboardCursorStyle,
                        minHeight: metrics.rowHeight,
                        fontSize: metrics.fontSize,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <TreeIndentGuides
                        depth={row.depth}
                        metrics={metrics}
                        offsetX={stickyContentOffsetX}
                    />
                    <FileTypeIcon
                        fileName={entry.relative_path}
                        mimeType={entry.mime_type}
                        size={metrics.smallIcon}
                    />
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
                        position: "relative",
                        paddingLeft: paddingLeft + noteOffset,
                        fontSize: metrics.fontSize,
                        minHeight: metrics.rowHeight,
                        ...TREE_ROW_BOX_STYLE,
                    }}
                >
                    <TreeIndentGuides
                        depth={row.depth}
                        metrics={metrics}
                        offsetX={stickyContentOffsetX}
                    />
                    <FileTypeIcon
                        fileName={note.path || note.id}
                        kind="note"
                        size={metrics.smallIcon}
                    />
                    <input
                        ref={renameInputRef}
                        defaultValue={getNoteRenameValue(note, showExtensions)}
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
                data-keyboard-focus={hasKeyboardCursor ? "true" : "false"}
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
                    position: "relative",
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
                    ...keyboardCursorStyle,
                    opacity: isDraggingThis ? 0.4 : 1,
                    minHeight: metrics.rowHeight,
                    fontSize: metrics.fontSize,
                    ...TREE_ROW_BOX_STYLE,
                }}
            >
                <TreeIndentGuides
                    depth={row.depth}
                    metrics={metrics}
                    offsetX={stickyContentOffsetX}
                />
                <FileTypeIcon
                    fileName={note.path || note.id}
                    kind="note"
                    size={metrics.smallIcon}
                />
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
        if (
            (getSelectableRowKey(prev.row) === prev.keyboardCursorKey) !==
            (getSelectableRowKey(next.row) === next.keyboardCursorKey)
        ) {
            return false;
        }
        if (prev.stickyContentOffsetX !== next.stickyContentOffsetX) {
            return false;
        }
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
                prev.selectedFolderPaths.has(path) !==
                next.selectedFolderPaths.has(path)
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
        | { kind: "file"; entry: VaultEntryDto }
        | { kind: "selection"; targets: MoveTargets };
    startX: number;
    startY: number;
    active: boolean;
}

function getDraggedVaultNote(note: NoteDto) {
    return {
        id: note.id,
        title: note.title,
        path: note.path,
    };
}

function buildFileTreeDragDetail(
    item: DragState["item"],
    phase: FileTreeNoteDragDetail["phase"],
    x: number,
    y: number,
): FileTreeNoteDragDetail {
    if (item.kind === "selection") {
        const notes = item.targets.notes.map(getDraggedVaultNote);
        const files = item.targets.entries
            .filter(isChatAttachableEntry)
            .map(getDraggedVaultFile);
        const folders = item.targets.folderPaths.map(getDraggedVaultFolder);
        return {
            phase,
            x,
            y,
            notes,
            ...(files.length > 0 ? { files } : {}),
            ...(folders.length === 1 ? { folder: folders[0] } : {}),
            ...(folders.length > 0 ? { folders } : {}),
        };
    }

    if (item.kind === "folder") {
        const folder = getDraggedVaultFolder(item.path);
        return {
            phase,
            x,
            y,
            notes: [],
            folder,
            folders: [folder],
        };
    }

    if (item.kind === "pdf" || item.kind === "file") {
        return {
            phase,
            x,
            y,
            notes: [],
            files: [getDraggedVaultFile(item.entry)],
        };
    }

    return {
        phase,
        x,
        y,
        notes: item.notes.map(getDraggedVaultNote),
    };
}

function getDragMoveTargets(item: DragState["item"]): MoveTargets {
    switch (item.kind) {
        case "selection":
            return item.targets;
        case "folder":
            return { notes: [], entries: [], folderPaths: [item.path] };
        case "pdf":
        case "file":
            return { notes: [], entries: [item.entry], folderPaths: [] };
        case "notes":
            return { notes: item.notes, entries: [], folderPaths: [] };
    }
}

function getMoveMenuLabel(targets: MoveTargets) {
    const count = getMoveTargetCount(targets);
    if (count > 1) {
        if (targets.notes.length === count) return "Move Selected Notes to…";
        if (targets.entries.length === count) return "Move Selected Files to…";
        return "Move Selected Items to…";
    }

    if (targets.folderPaths.length === 1) return "Move Folder to…";
    if (targets.notes.length === 1) return "Move Note to…";
    return "Move File to…";
}

function hasMoveDestination(targets: MoveTargets, folderPaths: string[]) {
    if (canMoveTargetsToFolder(targets, "")) return true;
    return folderPaths.some((folderPath) =>
        canMoveTargetsToFolder(targets, folderPath),
    );
}

function MoveDestinationPicker({
    state,
    folderPaths,
    onMove,
    onClose,
}: {
    state: MovePickerState;
    folderPaths: string[];
    onMove: (targetFolder: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [position, setPosition] = useState({ x: state.x, y: state.y });
    const normalizedQuery = query.trim().toLowerCase();
    const visibleFolderPaths = useMemo(() => {
        if (!normalizedQuery) return folderPaths;
        return folderPaths.filter((folderPath) => {
            const folderName = getBaseName(folderPath).toLowerCase();
            return (
                folderName.includes(normalizedQuery) ||
                folderPath.toLowerCase().includes(normalizedQuery)
            );
        });
    }, [folderPaths, normalizedQuery]);

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                state.x,
                state.y,
                rect.width,
                rect.height,
            ),
        );
    }, [state.x, state.y, visibleFolderPaths.length]);

    useEffect(() => {
        inputRef.current?.focus();

        const handleDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [onClose]);

    const renderTargetButton = (folderPath: string, label: string) => {
        const disabled = !canMoveTargetsToFolder(state.targets, folderPath);
        return (
            <button
                key={folderPath || "__root__"}
                type="button"
                aria-label={label}
                disabled={disabled}
                onClick={() => {
                    if (disabled) return;
                    onClose();
                    onMove(folderPath);
                }}
                className="text-left rounded"
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 8px",
                    color: "var(--text-primary)",
                    background: "transparent",
                    opacity: disabled ? 0.45 : 1,
                    cursor: disabled ? "default" : "pointer",
                }}
                onMouseEnter={(event) => {
                    if (disabled) return;
                    event.currentTarget.style.backgroundColor =
                        "var(--bg-tertiary)";
                }}
                onMouseLeave={(event) => {
                    event.currentTarget.style.backgroundColor = "transparent";
                }}
            >
                <span aria-hidden="true" style={{ flexShrink: 0 }}>
                    <FolderTypeIcon
                        folderName={folderPath || "vault"}
                        open={!folderPath}
                        size={15}
                    />
                </span>
                <span
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                        minWidth: 0,
                        flex: 1,
                    }}
                >
                    <span
                        style={{
                            fontSize: 12,
                            lineHeight: "16px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: "100%",
                        }}
                    >
                        {label}
                    </span>
                    {folderPath ? (
                        <span
                            aria-hidden="true"
                            style={{
                                fontSize: 10,
                                lineHeight: "13px",
                                color: "var(--text-tertiary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: "100%",
                            }}
                        >
                            {getParentPath(folderPath) || "/ Root"}
                        </span>
                    ) : null}
                </span>
            </button>
        );
    };

    return createPortal(
        <div
            ref={ref}
            role="dialog"
            aria-label="Move to Folder"
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10001,
                width: 280,
                maxHeight: 360,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 8,
                borderRadius: 10,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 10px 28px rgba(0,0,0,0.28)",
            }}
        >
            <div
                style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    padding: "0 2px",
                }}
            >
                Move to Folder
            </div>
            <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search folders..."
                style={{
                    width: "100%",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--bg-primary)",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    padding: "6px 8px",
                    outline: "none",
                }}
            />
            <div
                style={{
                    overflowY: "auto",
                    maxHeight: 280,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                }}
            >
                {renderTargetButton("", "/ Root")}
                {visibleFolderPaths.map((folderPath) =>
                    renderTargetButton(folderPath, getBaseName(folderPath)),
                )}
                {visibleFolderPaths.length === 0 ? (
                    <div
                        style={{
                            padding: "8px",
                            color: "var(--text-tertiary)",
                            fontSize: 12,
                        }}
                    >
                        No matching folders
                    </div>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}

// --- Main FileTree ---

export function FileTree() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const getFileTreeScrollTop = useLayoutStore(
        (s) => s.getFileTreeScrollTop,
    );
    const setFileTreeScrollTop = useLayoutStore(
        (s) => s.setFileTreeScrollTop,
    );
    const notes = useVaultStore((s) => s.notes);
    const entries = useVaultStore((s) => s.entries ?? []);
    const structureRevision = useVaultStore((s) => s.structureRevision);
    const contentRevision = useVaultStore((s) => s.contentRevision);
    const createNote = useVaultStore((s) => s.createNote);
    const createFolder = useVaultStore((s) => s.createFolder);
    const deleteNote = useVaultStore((s) => s.deleteNote);
    const deleteFolder = useVaultStore((s) => s.deleteFolder);
    const renameFolder = useVaultStore((s) => s.renameFolder);
    const renameNote = useVaultStore((s) => s.renameNote);
    const renameNoteAsFile = useVaultStore((s) => s.renameNoteAsFile);
    const refreshStructure = useVaultStore((s) => s.refreshStructure);
    const updateNoteMetadata = useVaultStore((s) => s.updateNoteMetadata);
    const touchContent = useVaultStore((s) => s.touchContent);
    const activeNoteId = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeEntryPath = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        if (tab && (isPdfTab(tab) || isFileTab(tab))) {
            return tab.path;
        }
        return null;
    });
    const openNote = useEditorStore((s) => s.openNote);
    const closeTab = useEditorStore((s) => s.closeTab);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const bookmarkItems = useBookmarkStore((s) => s.items);
    const fileTreeScale = useSettingsStore((s) => s.fileTreeScale);
    const fileTreeStickyFolders = useSettingsStore(
        (s) => s.fileTreeStickyFolders,
    );
    const fileTreeContentMode = useSettingsStore((s) => s.fileTreeContentMode);
    const fileTreeShowExtensions = useSettingsStore(
        (s) => s.fileTreeShowExtensions,
    );
    const fileTreeExtensionFilter = useSettingsStore(
        (s) => s.fileTreeExtensionFilter,
    );

    // Editor/workspace toggles that the unified toolbar exposes alongside the
    // tree-specific actions. Sourced from the same stores the old utility
    // row in SidebarShell used to read.
    const livePreviewEnabled = useSettingsStore((s) => s.livePreviewEnabled);
    const lineWrapping = useSettingsStore((s) => s.lineWrapping);
    const setSetting = useSettingsStore((s) => s.setSetting);

    const [sortMode, setSortMode] = useState<SortMode>(
        () => (safeStorageGetItem(SORT_KEY) as SortMode | null) ?? "name_asc",
    );
    const [revealActive, setRevealActive] = useState(
        () => safeStorageGetItem(REVEAL_KEY) === "true",
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        () => readExpandedFolders(vaultPath),
    );
    const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(
        new Set(),
    );
    const [selectedEntryPaths, setSelectedEntryPaths] = useState<Set<string>>(
        new Set(),
    );
    const [selectedFolderPaths, setSelectedFolderPaths] = useState<
        Set<string>
    >(new Set());
    const selectedRowCount =
        selectedNoteIds.size +
        selectedEntryPaths.size +
        selectedFolderPaths.size;
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
    const [movePicker, setMovePicker] = useState<MovePickerState | null>(null);
    const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
    const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(
        null,
    );
    const [renamingEntryPath, setRenamingEntryPath] = useState<string | null>(
        null,
    );
    const [, setClipboardVersion] = useState(0);
    const [focusedFolderPath, setFocusedFolderPath] = useState("");
    const [filterText, setFilterText] = useState("");
    const [keyboardCursorKey, setKeyboardCursorKey] = useState<string | null>(
        null,
    );

    const treeScrollRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef<DragState | null>(null);
    const dragOverPathRef = useRef<string | null>(null);
    const wasJustDraggingRef = useRef(false);
    const rafScrollRef = useRef(0);
    const restoreScrollRafRef = useRef<number | null>(null);
    const pendingRevealRef = useRef<string | null>(null);
    const lastClickedEntryPathRef = useRef<string | null>(null);
    const lastClickedRowKeyRef = useRef<string | null>(null);
    const suppressActiveKeyboardCursorRef = useRef(false);
    const flatRowsRef = useRef<FlatTreeRow[]>([]);
    const displayRowsRef = useRef<FlatTreeRow[]>([]);
    const shortcutNavigableRowsRef = useRef<FlatTreeRow[]>([]);
    const renameGuardRef = useRef(false);
    const expandedFoldersVaultPathRef = useRef(vaultPath);
    const skipExpandedFoldersPersistRef = useRef(false);
    const restoredScrollVaultPathRef = useRef<string | null>(null);

    const showTreeKeyboardCursor = useCallback((rowKey: string) => {
        suppressActiveKeyboardCursorRef.current = false;
        setKeyboardCursorKey(rowKey);
    }, []);
    const suppressRevealActivePathRef = useRef<string | null>(null);

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
    const visibleSelectedFolderPaths = selectedFolderPaths;
    const treeRevision =
        sortMode === "modified_desc" || sortMode === "modified_asc"
            ? `${structureRevision}:${contentRevision}`
            : structureRevision;
    const fileTreeExtensionFilterKey = fileTreeExtensionFilter.join("\n");
    const visibleNotes = useMemo(() => {
        return shouldIncludeMarkdownNotesInFileScope({
            contentMode: fileTreeContentMode,
            extensionFilter: fileTreeExtensionFilter,
        })
            ? notes
            : [];
    }, [fileTreeContentMode, fileTreeExtensionFilter, notes]);
    const visibleEntries = useMemo(
        () =>
            entries.filter((entry) =>
                shouldShowVaultEntryInFileTree(entry, {
                    contentMode: fileTreeContentMode,
                    extensionFilter: fileTreeExtensionFilter,
                }),
            ),
        [entries, fileTreeContentMode, fileTreeExtensionFilter],
    );
    // Intentionally keyed by revisions instead of the full notes array to avoid
    // rebuilding the folder tree for content-only updates.
    const tree = useMemo(
        () => buildTree(visibleNotes, visibleEntries),
        // visibleEntries and the filter key change only when entries/settings change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [treeRevision, visibleEntries, fileTreeExtensionFilterKey],
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
    const normalizedFilter = filterText.trim().toLowerCase();
    const fullyExpandedRows = useMemo(
        () => flattenTreeRows(tree, new Set(allFolderPaths), sortMode),
        [allFolderPaths, sortMode, tree],
    );
    const flatRows = useMemo(() => {
        // Without a filter, honor the user's expansion state as usual.
        if (!normalizedFilter) {
            return flattenTreeRows(tree, visibleExpandedFolders, sortMode);
        }
        // Active filter: walk the whole tree (all folders expanded) so hits
        // buried inside collapsed folders surface. Then keep only rows that
        // match directly, their ancestor folders (to preserve hierarchy),
        // and — if a folder itself matches — all of its descendants.
        return filterFlatTreeRows(fullyExpandedRows, normalizedFilter);
    }, [
        fullyExpandedRows,
        normalizedFilter,
        sortMode,
        tree,
        visibleExpandedFolders,
    ]);
    flatRowsRef.current = flatRows;
    const shortcutNavigableRows = useMemo(
        () => filterFlatTreeRows(fullyExpandedRows, normalizedFilter),
        [fullyExpandedRows, normalizedFilter],
    );
    shortcutNavigableRowsRef.current = shortcutNavigableRows;
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
    displayRowsRef.current = displayRows;

    useEffect(() => {
        const visibleKeys = new Set(
            displayRows
                .map((row) => getSelectableRowKey(row))
                .filter((key): key is string => key !== null),
        );

        setKeyboardCursorKey((current) => {
            if (suppressActiveKeyboardCursorRef.current) {
                return current && visibleKeys.has(current) ? current : null;
            }
            if (activeNoteId && visibleKeys.has(`note:${activeNoteId}`)) {
                return `note:${activeNoteId}`;
            }
            if (
                activeEntryPath &&
                visibleKeys.has(`entry:${activeEntryPath}`)
            ) {
                return `entry:${activeEntryPath}`;
            }
            return current && visibleKeys.has(current) ? current : null;
        });
    }, [activeEntryPath, activeNoteId, displayRows]);
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
            toolbarHeight: Math.max(30, Math.round(30 * treeScale)),
            toolbarButton: Math.max(24, Math.round(24 * treeScale)),
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
        // Filtering already rewrites the visible hierarchy around matches;
        // sticky headers add visual noise and can obscure filtered results.
        if (normalizedFilter) return [];
        if (!fileTreeStickyFolders) return [];
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
    }, [
        displayRows,
        fileTreeStickyFolders,
        normalizedFilter,
        scrollTop,
        metrics.rowHeight,
        folderLastDescendant,
    ]);

    const stickyFolderPaths = useMemo(
        () => new Set(stickyFolders.map((f) => f.row.path)),
        [stickyFolders],
    );

    // Restore the file list scroll when the sidebar remounts after switching
    // views. The position is kept in memory only, so app launches still start
    // from the top.
    useLayoutEffect(() => {
        const restoreKey = vaultPath || "__no_vault__";
        if (restoredScrollVaultPathRef.current === restoreKey) return;

        const savedScrollTop = getFileTreeScrollTop(vaultPath);
        if (savedScrollTop <= 0) {
            restoredScrollVaultPathRef.current = restoreKey;
            return;
        }

        if (displayRows.length === 0) return;

        let cancelled = false;
        let attempt = 0;
        suppressRevealActivePathRef.current = activeTreePath;

        const cancelPendingRestore = () => {
            if (restoreScrollRafRef.current === null) return;
            cancelAnimationFrame(restoreScrollRafRef.current);
            restoreScrollRafRef.current = null;
        };

        const applySavedScrollTop = () => {
            const el = treeScrollRef.current;
            if (!el) return true;

            const maxScrollTop = Math.max(
                0,
                Math.max(el.scrollHeight, totalHeight) - el.clientHeight,
            );
            const nextScrollTop = Math.min(savedScrollTop, maxScrollTop);
            el.scrollTop = nextScrollTop;
            setScrollTop(nextScrollTop);
            setFileTreeScrollTop(vaultPath, nextScrollTop);

            if (
                savedScrollTop <= maxScrollTop ||
                attempt >= FILE_TREE_SCROLL_RESTORE_MAX_ATTEMPTS
            ) {
                restoredScrollVaultPathRef.current = restoreKey;
                return true;
            }

            return false;
        };

        const retryRestore = () => {
            restoreScrollRafRef.current = null;
            if (cancelled || applySavedScrollTop()) return;

            attempt += 1;
            restoreScrollRafRef.current =
                requestAnimationFrame(retryRestore);
        };

        if (!applySavedScrollTop()) {
            attempt += 1;
            restoreScrollRafRef.current = requestAnimationFrame(retryRestore);
        }

        return () => {
            cancelled = true;
            cancelPendingRestore();
        };
    }, [
        displayRows.length,
        activeTreePath,
        getFileTreeScrollTop,
        setFileTreeScrollTop,
        totalHeight,
        vaultPath,
    ]);

    // Track viewport size
    useLayoutEffect(() => {
        const el = treeScrollRef.current;
        if (!el) return;
        const syncViewportMetrics = () => {
            setViewportHeight(el.clientHeight);
            setScrollTop(el.scrollTop);
        };

        syncViewportMetrics();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", syncViewportMetrics);
            return () => {
                cancelAnimationFrame(rafScrollRef.current);
                setFileTreeScrollTop(vaultPath, el.scrollTop);
                window.removeEventListener("resize", syncViewportMetrics);
            };
        }

        const ro = new ResizeObserver(() => {
            syncViewportMetrics();
        });
        ro.observe(el);
        window.addEventListener("resize", syncViewportMetrics);
        return () => {
            cancelAnimationFrame(rafScrollRef.current);
            setFileTreeScrollTop(vaultPath, el.scrollTop);
            ro.disconnect();
            window.removeEventListener("resize", syncViewportMetrics);
        };
    }, [setFileTreeScrollTop, vaultPath]);

    useEffect(() => {
        if (expandedFoldersVaultPathRef.current === vaultPath) return;
        expandedFoldersVaultPathRef.current = vaultPath;
        skipExpandedFoldersPersistRef.current = true;
        setExpandedFolders(readExpandedFolders(vaultPath));
    }, [vaultPath]);

    useEffect(() => {
        if (skipExpandedFoldersPersistRef.current) {
            skipExpandedFoldersPersistRef.current = false;
            return;
        }
        writeExpandedFolders(vaultPath, expandedFolders);
    }, [expandedFolders, vaultPath]);

    useEffect(() => {
        return subscribeSafeStorage((event) => {
            if (event.key !== "neverwrite.fileTree.clipboard") return;
            setClipboardVersion((value) => value + 1);
        });
    }, []);

    useLayoutEffect(() => {
        const el = treeScrollRef.current;
        if (!el) return;

        const maxScrollTop = Math.max(0, totalHeight - el.clientHeight);
        if (el.scrollTop > maxScrollTop) {
            el.scrollTop = maxScrollTop;
            setFileTreeScrollTop(vaultPath, maxScrollTop);
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
        setFileTreeScrollTop,
        vaultPath,
    ]);

    // RAF-batched scroll handler
    const handleTreeScroll = useCallback(() => {
        const el = treeScrollRef.current;
        if (!el) return;
        setFileTreeScrollTop(vaultPath, el.scrollTop);
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = requestAnimationFrame(() => {
            const el = treeScrollRef.current;
            if (!el) return;
            const nextScrollTop = el.scrollTop;
            setScrollTop(nextScrollTop);
        });
    }, [setFileTreeScrollTop, vaultPath]);

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
            setFileTreeScrollTop(vaultPath, top);
            if (typeof container.scrollTo === "function") {
                container.scrollTo({ top, behavior });
                return;
            }
            container.scrollTop = top;
        },
        [metrics.rowHeight, setFileTreeScrollTop, totalHeight, vaultPath],
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
        if (suppressRevealActivePathRef.current === activeTreePath) return;
        suppressRevealActivePathRef.current = null;

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
            setSelectedEntryPaths(new Set());
            setSelectedFolderPaths(new Set());
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
                const moved = await renameFolder(folderPath, nextFolderPath);
                if (!moved) return null;

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
                setSelectedFolderPaths((prev) => {
                    const next = new Set<string>();
                    for (const path of prev) {
                        next.add(
                            movePathPrefix(path, folderPath, nextFolderPath),
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

                return nextFolderPath;
            } catch (error) {
                logError("file-tree", "Failed to move folder", error);
                return null;
            }
        },
        [renameFolder, vaultPath],
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
                setSelectedFolderPaths(new Set());
                setFocusedFolderPath(getParentPath(updated.relative_path));
                await useVaultStore.getState().refreshEntries();
                return updated;
            } catch (error) {
                logError("file-tree", "Failed to move vault entry", error);
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

    const applyMoveTargets = useCallback(
        async (targets: MoveTargets, targetFolder: string) => {
            const normalized = normalizeMoveTargets(targets);

            for (const folderPath of normalized.folderPaths) {
                await moveFolder(folderPath, targetFolder);
            }

            const noteOperations = buildNoteMoveOperations(
                normalized.notes,
                targetFolder,
            );
            if (noteOperations.length > 0) {
                await applyMoveOperations(noteOperations);
            }

            for (const entry of normalized.entries) {
                await moveVaultEntry(entry, targetFolder);
            }
        },
        [applyMoveOperations, moveFolder, moveVaultEntry],
    );

    const getDragTargetFolder = useCallback(
        (item: DragState["item"], hoveredFolder: string | null) => {
            if (hoveredFolder === null) return null;

            return canMoveTargetsToFolder(
                getDragMoveTargets(item),
                hoveredFolder,
            )
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
                if (s.item.kind === "selection") {
                    setDraggingNoteIds(
                        new Set(
                            s.item.targets.notes.map((note) => note.id),
                        ),
                    );
                    setDraggingFolderPath(
                        s.item.targets.folderPaths[0] ?? null,
                    );
                    const itemCount =
                        s.item.targets.notes.length +
                        s.item.targets.entries.length +
                        s.item.targets.folderPaths.length;
                    setDragLabel(`${itemCount} items`);
                } else if (s.item.kind === "folder") {
                    setDraggingFolderPath(s.item.path);
                    setDragLabel(getBaseName(s.item.path));
                } else if (s.item.kind === "pdf") {
                    setDragLabel(s.item.entry.file_name);
                } else if (s.item.kind === "file") {
                    setDragLabel(s.item.entry.file_name);
                } else {
                    setDraggingNoteIds(
                        new Set(s.item.notes.map((note) => note.id)),
                    );
                    setDragLabel(
                        s.item.notes.length > 1
                            ? `${s.item.notes.length} notes`
                            : (s.item.notes[0]?.title ?? null),
                    );
                }
                emitFileTreeNoteDrag(
                    buildFileTreeDragDetail(
                        s.item,
                        "start",
                        e.clientX,
                        e.clientY,
                    ),
                );
            }

            setDragPos({ x: e.clientX, y: e.clientY });
            if (s.active) {
                emitFileTreeNoteDrag(
                    buildFileTreeDragDetail(
                        s.item,
                        "move",
                        e.clientX,
                        e.clientY,
                    ),
                );
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

            emitFileTreeNoteDrag(
                buildFileTreeDragDetail(s.item, "end", e.clientX, e.clientY),
            );

            wasJustDraggingRef.current = true;
            requestAnimationFrame(() => {
                wasJustDraggingRef.current = false;
            });

            resetDragState();

            const folder = dragOverPathRef.current;
            dragOverPathRef.current = null;
            setDragOverPath(null);

            if (folder === null) return;

            await applyMoveTargets(getDragMoveTargets(s.item), folder);
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [
        applyMoveTargets,
        getDragTargetFolder,
        resetDragState,
    ]);

    useEffect(() => {
        const handler = (event: Event) => {
            if (dragStateRef.current) return;
            const { phase, folderPath } = (
                event as CustomEvent<ExternalFileTreeDragDetail>
            ).detail;
            setDragOverPath(phase === "over" ? folderPath : null);
        };
        window.addEventListener(EXTERNAL_FILE_TREE_DRAG_EVENT, handler);
        return () => {
            window.removeEventListener(EXTERNAL_FILE_TREE_DRAG_EVENT, handler);
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
        safeStorageSetItem(SORT_KEY, mode);
        setSortMenuOpen(false);
    };

    const applySelectionState = useCallback((selection: TreeSelectionState) => {
        setSelectedNoteIds(selection.noteIds);
        setSelectedEntryPaths(selection.entryPaths);
        setSelectedFolderPaths(selection.folderPaths);
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
            setSelectedFolderPaths((prev) => {
                const next = new Set(prev);
                selection.folderPaths.forEach((folderPath) =>
                    next.add(folderPath),
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

    const handleFolderClick = useCallback(
        (path: string, modifiers: { cmd: boolean; shift: boolean }) => {
            if (wasJustDraggingRef.current) return;
            setFocusedFolderPath(path);
            const rowKey = `folder:${path}`;
            showTreeKeyboardCursor(rowKey);

            if (modifiers.shift && selectRowRange(rowKey, modifiers.cmd)) {
                return;
            }

            if (modifiers.cmd) {
                setSelectedFolderPaths((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                });
                lastClickedRowKeyRef.current = rowKey;
                return;
            }

            setSelectedEntryPaths(new Set());
            setSelectedNoteIds(new Set());
            setSelectedFolderPaths(new Set());
            lastClickedRowKeyRef.current = rowKey;
            handleToggleFolder(path);
        },
        [selectRowRange, showTreeKeyboardCursor],
    );

    const handleRevealToggle = () => {
        const next = !revealActive;
        if (!next) {
            // Preserve the currently visible tree state so nothing collapses
            setExpandedFolders(new Set(visibleExpandedFolders));
        }
        setRevealActive(next);
        safeStorageSetItem(REVEAL_KEY, String(next));
    };

    const handleCollapseExpandAll = () => {
        if (canCollapseAll) {
            setExpandedFolders(new Set());
        } else {
            setExpandedFolders(new Set(allFolderPaths));
        }
    };

    const getSelectedChatContextTargets = useCallback(
        (): ChatContextTargets => ({
            notes: notes.filter((item) => selectedNoteIds.has(item.id)),
            entries: entries.filter(
                (item) =>
                    selectedEntryPaths.has(item.path) &&
                    isChatAttachableEntry(item),
            ),
            folderPaths: allFolderPaths.filter((path) =>
                selectedFolderPaths.has(path),
            ),
        }),
        [
            allFolderPaths,
            entries,
            notes,
            selectedEntryPaths,
            selectedFolderPaths,
            selectedNoteIds,
        ],
    );

    const getSelectedMoveTargets = useCallback(
        (): MoveTargets => ({
            notes: notes.filter((item) => selectedNoteIds.has(item.id)),
            entries: entries.filter((item) => selectedEntryPaths.has(item.path)),
            folderPaths: allFolderPaths.filter((path) =>
                selectedFolderPaths.has(path),
            ),
        }),
        [
            allFolderPaths,
            entries,
            notes,
            selectedEntryPaths,
            selectedFolderPaths,
            selectedNoteIds,
        ],
    );

    const handleNoteMouseDown = useCallback(
        (note: NoteDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault(); // prevent text selection during drag
            if (selectedRowCount > 1 && selectedNoteIds.has(note.id)) {
                dragStateRef.current = {
                    item: {
                        kind: "selection",
                        targets: getSelectedMoveTargets(),
                    },
                    startX: e.clientX,
                    startY: e.clientY,
                    active: false,
                };
                return;
            }
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
        [
            getSelectedMoveTargets,
            notes,
            selectedNoteIds,
            selectedRowCount,
        ],
    );

    const handleFolderMouseDown = useCallback(
        (path: string, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (selectedRowCount > 1 && selectedFolderPaths.has(path)) {
                dragStateRef.current = {
                    item: {
                        kind: "selection",
                        targets: getSelectedMoveTargets(),
                    },
                    startX: e.clientX,
                    startY: e.clientY,
                    active: false,
                };
                return;
            }
            dragStateRef.current = {
                item: { kind: "folder", path },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [
            getSelectedMoveTargets,
            selectedFolderPaths,
            selectedRowCount,
        ],
    );

    const openPdf = useEditorStore((s) => s.openPdf);

    const handlePdfClick = useCallback(
        (entry: VaultEntryDto, modifiers: { cmd: boolean; shift: boolean }) => {
            if (wasJustDraggingRef.current) return;
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const rowKey = `entry:${entry.path}`;
            showTreeKeyboardCursor(rowKey);
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
            setSelectedFolderPaths(new Set());
            lastClickedEntryPathRef.current = entry.path;
            lastClickedRowKeyRef.current = rowKey;
            openPdf(entry.id, entry.title, entry.path);
        },
        [activeEntryPath, openPdf, selectRowRange, showTreeKeyboardCursor],
    );

    const handlePdfMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (selectedRowCount > 1 && selectedEntryPaths.has(entry.path)) {
                dragStateRef.current = {
                    item: {
                        kind: "selection",
                        targets: getSelectedMoveTargets(),
                    },
                    startX: e.clientX,
                    startY: e.clientY,
                    active: false,
                };
                return;
            }
            dragStateRef.current = {
                item: { kind: "pdf", entry },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [
            getSelectedMoveTargets,
            selectedEntryPaths,
            selectedRowCount,
        ],
    );

    const handlePdfContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) => {
            e.preventDefault();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const preserveSelection =
                selectedRowCount > 1 &&
                selectedEntryPaths.has(entry.path);
            if (!preserveSelection) {
                setSelectedNoteIds(new Set());
                setSelectedEntryPaths(new Set([entry.path]));
                setSelectedFolderPaths(new Set());
            }
            setMovePicker(null);
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                payload: { kind: "pdf", entry },
            });
        },
        [selectedEntryPaths, selectedRowCount],
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
            setSelectedFolderPaths(new Set());
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
            showTreeKeyboardCursor(rowKey);
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
            setSelectedFolderPaths(new Set());
            lastClickedEntryPathRef.current = entry.path;
            lastClickedRowKeyRef.current = rowKey;
            void openVaultFileEntry(entry);
        },
        [activeEntryPath, selectRowRange, showTreeKeyboardCursor],
    );

    const handleFileMouseDown = useCallback(
        (entry: VaultEntryDto, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (selectedRowCount > 1 && selectedEntryPaths.has(entry.path)) {
                dragStateRef.current = {
                    item: {
                        kind: "selection",
                        targets: getSelectedMoveTargets(),
                    },
                    startX: e.clientX,
                    startY: e.clientY,
                    active: false,
                };
                return;
            }
            dragStateRef.current = {
                item: { kind: "file", entry },
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [
            getSelectedMoveTargets,
            selectedEntryPaths,
            selectedRowCount,
        ],
    );

    const handleFileContextMenu = useCallback(
        (e: React.MouseEvent, entry: VaultEntryDto) => {
            e.preventDefault();
            setFocusedFolderPath(getParentPath(entry.relative_path));
            const preserveSelection =
                selectedRowCount > 1 &&
                selectedEntryPaths.has(entry.path);
            if (!preserveSelection) {
                setSelectedNoteIds(new Set());
                setSelectedEntryPaths(new Set([entry.path]));
                setSelectedFolderPaths(new Set());
            }
            setMovePicker(null);
            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                payload: { kind: "file", entry },
            });
        },
        [selectedEntryPaths, selectedRowCount],
    );

    const handleOpenFileInNewTab = useCallback(async (entry: VaultEntryDto) => {
        try {
            await openVaultFileEntry(entry, { newTab: true });
        } catch (error) {
            logError("file-tree", "Failed to open file in new tab", error);
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
            setSelectedFolderPaths(new Set());
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
            logError("file-tree", "Failed to move vault entry to trash", error);
        }
    }, []);

    const clearTreeSelection = useCallback(() => {
        if (
            selectedRowCount === 0 &&
            lastClickedRowKeyRef.current === null &&
            keyboardCursorKey === null
        ) {
            return;
        }

        suppressActiveKeyboardCursorRef.current = true;
        setSelectedNoteIds((prev) => (prev.size === 0 ? prev : new Set()));
        setSelectedEntryPaths((prev) => (prev.size === 0 ? prev : new Set()));
        setSelectedFolderPaths((prev) => (prev.size === 0 ? prev : new Set()));
        setKeyboardCursorKey(null);
        lastClickedRowKeyRef.current = null;
    }, [keyboardCursorKey, selectedRowCount]);

    useEffect(() => {
        window.addEventListener(
            CLEAR_FILE_TREE_SELECTION_EVENT,
            clearTreeSelection,
        );
        return () => {
            window.removeEventListener(
                CLEAR_FILE_TREE_SELECTION_EVENT,
                clearTreeSelection,
            );
        };
    }, [clearTreeSelection]);

    const clearEntrySelection = useCallback(() => {
        setSelectedEntryPaths(new Set());
        setSelectedFolderPaths(new Set());
    }, []);

    const handleCopyFullPath = useCallback((path: string) => {
        if (!path) return;
        void navigator.clipboard.writeText(path);
    }, []);

    const handleAddChatTargetsToChat = useCallback(
        (
            targets: ChatContextTargets,
            target: "current-chat" | "new-chat" = "current-chat",
        ) => {
            const notesToAdd = targets.notes.map((note) => ({
                id: note.id,
                title: note.title,
                path: note.path,
            }));
            const files = targets.entries
                .filter(isChatAttachableEntry)
                .map(getDraggedVaultFile);
            const folders = targets.folderPaths.map(getDraggedVaultFolder);
            if (
                notesToAdd.length === 0 &&
                files.length === 0 &&
                folders.length === 0
            ) {
                return;
            }

            emitFileTreeAttachment(
                {
                    phase: "attach",
                    x: 0,
                    y: 0,
                    notes: notesToAdd,
                    ...(folders.length === 1 ? { folder: folders[0] } : {}),
                    ...(folders.length > 0 ? { folders } : {}),
                    ...(files.length > 0 ? { files } : {}),
                },
                target,
            );
        },
        [],
    );

    const readNoteContent = useCallback(
        (noteId: string) =>
            vaultInvoke<{ content: string }>("read_note", { noteId }),
        [],
    );

    const openTreeNote = useCallback(
        async (note: NoteDto) => {
            const existing = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find(
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
                logError("file-tree", "Failed to open tree note", error);
            }
        },
        [openNote, readNoteContent],
    );

    const handleOpenNoteInNewTab = useCallback(
        async (note: NoteDto) => {
            try {
                const existing = selectEditorWorkspaceTabs(
                    useEditorStore.getState(),
                ).find(
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
                logError(
                    "file-tree",
                    "Failed to open tree note in new tab",
                    error,
                );
            }
        },
        [insertExternalTab, readNoteContent],
    );

    const handleNoteClick = useCallback(
        async (
            note: NoteDto,
            modifiers: { cmd: boolean; shift: boolean },
        ) => {
            if (wasJustDraggingRef.current) return;
            setFocusedFolderPath(getParentPath(note.id));
            const rowKey = `note:${note.id}`;
            showTreeKeyboardCursor(rowKey);

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
        },
        [clearEntrySelection, openTreeNote, selectRowRange, showTreeKeyboardCursor],
    );

    const handleNoteAuxClick = useCallback(
        (note: NoteDto, event: React.MouseEvent) => {
            if (event.button !== 1) return;
            if (wasJustDraggingRef.current) return;

            event.preventDefault();
            event.stopPropagation();
            clearEntrySelection();
            setSelectedNoteIds(new Set([note.id]));
            lastClickedRowKeyRef.current = `note:${note.id}`;
            void handleOpenNoteInNewTab(note);
        },
        [clearEntrySelection, handleOpenNoteInNewTab],
    );

    const handleNoteContextMenu = (e: React.MouseEvent, note: NoteDto) => {
        e.preventDefault();
        setFocusedFolderPath(getParentPath(note.id));

        const preserveSelection =
            selectedRowCount > 1 && selectedNoteIds.has(note.id);

        if (!preserveSelection) {
            clearEntrySelection();
            setSelectedNoteIds(new Set([note.id]));
            lastClickedRowKeyRef.current = `note:${note.id}`;
        }

        setMovePicker(null);
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            payload: { kind: "note", note },
        });
    };

    const handleFolderContextMenu = (e: React.MouseEvent, path: string) => {
        e.preventDefault();
        setFocusedFolderPath(path);
        const preserveSelection =
            selectedRowCount > 1 && selectedFolderPaths.has(path);

        if (!preserveSelection) {
            clearEntrySelection();
            setSelectedNoteIds(new Set());
            setSelectedFolderPaths(new Set([path]));
            lastClickedRowKeyRef.current = `folder:${path}`;
        }

        setMovePicker(null);
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
        setMovePicker(null);
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

    const getContextChatTargetsForNote = useCallback(
        (note: NoteDto): ChatContextTargets => {
            if (selectedRowCount > 1 && selectedNoteIds.has(note.id)) {
                return getSelectedChatContextTargets();
            }
            return { notes: [note], entries: [], folderPaths: [] };
        },
        [getSelectedChatContextTargets, selectedNoteIds, selectedRowCount],
    );

    const getContextChatTargetsForEntry = useCallback(
        (entry: VaultEntryDto): ChatContextTargets => {
            if (selectedRowCount > 1 && selectedEntryPaths.has(entry.path)) {
                return getSelectedChatContextTargets();
            }
            return {
                notes: [],
                entries: isChatAttachableEntry(entry) ? [entry] : [],
                folderPaths: [],
            };
        },
        [getSelectedChatContextTargets, selectedEntryPaths, selectedRowCount],
    );

    const getContextChatTargetsForFolder = useCallback(
        (path: string): ChatContextTargets => {
            if (selectedRowCount > 1 && selectedFolderPaths.has(path)) {
                return getSelectedChatContextTargets();
            }
            return { notes: [], entries: [], folderPaths: [path] };
        },
        [getSelectedChatContextTargets, selectedFolderPaths, selectedRowCount],
    );

    const getContextMoveTargetsForNote = useCallback(
        (note: NoteDto): MoveTargets => {
            if (selectedRowCount > 1 && selectedNoteIds.has(note.id)) {
                return getSelectedMoveTargets();
            }
            return { notes: [note], entries: [], folderPaths: [] };
        },
        [getSelectedMoveTargets, selectedNoteIds, selectedRowCount],
    );

    const getContextMoveTargetsForEntry = useCallback(
        (entry: VaultEntryDto): MoveTargets => {
            if (selectedRowCount > 1 && selectedEntryPaths.has(entry.path)) {
                return getSelectedMoveTargets();
            }
            return { notes: [], entries: [entry], folderPaths: [] };
        },
        [getSelectedMoveTargets, selectedEntryPaths, selectedRowCount],
    );

    const getContextMoveTargetsForFolder = useCallback(
        (path: string): MoveTargets => {
            if (selectedRowCount > 1 && selectedFolderPaths.has(path)) {
                return getSelectedMoveTargets();
            }
            return { notes: [], entries: [], folderPaths: [path] };
        },
        [getSelectedMoveTargets, selectedFolderPaths, selectedRowCount],
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
            const existing = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find(
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
                logError("file-tree", "Failed to copy folder", error);
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
        setSelectedEntryPaths(new Set());
        setSelectedFolderPaths(new Set());
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
            const parentPath = getParentPath(note.id);
            const nextNotePath = parentPath
                ? `${parentPath}/${newName}`
                : newName;
            const shouldConvertToFile =
                fileTreeContentMode === "all_files" &&
                shouldConvertRenamedNoteToFile(newName);
            if (shouldConvertToFile) {
                await renameNoteAsFile(note.id, nextNotePath);
                return;
            }
            await renameNote(note.id, nextNotePath);
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

            const currentTabs = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            );
            currentTabs.forEach((tab) => {
                if (isNoteTab(tab) && noteIds.has(tab.noteId)) {
                    closeTab(tab.id, { reason: "delete" });
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

            const currentTabs = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            );
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
                    closeTab(tab.id, { reason: "delete" });
                    return;
                }

                if (
                    isPdfTab(tab) &&
                    (tab.entryId === relativePath ||
                        tab.entryId.startsWith(prefix) ||
                        tab.path === sourceAbsolutePath ||
                        tab.path.startsWith(`${sourceAbsolutePath}/`))
                ) {
                    closeTab(tab.id, { reason: "delete" });
                    return;
                }

                if (
                    isFileTab(tab) &&
                    (tab.relativePath === relativePath ||
                        tab.relativePath.startsWith(prefix) ||
                        tab.path === sourceAbsolutePath ||
                        tab.path.startsWith(`${sourceAbsolutePath}/`))
                ) {
                    closeTab(tab.id, { reason: "delete" });
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
                setSelectedFolderPaths((prev) => {
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
                logError("file-tree", "Failed to delete folder", error);
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
            while (notes.some((item) => item.id === copyPath)) {
                copyPath = parentPath
                    ? `${parentPath}/${baseName} copy ${counter}`
                    : `${baseName} copy ${counter}`;
                counter += 1;
            }

            try {
                const existing = selectEditorWorkspaceTabs(
                    useEditorStore.getState(),
                ).find(
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
                logError("file-tree", "Failed to duplicate note", error);
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

    const getKeyboardRowKey = useCallback(() => {
        if (keyboardCursorKey) return keyboardCursorKey;
        if (activeNoteId) return `note:${activeNoteId}`;
        if (activeEntryPath) return `entry:${activeEntryPath}`;
        return lastClickedRowKeyRef.current;
    }, [activeEntryPath, activeNoteId, keyboardCursorKey]);

    const getKeyboardRowIndex = useCallback(() => {
        const key = getKeyboardRowKey();
        if (!key) return -1;
        return displayRowsRef.current.findIndex(
            (row) => getSelectableRowKey(row) === key,
        );
    }, [getKeyboardRowKey]);

    const expandKeyboardRowAncestors = useCallback((row: FlatTreeRow) => {
        const parts = row.path.split("/");
        if (parts.length <= 1) return;

        const ancestorPaths = parts
            .slice(0, -1)
            .map((_, index) => parts.slice(0, index + 1).join("/"));
        if (ancestorPaths.length === 0) return;

        setExpandedFolders((prev) => {
            const next = new Set(prev);
            let changed = false;
            for (const path of ancestorPaths) {
                if (next.has(path)) continue;
                next.add(path);
                changed = true;
            }
            return changed ? next : prev;
        });
    }, []);

    const selectKeyboardRow = useCallback((row: FlatTreeRow) => {
        const rowKey = getSelectableRowKey(row);
        if (!rowKey) return;

        showTreeKeyboardCursor(rowKey);
        lastClickedRowKeyRef.current = rowKey;

        if (row.kind === "folder") {
            setFocusedFolderPath(row.path);
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set());
            setSelectedFolderPaths(new Set([row.path]));
            return;
        }

        if (row.kind === "note") {
            setFocusedFolderPath(getParentPath(row.note.id));
            clearEntrySelection();
            setSelectedNoteIds(new Set([row.note.id]));
            return;
        }

        if (row.kind === "pdf" || row.kind === "file") {
            setFocusedFolderPath(getParentPath(row.entry.relative_path));
            setSelectedNoteIds(new Set());
            setSelectedEntryPaths(new Set([row.entry.path]));
            setSelectedFolderPaths(new Set());
            lastClickedEntryPathRef.current = row.entry.path;
        }
    }, [clearEntrySelection, showTreeKeyboardCursor]);

    const activateKeyboardRow = useCallback(
        (row: FlatTreeRow) => {
            if (row.kind === "folder") {
                handleFolderClick(row.path, { cmd: false, shift: false });
                return;
            }
            if (row.kind === "note") {
                void handleNoteClick(row.note, { cmd: false, shift: false });
                return;
            }
            if (row.kind === "pdf") {
                handlePdfClick(row.entry, { cmd: false, shift: false });
                return;
            }
            if (row.kind === "file") {
                handleFileClick(row.entry, { cmd: false, shift: false });
            }
        },
        [handleFileClick, handleFolderClick, handleNoteClick, handlePdfClick],
    );

    const navigateKeyboardToRow = useCallback(
        (rowIndex: number, options?: { openFileRows?: boolean }) => {
            const row = displayRowsRef.current[rowIndex];
            if (!row || row.kind === "create") return false;

            selectKeyboardRow(row);
            scrollToRow(rowIndex, "instant");
            if (options?.openFileRows && canKeyboardOpenRow(row)) {
                activateKeyboardRow(row);
            }
            return true;
        },
        [activateKeyboardRow, scrollToRow, selectKeyboardRow],
    );

    const navigateKeyboardByDelta = useCallback(
        (delta: -1 | 1) => {
            const rows = displayRowsRef.current;
            if (rows.length === 0) return false;

            const currentIndex = getKeyboardRowIndex();
            const fallbackIndex = delta > 0 ? -1 : rows.length;
            let nextIndex = currentIndex === -1 ? fallbackIndex : currentIndex;

            do {
                nextIndex += delta;
            } while (rows[nextIndex]?.kind === "create");

            if (nextIndex < 0 || nextIndex >= rows.length) return false;
            return navigateKeyboardToRow(nextIndex, { openFileRows: true });
        },
        [getKeyboardRowIndex, navigateKeyboardToRow],
    );

    const navigateKeyboardToEdge = useCallback(
        (edge: "first" | "last") => {
            const rows = displayRowsRef.current;
            const start = edge === "first" ? 0 : rows.length - 1;
            const delta = edge === "first" ? 1 : -1;
            for (
                let index = start;
                index >= 0 && index < rows.length;
                index += delta
            ) {
                if (rows[index].kind !== "create") {
                    return navigateKeyboardToRow(index, {
                        openFileRows: true,
                    });
                }
            }
            return false;
        },
        [navigateKeyboardToRow],
    );

    const navigateShortcutToOpenableRow = useCallback(
        (direction: -1 | 1) => {
            const rows = shortcutNavigableRowsRef.current;
            if (rows.length === 0) return false;

            const currentKey = getKeyboardRowKey();
            const currentIndex = currentKey
                ? rows.findIndex((row) => getSelectableRowKey(row) === currentKey)
                : -1;
            const fallbackIndex = direction > 0 ? -1 : rows.length;

            for (
                let index =
                    (currentIndex === -1 ? fallbackIndex : currentIndex) +
                    direction;
                index >= 0 && index < rows.length;
                index += direction
            ) {
                const row = rows[index];
                if (!canKeyboardOpenRow(row)) continue;
                expandKeyboardRowAncestors(row);
                selectKeyboardRow(row);
                activateKeyboardRow(row);
                return true;
            }

            return false;
        },
        [
            activateKeyboardRow,
            expandKeyboardRowAncestors,
            getKeyboardRowKey,
            selectKeyboardRow,
        ],
    );

    const navigateKeyboardIntoFolder = useCallback(() => {
        const rows = displayRowsRef.current;
        const currentIndex = getKeyboardRowIndex();
        const currentRow = rows[currentIndex];
        if (!currentRow || currentRow.kind !== "folder") return false;

        if (!visibleExpandedFolders.has(currentRow.path)) {
            selectKeyboardRow(currentRow);
            setExpandedFolders((prev) => {
                const next = new Set(prev);
                next.add(currentRow.path);
                return next;
            });
            return true;
        }

        const childIndex = currentIndex + 1;
        if (
            childIndex < rows.length &&
            rows[childIndex].depth > currentRow.depth
        ) {
            return navigateKeyboardToRow(childIndex, { openFileRows: true });
        }

        return false;
    }, [
        getKeyboardRowIndex,
        navigateKeyboardToRow,
        selectKeyboardRow,
        visibleExpandedFolders,
    ]);

    const navigateKeyboardToParent = useCallback(() => {
        const rows = displayRowsRef.current;
        const currentIndex = getKeyboardRowIndex();
        const currentRow = rows[currentIndex];
        if (!currentRow) return false;

        if (
            currentRow.kind === "folder" &&
            visibleExpandedFolders.has(currentRow.path)
        ) {
            selectKeyboardRow(currentRow);
            setExpandedFolders((prev) => {
                const next = new Set(prev);
                next.delete(currentRow.path);
                return next;
            });
            return true;
        }

        for (let index = currentIndex - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (
                row.kind === "folder" &&
                row.depth < currentRow.depth &&
                currentRow.path.startsWith(`${row.path}/`)
            ) {
                return navigateKeyboardToRow(index);
            }
        }

        return false;
    }, [
        getKeyboardRowIndex,
        navigateKeyboardToRow,
        selectKeyboardRow,
        visibleExpandedFolders,
    ]);

    useEffect(() => {
        const handleDocumentKeyDown = (event: KeyboardEvent) => {
            if (
                event.target instanceof HTMLElement &&
                event.target.closest("input, textarea, select")
            ) {
                return;
            }

            const direction = matchesShortcutAction(event, "next_file")
                ? 1
                : matchesShortcutAction(event, "previous_file")
                  ? -1
                  : null;
            if (direction === null) return;

            event.preventDefault();
            event.stopPropagation();
            navigateShortcutToOpenableRow(direction);
        };

        document.addEventListener("keydown", handleDocumentKeyDown, true);
        return () =>
            document.removeEventListener(
                "keydown",
                handleDocumentKeyDown,
                true,
            );
    }, [navigateShortcutToOpenableRow]);

    const handleTreeKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            const target = event.target;
            if (isEditableKeyboardTarget(target)) return;

            if (
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey
            ) {
                let handled = false;
                const canActivateFromViewport =
                    event.target === event.currentTarget;
                switch (event.key) {
                    case "ArrowDown":
                        handled = navigateKeyboardByDelta(1);
                        break;
                    case "ArrowUp":
                        handled = navigateKeyboardByDelta(-1);
                        break;
                    case "ArrowRight":
                        handled = navigateKeyboardIntoFolder();
                        break;
                    case "ArrowLeft":
                        handled = navigateKeyboardToParent();
                        break;
                    case "Home":
                        handled = navigateKeyboardToEdge("first");
                        break;
                    case "End":
                        handled = navigateKeyboardToEdge("last");
                        break;
                    case "Enter": {
                        if (!canActivateFromViewport) break;
                        const row =
                            displayRowsRef.current[getKeyboardRowIndex()];
                        if (row && row.kind !== "create") {
                            activateKeyboardRow(row);
                            handled = true;
                        }
                        break;
                    }
                    case " ": {
                        if (!canActivateFromViewport) break;
                        const row =
                            displayRowsRef.current[getKeyboardRowIndex()];
                        if (row && row.kind !== "create") {
                            activateKeyboardRow(row);
                            handled = true;
                        }
                        break;
                    }
                }

                if (handled) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                return;
            }

            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.altKey || event.shiftKey) return;

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
            activateKeyboardRow,
            focusedFolderPath,
            getKeyboardRowIndex,
            handleCopyFolder,
            handleCopyNotes,
            handlePasteIntoFolder,
            navigateKeyboardByDelta,
            navigateKeyboardIntoFolder,
            navigateKeyboardToEdge,
            navigateKeyboardToParent,
            notes,
            selectedNoteIds,
            treeClipboard,
        ],
    );

    const openMovePicker = useCallback(
        (
            menu: ContextMenuState<FileTreeContextPayload>,
            targets: MoveTargets,
        ) => {
            setMovePicker({ x: menu.x, y: menu.y, targets });
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
                const absolutePath = getAbsoluteVaultPath(vaultPath, path);
                const chatTargets = getContextChatTargetsForFolder(path);
                const moveTargets = getContextMoveTargetsForFolder(path);
                const chatTargetCount =
                    chatTargets.notes.length +
                    chatTargets.entries.length +
                    chatTargets.folderPaths.length;
                const addToChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to Chat"
                        : "Add to Chat";
                const addToNewChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to New Chat"
                        : "Add to New Chat";
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
                    {
                        label: addToChatLabel,
                        action: () => handleAddChatTargetsToChat(chatTargets),
                    },
                    {
                        label: addToNewChatLabel,
                        action: () =>
                            handleAddChatTargetsToChat(chatTargets, "new-chat"),
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
                        label: getMoveMenuLabel(moveTargets),
                        action: () => openMovePicker(contextMenu, moveTargets),
                        disabled: !hasMoveDestination(
                            moveTargets,
                            allFolderPaths,
                        ),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => handleRevealFolderInFinder(path),
                    },
                    {
                        label: "Copy Full Path",
                        action: () => handleCopyFullPath(absolutePath),
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
                const moveTargets = getContextMoveTargetsForNote(note);
                const chatTargets = getContextChatTargetsForNote(note);
                const chatTargetCount =
                    chatTargets.notes.length +
                    chatTargets.entries.length +
                    chatTargets.folderPaths.length;
                const deleteTargets = contextTargetNotes;
                const deleteLabel =
                    deleteTargets.length > 1
                        ? "Delete Selected Notes"
                        : "Delete Note";
                const moveLabel = getMoveMenuLabel(moveTargets);
                const addToChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to Chat"
                        : "Add to Chat";
                const addToNewChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to New Chat"
                        : "Add to New Chat";

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
                    {
                        label: addToChatLabel,
                        action: () => handleAddChatTargetsToChat(chatTargets),
                    },
                    {
                        label: addToNewChatLabel,
                        action: () =>
                            handleAddChatTargetsToChat(chatTargets, "new-chat"),
                    },
                    { type: "separator" },
                    {
                        label: "Rename",
                        action: () => handleRenameStart(note),
                    },
                    {
                        label: moveLabel,
                        action: () => openMovePicker(contextMenu, moveTargets),
                        disabled: !hasMoveDestination(
                            moveTargets,
                            allFolderPaths,
                        ),
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
                        label: "Copy Full Path",
                        action: () =>
                            handleCopyFullPath(
                                getAbsoluteVaultPath(
                                    vaultPath,
                                    note.path || note.id,
                                ),
                            ),
                    },
                    { type: "separator" },
                    {
                        label: bookmarkItems.some((i) => i.noteId === note.id)
                            ? "Remove from Bookmarks"
                            : "Add to Bookmarks",
                        action: () => {
                            const store = useBookmarkStore.getState();
                            const existing = store.items.find(
                                (i) => i.noteId === note.id,
                            );
                            if (existing) {
                                store.removeBookmark(existing.id);
                            } else {
                                store.addBookmark({
                                    kind: "note",
                                    noteId: note.id,
                                });
                            }
                        },
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
                const moveTargets = getContextMoveTargetsForEntry(entry);
                const chatTargets = getContextChatTargetsForEntry(entry);
                const chatTargetCount =
                    chatTargets.notes.length +
                    chatTargets.entries.length +
                    chatTargets.folderPaths.length;
                const addToChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to Chat"
                        : "Add to Chat";
                const addToNewChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to New Chat"
                        : "Add to New Chat";
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
                        label: addToChatLabel,
                        action: () => handleAddChatTargetsToChat(chatTargets),
                    },
                    {
                        label: addToNewChatLabel,
                        action: () =>
                            handleAddChatTargetsToChat(chatTargets, "new-chat"),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => void revealItemInDir(entry.path),
                    },
                    {
                        label: "Copy Full Path",
                        action: () => handleCopyFullPath(entry.path),
                    },
                    {
                        label: getMoveMenuLabel(moveTargets),
                        action: () => openMovePicker(contextMenu, moveTargets),
                        disabled: !hasMoveDestination(
                            moveTargets,
                            allFolderPaths,
                        ),
                    },
                    { type: "separator" },
                    {
                        label: bookmarkItems.some(
                            (i) => i.entryPath === entry.relative_path,
                        )
                            ? "Remove from Bookmarks"
                            : "Add to Bookmarks",
                        action: () => {
                            const store = useBookmarkStore.getState();
                            const existing = store.items.find(
                                (i) => i.entryPath === entry.relative_path,
                            );
                            if (existing) {
                                store.removeBookmark(existing.id);
                            } else {
                                store.addBookmark({
                                    kind: "pdf",
                                    entryPath: entry.relative_path,
                                });
                            }
                        },
                    },
                    { type: "separator" },
                    {
                        label: "Move File to Trash",
                        action: () => void handleMoveEntryToTrash(entry),
                        danger: true,
                    },
                ];
            }
            case "file": {
                const { entry } = contextMenu.payload;
                const canOpenInApp = canOpenVaultFileEntryInApp(entry);
                const moveTargets = getContextMoveTargetsForEntry(entry);
                const chatTargets = getContextChatTargetsForEntry(entry);
                const chatTargetCount =
                    chatTargets.notes.length +
                    chatTargets.entries.length +
                    chatTargets.folderPaths.length;
                const addToChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to Chat"
                        : "Add to Chat";
                const addToNewChatLabel =
                    chatTargetCount > 1
                        ? "Add Selected to New Chat"
                        : "Add to New Chat";
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
                        label: addToChatLabel,
                        action: () => handleAddChatTargetsToChat(chatTargets),
                    },
                    {
                        label: addToNewChatLabel,
                        action: () =>
                            handleAddChatTargetsToChat(chatTargets, "new-chat"),
                    },
                    {
                        label: "Reveal in Finder",
                        action: () => void revealItemInDir(entry.path),
                    },
                    {
                        label: "Copy Full Path",
                        action: () => handleCopyFullPath(entry.path),
                    },
                    {
                        label: getMoveMenuLabel(moveTargets),
                        action: () => openMovePicker(contextMenu, moveTargets),
                        disabled: !hasMoveDestination(
                            moveTargets,
                            allFolderPaths,
                        ),
                    },
                    { type: "separator" },
                    {
                        label: bookmarkItems.some(
                            (i) => i.entryPath === entry.relative_path,
                        )
                            ? "Remove from Bookmarks"
                            : "Add to Bookmarks",
                        action: () => {
                            const store = useBookmarkStore.getState();
                            const existing = store.items.find(
                                (i) => i.entryPath === entry.relative_path,
                            );
                            if (existing) {
                                store.removeBookmark(existing.id);
                            } else {
                                store.addBookmark({
                                    kind: "file",
                                    entryPath: entry.relative_path,
                                });
                            }
                        },
                    },
                    { type: "separator" },
                    {
                        label: "Move File to Trash",
                        action: () => void handleMoveEntryToTrash(entry),
                        danger: true,
                    },
                ];
            }
        }
    }, [
        allFolderPaths,
        contextMenu,
        expandedFolders.size,
        getContextChatTargetsForEntry,
        getContextChatTargetsForFolder,
        getContextChatTargetsForNote,
        getContextMoveTargetsForEntry,
        getContextMoveTargetsForFolder,
        getContextMoveTargetsForNote,
        getContextTargetNotes,
        handleAddChatTargetsToChat,
        handleCopyFolder,
        handleCopyFullPath,
        handleCopyNotes,
        handleDelete,
        handleDeleteFolder,
        handleDuplicateNote,
        handleEntryRenameStart,
        handleFolderRenameStart,
        handleMoveEntryToTrash,
        handlePdfClick,
        handleOpenPdfInNewTab,
        handleOpenNoteInNewTab,
        handlePasteIntoFolder,
        handleRevealFolderInFinder,
        handleRevealNoteInFinder,
        openMovePicker,
        openTreeNote,
        startCreating,
        treeClipboard,
        bookmarkItems,
        vaultPath,
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

    const folderClickRef = useRef(handleFolderClick);
    folderClickRef.current = handleFolderClick;
    const stableFolderClick = useCallback(
        (path: string, modifiers: { cmd: boolean; shift: boolean }) =>
            folderClickRef.current(path, modifiers),
        [],
    );

    const folderMouseDownRef = useRef(handleFolderMouseDown);
    folderMouseDownRef.current = handleFolderMouseDown;
    const stableFolderMouseDown = useCallback(
        (path: string, e: React.MouseEvent) =>
            folderMouseDownRef.current(path, e),
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
                className="flex items-center justify-center gap-0.5 shrink-0"
                style={{
                    height: metrics.toolbarHeight,
                    borderBottom: "1px solid var(--border)",
                    position: "relative",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-tertiary) 30%, transparent)",
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

                {/* Thin divider between tree-specific ops and editor toggles. */}
                <span
                    aria-hidden="true"
                    style={{
                        width: 1,
                        height: 16,
                        margin: "0 4px",
                        backgroundColor:
                            "color-mix(in srgb, var(--border) 60%, transparent)",
                        flexShrink: 0,
                    }}
                />

                <ToolbarBtn
                    title={
                        livePreviewEnabled
                            ? "Disable Live Preview"
                            : "Enable Live Preview"
                    }
                    active={livePreviewEnabled}
                    onClick={() =>
                        setSetting("livePreviewEnabled", !livePreviewEnabled)
                    }
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    {livePreviewEnabled ? (
                        <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    ) : (
                        <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                    )}
                </ToolbarBtn>

                <ToolbarBtn
                    title={
                        lineWrapping
                            ? "Disable Line Wrapping"
                            : "Enable Line Wrapping"
                    }
                    active={lineWrapping}
                    onClick={() => setSetting("lineWrapping", !lineWrapping)}
                    size={metrics.toolbarButton}
                    iconScale={metrics.toolbarIconScale}
                >
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M4 6h16" />
                        <path d="M4 12h10a3 3 0 1 1 0 6H9" />
                        <path d="m9 15-3 3 3 3" />
                        {!lineWrapping && (
                            <line x1="5" y1="5" x2="19" y2="19" />
                        )}
                    </svg>
                </ToolbarBtn>

                {sortMenuOpen && (
                    <SortMenu
                        current={sortMode}
                        onSelect={handleSortSelect}
                        onClose={() => setSortMenuOpen(false)}
                    />
                )}
            </div>

            {/* Persistent filter. Wrapper styling matches the other
                left-sidebar panels so the bar reads identical across the
                whole sidebar. */}
            <div
                className="shrink-0 px-2 pt-2 pb-2"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <SidebarFilterInput
                    value={filterText}
                    onChange={setFilterText}
                    placeholder="Filter files..."
                />
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
                    // Stay transparent so the sidebar's vibrancy tint (or
                    // the opaque sidebar bg on non-vibrancy platforms) shows
                    // through uniformly. Only the drag-over state paints.
                    backgroundColor:
                        dragOverPath === ""
                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                            : "transparent",
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
                        {normalizedFilter
                            ? `No files match "${filterText}"`
                            : "No notes"}
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
                                    left: 0,
                                    height: 0,
                                    zIndex: 10,
                                    overflow: "visible",
                                    minWidth: "100%",
                                    width: "100%",
                                    boxSizing: "border-box",
                                }}
                            >
                                {stickyFolders.map(({ row, top }, i) => (
                                    <div
                                        key={`sticky:${row.path}`}
                                        style={{
                                            position: "absolute",
                                            top,
                                            ...TREE_STICKY_CHROME_STYLE,
                                            zIndex: 20 - row.depth,
                                            background:
                                                TREE_STICKY_CHROME_BACKGROUND,
                                            backdropFilter:
                                                TREE_STICKY_CHROME_BACKDROP_FILTER,
                                            WebkitBackdropFilter:
                                                TREE_STICKY_CHROME_BACKDROP_FILTER,
                                            // Only the deepest sticky folder casts a shadow
                                            ...(i ===
                                                stickyFolders.length - 1 && {
                                                boxShadow:
                                                    TREE_STICKY_EDGE_SHADOW,
                                            }),
                                        }}
                                    >
                                        <FlatTreeRowView
                                            row={row}
                                            stickyContentOffsetX={
                                                TREE_VIEWPORT_SIDE_PADDING_PX
                                            }
                                            metrics={metrics}
                                            activeNoteId={activeNoteId}
                                            activeEntryPath={activeEntryPath}
                                            keyboardCursorKey={
                                                keyboardCursorKey
                                            }
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
                                            }
                                            selectedEntryPaths={
                                                visibleSelectedEntryPaths
                                            }
                                            selectedFolderPaths={
                                                visibleSelectedFolderPaths
                                            }
                                            contextMenuFolderPath={
                                                contextMenuFolderPath
                                            }
                                            draggingNoteIds={draggingNoteIds}
                                            draggingFolderPath={
                                                draggingFolderPath
                                            }
                                            dragOverPath={dragOverPath}
                                            onFolderClick={stableFolderClick}
                                            onFolderMouseDown={
                                                stableFolderMouseDown
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
                                ...TREE_CONTENT_BOX_STYLE,
                            }}
                        >
                            <div
                                data-testid="file-tree-rows-layer"
                                style={{
                                    position: "absolute",
                                    top: offsetY,
                                    left: 0,
                                    ...TREE_CONTENT_BOX_STYLE,
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
                                            keyboardCursorKey={
                                                keyboardCursorKey
                                            }
                                            expandedFolders={
                                                visibleExpandedFolders
                                            }
                                            selectedNoteIds={
                                                visibleSelectedNoteIds
                                            }
                                            selectedEntryPaths={
                                                visibleSelectedEntryPaths
                                            }
                                            selectedFolderPaths={
                                                visibleSelectedFolderPaths
                                            }
                                            contextMenuFolderPath={
                                                contextMenuFolderPath
                                            }
                                            draggingNoteIds={draggingNoteIds}
                                            draggingFolderPath={
                                                draggingFolderPath
                                            }
                                            dragOverPath={dragOverPath}
                                            onFolderClick={stableFolderClick}
                                            onFolderMouseDown={
                                                stableFolderMouseDown
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

            {/* Drag ghost — portaled to <body> so it escapes the docked
                sidebar's transformed wrapper, which would otherwise act as the
                containing block for `position: fixed` and clip the ghost
                against the sidebar's `overflow: hidden`. */}
            {dragPos &&
                dragLabel &&
                createPortal(
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
                    </div>,
                    document.body,
                )}

            {movePicker && (
                <MoveDestinationPicker
                    state={movePicker}
                    folderPaths={allFolderPaths}
                    onMove={(targetFolder) =>
                        void applyMoveTargets(movePicker.targets, targetFolder)
                    }
                    onClose={() => setMovePicker(null)}
                />
            )}

            {/* Context menu */}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={contextMenuEntries}
                    minWidth={160}
                    maxHeight={Math.max(
                        FILE_TREE_CONTEXT_MENU_MIN_HEIGHT,
                        window.innerHeight -
                            FILE_TREE_CONTEXT_MENU_VIEWPORT_MARGIN,
                    )}
                />
            )}
        </div>
    );
}
