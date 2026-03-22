import {
    useDeferredValue,
    useState,
    useEffect,
    useMemo,
    useRef,
    useLayoutEffect,
} from "react";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    useEditorStore,
    type PendingReveal,
    isNoteTab,
    type NoteTab,
} from "../../app/store/editorStore";
import { useShallow } from "zustand/react/shallow";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { revealNoteInTree } from "../../app/utils/navigation";
import { useVaultStore } from "../../app/store/vaultStore";
import { findWikilinks } from "../../app/utils/wikilinks";

interface BacklinkDto {
    id: string;
    title: string;
}

interface ResolvedOutgoingLink {
    target: string;
    note: { id: string; title: string };
}

interface BrokenOutgoingLink {
    target: string;
    note: null;
}

type OutgoingLink = ResolvedOutgoingLink | BrokenOutgoingLink;

function isResolvedOutgoingLink(
    link: OutgoingLink,
): link is ResolvedOutgoingLink {
    return link.note !== null;
}

interface BacklinkContextMenuState {
    x: number;
    y: number;
    backlink: BacklinkDto;
}

interface OutgoingContextMenuState {
    x: number;
    y: number;
    link: OutgoingLink;
}

interface ResolvedWikilinkDto {
    target: string;
    resolved_note_id: string | null;
    resolved_title: string | null;
}

function LinkIcon() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, opacity: 0.5 }}
        >
            <path d="M10 2h4v4M14 2l-6 6M6 4H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
        </svg>
    );
}

function BrokenLinkIcon() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, opacity: 0.7 }}
        >
            <path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" />
            <path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" />
            <path d="M2 2l12 12" />
        </svg>
    );
}

interface NoteItemProps {
    title: string;
    subtitle?: string;
    onClick: () => void;
    onAuxClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    broken?: boolean;
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function NoteItem({
    title,
    subtitle,
    onClick,
    onAuxClick,
    broken = false,
    onContextMenu,
}: NoteItemProps) {
    return (
        <button
            onClick={onClick}
            onAuxClick={onAuxClick}
            onContextMenu={onContextMenu}
            className="w-full text-left px-3 py-1.5 flex items-start gap-2 rounded-sm hover:bg-(--bg-tertiary) transition-colors duration-80 cursor-pointer"
            style={{ color: "var(--text-primary)" }}
        >
            <div className="mt-0.5">
                {broken ? <BrokenLinkIcon /> : <LinkIcon />}
            </div>
            <div className="min-w-0">
                <div
                    className="text-xs truncate"
                    style={{
                        color: broken ? "#ef4444" : "var(--text-primary)",
                    }}
                >
                    {title}
                </div>
                {subtitle && (
                    <div
                        className="text-xs truncate"
                        style={{ color: "var(--text-secondary)", fontSize: 10 }}
                    >
                        {subtitle}
                    </div>
                )}
            </div>
        </button>
    );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
    return (
        <div
            className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-secondary)" }}
        >
            <span>{label}</span>
            {count > 0 && <span>{count}</span>}
        </div>
    );
}

function BacklinksContextMenu({
    menu,
    onOpenInNewTab,
    onRevealLink,
    onGoToMention,
    onRevealInFileTree,
    onCopyWikilink,
    onClose,
}: {
    menu: BacklinkContextMenuState;
    onOpenInNewTab: (backlink: BacklinkDto) => void;
    onRevealLink: (backlink: BacklinkDto) => void;
    onGoToMention: (backlink: BacklinkDto) => void;
    onRevealInFileTree: (backlink: BacklinkDto) => void;
    onCopyWikilink: (backlink: BacklinkDto) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [menu.x, menu.y]);

    useEffect(() => {
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
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

    const item = (label: string, action: () => void) => (
        <button
            key={label}
            onClick={() => {
                action();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-xs rounded hover:bg-(--bg-tertiary)"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
            }}
        >
            {label}
        </button>
    );

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 9999,
                minWidth: 190,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {item("Open in New Tab", () => onOpenInNewTab(menu.backlink))}
            {item("Reveal Link", () => onRevealLink(menu.backlink))}
            {item("Go to Mention", () => onGoToMention(menu.backlink))}
            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    margin: "4px 0",
                }}
            />
            {item("Reveal in File Tree", () =>
                onRevealInFileTree(menu.backlink),
            )}
            {item("Copy Wikilink", () => onCopyWikilink(menu.backlink))}
        </div>
    );
}

