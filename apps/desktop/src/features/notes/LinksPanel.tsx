import { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
    useEditorStore,
    type PendingReveal,
} from "../../app/store/editorStore";
import { useShallow } from "zustand/react/shallow";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { revealNoteInTree } from "../../app/utils/navigation";
import { useVaultStore, type NoteDto } from "../../app/store/vaultStore";
import { findWikilinks } from "../../app/utils/wikilinks";

interface BacklinkDto {
    id: string;
    title: string;
}

interface ResolvedOutgoingLink {
    target: string;
    note: NoteDto;
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

function normalizeWikilinkTarget(target: string): string {
    const trimmed = target.trim();
    const withoutSubpath = trimmed.split(/[#^]/, 1)[0]?.trim() ?? "";
    return withoutSubpath
        .replace(/\.md$/i, "")
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, "...")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function getWikilinkVariants(target: string): string[] {
    const normalized = normalizeWikilinkTarget(target);
    if (!normalized) return [];
    const trimmed = normalized.replace(/[\s.,!?:;]+$/g, "");
    return trimmed && trimmed !== normalized
        ? [normalized, trimmed]
        : [normalized];
}

function isStrongPrefixCandidate(target: string): boolean {
    return target.length >= 24 && target.split(/\s+/).length >= 4;
}

function isPrefixExpansion(candidate: string, target: string): boolean {
    if (candidate === target || !candidate.startsWith(target)) {
        return false;
    }

    const next = candidate.charAt(target.length);
    return next === " " || next === "-" || next === ":" || next === "(";
}

function findUniquePrefixNote(
    target: string,
    notes: NoteDto[],
): NoteDto | null {
    const variants = getWikilinkVariants(target).filter(
        isStrongPrefixCandidate,
    );
    if (!variants.length) return null;

    const matches: NoteDto[] = [];

    for (const note of notes) {
        const aliases = [
            normalizeWikilinkTarget(note.title),
            normalizeWikilinkTarget(note.id.split("/").pop() ?? ""),
        ];

        if (
            !aliases.some((alias) =>
                variants.some((variant) => isPrefixExpansion(alias, variant)),
            )
        ) {
            continue;
        }

        matches.push(note);
        if (matches.length > 1) return null;
    }

    return matches[0] ?? null;
}

interface NoteIndex {
    byId: Map<string, NoteDto>;
    byTitle: Map<string, NoteDto>;
    byFilename: Map<string, NoteDto[]>;
    notes: NoteDto[];
}

function buildNoteIndex(notes: NoteDto[]): NoteIndex {
    const byId = new Map<string, NoteDto>();
    const byTitle = new Map<string, NoteDto>();
    const byFilename = new Map<string, NoteDto[]>();

    for (const note of notes) {
        byId.set(normalizeWikilinkTarget(note.id), note);
        byTitle.set(normalizeWikilinkTarget(note.title), note);

        const filename = normalizeWikilinkTarget(
            note.id.split("/").pop() ?? "",
        );
        if (filename) {
            const existing = byFilename.get(filename);
            if (existing) existing.push(note);
            else byFilename.set(filename, [note]);
        }
    }

    return { byId, byTitle, byFilename, notes };
}

function resolveNote(target: string, index: NoteIndex): NoteDto | null {
    const variants = getWikilinkVariants(target);
    for (const v of variants) {
        const byId = index.byId.get(v);
        if (byId) return byId;
    }
    for (const v of variants) {
        const byTitle = index.byTitle.get(v);
        if (byTitle) return byTitle;
    }
    for (const v of variants) {
        const matches = index.byFilename.get(v);
        if (matches?.length === 1) return matches[0];
    }
    return findUniquePrefixNote(target, index.notes);
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
    broken?: boolean;
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function NoteItem({
    title,
    subtitle,
    onClick,
    broken = false,
    onContextMenu,
}: NoteItemProps) {
    return (
        <button
            onClick={onClick}
            onContextMenu={onContextMenu}
            className="w-full text-left px-3 py-1.5 flex items-start gap-2 rounded-sm"
            style={{ color: "var(--text-primary)" }}
            onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")
            }
            onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "transparent")
            }
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
            className="w-full text-left px-3 py-1.5 text-xs rounded"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
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
            className="w-full text-left px-3 py-1.5 text-xs rounded"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
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
    const notes = useVaultStore((s) => s.notes);
    const tabs = useEditorStore((s) => s.tabs);

    // Single shallow selector — re-renders only when these 3 values change
    const { activeNoteId, activeContent, activeTitle } = useEditorStore(
        useShallow((s) => {
            const tab = s.tabs.find((t) => t.id === s.activeTabId);
            return {
                activeNoteId: tab?.noteId ?? null,
                activeContent: tab?.content ?? null,
                activeTitle: tab?.title ?? null,
            };
        }),
    );

    const [backlinks, setBacklinks] = useState<BacklinkDto[]>([]);
    const [backlinkContextMenu, setBacklinkContextMenu] =
        useState<BacklinkContextMenuState | null>(null);
    const [outgoingContextMenu, setOutgoingContextMenu] =
        useState<OutgoingContextMenuState | null>(null);
    const backlinkRequestIdRef = useRef(0);

    useEffect(() => {
        if (!activeNoteId) {
            backlinkRequestIdRef.current += 1;
            return;
        }
        const requestId = ++backlinkRequestIdRef.current;
        invoke<BacklinkDto[]>("get_backlinks", { noteId: activeNoteId })
            .then((nextBacklinks) => {
                if (requestId !== backlinkRequestIdRef.current) return;
                setBacklinks(nextBacklinks);
            })
            .catch(() => {
                if (requestId !== backlinkRequestIdRef.current) return;
                setBacklinks([]);
            });
    }, [activeNoteId]);

    const noteIndex = useMemo(() => buildNoteIndex(notes), [notes]);

    const outgoingLinks = useMemo(() => {
        if (!activeContent) return [];
        const seen = new Set<string>();
        return findWikilinks(activeContent)
            .filter(({ target }) => {
                if (seen.has(target)) return false;
                seen.add(target);
                return true;
            })
            .map(({ target }) => {
                const note = resolveNote(target, noteIndex);
                return note
                    ? ({ target, note } satisfies ResolvedOutgoingLink)
                    : ({ target, note: null } satisfies BrokenOutgoingLink);
            });
    }, [activeContent, noteIndex]);

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
        const existing = tabs.find((t) => t.noteId === id);
        if (existing) {
            openNote(id, title, existing.content);
            return;
        }
        try {
            const detail = await invoke<{ content: string }>("read_note", {
                noteId: id,
            });
            openNote(id, title, detail.content, {
                placement: "afterActive",
            });
        } catch (e) {
            console.error("Error opening note:", e);
        }
    };

    const openBacklinkInNewTab = async (bl: BacklinkDto) => {
        try {
            const existing = tabs.find((t) => t.noteId === bl.id);
            const content =
                existing?.content ??
                (
                    await invoke<{ content: string }>("read_note", {
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
            const existing = tabs.find((t) => t.noteId === link.note.id);
            const content =
                existing?.content ??
                (
                    await invoke<{ content: string }>("read_note", {
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
                    openNote(created.id, created.title, "", {
                        placement: "afterActive",
                    });
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

            <SectionHeader label="Outgoing Links" count={outgoingLinks.length} />
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
