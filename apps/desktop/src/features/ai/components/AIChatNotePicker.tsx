import { useState } from "react";
import type { AIChatNoteSummary } from "../types";

interface AIChatNotePickerProps {
    open: boolean;
    notes: AIChatNoteSummary[];
    onClose: () => void;
    onPick: (note: AIChatNoteSummary) => void;
}

export function AIChatNotePicker({
    open,
    notes,
    onClose,
    onPick,
}: AIChatNotePickerProps) {
    const [query, setQuery] = useState("");

    const normalized = query.trim().toLowerCase();
    const filteredNotes = (!normalized
        ? notes
        : notes.filter((note) => {
              const haystack = `${note.title} ${note.path}`.toLowerCase();
              return haystack.includes(normalized);
          })
    ).slice(0, 40);

    if (!open) return null;

    return (
        <div
            className="absolute inset-0 z-20 flex items-start justify-center p-3"
            style={{
                background: "rgb(0 0 0 / 0.22)",
                backdropFilter: "blur(4px)",
            }}
        >
            <div
                className="mt-8 w-full max-w-md overflow-hidden rounded-2xl"
                style={{
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-soft)",
                }}
            >
                <div
                    className="flex items-center justify-between px-3 py-3"
                    style={{ borderBottom: "1px solid var(--border)" }}
                >
                    <div>
                        <div
                            className="text-[11px] uppercase tracking-[0.14em]"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            Context
                        </div>
                        <div
                            className="mt-1 text-sm font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            Attach note
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md px-2 py-1 text-xs"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "1px solid var(--border)",
                        }}
                    >
                        Close
                    </button>
                </div>

                <div className="p-3">
                    <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Filter notes..."
                        className="w-full rounded-md px-3 py-2 text-sm"
                        style={{
                            color: "var(--text-primary)",
                            backgroundColor: "var(--bg-secondary)",
                            border: "1px solid var(--border)",
                            outline: "none",
                        }}
                    />
                </div>

                <div
                    className="max-h-[420px] overflow-y-auto px-3 pb-3"
                    data-scrollbar-active="true"
                >
                    <div className="flex flex-col gap-2">
                        {filteredNotes.length === 0 ? (
                            <div
                                className="rounded-xl px-3 py-4 text-sm"
                                style={{
                                    color: "var(--text-secondary)",
                                    backgroundColor: "var(--bg-secondary)",
                                    border: "1px dashed var(--border)",
                                }}
                            >
                                No notes match the current filter.
                            </div>
                        ) : (
                            filteredNotes.map((note) => (
                                <button
                                    key={note.id}
                                    type="button"
                                    onClick={() => {
                                        onPick(note);
                                        setQuery("");
                                    }}
                                    className="rounded-xl px-3 py-2 text-left"
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                        border: "1px solid var(--border)",
                                        color: "var(--text-primary)",
                                    }}
                                >
                                    <div className="text-sm font-medium">
                                        {note.title}
                                    </div>
                                    <div
                                        className="mt-1 text-xs"
                                        style={{ color: "var(--text-secondary)" }}
                                    >
                                        {note.path}
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
