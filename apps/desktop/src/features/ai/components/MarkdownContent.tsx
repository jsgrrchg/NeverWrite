import { invoke } from "@tauri-apps/api/core";
import type { ReactElement, ReactNode } from "react";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { ChatInlinePill } from "./ChatInlinePill";
import type { ChatPillMetrics } from "./chatPillMetrics";

interface MarkdownContentProps {
    content: string;
    className?: string;
    pillMetrics: ChatPillMetrics;
}

async function openVaultFile(absolutePath: string) {
    const { notes } = useVaultStore.getState();
    const cleaned = absolutePath.trim();
    const note =
        notes.find((n) => n.path === cleaned) ??
        notes.find((n) => n.path.endsWith(cleaned)) ??
        notes.find((n) => cleaned.endsWith(n.id + ".md"));
    if (!note) return;

    const { tabs, openNote } = useEditorStore.getState();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
        openNote(note.id, note.title, existing.content);
        return;
    }

    try {
        const detail = await invoke<{ content: string }>("read_note", {
            noteId: note.id,
        });
        openNote(note.id, note.title, detail.content);
    } catch {
        // Note might have been deleted
    }
}

interface Block {
    type: "code" | "text";
    content: string;
    language?: string;
}

function parseBlocks(text: string): Block[] {
    const blocks: Block[] = [];
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            blocks.push({
                type: "text",
                content: text.slice(lastIndex, match.index),
            });
        }
        blocks.push({
            type: "code",
            content: match[2].replace(/\n$/, ""),
            language: match[1] || undefined,
        });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        blocks.push({ type: "text", content: text.slice(lastIndex) });
    }

    return blocks;
}

async function openWikilink(name: string) {
    const { notes } = useVaultStore.getState();
    const note =
        notes.find((n) => n.title === name) ??
        notes.find((n) => n.title.toLowerCase() === name.toLowerCase()) ??
        notes.find((n) => n.id.endsWith(name) || n.id.endsWith(name.replace(/ /g, "-")));
    if (!note) return;
    const { tabs, openNote } = useEditorStore.getState();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
        openNote(note.id, note.title, existing.content);
        return;
    }
    try {
        const detail = await invoke<{ content: string }>("read_note", { noteId: note.id });
        openNote(note.id, note.title, detail.content);
    } catch {
        // Note might have been deleted
    }
}

function renderInlineMarkdown(
    text: string,
    pillMetrics: ChatPillMetrics,
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // Process: wikilinks, inline code, bold, italic, links, absolute file paths (.md)
    const inlineRegex =
        /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(\/[\w][\w\s/~.()-]*\.md)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyIndex = 0;

    while ((match = inlineRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index));
        }

        const full = match[0];
        const key = keyIndex++;

        if (match[1]) {
            // wikilink [[Note Name]] or [[Note Name|Alias]]
            const inner = full.slice(2, -2);
            const [target, alias] = inner.split("|");
            const label = alias ?? target;
            parts.push(
                <ChatInlinePill
                    key={key}
                    label={label.trim()}
                    metrics={pillMetrics}
                    interactive
                    onClick={() => void openWikilink(target.trim())}
                    title={target.trim()}
                />,
            );
        } else if (match[2]) {
            // inline code — render .md files as vault pills
            const codeText = full.slice(1, -1);
            if (/\.md$/i.test(codeText)) {
                const fileName = codeText.replace(/\.md$/i, "");
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="file"
                            onClick={() => void openWikilink(fileName)}
                            title={codeText}
                        />,
                    );
            } else {
                parts.push(
                    <code
                        key={key}
                        className="rounded px-1.5 py-0.5 text-[0.85em]"
                        style={{
                            backgroundColor: "var(--bg-tertiary)",
                            color: "var(--accent)",
                        }}
                    >
                        {codeText}
                    </code>,
                );
            }
        } else if (match[3]) {
            // bold
            parts.push(
                <strong key={key} style={{ color: "var(--text-primary)" }}>
                    {full.slice(2, -2)}
                </strong>,
            );
        } else if (match[4]) {
            // italic
            parts.push(<em key={key}>{full.slice(1, -1)}</em>);
        } else if (match[5]) {
            // link
            const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(full);
            if (linkMatch) {
                const url = linkMatch[2];
                const isVaultPath = url.startsWith("/") && url.endsWith(".md");
                if (isVaultPath) {
                    const decoded = decodeURIComponent(url);
                    const fileName =
                        decoded.split("/").pop()?.replace(/\.md$/, "") ??
                        linkMatch[1];
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="file"
                            onClick={() => void openVaultFile(decoded)}
                            title={decoded}
                        />,
                    );
                } else {
                    parts.push(
                        <a
                            key={key}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                color: "var(--accent)",
                                whiteSpace: "normal",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                            }}
                            className="underline"
                        >
                            {linkMatch[1]}
                        </a>,
                    );
                }
            }
        } else if (match[6]) {
            // absolute file path — clickable vault link
            const filePath = decodeURIComponent(full);
            const fileName =
                filePath.split("/").pop()?.replace(/\.md$/, "") ?? filePath;
            parts.push(
                <ChatInlinePill
                    key={key}
                    label={fileName}
                    metrics={pillMetrics}
                    interactive
                    variant="file"
                    onClick={() => void openVaultFile(filePath)}
                    title={filePath}
                />,
            );
        }

        lastIndex = match.index + full.length;
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }

    return parts;
}

