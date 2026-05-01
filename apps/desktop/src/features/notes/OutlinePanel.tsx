import { useCallback, useDeferredValue, useMemo, useState } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";

export interface OutlineSelection {
    anchor: number;
    head: number;
}

interface OutlineHeading {
    id: string;
    title: string;
    level: number;
    anchor: number;
    head: number;
}

interface OutlineNode extends OutlineHeading {
    children: OutlineNode[];
}

const ATX_RE = /^\s*(#{1,6})\s+(.+?)\s*$/;
const SETEXT_H1_RE = /^===+\s*$/;
const SETEXT_H2_RE = /^---+\s*$/;
const TRAILING_HASHES_RE = /\s+#+\s*$/;
const OUTLINE_INDENT_STEP = 14;
const OUTLINE_GUIDE_COLOR = "var(--tree-guide-color)";

function cleanHeadingTitle(raw: string): string {
    return raw
        .trim()
        .replace(TRAILING_HASHES_RE, "")
        .replace(/!\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/!\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/!\[([^\]]*)\]\[[^\]]+\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\[[^\]]+\]/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[\^([^\]]+)\]/g, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/_(.*?)_/g, "$1")
        .replace(/~~(.*?)~~/g, "$1")
        .replace(/==(.*?)==/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

function splitFrontmatter(content: string): { body: string; offset: number } {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/);
    if (!match) {
        return { body: content, offset: 0 };
    }

    return {
        body: content.slice(match[0].length),
        offset: match[0].length,
    };
}

function detectFence(trimmed: string): "```" | "~~~" | null {
    if (trimmed.startsWith("```")) return "```";
    if (trimmed.startsWith("~~~")) return "~~~";
    return null;
}

function extractHeadings(content: string): OutlineHeading[] {
    const { body, offset: frontmatterOffset } = splitFrontmatter(content);
    const lines = body.split("\n");
    const headings: OutlineHeading[] = [];
    let offset = frontmatterOffset;
    let fenceMarker: "```" | "~~~" | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const trimmed = line.trim();
        const detectedFence = detectFence(trimmed);

        if (detectedFence) {
            if (fenceMarker === null) {
                fenceMarker = detectedFence;
            } else if (fenceMarker === detectedFence) {
                fenceMarker = null;
            }
            offset += rawLine.length + 1;
            continue;
        }

        if (fenceMarker === null) {
            const atx = ATX_RE.exec(line);
            if (atx) {
                const level = atx[1].length;
                const title = cleanHeadingTitle(atx[2]);
                if (title) {
                    headings.push({
                        id: `${offset}:${level}:${index}`,
                        title,
                        level,
                        anchor: offset,
                        head: offset + rawLine.length,
                    });
                }
            } else if (trimmed) {
                const nextLine = lines[index + 1] ?? "";
                const nextTrimmed = nextLine.endsWith("\r")
                    ? nextLine.slice(0, -1).trim()
                    : nextLine.trim();
                const level = SETEXT_H1_RE.test(nextTrimmed)
                    ? 1
                    : SETEXT_H2_RE.test(nextTrimmed)
                      ? 2
                      : null;
                if (level !== null) {
                    const title = cleanHeadingTitle(trimmed);
                    if (title) {
                        headings.push({
                            id: `${offset}:${level}:${index}`,
                            title,
                            level,
                            anchor: offset,
                            head: offset + rawLine.length,
                        });
                    }
                }
            }
        }

        offset += rawLine.length + 1;
    }

    return headings;
}

function buildOutlineTree(headings: OutlineHeading[]): OutlineNode[] {
    const root: OutlineNode = {
        id: "root",
        title: "",
        level: 0,
        anchor: 0,
        head: 0,
        children: [],
    };
    const stack: OutlineNode[] = [root];

    for (const heading of headings) {
        const node: OutlineNode = { ...heading, children: [] };
        while (
            stack.length > 1 &&
            stack[stack.length - 1].level >= heading.level
        ) {
            stack.pop();
        }
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    }

    return root.children;
}

function Chevron({ open }: { open: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            style={{
                flexShrink: 0,
                transform: open ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms ease",
                opacity: 0.5,
            }}
        >
            <path
                d="M6 4l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function CollapsibleChildren({
    open,
    children,
}: {
    open: boolean;
    children: React.ReactNode;
}) {
    return (
        <div
            style={{
                display: "grid",
                gridTemplateRows: open ? "1fr" : "0fr",
                transition: "grid-template-rows 150ms ease",
            }}
        >
            <div style={{ overflow: "hidden" }}>{children}</div>
        </div>
    );
}

