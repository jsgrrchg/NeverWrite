import {
    memo,
    useMemo,
    useState,
    type MouseEvent,
    type ReactElement,
    type ReactNode,
} from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    DIFF_PANEL_MAX_HEIGHT,
    computeUnifiedDiffLines,
} from "../diff/reviewDiff";
import { ChatInlinePill } from "./ChatInlinePill";
import type { ChatPillMetrics } from "./chatPillMetrics";
import {
    openChatNoteByReference,
    openChatMapByReference,
} from "../chatNoteNavigation";
import { openChatPdfByReference } from "../chatFileNavigation";
import { DiffLineView } from "./editedFilesPresentation";

interface MarkdownContentProps {
    content: string;
    className?: string;
    pillMetrics: ChatPillMetrics;
}

function parseVaultReference(value: string) {
    const trimmed = value.trim();
    const match = /^(.*?\.md)(?::(\d+)|#L(\d+))?$/i.exec(trimmed);
    if (!match) return null;

    return {
        path: match[1],
        line: match[2] ?? match[3] ?? null,
        kind: "note" as const,
    };
}

function parseExcalidrawReference(value: string) {
    const trimmed = value.trim();
    if (!/\.excalidraw$/i.test(trimmed)) return null;
    const fileName =
        trimmed
            .split("/")
            .pop()
            ?.replace(/\.excalidraw$/i, "") ?? trimmed;
    return { path: trimmed, fileName };
}

function parsePdfReference(value: string) {
    const trimmed = value.trim();
    if (!/\.pdf$/i.test(trimmed)) return null;
    const fileName =
        trimmed
            .split("/")
            .pop()
            ?.replace(/\.pdf$/i, "") ?? trimmed;
    return { path: trimmed, fileName };
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

interface MarkdownPillContextMenuPayload {
    reference: string;
    kind: "note" | "excalidraw" | "pdf";
}

type InlineContextMenuHandler = (
    event: MouseEvent<HTMLElement>,
    reference: string,
) => void;

function renderInlineMarkdown(
    text: string,
    pillMetrics: ChatPillMetrics,
    onNoteContextMenu: InlineContextMenuHandler,
    onMapContextMenu?: InlineContextMenuHandler,
    onPdfContextMenu?: InlineContextMenuHandler,
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // Process: wikilinks, inline code, bold, italic, links, vault file paths (.md[:line], .excalidraw, .pdf)
    const inlineRegex =
        /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|((?:\/|[\w\u00C0-\u024F-])[\w\u00C0-\u024F\s/~.()/-]*\.(?:md(?::\d+|#L\d+)?|excalidraw|pdf))/g;
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
                    onClick={() => void openChatNoteByReference(target.trim())}
                    onContextMenu={(event) =>
                        onNoteContextMenu(event, target.trim())
                    }
                    title={target.trim()}
                />,
            );
        } else if (match[2]) {
            // inline code — render vault files as pills
            const codeText = full.slice(1, -1);
            const parsedReference = parseVaultReference(codeText);
            const pdfRef = !parsedReference
                ? parsePdfReference(codeText)
                : null;
            if (parsedReference) {
                const fileName =
                    parsedReference.path
                        .split("/")
                        .pop()
                        ?.replace(/\.md$/i, "") ??
                    parsedReference.path.replace(/\.md$/i, "");
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="accent"
                        onClick={() =>
                            void openChatNoteByReference(parsedReference.path)
                        }
                        onContextMenu={(event) =>
                            onNoteContextMenu(event, parsedReference.path)
                        }
                        title={codeText}
                    />,
                );
            } else if (pdfRef) {
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={pdfRef.fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="file"
                        onClick={() => void openChatPdfByReference(pdfRef.path)}
                        onContextMenu={
                            onPdfContextMenu
                                ? (event) =>
                                      onPdfContextMenu(event, pdfRef.path)
                                : undefined
                        }
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
                const decoded = decodeURIComponent(url);
                const parsedUrlReference = parseVaultReference(decoded);
                const parsedLabelReference = parseVaultReference(linkMatch[1]);
                const parsedReference =
                    parsedUrlReference && decoded.startsWith("/")
                        ? parsedUrlReference
                        : parsedLabelReference;
                const excalidrawRef =
                    parseExcalidrawReference(decoded) ??
                    parseExcalidrawReference(linkMatch[1]);
                const pdfLinkRef =
                    parsePdfReference(decoded) ??
                    parsePdfReference(linkMatch[1]);
                if (excalidrawRef) {
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={excalidrawRef.fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="file"
                            onClick={() =>
                                void openChatMapByReference(excalidrawRef.path)
                            }
                            onContextMenu={
                                onMapContextMenu
                                    ? (event) =>
                                          onMapContextMenu(
                                              event,
                                              excalidrawRef.path,
                                          )
                                    : undefined
                            }
                            title={decoded}
                        />,
                    );
                } else if (pdfLinkRef) {
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={pdfLinkRef.fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="file"
                            onClick={() =>
                                void openChatPdfByReference(pdfLinkRef.path)
                            }
                            onContextMenu={
                                onPdfContextMenu
                                    ? (event) =>
                                          onPdfContextMenu(
                                              event,
                                              pdfLinkRef.path,
                                          )
                                    : undefined
                            }
                            title={decoded}
                        />,
                    );
                } else if (parsedReference) {
                    const fileName =
                        parsedReference.path
                            .split("/")
                            .pop()
                            ?.replace(/\.md$/, "") ?? linkMatch[1];
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="accent"
                            onClick={() =>
                                void openChatNoteByReference(
                                    parsedReference.path,
                                )
                            }
                            onContextMenu={(event) =>
                                onNoteContextMenu(event, parsedReference.path)
                            }
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
            // vault file path — clickable vault link (.md, .excalidraw, .pdf)
            const filePath = decodeURIComponent(full);
            const excalidrawRef = parseExcalidrawReference(filePath);
            const pdfPathRef = parsePdfReference(filePath);
            if (excalidrawRef) {
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={excalidrawRef.fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="file"
                        onClick={() =>
                            void openChatMapByReference(excalidrawRef.path)
                        }
                        onContextMenu={
                            onMapContextMenu
                                ? (event) =>
                                      onMapContextMenu(
                                          event,
                                          excalidrawRef.path,
                                      )
                                : undefined
                        }
                        title={filePath}
                    />,
                );
            } else if (pdfPathRef) {
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={pdfPathRef.fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="file"
                        onClick={() =>
                            void openChatPdfByReference(pdfPathRef.path)
                        }
                        onContextMenu={
                            onPdfContextMenu
                                ? (event) =>
                                      onPdfContextMenu(event, pdfPathRef.path)
                                : undefined
                        }
                        title={filePath}
                    />,
                );
            } else {
                const parsedReference = parseVaultReference(filePath);
                const fileName =
                    parsedReference?.path
                        .split("/")
                        .pop()
                        ?.replace(/\.md$/, "") ?? filePath;
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="accent"
                        onClick={() =>
                            void openChatNoteByReference(
                                parsedReference?.path ?? filePath,
                            )
                        }
                        onContextMenu={(event) =>
                            onNoteContextMenu(
                                event,
                                parsedReference?.path ?? filePath,
                            )
                        }
                        title={filePath}
                    />,
                );
            }
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
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<MarkdownPillContextMenuPayload> | null>(null);
    const lines = content.split("\n");
    const elements: ReactNode[] = [];
    let listItems: { ordered: boolean; text: string }[] = [];
    let listOrdered = false;

    const handleNoteContextMenu = (
        event: MouseEvent<HTMLElement>,
        reference: string,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { reference, kind: "note" },
        });
    };

    const handleMapContextMenu = (
        event: MouseEvent<HTMLElement>,
        reference: string,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { reference, kind: "excalidraw" },
        });
    };

    const handlePdfContextMenu = (
        event: MouseEvent<HTMLElement>,
        reference: string,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { reference, kind: "pdf" },
        });
    };

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
                        {renderInlineMarkdown(
                            item.text,
                            pillMetrics,
                            handleNoteContextMenu,
                            handleMapContextMenu,
                            handlePdfContextMenu,
                        )}
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
                    {renderInlineMarkdown(
                        headerMatch[2],
                        pillMetrics,
                        handleNoteContextMenu,
                        handleMapContextMenu,
                    )}
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
                    {renderInlineMarkdown(
                        line.slice(2),
                        pillMetrics,
                        handleNoteContextMenu,
                        handleMapContextMenu,
                    )}
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
                {renderInlineMarkdown(
                    line,
                    pillMetrics,
                    handleNoteContextMenu,
                    handleMapContextMenu,
                )}
            </div>,
        );
    }

    flushList();
    return (
        <>
            {elements}
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={
                        contextMenu.payload.kind === "excalidraw"
                            ? [
                                  {
                                      label: "Open Map",
                                      action: () => {
                                          void openChatMapByReference(
                                              contextMenu.payload.reference,
                                          );
                                      },
                                  },
                              ]
                            : contextMenu.payload.kind === "pdf"
                              ? [
                                    {
                                        label: "Open PDF",
                                        action: () => {
                                            openChatPdfByReference(
                                                contextMenu.payload.reference,
                                            );
                                        },
                                    },
                                    {
                                        label: "Open in New Tab",
                                        action: () => {
                                            openChatPdfByReference(
                                                contextMenu.payload.reference,
                                                { newTab: true },
                                            );
                                        },
                                    },
                                ]
                              : [
                                    {
                                        label: "Open in New Tab",
                                        action: () => {
                                            void openChatNoteByReference(
                                                contextMenu.payload.reference,
                                                { newTab: true },
                                            );
                                        },
                                    },
                                ]
                    }
                />
            ) : null}
        </>
    );
}

