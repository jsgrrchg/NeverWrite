import { useDeferredValue, useMemo, useState } from "react";
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

function OutlineTree({
    nodes,
    depth,
    onSelect,
    onContextMenu,
}: {
    nodes: OutlineNode[];
    depth: number;
    onSelect: (selection: OutlineSelection) => void;
    onContextMenu: (event: React.MouseEvent, node: OutlineNode) => void;
}) {
    return (
        <>
            {nodes.map((node) => (
                <div key={node.id}>
                    <button
                        onClick={() =>
                            onSelect({
                                anchor: node.anchor,
                                head: node.head,
                            })
                        }
                        onContextMenu={(event) => onContextMenu(event, node)}
                        className="w-full text-left rounded-sm"
                        style={{
                            display: "block",
                            padding: "4px 10px 4px 12px",
                            marginLeft: depth * 14,
                            color: "var(--text-primary)",
                            borderLeft:
                                depth > 0
                                    ? "1px solid color-mix(in srgb, var(--border) 85%, transparent)"
                                    : "none",
                            fontSize: 12,
                            lineHeight: 1.45,
                            opacity: depth === 0 ? 1 : 0.88,
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
                                WebkitLineClamp: 3,
                                overflow: "hidden",
                            }}
                        >
                            {node.title}
                        </span>
                    </button>
                    {node.children.length > 0 && (
                        <OutlineTree
                            nodes={node.children}
                            depth={depth + 1}
                            onSelect={onSelect}
                            onContextMenu={onContextMenu}
                        />
                    )}
                </div>
            ))}
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
    const headings = useMemo(
        () => (deferredContent ? extractHeadings(deferredContent) : []),
        [deferredContent],
    );

    const tree = useMemo(() => buildOutlineTree(headings), [headings]);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-secondary)" }}
            >
                Outline
            </div>
            <div className="flex-1 overflow-y-auto pl-1 pr-2.5 pb-3">
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
