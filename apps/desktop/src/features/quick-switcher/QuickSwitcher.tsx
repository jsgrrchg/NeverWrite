import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";
import { useCommandStore } from "../command-palette/store/commandStore";

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
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const activeModal = useCommandStore((s) => s.activeModal);
    const closeModal = useCommandStore((s) => s.closeModal);
    const notes = useVaultStore((s) => s.notes);
    const openNote = useEditorStore((s) => s.openNote);

    const open = activeModal === "quick-switcher";

    // Read tabs snapshot only when building results (avoids subscribing to tabs)
    const results = open
        ? query.trim()
            ? notes
                  .map((note) => ({
                      note,
                      score: Math.max(
                          fuzzyScore(query, note.title),
                          fuzzyScore(query, note.id),
                      ),
                  }))
                  .filter(({ score }) => score > 0)
                  .sort((a, b) => b.score - a.score)
                  .map(({ note }) => note)
            : // When empty, show open tabs first then remaining notes
              (() => {
                  const tabs = useEditorStore.getState().tabs;
                  return [
                      ...tabs
                          .map((t) => notes.find((n) => n.id === t.noteId))
                          .filter((n): n is NoteDto => !!n),
                      ...notes.filter(
                          (n) => !tabs.some((t) => t.noteId === n.id),
                      ),
                  ];
              })()
        : [];

    useEffect(() => {
        if (open) {
            setQuery("");
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open]);

    useEffect(() => {
        setSelectedIndex(0);
    }, [query]);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const item = list.children[selectedIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const openNoteAndClose = useCallback(
        async (note: NoteDto) => {
            closeModal();
            const existing = useEditorStore
                .getState()
                .tabs.find((t) => t.noteId === note.id);
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
                console.error("Error reading note:", e);
            }
        },
        [closeModal, openNote],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
                e.preventDefault();
                const note = results[selectedIndex];
                if (note) void openNoteAndClose(note);
            } else if (e.key === "Escape") {
                e.preventDefault();
                closeModal();
            }
        },
        [results, selectedIndex, openNoteAndClose, closeModal],
    );

    if (!open) return null;

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
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search notes..."
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
                            No notes found
                        </div>
                    ) : (
                        results.slice(0, 20).map((note, i) => (
                            <button
                                key={note.id}
                                onClick={() => void openNoteAndClose(note)}
                                className="w-full text-left px-4 py-2 text-sm"
                                style={{
                                    backgroundColor:
                                        i === selectedIndex
                                            ? "var(--accent)"
                                            : "transparent",
                                    color:
                                        i === selectedIndex
                                            ? "#fff"
                                            : "var(--text-primary)",
                                }}
                            >
                                <div className="truncate">{note.title}</div>
                                <div
                                    className="text-xs truncate"
                                    style={{
                                        opacity:
                                            i === selectedIndex ? 0.7 : 0.5,
                                    }}
                                >
                                    {note.id}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
