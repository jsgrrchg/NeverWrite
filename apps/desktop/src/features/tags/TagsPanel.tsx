import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

interface TagEntry {
    tag: string;
    note_ids: string[];
}

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

export function TagsPanel() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const notes = useVaultStore((s) => s.notes);
    const openNote = useEditorStore((s) => s.openNote);
    const [tags, setTags] = useState<TagEntry[]>([]);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Refetch whenever vault or notes list changes
    useEffect(() => {
        if (!vaultPath) {
            setTags([]);
            return;
        }
        void invoke<TagEntry[]>("get_tags").then(setTags).catch(console.error);
    }, [vaultPath, notes.length]);

    const toggleTag = (tag: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    };

    const handleNoteClick = async (noteId: string) => {
        const note = notes.find((n) => n.id === noteId);
        if (!note) return;
        const { tabs: currentTabs } = useEditorStore.getState();
        const existing = currentTabs.find((t) => t.noteId === noteId);
        if (existing) {
            openNote(note.id, note.title, existing.content);
            return;
        }
        try {
            const detail = await invoke<{ content: string }>("read_note", {
                noteId,
            });
            openNote(note.id, note.title, detail.content);
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wider flex-shrink-0"
                style={{
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid var(--border)",
                }}
            >
                Tags
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto py-1 px-1">
                {!vaultPath ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No vault open
                    </p>
                ) : tags.length === 0 ? (
                    <p
                        className="text-xs px-3 py-2"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No tags found
                    </p>
                ) : (
                    tags.map(({ tag, note_ids }) => {
                        const isExpanded = expanded.has(tag);
                        return (
                            <div key={tag}>
                                {/* Tag row */}
                                <button
                                    onClick={() => toggleTag(tag)}
                                    className="flex items-center gap-1.5 w-full text-left py-1 px-2 text-xs rounded"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    <ChevronIcon open={isExpanded} />
                                    <span
                                        className="flex-1 truncate"
                                        style={{ color: "var(--accent)" }}
                                    >
                                        #{tag}
                                    </span>
                                    <span
                                        className="text-xs tabular-nums"
                                        style={{
                                            color: "var(--text-secondary)",
                                            fontSize: "0.65rem",
                                        }}
                                    >
                                        {note_ids.length}
                                    </span>
                                </button>

                                {/* Notes under tag */}
                                {isExpanded &&
                                    note_ids.map((noteId) => {
                                        const note = notes.find(
                                            (n) => n.id === noteId,
                                        );
                                        if (!note) return null;
                                        return (
                                            <button
                                                key={noteId}
                                                onClick={() =>
                                                    void handleNoteClick(noteId)
                                                }
                                                className="flex items-center gap-1.5 w-full text-left py-0.5 text-xs rounded mx-1"
                                                style={{
                                                    paddingLeft: 28,
                                                    width: "calc(100% - 8px)",
                                                    color: "var(--text-secondary)",
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
                                                <svg
                                                    width="11"
                                                    height="11"
                                                    viewBox="0 0 16 16"
                                                    fill="none"
                                                    style={{
                                                        flexShrink: 0,
                                                        opacity: 0.4,
                                                    }}
                                                >
                                                    <path
                                                        d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                                                        stroke="currentColor"
                                                        strokeWidth="1"
                                                    />
                                                </svg>
                                                <span className="truncate">
                                                    {note.title}
                                                </span>
                                            </button>
                                        );
                                    })}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
