import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

// --- Tree building ---

interface TreeNode {
    name: string;
    children?: Record<string, TreeNode>;
    note?: NoteDto;
}

function buildTree(notes: NoteDto[]): Record<string, TreeNode> {
    const root: Record<string, TreeNode> = {};

    for (const note of notes) {
        // note.id is the relative path without .md (e.g. "daily/2024-01-01")
        const parts = note.id.split("/");
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!current[part]) {
                current[part] = { name: part };
            }
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

function sortedEntries(map: Record<string, TreeNode>): [string, TreeNode][] {
    return Object.entries(map).sort(([, a], [, b]) => {
        const aIsDir = !!a.children;
        const bIsDir = !!b.children;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// --- Icons ---

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms ease",
                flexShrink: 0,
                opacity: 0.6,
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

function FolderIcon({ open }: { open: boolean }) {
    if (open) {
        return (
            <svg
                width="15"
                height="15"
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
            width="15"
            height="15"
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

function NoteIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0, opacity: 0.5 }}
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

// --- Tree node component ---

interface TreeNodeViewProps {
    name: string;
    node: TreeNode;
    activeNoteId: string | null;
    depth: number;
    onNoteClick: (note: NoteDto) => void;
}

function TreeNodeView({
    name,
    node,
    activeNoteId,
    depth,
    onNoteClick,
}: TreeNodeViewProps) {
    const [expanded, setExpanded] = useState(true);
    const isDir = !!node.children;
    const isActive = node.note?.id === activeNoteId;
    const label = node.note?.title || name;

    const paddingLeft = depth * 16 + 8;

    if (isDir) {
        return (
            <div>
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-1.5 w-full text-left py-1 text-xs rounded"
                    style={{
                        paddingLeft,
                        color: "var(--text-secondary)",
                    }}
                >
                    <ChevronIcon open={expanded} />
                    <FolderIcon open={expanded} />
                    <span className="truncate">{name}</span>
                </button>
                {expanded &&
                    sortedEntries(node.children!).map(([key, child]) => (
                        <TreeNodeView
                            key={key}
                            name={key}
                            node={child}
                            activeNoteId={activeNoteId}
                            depth={depth + 1}
                            onNoteClick={onNoteClick}
                        />
                    ))}
            </div>
        );
    }

    return (
        <button
            onClick={() => node.note && onNoteClick(node.note)}
            className="flex items-center gap-1.5 w-full text-left py-1 text-xs rounded mx-1"
            style={{
                paddingLeft: paddingLeft + 14,
                width: "calc(100% - 8px)",
                backgroundColor: isActive ? "var(--accent)" : "transparent",
                color: isActive ? "#fff" : "var(--text-primary)",
            }}
        >
            <NoteIcon />
            <span className="truncate">{label}</span>
        </button>
    );
}

// --- Open vault form ---

function OpenVaultForm() {
    const { openVault, isLoading, error } = useVaultStore();

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

// --- Main FileTree component ---

export function FileTree() {
    const { vaultPath, notes, createNote } = useVaultStore();
    const { tabs, activeTabId, openNote } = useEditorStore();
    const [creatingNote, setCreatingNote] = useState(false);
    const [newNoteName, setNewNoteName] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const activeTab = tabs.find((t) => t.id === activeTabId);
    const tree = buildTree(notes);

    const handleNoteClick = async (note: NoteDto) => {
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
            console.error("Error al leer nota:", e);
        }
    };

    const startCreating = () => {
        setNewNoteName("");
        setCreatingNote(true);
        setTimeout(() => inputRef.current?.focus(), 0);
    };

    const confirmCreate = async () => {
        const name = newNoteName.trim();
        setCreatingNote(false);
        setNewNoteName("");
        if (!name) return;
        const note = await createNote(name);
        if (note) openNote(note.id, note.title, "");
    };

    const cancelCreate = () => {
        setCreatingNote(false);
        setNewNoteName("");
    };

    if (!vaultPath) {
        return <OpenVaultForm />;
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wider flex-shrink-0 flex items-center justify-between"
                style={{
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid var(--border)",
                }}
            >
                <span>Notes</span>
                <button
                    onClick={startCreating}
                    title="New note"
                    className="opacity-50 hover:opacity-100 leading-none"
                    style={{ fontSize: 16 }}
                >
                    +
                </button>
            </div>

            {/* Input para nueva nota */}
            {creatingNote && (
                <div
                    className="px-2 py-1 flex-shrink-0"
                    style={{ borderBottom: "1px solid var(--border)" }}
                >
                    <input
                        ref={inputRef}
                        value={newNoteName}
                        onChange={(e) => setNewNoteName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") confirmCreate();
                            if (e.key === "Escape") cancelCreate();
                        }}
                        onBlur={confirmCreate}
                        placeholder="note-name"
                        className="w-full text-xs px-2 py-1 rounded outline-none"
                        style={{
                            backgroundColor: "var(--bg-primary)",
                            border: "1px solid var(--accent)",
                            color: "var(--text-primary)",
                        }}
                    />
                </div>
            )}

            {/* Tree */}
            <div className="flex-1 overflow-y-auto py-1 px-1">
                {notes.length === 0 ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No notes
                    </p>
                ) : (
                    sortedEntries(tree).map(([key, node]) => (
                        <TreeNodeView
                            key={key}
                            name={key}
                            node={node}
                            activeNoteId={activeTab?.noteId ?? null}
                            depth={0}
                            onNoteClick={handleNoteClick}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
