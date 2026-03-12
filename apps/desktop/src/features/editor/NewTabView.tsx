import { useMemo, useState, useCallback } from "react";
import { useVaultStore, getRecentVaults, togglePinVault, type RecentVault } from "../../app/store/vaultStore";
import {
    useEditorStore,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useLayoutStore } from "../../app/store/layoutStore";

function formatRelativeTime(unixSeconds: number): string {
    const diff = Date.now() / 1000 - unixSeconds;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(unixSeconds * 1000).toLocaleDateString();
}

function PinIcon({ pinned }: { pinned: boolean }) {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill={pinned ? "var(--accent)" : "none"}
            stroke={pinned ? "var(--accent)" : "var(--text-secondary)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M9.5 2.5L13.5 6.5L10 8L8 14L6 10L2 8L8 6L9.5 2.5Z" />
            <line x1="2" y1="14" x2="5.5" y2="10.5" />
        </svg>
    );
}

export function NewTabView() {
    const notes = useVaultStore((s) => s.notes);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const openVault = useVaultStore((s) => s.openVault);
    const createNote = useVaultStore((s) => s.createNote);
    const openNote = useEditorStore((s) => s.openNote);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);

    const [recentVaults, setRecentVaults] = useState<RecentVault[]>(() =>
        getRecentVaults(),
    );

    const recentNotes = useMemo(
        () =>
            [...notes]
                .sort((a, b) => b.modified_at - a.modified_at)
                .slice(0, 10),
        [notes],
    );

    const pinnedVaults = recentVaults.filter((v) => v.pinned);
    const unpinnedVaults = recentVaults.filter((v) => !v.pinned);
    const vaultsToShow = [
        ...pinnedVaults,
        ...unpinnedVaults.slice(0, Math.max(0, 5 - pinnedVaults.length)),
    ];

    const handleOpen = async (id: string, title: string) => {
        const tabs = useEditorStore.getState().tabs;
        const existing = tabs.find(
            (t): t is NoteTab => isNoteTab(t) && t.noteId === id,
        );
        if (existing) {
            openNote(id, title, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", { noteId: id });
            openNote(id, title, detail.content);
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const handleNewNote = async () => {
        if (!vaultPath) return;
        const { notes: currentNotes } = useVaultStore.getState();
        let name = "Untitled";
        let i = 1;
        while (currentNotes.some((n) => n.id === name || n.id.endsWith(`/${name}`))) {
            name = `Untitled ${i++}`;
        }
        const note = await createNote(name);
        if (note) {
            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: note.id,
                title: note.title,
                content: "",
            });
        }
    };

    const handleOpenSearch = () => {
        useLayoutStore.getState().setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    };

    const handleTogglePin = useCallback((path: string, e: React.MouseEvent) => {
        e.stopPropagation();
        togglePinVault(path);
        setRecentVaults(getRecentVaults());
    }, []);

    return (
        <div
            className="h-full w-full overflow-auto flex items-start justify-center"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            <div className="w-full max-w-lg px-8 py-16">
                {/* Header */}
                <div className="mb-8">
                    <div
                        className="text-[11px] uppercase tracking-[0.16em] mb-1"
                        style={{ color: "var(--accent)" }}
                    >
                        VaultAI
                    </div>
                    <h1
                        className="text-2xl font-semibold"
                        style={{ color: "var(--text-primary)" }}
                    >
                        New Tab
                    </h1>
                </div>

                {/* Quick actions */}
                <div className="grid grid-cols-2 gap-2 mb-8">
                    <button
                        onClick={() => void handleNewNote()}
                        className="rounded-xl px-4 py-3 text-left"
                        style={{
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-secondary)",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.borderColor = "var(--accent)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.borderColor = "var(--border)")
                        }
                    >
                        <div className="flex items-center gap-2 mb-1">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 3v10M3 8h10" />
                            </svg>
                            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                                New Note
                            </span>
                        </div>
                        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                            Create a new note in the vault
                        </span>
                    </button>

                    <button
                        onClick={handleOpenSearch}
                        className="rounded-xl px-4 py-3 text-left"
                        style={{
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-secondary)",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.borderColor = "var(--accent)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.borderColor = "var(--border)")
                        }
                    >
                        <div className="flex items-center gap-2 mb-1">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="7" cy="7" r="4.5" />
                                <path d="M10.5 10.5L14 14" />
                            </svg>
                            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                                Search
                            </span>
                        </div>
                        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                            Search across all notes
                        </span>
                    </button>
                </div>

                {/* Recent notes */}
                {recentNotes.length > 0 && (
                    <div className="mb-8">
                        <div
                            className="text-xs uppercase tracking-[0.12em] mb-3"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            Recent
                        </div>
                        <div
                            className="rounded-xl overflow-hidden"
                            style={{ border: "1px solid var(--border)" }}
                        >
                            {recentNotes.map((note, i) => (
                                <button
                                    key={note.id}
                                    onClick={() => void handleOpen(note.id, note.title)}
                                    className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-4"
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                        borderTop: i > 0 ? "1px solid var(--border)" : "none",
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.backgroundColor = "var(--bg-secondary)")
                                    }
                                >
                                    <div className="min-w-0 flex-1">
                                        <div
                                            className="text-sm truncate"
                                            style={{ color: "var(--text-primary)" }}
                                        >
                                            {note.title}
                                        </div>
                                        {note.id.includes("/") && (
                                            <div
                                                className="text-[11px] truncate mt-0.5"
                                                style={{ color: "var(--text-secondary)" }}
                                            >
                                                {note.id.split("/").slice(0, -1).join("/")}
                                            </div>
                                        )}
                                    </div>
                                    <span
                                        className="text-[11px] shrink-0"
                                        style={{ color: "var(--text-secondary)" }}
                                    >
                                        {formatRelativeTime(note.modified_at)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Vaults */}
                {vaultsToShow.length > 0 && (
                    <div className="mb-8">
                        <div
                            className="text-xs uppercase tracking-[0.12em] mb-3"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            Vaults
                        </div>
                        <div
                            className="rounded-xl overflow-hidden"
                            style={{ border: "1px solid var(--border)" }}
                        >
                            {vaultsToShow.map((vault, i) => (
                                <div
                                    key={vault.path}
                                    className="flex items-center"
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                        borderTop: i > 0 ? "1px solid var(--border)" : "none",
                                    }}
                                    onMouseEnter={(e) =>
                                        (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")
                                    }
                                    onMouseLeave={(e) =>
                                        (e.currentTarget.style.backgroundColor = "var(--bg-secondary)")
                                    }
                                >
                                    <button
                                        onClick={() => void openVault(vault.path)}
                                        className="flex-1 text-left px-4 py-2.5 min-w-0"
                                    >
                                        <div className="flex items-center gap-2">
                                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--text-secondary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M2 4h5l1.5 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
                                            </svg>
                                            <span
                                                className="text-sm truncate"
                                                style={{
                                                    color: "var(--text-primary)",
                                                    fontWeight: vault.pinned ? 500 : 400,
                                                }}
                                            >
                                                {vault.name}
                                            </span>
                                        </div>
                                        <div
                                            className="text-[11px] truncate mt-0.5 pl-5"
                                            style={{ color: "var(--text-secondary)" }}
                                            title={vault.path}
                                        >
                                            {vault.path}
                                        </div>
                                    </button>
                                    <button
                                        onClick={(e) => handleTogglePin(vault.path, e)}
                                        title={vault.pinned ? "Unpin vault" : "Pin vault"}
                                        className="shrink-0 px-3 py-2.5 opacity-40 hover:opacity-100"
                                    >
                                        <PinIcon pinned={!!vault.pinned} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}
