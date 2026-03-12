import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useLayoutEffect,
} from "react";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    useEditorStore,
    type PendingReveal,
} from "../../app/store/editorStore";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { revealNoteInTree } from "../../app/utils/navigation";

interface BacklinkDto {
    id: string;
    title: string;
}

interface ContextMenuState {
    x: number;
    y: number;
    backlink: BacklinkDto;
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
    menu: ContextMenuState;
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
            getViewportSafeMenuPosition(menu.x, menu.y, rect.width, rect.height),
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

export function BacklinksPanel() {
    const tabs = useEditorStore((s) => s.tabs);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const openNote = useEditorStore((s) => s.openNote);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const queueReveal = useEditorStore((s) => s.queueReveal);
    const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
    const activeNoteId = activeTab?.noteId ?? null;
    const activeTitle = activeTab?.title ?? null;
    const [backlinks, setBacklinks] = useState<BacklinkDto[]>([]);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
        null,
    );
    const requestIdRef = useRef(0);

    useEffect(() => {
        if (!activeNoteId) {
            requestIdRef.current += 1;
            return;
        }

        const requestId = ++requestIdRef.current;
        vaultInvoke<BacklinkDto[]>("get_backlinks", { noteId: activeNoteId })
            .then((nextBacklinks) => {
                if (requestId !== requestIdRef.current) return;
                setBacklinks(nextBacklinks);
            })
            .catch(() => {
                if (requestId !== requestIdRef.current) return;
                setBacklinks([]);
            });
    }, [activeNoteId]);

    const revealTargets = useMemo(() => {
        if (!activeNoteId) return [];
        return [
            activeNoteId,
            activeTitle ?? activeNoteId,
            activeNoteId.split("/").pop() ?? activeNoteId,
        ];
    }, [activeNoteId, activeTitle]);

    if (!activeTab) return null;

    const readBacklink = async (bl: BacklinkDto) =>
        vaultInvoke<{ content: string }>("read_note", {
            noteId: bl.id,
        });

    const openSourceNote = async (bl: BacklinkDto) => {
        const existing = tabs.find((t) => t.noteId === bl.id);
        if (existing) {
            openNote(bl.id, bl.title, existing.content);
            return;
        }
        try {
            const detail = await readBacklink(bl);
            openNote(bl.id, bl.title, detail.content);
        } catch (e) {
            console.error("Error reading backlink note:", e);
        }
    };

    const openSourceInNewTab = async (bl: BacklinkDto) => {
        try {
            const existing = tabs.find((t) => t.noteId === bl.id);
            const content =
                existing?.content ?? (await readBacklink(bl)).content;

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

    const queueBacklinkReveal = async (
        bl: BacklinkDto,
        mode: PendingReveal["mode"],
    ) => {
        queueReveal({
            noteId: bl.id,
            targets: revealTargets,
            mode,
        });
        await openSourceNote(bl);
    };

    const copyWikilink = async (bl: BacklinkDto) => {
        try {
            await navigator.clipboard.writeText(`[[${bl.id}]]`);
        } catch (e) {
            console.error("Error copying wikilink:", e);
        }
    };

    return (
        <div
            className="shrink-0"
            style={{ borderTop: "1px solid var(--border)" }}
        >
            <div
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-secondary)" }}
            >
                Backlinks
            </div>
            <div className="px-2 pb-2">
                {backlinks.length === 0 ? (
                    <div
                        className="text-xs px-1 py-1"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No backlinks
                    </div>
                ) : (
                    backlinks.map((bl) => (
                        <button
                            key={bl.id}
                            onClick={() => void openSourceNote(bl)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    backlink: bl,
                                });
                            }}
                            className="w-full text-left text-xs py-1 px-1 rounded truncate"
                            style={{ color: "var(--text-primary)" }}
                            onMouseEnter={(e) =>
                                (e.currentTarget.style.backgroundColor =
                                    "var(--bg-tertiary)")
                            }
                            onMouseLeave={(e) =>
                                (e.currentTarget.style.backgroundColor =
                                    "transparent")
                            }
                        >
                            {bl.title}
                        </button>
                    ))
                )}
            </div>

            {contextMenu && (
                <BacklinksContextMenu
                    menu={contextMenu}
                    onOpenInNewTab={(bl) => void openSourceInNewTab(bl)}
                    onRevealLink={(bl) => void queueBacklinkReveal(bl, "link")}
                    onGoToMention={(bl) =>
                        void queueBacklinkReveal(bl, "mention")
                    }
                    onRevealInFileTree={(bl) => revealNoteInTree(bl.id)}
                    onCopyWikilink={(bl) => void copyWikilink(bl)}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}