function OutgoingLinksContextMenu({
    menu,
    onOpenInNewTab,
    onRevealLink,
    onRevealInFileTree,
    onCopyWikilink,
    onCreateNote,
    onClose,
}: {
    menu: OutgoingContextMenuState;
    onOpenInNewTab: (link: ResolvedOutgoingLink) => void;
    onRevealLink: (link: OutgoingLink) => void;
    onRevealInFileTree: (link: ResolvedOutgoingLink) => void;
    onCopyWikilink: (link: OutgoingLink) => void;
    onCreateNote: (link: BrokenOutgoingLink) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [menu.x, menu.y]);

    useEffect(() => {
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
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

    const item = (label: string, action: () => void) => (
        <button
            key={label}
            onClick={() => {
                action();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-xs rounded hover:bg-(--bg-tertiary)"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
            }}
        >
            {label}
        </button>
    );

    const resolvedLink = isResolvedOutgoingLink(menu.link) ? menu.link : null;
    const brokenLink = resolvedLink ? null : menu.link;

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 9999,
                minWidth: 190,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {resolvedLink
                ? item("Open in New Tab", () => onOpenInNewTab(resolvedLink))
                : brokenLink &&
                  item("Create Note", () =>
                      onCreateNote(brokenLink as BrokenOutgoingLink),
                  )}
            {item("Reveal Link", () => onRevealLink(menu.link))}
            {resolvedLink && (
                <>
                    <div
                        style={{
                            borderTop: "1px solid var(--border)",
                            margin: "4px 0",
                        }}
                    />
                    {item("Reveal in File Tree", () =>
                        onRevealInFileTree(resolvedLink),
                    )}
                </>
            )}
            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    margin: "4px 0",
                }}
            />
            {item("Copy Wikilink", () => onCopyWikilink(menu.link))}
        </div>
    );
}