function CodeBlock({
    content,
    language,
}: {
    content: string;
    language?: string;
}) {
    const [copied, setCopied] = useState(false);
    const languageLabel =
        language?.toLowerCase() === "md" ? "Markdown" : language;
    const isUnifiedDiff =
        language?.toLowerCase() === "diff" ||
        language?.toLowerCase() === "patch";
    const diffLines = useMemo(
        () => (isUnifiedDiff ? computeUnifiedDiffLines(content) : []),
        [content, isUnifiedDiff],
    );

    const handleCopy = () => {
        void navigator.clipboard.writeText(content).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        });
    };

    return (
        <div
            className="group relative my-2 min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
            }}
        >
            <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy code block"
                title={copied ? "Copied" : "Copy"}
                className="absolute right-2 z-10 flex items-center justify-center rounded-md"
                style={{
                    top: language ? 5 : 8,
                    width: 22,
                    height: 22,
                    border: "1px solid var(--border)",
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-elevated) 92%, transparent)",
                    color: copied ? "var(--accent)" : "var(--text-secondary)",
                    opacity: 0.9,
                    cursor: "pointer",
                }}
            >
                <svg
                    width="11"
                    height="11"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    {copied ? (
                        <path d="M3 7l2.2 2.2L11 3.8" />
                    ) : (
                        <>
                            <rect x="5" y="3" width="6" height="8" rx="1.2" />
                            <path d="M3.5 9.5H3A1 1 0 012 8.5v-5A1.5 1.5 0 013.5 2H8" />
                        </>
                    )}
                </svg>
            </button>
            {language ? (
                <div
                    className="px-3 py-2 pr-10 text-[0.65em] uppercase tracking-wider"
                    style={{
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                >
                    {languageLabel}
                </div>
            ) : null}
            {diffLines.length > 0 ? (
                <div
                    className="max-w-full overflow-auto text-[0.8em] leading-relaxed"
                    style={{
                        maxHeight: DIFF_PANEL_MAX_HEIGHT,
                        fontFamily: "var(--font-mono, monospace)",
                    }}
                >
                    {diffLines.map((line, index) => (
                        <DiffLineView key={index} line={line} />
                    ))}
                </div>
            ) : (
                <pre
                    className="max-w-full overflow-y-auto p-3 text-[0.8em] leading-relaxed"
                    style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                    }}
                >
                    <code
                        style={{
                            color: "var(--text-primary)",
                            whiteSpace: "inherit",
                            overflowWrap: "inherit",
                            wordBreak: "inherit",
                        }}
                    >
                        {content}
                    </code>
                </pre>
            )}
        </div>
    );
}

export const MarkdownContent = memo(function MarkdownContent({
    content,
    className,
    pillMetrics,
}: MarkdownContentProps) {
    const blocks = useMemo(() => parseBlocks(content), [content]);

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
});