function TextBlock({
    content,
    pillMetrics,
}: {
    content: string;
    pillMetrics: ChatPillMetrics;
}) {
    const lines = content.split("\n");
    const elements: ReactNode[] = [];
    let listItems: { ordered: boolean; text: string }[] = [];
    let listOrdered = false;

    function flushList() {
        if (listItems.length === 0) return;
        const Tag = listOrdered ? "ol" : "ul";
        elements.push(
            <Tag
                key={elements.length}
                className={`my-1 space-y-0.5 pl-5 ${listOrdered ? "list-decimal" : "list-disc"}`}
                style={{
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {listItems.map((item, i) => (
                    <li
                        key={i}
                        style={{
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                        }}
                    >
                        {renderInlineMarkdown(item.text, pillMetrics)}
                    </li>
                ))}
            </Tag>,
        );
        listItems = [];
    }

    for (const line of lines) {
        // Headers
        const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line);
        if (headerMatch) {
            flushList();
            const level = headerMatch[1].length;
            const sizes = [
                "text-[1.4em] font-semibold",
                "text-[1.2em] font-semibold",
                "text-[1.05em] font-semibold",
                "text-[1.05em] font-medium",
                "text-[0.9em] font-medium",
                "text-[0.9em] font-medium",
            ];
            elements.push(
                <div
                    key={elements.length}
                    className={`${sizes[level - 1]} mt-2 first:mt-0`}
                    style={{
                        color: "var(--text-primary)",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {renderInlineMarkdown(headerMatch[2], pillMetrics)}
                </div>,
            );
            continue;
        }

        // Unordered list
        const ulMatch = /^[\s]*[-*+]\s+(.+)$/.exec(line);
        if (ulMatch) {
            if (listItems.length > 0 && listOrdered) flushList();
            listOrdered = false;
            listItems.push({ ordered: false, text: ulMatch[1] });
            continue;
        }

        // Ordered list
        const olMatch = /^[\s]*\d+[.)]\s+(.+)$/.exec(line);
        if (olMatch) {
            if (listItems.length > 0 && !listOrdered) flushList();
            listOrdered = true;
            listItems.push({ ordered: true, text: olMatch[1] });
            continue;
        }

        flushList();

        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
            elements.push(
                <hr
                    key={elements.length}
                    className="my-2"
                    style={{ borderColor: "var(--border)" }}
                />,
            );
            continue;
        }

        // Blockquote
        if (line.startsWith("> ")) {
            elements.push(
                <blockquote
                    key={elements.length}
                    className="my-1 border-l-2 pl-3 italic"
                    style={{
                        borderColor: "var(--accent)",
                        color: "var(--text-secondary)",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    {renderInlineMarkdown(line.slice(2), pillMetrics)}
                </blockquote>,
            );
            continue;
        }

        // Empty line
        if (line.trim() === "") {
            elements.push(<div key={elements.length} className="h-2" />);
            continue;
        }

        // Normal paragraph line
        elements.push(
            <div
                key={elements.length}
                style={{
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {renderInlineMarkdown(line, pillMetrics)}
            </div>,
        );
    }

    flushList();
    return <>{elements}</>;
}

function CodeBlock({
    content,
    language,
}: {
    content: string;
    language?: string;
}) {
    return (
        <div
            className="group relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
            }}
        >
            {language ? (
                <div
                    className="px-3 py-1 text-[0.6em] uppercase tracking-wider"
                    style={{
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                >
                    {language}
                </div>
            ) : null}
            <pre className="max-w-full overflow-x-auto p-3 text-[0.8em] leading-relaxed">
                <code style={{ color: "var(--text-primary)" }}>{content}</code>
            </pre>
        </div>
    );
}

export function MarkdownContent({
    content,
    className,
    pillMetrics,
}: MarkdownContentProps) {
    const blocks = parseBlocks(content);

    return (
        <div
            className={className}
            style={{
                minWidth: 0,
                maxWidth: "100%",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            {blocks.map((block, i) =>
                block.type === "code" ? (
                    <CodeBlock
                        key={i}
                        content={block.content}
                        language={block.language}
                    />
                ) : (
                    <TextBlock
                        key={i}
                        content={block.content}
                        pillMetrics={pillMetrics}
                    />
                ),
            )}
        </div>
    );
}