export function LinksPanel() {
    const { openNote, insertExternalTab, queueReveal } = useEditorStore(
        useShallow((s) => ({
            openNote: s.openNote,
            insertExternalTab: s.insertExternalTab,
            queueReveal: s.queueReveal,
        })),
    );

    // Single shallow selector — re-renders only when these 3 values change.
    // `tabs` is NOT subscribed here — event handlers use getState() instead.
    const { activeNoteId, activeTitle, activeContent } = useEditorStore(
        useShallow((s) => {
            const tab = s.tabs.find((t) => t.id === s.activeTabId);
            return {
                activeNoteId: tab && isNoteTab(tab) ? tab.noteId : null,
                activeTitle: tab?.title ?? null,
                activeContent: tab && isNoteTab(tab) ? tab.content : "",
            };
        }),
    );
    const deferredActiveContent = useDeferredValue(activeContent);

    const [backlinks, setBacklinks] = useState<BacklinkDto[]>([]);
    const [outgoingLinks, setOutgoingLinks] = useState<OutgoingLink[]>([]);
    const [backlinkContextMenu, setBacklinkContextMenu] =
        useState<BacklinkContextMenuState | null>(null);
    const [outgoingContextMenu, setOutgoingContextMenu] =
        useState<OutgoingContextMenuState | null>(null);
    const backlinkRequestIdRef = useRef(0);
    const outgoingRequestIdRef = useRef(0);

    // Backlinks only depend on which note is active — not on content.
    useEffect(() => {
        if (!activeNoteId) {
            backlinkRequestIdRef.current += 1;
            queueMicrotask(() => setBacklinks([]));
            return;
        }
        const blRequestId = ++backlinkRequestIdRef.current;
        vaultInvoke<BacklinkDto[]>("get_backlinks", { noteId: activeNoteId })
            .then((nextBacklinks) => {
                if (blRequestId !== backlinkRequestIdRef.current) return;
                setBacklinks(nextBacklinks);
            })
            .catch(() => {
                if (blRequestId !== backlinkRequestIdRef.current) return;
                setBacklinks([]);
            });
    }, [activeNoteId]);

    // Outgoing links depend on content (parsed wikilinks).
    useEffect(() => {
        if (!activeNoteId) {
            outgoingRequestIdRef.current += 1;
            queueMicrotask(() => setOutgoingLinks([]));
            return;
        }

        const uniqueTargets = [
            ...new Set(
                findWikilinks(deferredActiveContent)
                    .map((link) => link.target)
                    .filter(Boolean),
            ),
        ];

        if (uniqueTargets.length === 0) {
            outgoingRequestIdRef.current += 1;
            queueMicrotask(() => setOutgoingLinks([]));
            return;
        }

        const olRequestId = ++outgoingRequestIdRef.current;
        vaultInvoke<ResolvedWikilinkDto[]>("resolve_wikilinks_batch", {
            noteId: activeNoteId,
            targets: uniqueTargets,
        })
            .then((links) => {
                if (olRequestId !== outgoingRequestIdRef.current) return;
                const resolvedByTarget = new Map(
                    links.map((link) => [link.target, link]),
                );

                setOutgoingLinks(
                    uniqueTargets.map((target) => {
                        const resolved = resolvedByTarget.get(target);
                        return resolved?.resolved_note_id
                            ? ({
                                  target,
                                  note: {
                                      id: resolved.resolved_note_id,
                                      title:
                                          resolved.resolved_title ??
                                          resolved.resolved_note_id,
                                  },
                              } as ResolvedOutgoingLink)
                            : ({
                                  target,
                                  note: null,
                              } as BrokenOutgoingLink);
                    }),
                );
            })
            .catch(() => {
                if (olRequestId !== outgoingRequestIdRef.current) return;
                setOutgoingLinks([]);
            });
    }, [activeNoteId, deferredActiveContent]);

    const revealTargets = useMemo(() => {
        if (!activeNoteId) return [];
        return [
            activeNoteId,
            activeTitle ?? activeNoteId,
            activeNoteId.split("/").pop() ?? activeNoteId,
        ];
    }, [activeNoteId, activeTitle]);

    const getBacklinkTargets = (bl: BacklinkDto) => [
        bl.id,
        bl.title,
        bl.id.split("/").pop() ?? bl.id,
    ];

    const getOutgoingTargets = (link: OutgoingLink) => [
        link.target,
        ...(link.note
            ? [
                  link.note.id,
                  link.note.title,
                  link.note.id.split("/").pop() ?? link.note.id,
              ]
            : []),
    ];

    const openNoteById = async (id: string, title: string) => {
        const existing = useEditorStore
            .getState()
            .tabs.find((t): t is NoteTab => isNoteTab(t) && t.noteId === id);
        if (existing) {
            openNote(id, title, existing.content);
            return;
        }
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: id,
            });
            openNote(id, title, detail.content);
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const openBacklinkInNewTab = async (bl: BacklinkDto) => {
        try {
            const existing = useEditorStore
                .getState()
                .tabs.find(
                    (t): t is NoteTab => isNoteTab(t) && t.noteId === bl.id,
                );
            const content =
                existing?.content ??
                (
                    await vaultInvoke<{ content: string }>("read_note", {
                        noteId: bl.id,
                    })
                ).content;

            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: bl.id,
                title: bl.title,
                content,
            });
        } catch (e) {
            console.error("Error opening backlink in new tab:", e);
        }
    };

    const revealLinkInCurrentNote = (bl: BacklinkDto) => {
        if (!activeNoteId) return;
        queueReveal({
            noteId: activeNoteId,
            targets: getBacklinkTargets(bl),
            mode: "link",
        });
    };

    const goToMention = async (
        bl: BacklinkDto,
        mode: PendingReveal["mode"] = "mention",
    ) => {
        queueReveal({
            noteId: bl.id,
            targets: revealTargets,
            mode,
        });
        await openNoteById(bl.id, bl.title);
    };

    const copyWikilink = async (bl: BacklinkDto) => {
        try {
            await navigator.clipboard.writeText(`[[${bl.id}]]`);
        } catch (e) {
            console.error("Error copying wikilink:", e);
        }
    };

    const copyOutgoingWikilink = async (link: OutgoingLink) => {
        try {
            await navigator.clipboard.writeText(`[[${link.target}]]`);
        } catch (e) {
            console.error("Error copying wikilink:", e);
        }
    };

    const openOutgoingInNewTab = async (link: ResolvedOutgoingLink) => {
        try {
            const existing = useEditorStore
                .getState()
                .tabs.find(
                    (t): t is NoteTab =>
                        isNoteTab(t) && t.noteId === link.note.id,
                );
            const content =
                existing?.content ??
                (
                    await vaultInvoke<{ content: string }>("read_note", {
                        noteId: link.note.id,
                    })
                ).content;

            insertExternalTab({
                id: crypto.randomUUID(),
                noteId: link.note.id,
                title: link.note.title,
                content,
            });
        } catch (e) {
            console.error("Error opening outgoing link in new tab:", e);
        }
    };

    const revealOutgoingLink = (link: OutgoingLink) => {
        if (!activeNoteId) return;
        queueReveal({
            noteId: activeNoteId,
            targets: getOutgoingTargets(link),
            mode: "link",
        });
    };

    const createOutgoingNote = (link: BrokenOutgoingLink) => {
        void useVaultStore
            .getState()
            .createNote(link.target)
            .then((created) => {
                if (created) {
                    openNote(created.id, created.title, "");
                }
            });
    };

    if (!activeNoteId) {
        return (
            <div
                className="flex items-center justify-center h-full text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                No note open
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <SectionHeader label="Backlinks" count={backlinks.length} />
            {backlinks.length === 0 ? (
                <div
                    className="px-3 pb-2 text-xs"
                    style={{ color: "var(--text-secondary)" }}
                >
                    No backlinks
                </div>
            ) : (
                <div className="px-1 pb-1">
                    {backlinks.map((bl) => (
                        <NoteItem
                            key={bl.id}
                            title={bl.title}
                            subtitle={bl.id}
                            onClick={() => void openNoteById(bl.id, bl.title)}
                            onAuxClick={(event) => {
                                if (event.button !== 1) return;
                                event.preventDefault();
                                event.stopPropagation();
                                void openBacklinkInNewTab(bl);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                setBacklinkContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    backlink: bl,
                                });
                            }}
                        />
                    ))}
                </div>
            )}

            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    margin: "4px 0",
                }}
            />

            <SectionHeader
                label="Outgoing Links"
                count={outgoingLinks.length}
            />
            {outgoingLinks.length === 0 ? (
                <div
                    className="px-3 pb-2 text-xs"
                    style={{ color: "var(--text-secondary)" }}
                >
                    No outgoing links
                </div>
            ) : (
                <div className="px-1 pb-1">
                    {outgoingLinks.map(({ target, note }) =>
                        note ? (
                            <NoteItem
                                key={target}
                                title={note.title}
                                subtitle={note.id}
                                onClick={() =>
                                    void openNoteById(note.id, note.title)
                                }
                                onAuxClick={(event) => {
                                    if (event.button !== 1) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void openOutgoingInNewTab({ target, note });
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setOutgoingContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        link: { target, note },
                                    });
                                }}
                            />
                        ) : (
                            <NoteItem
                                key={target}
                                title={target}
                                subtitle="Not found"
                                broken
                                onClick={() => {
                                    void useVaultStore
                                        .getState()
                                        .createNote(target)
                                        .then((created) => {
                                            if (created)
                                                openNote(
                                                    created.id,
                                                    created.title,
                                                    "",
                                                );
                                        });
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setOutgoingContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        link: { target, note: null },
                                    });
                                }}
                            />
                        ),
                    )}
                </div>
            )}

            {backlinkContextMenu && (
                <BacklinksContextMenu
                    menu={backlinkContextMenu}
                    onOpenInNewTab={(bl) => void openBacklinkInNewTab(bl)}
                    onRevealLink={(bl) => revealLinkInCurrentNote(bl)}
                    onGoToMention={(bl) => void goToMention(bl)}
                    onRevealInFileTree={(bl) => revealNoteInTree(bl.id)}
                    onCopyWikilink={(bl) => void copyWikilink(bl)}
                    onClose={() => setBacklinkContextMenu(null)}
                />
            )}

            {outgoingContextMenu && (
                <OutgoingLinksContextMenu
                    menu={outgoingContextMenu}
                    onOpenInNewTab={(link) => void openOutgoingInNewTab(link)}
                    onRevealLink={(link) => revealOutgoingLink(link)}
                    onRevealInFileTree={(link) =>
                        revealNoteInTree(link.note.id)
                    }
                    onCopyWikilink={(link) => void copyOutgoingWikilink(link)}
                    onCreateNote={(link) => createOutgoingNote(link)}
                    onClose={() => setOutgoingContextMenu(null)}
                />
            )}
        </div>
    );
}
