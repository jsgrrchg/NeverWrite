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
    canOpenVaultFileEntryInApp,
    isImageLikeVaultPath,
    isTextLikeVaultPath,
} from "../../../app/utils/vaultEntries";
import { useVaultStore } from "../../../app/store/vaultStore";
import { resolveVaultAbsolutePath } from "../../../app/utils/vaultPaths";
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
import {
    openAiEditedFileByAbsolutePath,
    openChatPdfByReference,
} from "../chatFileNavigation";
import { DiffLineView } from "./editedFilesPresentation";
import {
    getChatCodeBlockFontSize,
    getChatCodeLabelFontSize,
} from "./chatCodeSizing";
import { extractFenceLanguageToken } from "../../editor/codeLanguage";
import { HighlightedCodeText } from "../../editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "../../editor/useCodeLanguageSupport";

interface MarkdownContentProps {
    content: string;
    className?: string;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
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

function isExternalReference(value: string) {
    const trimmed = value.trim();
    return trimmed.length === 0
        ? true
        : trimmed.startsWith("#") ||
              /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
              trimmed.startsWith("//");
}

function resolveVaultLocalPath(
    value: string,
    options?: { allowRelative?: boolean },
) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isExternalReference(trimmed)) return null;
    if (!options?.allowRelative && !trimmed.startsWith("/")) return null;
    return resolveVaultAbsolutePath(
        trimmed,
        useVaultStore.getState().vaultPath,
    );
}

function resolveVaultNoteReference(
    value: string,
    options?: { allowRelative?: boolean },
) {
    const parsed = parseVaultReference(value);
    if (!parsed) return null;
    const resolvedPath = resolveVaultLocalPath(parsed.path, options);
    if (!resolvedPath) return null;
    return {
        ...parsed,
        path: resolvedPath,
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

function parseTextFileReference(value: string) {
    const trimmed = value.trim();
    const resolvedPath = resolveVaultLocalPath(trimmed);
    if (!resolvedPath) return null;
    if (
        parseVaultReference(resolvedPath) ||
        parseExcalidrawReference(trimmed) ||
        parsePdfReference(trimmed)
    ) {
        return null;
    }
    const entry = useVaultStore
        .getState()
        .entries.find((candidate) => candidate.path === resolvedPath);
    if (entry) {
        if (entry.kind !== "file" || !canOpenVaultFileEntryInApp(entry)) {
            return null;
        }
    } else if (
        !isTextLikeVaultPath(resolvedPath) &&
        !isImageLikeVaultPath(resolvedPath)
    ) {
        return null;
    }

    return {
        path: resolvedPath,
        fileName: resolvedPath.split("/").pop() ?? resolvedPath,
    };
}

function parseRelativeTextFileReference(value: string) {
    const trimmed = value.trim();
    const resolvedPath = resolveVaultLocalPath(trimmed, {
        allowRelative: true,
    });
    if (!resolvedPath) return null;
    if (
        parseVaultReference(resolvedPath) ||
        parseExcalidrawReference(trimmed) ||
        parsePdfReference(trimmed)
    ) {
        return null;
    }
    const entry = useVaultStore
        .getState()
        .entries.find((candidate) => candidate.path === resolvedPath);
    if (entry) {
        if (entry.kind !== "file" || !canOpenVaultFileEntryInApp(entry)) {
            return null;
        }
    } else if (
        !isTextLikeVaultPath(resolvedPath) &&
        !isImageLikeVaultPath(resolvedPath)
    ) {
        return null;
    }

    return {
        path: resolvedPath,
        fileName: resolvedPath.split("/").pop() ?? resolvedPath,
    };
}

interface Block {
    type: "code" | "text";
    content: string;
    info?: string;
}

interface MarkdownTable {
    headers: string[];
    rows: string[][];
}

const PARSED_BLOCK_CACHE_LIMIT = 250;
const parsedBlockCache = new Map<string, Block[]>();

function rememberParsedBlocks(text: string, blocks: Block[]) {
    if (parsedBlockCache.has(text)) {
        parsedBlockCache.delete(text);
    }
    parsedBlockCache.set(text, blocks);
    if (parsedBlockCache.size > PARSED_BLOCK_CACHE_LIMIT) {
        const oldestKey = parsedBlockCache.keys().next().value;
        if (oldestKey !== undefined) {
            parsedBlockCache.delete(oldestKey);
        }
    }
    return blocks;
}

function parseBlocks(text: string): Block[] {
    const cached = parsedBlockCache.get(text);
    if (cached) {
        return cached;
    }

    const blocks: Block[] = [];
    const codeBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
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
            info: match[1]?.trim() || undefined,
        });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        blocks.push({ type: "text", content: text.slice(lastIndex) });
    }

    return rememberParsedBlocks(text, blocks);
}

function parseMarkdownTableRow(line: string): string[] | null {
    if (!line.includes("|")) return null;

    let normalized = line.trim();
    if (normalized.startsWith("|")) {
        normalized = normalized.slice(1);
    }
    if (normalized.endsWith("|")) {
        normalized = normalized.slice(0, -1);
    }

    const cells = normalized.split("|").map((cell) => cell.trim());
    if (cells.length < 2) return null;
    if (cells.every((cell) => cell.length === 0)) return null;

    return cells;
}

