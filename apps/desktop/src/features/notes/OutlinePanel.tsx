import { useMemo } from "react";

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

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;

function stripFrontmatter(content: string) {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return content;
    return content.slice(match[0].length);
}

function cleanHeadingTitle(raw: string) {
    return raw
        .trim()
        .replace(/\s+#+\s*$/g, "")
        .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
}

function parseOutlineHeadings(content: string): OutlineHeading[] {
    const body = stripFrontmatter(content);
    const headings: OutlineHeading[] = [];
    const lines = body.split(/\r?\n/);
    const lineBreakLength = body.includes("\r\n") ? 2 : 1;
    let offset = 0;
    let fencedCode: { marker: "```" | "~~~" } | null = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();

        const fenceMatch = trimmed.match(/^(```+|~~~+)/);
        if (fenceMatch) {
            const marker = fenceMatch[1].startsWith("`") ? "```" : "~~~";
            if (!fencedCode) {
                fencedCode = { marker };
            } else if (fencedCode.marker === marker) {
                fencedCode = null;
            }
            offset += line.length + lineBreakLength;
            continue;
        }

        if (!fencedCode) {
            const atxMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
            if (atxMatch) {
                headings.push({
                    id: `${offset}:${atxMatch[1].length}:${index}`,
                    title: cleanHeadingTitle(atxMatch[2]),
                    level: atxMatch[1].length,
                    anchor: offset,
                    head: offset + line.length,
                });
                offset += line.length + lineBreakLength;
                continue;
            }

            const nextLine = lines[index + 1];
            if (
                trimmed &&
                nextLine &&
                /^===+\s*$/.test(nextLine.trim())
            ) {
                headings.push({
                    id: `${offset}:1:${index}`,
                    title: cleanHeadingTitle(trimmed),
                    level: 1,
                    anchor: offset,
                    head: offset + line.length,
                });
            } else if (
                trimmed &&
                nextLine &&
                /^---+\s*$/.test(nextLine.trim())
            ) {
                headings.push({
                    id: `${offset}:2:${index}`,
                    title: cleanHeadingTitle(trimmed),
                    level: 2,
                    anchor: offset,
                    head: offset + line.length,
                });
            }
        }

        offset += line.length + lineBreakLength;
    }

    return headings.filter((heading) => heading.title.length > 0);
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
}: {
    nodes: OutlineNode[];
    depth: number;
    onSelect: (selection: OutlineSelection) => void;
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
                        />
                    )}
                </div>
            ))}
        </>
    );
}

export function OutlinePanel({
    title,
    content,
    onSelectHeading,
}: {
    title: string | null;
    content: string | null;
    onSelectHeading: (selection: OutlineSelection) => void;
}) {
    const tree = useMemo(() => {
        if (!content) return [];
        return buildOutlineTree(parseOutlineHeadings(content));
    }, [content]);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div
                className="px-3 pt-3 pb-2 text-xs font-semibold"
                style={{ color: "var(--text-secondary)", lineHeight: 1.35 }}
            >
                {title ? `Outline — ${title}` : "Outline"}
            </div>
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
                        onSelect={onSelectHeading}
                    />
                )}
            </div>
        </div>
    );
}
