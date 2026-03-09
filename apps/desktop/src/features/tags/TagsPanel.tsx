import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { revealNoteInTree } from "../../app/utils/navigation";
import { useVirtualList } from "../../app/hooks/useVirtualList";

const TAG_ROW_HEIGHT = 28;
const TAG_NOTE_ROW_HEIGHT = 24;

interface TagEntry {
    tag: string;
    note_ids: string[];
}

type TagRow =
    | { kind: "tag"; tag: string; note_ids: string[] }
    | { kind: "note"; tag: string; noteId: string };

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
    const vaultRevision = useVaultStore((s) => s.vaultRevision);
    const openNote = useEditorStore((s) => s.openNote);
    const [tags, setTags] = useState<TagEntry[]>([]);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [tagContextMenu, setTagContextMenu] =
        useState<ContextMenuState<TagEntry> | null>(null);
    const [noteContextMenu, setNoteContextMenu] = useState<
        ContextMenuState<{ noteId: string }>
    | null>(null);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const listRef = useRef<HTMLDivElement>(null);
    const noteMap = useMemo(
        () => new Map(notes.map((note) => [note.id, note])),
        [notes],
    );
    const rows = useMemo<TagRow[]>(
        () =>
            tags.flatMap(({ tag, note_ids }) => [
                { kind: "tag", tag, note_ids } as const,
                ...(expanded.has(tag)
                    ? note_ids.map((noteId) => ({
                          kind: "note" as const,
                          tag,
                          noteId,
                      }))
                    : []),
            ]),
        [expanded, tags],
    );
    const virtual = useVirtualList(listRef, rows.length, TAG_ROW_HEIGHT, 10);
    const visibleRows = rows.slice(virtual.startIndex, virtual.endIndex);

    // Refetch when the persisted vault contents may have changed.
    useEffect(() => {
        if (!vaultPath) return;
        void invoke<TagEntry[]>("get_tags").then(setTags).catch(console.error);
    }, [vaultPath, vaultRevision]);

    const toggleTag = (tag: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    };

    const handleNoteClick = async (noteId: string) => {
        const note = noteMap.get(noteId);
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

    const handleOpenNoteInNewTab = async (noteId: string) => {
        const note = noteMap.get(noteId);
        if (!note) return;
        try {
            const currentTabs = useEditorStore.getState().tabs;
            const existing = currentTabs.find((tab) => tab.noteId === noteId);
            const content =
                existing?.content ??
                (
                    await invoke<{ content: string }>("read_note", {
                        noteId,
                    })
                ).content;

            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: note.id,
                title: note.title,
                content,
                isDirty: false,
            });
        } catch (error) {
            console.error("Error opening tagged note in new tab:", error);
        }
    };

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Header */}
            <div
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wider shrink-0"
                style={{
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid var(--border)",
                }}
            >
                Tags
            </div>

            {/* Content */}
            <div ref={listRef} className="flex-1 overflow-y-auto py-1 px-1">
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
                    <div style={{ position: "relative", height: virtual.totalHeight }}>
                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: virtual.offsetTop,
                            }}
                        >
                            {visibleRows.map((row) => {
                                if (row.kind === "tag") {
                                    const isExpanded = expanded.has(row.tag);
                                    return (
                                        <button
                                            key={`tag:${row.tag}`}
                                            onClick={() => toggleTag(row.tag)}
                                            onContextMenu={(event) => {
                                                event.preventDefault();
                                                setTagContextMenu({
                                                    x: event.clientX,
                                                    y: event.clientY,
                                                    payload: {
                                                        tag: row.tag,
                                                        note_ids: row.note_ids,
                                                    },
                                                });
                                            }}
                                            className="flex items-center gap-1.5 w-full text-left py-1 px-2 text-xs rounded"
                                            style={{
                                                color: "var(--text-primary)",
                                                minHeight: TAG_ROW_HEIGHT,
                                            }}
                                        >
                                            <ChevronIcon open={isExpanded} />
                                            <span
                                                className="flex-1 truncate"
                                                style={{ color: "var(--accent)" }}
                                            >
                                                #{row.tag}
                                            </span>
                                            <span
                                                className="text-xs tabular-nums"
                                                style={{
                                                    color: "var(--text-secondary)",
                                                    fontSize: "0.65rem",
                                                }}
                                            >
                                                {row.note_ids.length}
                                            </span>
                                        </button>
                                    );
                                }

                                const note = noteMap.get(row.noteId);
                                if (!note) return null;

                                return (
                                    <button
                                        key={`note:${row.tag}:${row.noteId}`}
                                        onClick={() => void handleNoteClick(row.noteId)}
                                        onContextMenu={(event) => {
                                            event.preventDefault();
                                            setNoteContextMenu({
                                                x: event.clientX,
                                                y: event.clientY,
                                                payload: { noteId: row.noteId },
                                            });
                                        }}
                                        className="flex items-center gap-1.5 w-full text-left py-0.5 text-xs rounded mx-1"
                                        style={{
                                            paddingLeft: 28,
                                            width: "calc(100% - 8px)",
                                            color: "var(--text-secondary)",
                                            minHeight: TAG_NOTE_ROW_HEIGHT,
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
                                            style={{ flexShrink: 0, opacity: 0.4 }}
                                        >
                                            <path
                                                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                                                stroke="currentColor"
                                                strokeWidth="1"
                                            />
                                        </svg>
                                        <span className="truncate">{note.title}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
            {tagContextMenu && (
                <ContextMenu
                    menu={tagContextMenu}
                    onClose={() => setTagContextMenu(null)}
                    entries={[
                        {
                            label: expanded.has(tagContextMenu.payload.tag)
                                ? "Collapse"
                                : "Expand",
                            action: () => toggleTag(tagContextMenu.payload.tag),
                        },
                        {
                            label: "Copy Tag",
                            action: () =>
                                void navigator.clipboard.writeText(
                                    `#${tagContextMenu.payload.tag}`,
                                ),
                        },
                    ]}
                />
            )}
            {noteContextMenu && (
                <ContextMenu
                    menu={noteContextMenu}
                    onClose={() => setNoteContextMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () =>
                                void handleNoteClick(noteContextMenu.payload.noteId),
                        },
                        {
                            label: "Open in New Tab",
                            action: () =>
                                void handleOpenNoteInNewTab(
                                    noteContextMenu.payload.noteId,
                                ),
                        },
                        { type: "separator" },
                        {
                            label: "Reveal in File Tree",
                            action: () =>
                                revealNoteInTree(noteContextMenu.payload.noteId),
                        },
                        {
                            label: "Copy Note Path",
                            action: () =>
                                void navigator.clipboard.writeText(
                                    noteContextMenu.payload.noteId,
                                ),
                        },
                    ]}
                />
            )}
        </div>
    );
}
