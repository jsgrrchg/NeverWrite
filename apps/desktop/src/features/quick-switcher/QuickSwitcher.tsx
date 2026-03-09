import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useDeferredValue,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";
import { useCommandStore } from "../command-palette/store/commandStore";
import { useVirtualList } from "../../app/hooks/useVirtualList";

const QUICK_SWITCHER_ROW_HEIGHT = 48;

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
    const activeModal = useCommandStore((s) => s.activeModal);
    if (activeModal !== "quick-switcher") return null;

    return <QuickSwitcherDialog />;
}

function QuickSwitcherDialog() {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const closeModal = useCommandStore((s) => s.closeModal);
    const notes = useVaultStore((s) => s.notes);
    const tabs = useEditorStore((s) => s.tabs);
    const openNote = useEditorStore((s) => s.openNote);
    const deferredQuery = useDeferredValue(query);
    const noteMap = useMemo(
        () => new Map(notes.map((note) => [note.id, note])),
        [notes],
    );

    const results = useMemo(() => {
        if (!deferredQuery.trim()) {
            return [
                ...tabs
                    .map((tab) => noteMap.get(tab.noteId))
                    .filter((note): note is NoteDto => !!note),
                ...notes.filter(
                    (note) => !tabs.some((tab) => tab.noteId === note.id),
                ),
            ];
        }

        return notes
            .map((note) => ({
                note,
                score: Math.max(
                    fuzzyScore(deferredQuery, note.title),
                    fuzzyScore(deferredQuery, note.id),
                ),
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map(({ note }) => note);
    }, [deferredQuery, noteMap, notes, tabs]);
    const virtual = useVirtualList(
        listRef,
        Math.min(results.length, 200),
        QUICK_SWITCHER_ROW_HEIGHT,
        6,
    );
    const visibleResults = results
        .slice(0, 200)
        .slice(virtual.startIndex, virtual.endIndex);

    useEffect(() => {
        const frame = window.setTimeout(() => inputRef.current?.focus(), 0);
        return () => window.clearTimeout(frame);
    }, []);

    useEffect(() => {
        setSelectedIndex((current) =>
            Math.min(current, Math.max(0, Math.min(results.length, 200) - 1)),
        );
    }, [results]);

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
            const maxIndex = Math.max(0, Math.min(results.length, 200) - 1);
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((i) => Math.min(i + 1, maxIndex));
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
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setSelectedIndex(0);
                    }}
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
                        <div
                            style={{
                                position: "relative",
                                height: virtual.totalHeight,
                            }}
                        >
                            <div
                                style={{
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: virtual.offsetTop,
                                }}
                            >
                                {visibleResults.map((note, localIndex) => {
                                    const i = virtual.startIndex + localIndex;
                                    return (
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
                                                minHeight:
                                                    QUICK_SWITCHER_ROW_HEIGHT,
                                            }}
                                        >
                                            <div className="truncate">{note.title}</div>
                                            <div
                                                className="text-xs truncate"
                                                style={{
                                                    opacity:
                                                        i === selectedIndex
                                                            ? 0.7
                                                            : 0.5,
                                                }}
                                            >
                                                {note.id}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