function OutlineIndentGuides({ depth }: { depth: number }) {
    if (depth <= 0) {
        return null;
    }

    return (
        <span
            aria-hidden="true"
            data-outline-indent-guides="true"
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
            }}
        >
            {Array.from({ length: depth }, (_, level) => {
                const guideX = Math.round(
                    level * OUTLINE_INDENT_STEP + OUTLINE_INDENT_STEP / 2,
                );

                return (
                    <span
                        key={level}
                        data-outline-guide-line="true"
                        style={{
                            position: "absolute",
                            left: guideX,
                            top: 0,
                            bottom: 0,
                            width: 1,
                            backgroundColor: OUTLINE_GUIDE_COLOR,
                        }}
                    />
                );
            })}
        </span>
    );
}

function OutlineTree({
    nodes,
    depth,
    collapsed,
    onToggle,
    onSelect,
    onContextMenu,
}: {
    nodes: OutlineNode[];
    depth: number;
    collapsed: Set<string>;
    onToggle: (id: string) => void;
    onSelect: (selection: OutlineSelection) => void;
    onContextMenu: (event: React.MouseEvent, node: OutlineNode) => void;
}) {
    return (
        <>
            {nodes.map((node) => {
                const hasChildren = node.children.length > 0;
                const isOpen = !collapsed.has(node.id);

                return (
                    <div key={node.id}>
                        <div
                            className="flex items-center group"
                            data-outline-row="true"
                            style={{
                                position: "relative",
                                paddingLeft: depth * OUTLINE_INDENT_STEP,
                            }}
                        >
                            <OutlineIndentGuides depth={depth} />
                            {hasChildren ? (
                                <button
                                    onClick={() => onToggle(node.id)}
                                    className="shrink-0 flex items-center justify-center rounded-sm"
                                    style={{
                                        width: 20,
                                        height: 20,
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    <Chevron open={isOpen} />
                                </button>
                            ) : (
                                <span style={{ width: 20, flexShrink: 0 }} />
                            )}
                            <button
                                onClick={() =>
                                    onSelect({
                                        anchor: node.anchor,
                                        head: node.head,
                                    })
                                }
                                onContextMenu={(event) =>
                                    onContextMenu(event, node)
                                }
                                className="flex-1 min-w-0 text-left rounded-sm transition-colors duration-75"
                                style={{
                                    padding: "3px 8px",
                                    color: "var(--text-primary)",
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    fontWeight: depth === 0 ? 500 : 400,
                                    opacity: depth === 0 ? 1 : 0.85,
                                }}
                                onMouseEnter={(e) =>
                                    (e.currentTarget.style.backgroundColor =
                                        "var(--bg-tertiary)")
                                }
                                onMouseLeave={(e) =>
                                    (e.currentTarget.style.backgroundColor =
                                        "transparent")
                                }
                            >
                                <span
                                    style={{
                                        display: "-webkit-box",
                                        WebkitBoxOrient: "vertical",
                                        WebkitLineClamp: 2,
                                        overflow: "hidden",
                                    }}
                                >
                                    {node.title}
                                </span>
                            </button>
                        </div>
                        {hasChildren && (
                            <CollapsibleChildren open={isOpen}>
                                <OutlineTree
                                    nodes={node.children}
                                    depth={depth + 1}
                                    collapsed={collapsed}
                                    onToggle={onToggle}
                                    onSelect={onSelect}
                                    onContextMenu={onContextMenu}
                                />
                            </CollapsibleChildren>
                        )}
                    </div>
                );
            })}
        </>
    );
}

export function OutlinePanel({
    content,
    onSelectHeading,
}: {
    content: string | null;
    onSelectHeading: (selection: OutlineSelection) => void;
}) {
    const deferredContent = useDeferredValue(content);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<OutlineNode> | null>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const headings = useMemo(
        () => (deferredContent ? extractHeadings(deferredContent) : []),
        [deferredContent],
    );

    const tree = useMemo(() => buildOutlineTree(headings), [headings]);

    const handleToggle = useCallback((id: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-1 pb-3">
                {tree.length === 0 ? (
                    <div
                        className="px-3 py-2 text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        No headings found
                    </div>
                ) : (
                    <OutlineTree
                        nodes={tree}
                        depth={0}
                        collapsed={collapsed}
                        onToggle={handleToggle}
                        onSelect={onSelectHeading}
                        onContextMenu={(event, node) => {
                            event.preventDefault();
                            setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                payload: node,
                            });
                        }}
                    />
                )}
            </div>
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Jump to Heading",
                            action: () =>
                                onSelectHeading({
                                    anchor: contextMenu.payload.anchor,
                                    head: contextMenu.payload.head,
                                }),
                        },
                        {
                            label: "Copy Heading Text",
                            action: () =>
                                void navigator.clipboard.writeText(
                                    contextMenu.payload.title,
                                ),
                        },
                    ]}
                />
            )}
        </div>
    );
}