function isMarkdownTableSeparator(line: string, expectedColumns: number) {
    const cells = parseMarkdownTableRow(line);
    if (!cells || cells.length !== expectedColumns) return false;

    return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(
    lines: string[],
    startIndex: number,
): { table: MarkdownTable; nextIndex: number } | null {
    const headers = parseMarkdownTableRow(lines[startIndex] ?? "");
    if (!headers || headers.length < 2) return null;

    const separatorLine = lines[startIndex + 1];
    if (
        !separatorLine ||
        !isMarkdownTableSeparator(separatorLine, headers.length)
    )
        return null;

    const rows: string[][] = [];
    let index = startIndex + 2;

    while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === "") break;

        const row = parseMarkdownTableRow(line);
        if (!row || row.length !== headers.length) break;
        rows.push(row);
        index += 1;
    }

    return {
        table: {
            headers,
            rows,
        },
        nextIndex: index,
    };
}

interface MarkdownPillContextMenuPayload {
    reference: string;
    kind: "note" | "excalidraw" | "pdf" | "file";
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
    onFileContextMenu?: InlineContextMenuHandler,
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // Process: wikilinks, inline code, bold, italic, links, and absolute vault file paths.
    const inlineRegex =
        /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|((?:\/)[\w\u00C0-\u024F~.()/-]+(?::\d+|#L\d+)?)/g;
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
            const parsedReference = resolveVaultNoteReference(codeText);
            const pdfRef = !parsedReference
                ? parsePdfReference(codeText)
                : null;
            const textFileRef =
                !parsedReference && !pdfRef
                    ? parseTextFileReference(codeText)
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
            } else if (textFileRef) {
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={textFileRef.fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="file"
                        onClick={() =>
                            void openAiEditedFileByAbsolutePath(
                                textFileRef.path,
                            )
                        }
                        onContextMenu={
                            onFileContextMenu
                                ? (event) =>
                                      onFileContextMenu(event, textFileRef.path)
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
                const parsedUrlReference = resolveVaultNoteReference(decoded, {
                    allowRelative: true,
                });
                const parsedLabelReference = resolveVaultNoteReference(
                    linkMatch[1],
                    {
                        allowRelative: true,
                    },
                );
                const parsedReference =
                    parsedUrlReference ?? parsedLabelReference;
                const excalidrawRef =
                    parseExcalidrawReference(decoded) ??
                    parseExcalidrawReference(linkMatch[1]);
                const pdfLinkRef =
                    parsePdfReference(decoded) ??
                    parsePdfReference(linkMatch[1]);
                const textFileRef =
                    parseRelativeTextFileReference(decoded) ??
                    parseRelativeTextFileReference(linkMatch[1]);
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
                } else if (textFileRef) {
                    parts.push(
                        <ChatInlinePill
                            key={key}
                            label={textFileRef.fileName}
                            metrics={pillMetrics}
                            interactive
                            variant="file"
                            onClick={() =>
                                void openAiEditedFileByAbsolutePath(
                                    textFileRef.path,
                                )
                            }
                            onContextMenu={
                                onFileContextMenu
                                    ? (event) =>
                                          onFileContextMenu(
                                              event,
                                              textFileRef.path,
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
            // Absolute vault file path.
            const filePath = decodeURIComponent(full);
            const excalidrawRef = parseExcalidrawReference(filePath);
            const pdfPathRef = parsePdfReference(filePath);
            const textFileRef = parseTextFileReference(filePath);
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
            } else if (textFileRef) {
                parts.push(
                    <ChatInlinePill
                        key={key}
                        label={textFileRef.fileName}
                        metrics={pillMetrics}
                        interactive
                        variant="file"
                        onClick={() =>
                            void openAiEditedFileByAbsolutePath(
                                textFileRef.path,
                            )
                        }
                        onContextMenu={
                            onFileContextMenu
                                ? (event) =>
                                      onFileContextMenu(event, textFileRef.path)
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

    const handleFileContextMenu = (
        event: MouseEvent<HTMLElement>,
        reference: string,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { reference, kind: "file" },
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
                            handleFileContextMenu,
                        )}
                    </li>
                ))}
            </Tag>,
        );
        listItems = [];
    }

    let lineIndex = 0;
    while (lineIndex < lines.length) {
        const line = lines[lineIndex];

        const table = parseMarkdownTable(lines, lineIndex);
        if (table) {
            flushList();
            elements.push(
                <div
                    key={elements.length}
                    className="my-2 max-w-full overflow-x-auto"
                >
                    <table
                        style={{
                            width: "100%",
                            tableLayout: "fixed",
                            borderCollapse: "collapse",
                            fontSize: "1em",
                        }}
                    >
                        <thead>
                            <tr>
                                {table.table.headers.map((header, index) => (
                                    <th
                                        key={index}
                                        style={{
                                            textAlign: "left",
                                            padding: "8px 10px",
                                            borderBottom:
                                                "1px solid var(--border)",
                                            color: "var(--text-primary)",
                                            background:
                                                "color-mix(in srgb, var(--bg-tertiary) 78%, transparent)",
                                            verticalAlign: "top",
                                            overflowWrap: "anywhere",
                                            wordBreak: "break-word",
                                        }}
                                    >
                                        {renderInlineMarkdown(
                                            header,
                                            pillMetrics,
                                            handleNoteContextMenu,
                                            handleMapContextMenu,
                                            handlePdfContextMenu,
                                            handleFileContextMenu,
                                        )}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {table.table.rows.map((row, rowIndex) => (
                                <tr key={rowIndex}>
                                    {row.map((cell, cellIndex) => (
                                        <td
                                            key={cellIndex}
                                            style={{
                                                padding: "8px 10px",
                                                borderBottom:
                                                    rowIndex ===
                                                    table.table.rows.length - 1
                                                        ? "none"
                                                        : "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                                                color: "var(--text-secondary)",
                                                verticalAlign: "top",
                                                overflowWrap: "anywhere",
                                                wordBreak: "break-word",
                                            }}
                                        >
                                            {renderInlineMarkdown(
                                                cell,
                                                pillMetrics,
                                                handleNoteContextMenu,
                                                handleMapContextMenu,
                                                handlePdfContextMenu,
                                                handleFileContextMenu,
                                            )}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>,
            );
            lineIndex = table.nextIndex;
            continue;
        }

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
                        handlePdfContextMenu,
                        handleFileContextMenu,
                    )}
                </div>,
            );
            lineIndex += 1;
            continue;
        }

        // Unordered list
        const ulMatch = /^[\s]*[-*+]\s+(.+)$/.exec(line);
        if (ulMatch) {
            if (listItems.length > 0 && listOrdered) flushList();
            listOrdered = false;
            listItems.push({ ordered: false, text: ulMatch[1] });
            lineIndex += 1;
            continue;
        }

        // Ordered list
        const olMatch = /^[\s]*\d+[.)]\s+(.+)$/.exec(line);
        if (olMatch) {
            if (listItems.length > 0 && !listOrdered) flushList();
            listOrdered = true;
            listItems.push({ ordered: true, text: olMatch[1] });
            lineIndex += 1;
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
            lineIndex += 1;
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
                        handlePdfContextMenu,
                        handleFileContextMenu,
                    )}
                </blockquote>,
            );
            lineIndex += 1;
            continue;
        }

        // Empty line
        if (line.trim() === "") {
            elements.push(<div key={elements.length} className="h-2" />);
            lineIndex += 1;
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
                    handlePdfContextMenu,
                    handleFileContextMenu,
                )}
            </div>,
        );
        lineIndex += 1;
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
                            : contextMenu.payload.kind === "file"
                              ? [
                                    {
                                        label: "Open",
                                        action: () => {
                                            void openAiEditedFileByAbsolutePath(
                                                contextMenu.payload.reference,
                                            );
                                        },
                                    },
                                    {
                                        label: "Open in New Tab",
                                        action: () => {
                                            void openAiEditedFileByAbsolutePath(
                                                contextMenu.payload.reference,
                                                { newTab: true },
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
                                          label: "Open",
                                          action: () => {
                                              void openChatNoteByReference(
                                                  contextMenu.payload.reference,
                                              );
                                          },
                                      },
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
    info,
    chatFontSize = 14,
}: {
    content: string;
    info?: string;
    chatFontSize?: number;
}) {
    const [copied, setCopied] = useState(false);
    const languageSupport = useMarkdownCodeLanguageSupport(info);
    const languageToken = extractFenceLanguageToken(info ?? "");
    const languageLabel =
        languageToken?.toLowerCase() === "md"
            ? "Markdown"
            : (languageToken ?? info?.trim());
    const isUnifiedDiff =
        languageToken?.toLowerCase() === "diff" ||
        languageToken?.toLowerCase() === "patch";
    const diffLines = useMemo(
        () => (isUnifiedDiff ? computeUnifiedDiffLines(content) : []),
        [content, isUnifiedDiff],
    );
    const codeFontSize = getChatCodeBlockFontSize(chatFontSize);
    const languageLabelFontSize = getChatCodeLabelFontSize(chatFontSize);

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
                    top: languageLabel ? 5 : 8,
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
            {languageLabel ? (
                <div
                    className="px-3 py-2 pr-10 uppercase tracking-wider"
                    style={{
                        fontSize: languageLabelFontSize,
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border)",
                    }}
                >
                    {languageLabel}
                </div>
            ) : null}
            {diffLines.length > 0 ? (
                <div
                    className="max-w-full overflow-auto leading-relaxed"
                    style={{
                        fontSize: codeFontSize,
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
                    className="max-w-full overflow-y-auto p-3 leading-relaxed"
                    style={{
                        fontSize: codeFontSize,
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
                        <HighlightedCodeText
                            text={content}
                            language={languageSupport}
                            segmentKeyPrefix={`chat-code:${languageToken ?? "plain"}:${content.length}`}
                        />
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
    chatFontSize = 14,
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
                        info={block.info}
                        chatFontSize={chatFontSize}
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
