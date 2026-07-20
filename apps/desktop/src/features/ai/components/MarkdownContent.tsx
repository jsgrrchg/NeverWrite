import {
    memo,
    useMemo,
    useState,
    type MouseEvent,
    type MouseEventHandler,
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
import type { ChatPillVariant } from "./chatPillPalette";
import {
    DIFF_PANEL_MAX_HEIGHT,
    computeUnifiedDiffLines,
} from "../diff/reviewDiff";
import { ChatInlinePill } from "./ChatInlinePill";
import { ChatVaultReference } from "./ChatVaultReference";
import type { ChatPillMetrics } from "./chatPillMetrics";
import {
    findChatNoteByReference,
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
import { formatCodeFenceLanguageLabel } from "../../editor/codeFencePresentation";
import { HighlightedCodeText } from "../../editor/staticCodeHighlight";
import { useMarkdownCodeLanguageSupport } from "../../editor/useCodeLanguageSupport";
import {
    parseChatVaultReferenceTarget,
    serializeChatVaultReferenceTarget,
} from "../chatVaultReferenceTarget";

interface MarkdownContentProps {
    content: string;
    className?: string;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
    blockQuoteAppearance?: "accent" | "plain";
    /**
     * Visual treatment for inline vault references. Chat surfaces pass "link"
     * for the accent-colored, icon-led appearance; other surfaces keep "pill".
     */
    fileReferenceAppearance?: FileReferenceAppearance;
}

function safeDecodeUriComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseVaultReference(value: string) {
    const target = parseChatVaultReferenceTarget(value);
    if (!/\.md$/i.test(target.path)) return null;

    return {
        ...target,
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

function resolveIndexedVaultNoteReference(
    value: string,
    options?: { allowRelative?: boolean },
) {
    const explicitReference = resolveVaultNoteReference(value, options);
    if (explicitReference) return explicitReference;

    const target = parseChatVaultReferenceTarget(value);
    if (!target.path || isExternalReference(target.path)) return null;
    if (!options?.allowRelative && !target.path.startsWith("/")) return null;

    const note = findChatNoteByReference(target.path);
    if (!note) return null;
    return {
        ...target,
        path: note.path,
        kind: "note" as const,
    };
}

function isOpenableExternalReference(value: string) {
    const trimmed = value.trim();
    return /^(?:https?:|mailto:)/i.test(trimmed) || trimmed.startsWith("//");
}

function parseExcalidrawReference(value: string) {
    const target = parseChatVaultReferenceTarget(value);
    if (!/\.excalidraw$/i.test(target.path)) return null;
    const fileName =
        target.path
            .split("/")
            .pop()
            ?.replace(/\.excalidraw$/i, "") ?? target.path;
    return { ...target, fileName };
}

function parsePdfReference(value: string) {
    const target = parseChatVaultReferenceTarget(value);
    if (!/\.pdf$/i.test(target.path)) return null;
    const fileName =
        target.path
            .split("/")
            .pop()
            ?.replace(/\.pdf$/i, "") ?? target.path;
    return { ...target, fileName };
}

function parseTextFileReference(value: string) {
    const target = parseChatVaultReferenceTarget(value);
    const resolvedPath = resolveVaultLocalPath(target.path);
    if (!resolvedPath) return null;
    if (
        parseVaultReference(resolvedPath) ||
        parseExcalidrawReference(target.path) ||
        parsePdfReference(target.path)
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
        line: target.line,
        endLine: target.endLine,
    };
}

function parseRelativeTextFileReference(value: string) {
    const target = parseChatVaultReferenceTarget(value);
    const resolvedPath = resolveVaultLocalPath(target.path, {
        allowRelative: true,
    });
    if (!resolvedPath) return null;
    if (
        parseVaultReference(resolvedPath) ||
        parseExcalidrawReference(target.path) ||
        parsePdfReference(target.path)
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
        line: target.line,
        endLine: target.endLine,
    };
}

/**
 * Resolves a vault folder reference. Unlike file references, folders are only
 * recognized when the vault index actually knows the path as a directory, so
 * extension-less prose never masquerades as a folder link.
 */
function parseVaultFolderReference(
    value: string,
    options?: { allowRelative?: boolean },
) {
    const target = parseChatVaultReferenceTarget(value);
    if (target.line) return null;
    const resolvedPath = resolveVaultLocalPath(target.path, options);
    if (!resolvedPath) return null;
    if (
        parseVaultReference(resolvedPath) ||
        parseExcalidrawReference(target.path) ||
        parsePdfReference(target.path)
    ) {
        return null;
    }
    const entry = useVaultStore
        .getState()
        .entries.find((candidate) => candidate.path === resolvedPath);
    if (!entry || entry.kind !== "folder") return null;

    return {
        path: resolvedPath,
        folderName: resolvedPath.split("/").pop() ?? resolvedPath,
    };
}

type FileReferenceAppearance = "link" | "pill";

/**
 * Single owner for inline vault references (notes, files, PDFs, drawings and
 * folders). Every parser branch funnels through here so the link appearance and
 * leading icon stay consistent; folders stay non-interactive per Comando.
 */
function renderReferencePill(params: {
    key: number;
    label: string;
    title: string;
    variant: ChatPillVariant;
    metrics: ChatPillMetrics;
    appearance: FileReferenceAppearance;
    iconPath: string;
    line?: number | null;
    endLine?: number | null;
    isFolder?: boolean;
    onClick?: () => void;
    onContextMenu?: MouseEventHandler<HTMLElement>;
}): ReactElement {
    if (params.appearance === "link") {
        return (
            <ChatVaultReference
                interactive={params.onClick != null}
                key={params.key}
                kind={
                    params.isFolder
                        ? "folder"
                        : params.variant === "accent"
                          ? "note"
                          : "file"
                }
                label={params.label}
                line={params.line}
                endLine={params.endLine}
                metrics={params.metrics}
                onClick={params.onClick}
                onContextMenu={params.onContextMenu}
                path={params.iconPath}
                title={params.title}
            />
        );
    }

    return (
        <ChatInlinePill
            interactive={params.onClick != null}
            key={params.key}
            label={params.label}
            metrics={params.metrics}
            onClick={params.onClick}
            onContextMenu={params.onContextMenu}
            title={params.title}
            variant={params.variant}
        />
    );
}

function noteReferenceLabel(reference: {
    path: string;
    line: number | null;
}) {
    const fileName = reference.path.split("/").pop() ?? reference.path;
    return reference.line ? fileName : fileName.replace(/\.md$/i, "");
}

function serializedReference(reference: {
    path: string;
    line: number | null;
    endLine: number | null;
}) {
    return serializeChatVaultReferenceTarget(reference);
}

function noteIconPath(reference: string) {
    return /\.md$/i.test(reference) ? reference : `${reference}.md`;
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

interface MarkdownListItem {
    ordered: boolean;
    text: string;
    markerNumber?: number;
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

function renderExternalLink(key: number, href: string, label = href) {
    return (
        <a
            key={key}
            href={href}
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
            {label}
        </a>
    );
}

function splitTrailingUrlPunctuation(url: string) {
    const match = /^(.+?)([.,!?;:]*)$/.exec(url);
    return {
        href: match?.[1] ?? url,
        trailing: match?.[2] ?? "",
    };
}

function renderInlineMarkdown(
    text: string,
    pillMetrics: ChatPillMetrics,
    onNoteContextMenu: InlineContextMenuHandler,
    onMapContextMenu?: InlineContextMenuHandler,
    onPdfContextMenu?: InlineContextMenuHandler,
    onFileContextMenu?: InlineContextMenuHandler,
    appearance: FileReferenceAppearance = "pill",
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    // Process: wikilinks, inline code, bold, italic, links, raw URLs, and absolute vault file paths.
    const inlineRegex =
        /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(\bhttps?:\/\/[^\s<>"']+)|((?<![\w\u00C0-\u024F])(?:\/)[\w\u00C0-\u024F~.()/-]+(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?)/g;
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
            const [rawTarget, alias] = inner.split("|");
            const target = parseChatVaultReferenceTarget(rawTarget);
            const reference = serializeChatVaultReferenceTarget(target);
            const label = alias ?? noteReferenceLabel(target);
            parts.push(
                renderReferencePill({
                    key,
                    label: label.trim(),
                    title: reference,
                    variant: "accent",
                    metrics: pillMetrics,
                    appearance,
                    iconPath: noteIconPath(target.path),
                    line: target.line,
                    endLine: target.endLine,
                    onClick: () =>
                        void openChatNoteByReference(reference),
                    onContextMenu: (event) =>
                        onNoteContextMenu(event, reference),
                }),
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
            const folderRef =
                !parsedReference && !pdfRef && !textFileRef
                    ? parseVaultFolderReference(codeText)
                    : null;
            if (parsedReference) {
                const reference = serializedReference(parsedReference);
                parts.push(
                    renderReferencePill({
                        key,
                        label: noteReferenceLabel(parsedReference),
                        title: codeText,
                        variant: "accent",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: parsedReference.path,
                        line: parsedReference.line,
                        endLine: parsedReference.endLine,
                        onClick: () =>
                            void openChatNoteByReference(reference),
                        onContextMenu: (event) =>
                            onNoteContextMenu(event, reference),
                    }),
                );
            } else if (pdfRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: pdfRef.fileName,
                        title: codeText,
                        variant: "file",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: pdfRef.path,
                        onClick: () => void openChatPdfByReference(pdfRef.path),
                        onContextMenu: onPdfContextMenu
                            ? (event) => onPdfContextMenu(event, pdfRef.path)
                            : undefined,
                    }),
                );
            } else if (textFileRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: textFileRef.fileName,
                        title: codeText,
                        variant: "file",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: textFileRef.path,
                        line: textFileRef.line,
                        endLine: textFileRef.endLine,
                        onClick: () =>
                            void openAiEditedFileByAbsolutePath(
                                serializedReference(textFileRef),
                            ),
                        onContextMenu: onFileContextMenu
                            ? (event) =>
                                  onFileContextMenu(
                                      event,
                                      serializedReference(textFileRef),
                                  )
                            : undefined,
                    }),
                );
            } else if (folderRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: folderRef.folderName,
                        title: codeText,
                        variant: "folder",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: folderRef.path,
                        isFolder: true,
                    }),
                );
            } else {
                parts.push(
                    <code key={key} className="chat-inline-code">
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
                // Assistant output may include literal "%" characters in links.
                // Keep rendering resilient when the URL is not valid URI-encoded text.
                const decoded = safeDecodeUriComponent(url);
                const isExternalTarget = isExternalReference(decoded);
                const parsedUrlReference = !isExternalTarget
                    ? resolveIndexedVaultNoteReference(decoded, {
                          allowRelative: true,
                      })
                    : null;
                const parsedLabelReference = !isExternalTarget
                    ? resolveIndexedVaultNoteReference(linkMatch[1], {
                          allowRelative: true,
                      })
                    : null;
                const parsedReference =
                    parsedUrlReference ?? parsedLabelReference;
                const excalidrawRef = !isExternalTarget
                    ? (parseExcalidrawReference(decoded) ??
                      parseExcalidrawReference(linkMatch[1]))
                    : null;
                const pdfLinkRef = !isExternalTarget
                    ? (parsePdfReference(decoded) ??
                      parsePdfReference(linkMatch[1]))
                    : null;
                const textFileRef = !isExternalTarget
                    ? (parseRelativeTextFileReference(decoded) ??
                      parseRelativeTextFileReference(linkMatch[1]))
                    : null;
                const folderRef =
                    !isExternalTarget &&
                    !excalidrawRef &&
                    !pdfLinkRef &&
                    !textFileRef
                        ? (parseVaultFolderReference(decoded, {
                              allowRelative: true,
                          }) ??
                          parseVaultFolderReference(linkMatch[1], {
                              allowRelative: true,
                          }))
                        : null;
                if (excalidrawRef) {
                    parts.push(
                        renderReferencePill({
                            key,
                            label: excalidrawRef.fileName,
                            title: decoded,
                            variant: "file",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: excalidrawRef.path,
                            onClick: () =>
                                void openChatMapByReference(excalidrawRef.path),
                            onContextMenu: onMapContextMenu
                                ? (event) =>
                                      onMapContextMenu(event, excalidrawRef.path)
                                : undefined,
                        }),
                    );
                } else if (pdfLinkRef) {
                    parts.push(
                        renderReferencePill({
                            key,
                            label: pdfLinkRef.fileName,
                            title: decoded,
                            variant: "file",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: pdfLinkRef.path,
                            onClick: () =>
                                void openChatPdfByReference(pdfLinkRef.path),
                            onContextMenu: onPdfContextMenu
                                ? (event) =>
                                      onPdfContextMenu(event, pdfLinkRef.path)
                                : undefined,
                        }),
                    );
                } else if (textFileRef) {
                    parts.push(
                        renderReferencePill({
                            key,
                            label: textFileRef.fileName,
                            title: decoded,
                            variant: "file",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: textFileRef.path,
                            line: textFileRef.line,
                            endLine: textFileRef.endLine,
                            onClick: () =>
                                void openAiEditedFileByAbsolutePath(
                                    serializedReference(textFileRef),
                                ),
                            onContextMenu: onFileContextMenu
                                ? (event) =>
                                      onFileContextMenu(
                                          event,
                                          serializedReference(textFileRef),
                                      )
                                : undefined,
                        }),
                    );
                } else if (folderRef) {
                    parts.push(
                        renderReferencePill({
                            key,
                            label: folderRef.folderName,
                            title: decoded,
                            variant: "folder",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: folderRef.path,
                            isFolder: true,
                        }),
                    );
                } else if (parsedReference) {
                    const reference = serializedReference(parsedReference);
                    parts.push(
                        renderReferencePill({
                            key,
                            label: linkMatch[1].trim(),
                            title: decoded,
                            variant: "accent",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: parsedReference.path,
                            line: parsedReference.line,
                            endLine: parsedReference.endLine,
                            onClick: () =>
                                void openChatNoteByReference(reference),
                            onContextMenu: (event) =>
                                onNoteContextMenu(event, reference),
                        }),
                    );
                } else {
                    parts.push(
                        isOpenableExternalReference(url)
                            ? renderExternalLink(key, url, linkMatch[1])
                            : linkMatch[1],
                    );
                }
            }
        } else if (match[6]) {
            const { href, trailing } = splitTrailingUrlPunctuation(full);
            parts.push(renderExternalLink(key, href));
            if (trailing) {
                parts.push(trailing);
            }
        } else if (match[7]) {
            // Absolute vault file path.
            const filePath = safeDecodeUriComponent(full);
            const excalidrawRef = parseExcalidrawReference(filePath);
            const pdfPathRef = parsePdfReference(filePath);
            const textFileRef = parseTextFileReference(filePath);
            const folderRef =
                !excalidrawRef && !pdfPathRef && !textFileRef
                    ? parseVaultFolderReference(filePath)
                    : null;
            if (excalidrawRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: excalidrawRef.fileName,
                        title: filePath,
                        variant: "file",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: excalidrawRef.path,
                        onClick: () =>
                            void openChatMapByReference(excalidrawRef.path),
                        onContextMenu: onMapContextMenu
                            ? (event) =>
                                  onMapContextMenu(event, excalidrawRef.path)
                            : undefined,
                    }),
                );
            } else if (pdfPathRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: pdfPathRef.fileName,
                        title: filePath,
                        variant: "file",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: pdfPathRef.path,
                        onClick: () =>
                            void openChatPdfByReference(pdfPathRef.path),
                        onContextMenu: onPdfContextMenu
                            ? (event) => onPdfContextMenu(event, pdfPathRef.path)
                            : undefined,
                    }),
                );
            } else if (textFileRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: textFileRef.fileName,
                        title: filePath,
                        variant: "file",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: textFileRef.path,
                        line: textFileRef.line,
                        endLine: textFileRef.endLine,
                        onClick: () =>
                            void openAiEditedFileByAbsolutePath(
                                serializedReference(textFileRef),
                            ),
                        onContextMenu: onFileContextMenu
                            ? (event) =>
                                  onFileContextMenu(
                                      event,
                                      serializedReference(textFileRef),
                                  )
                            : undefined,
                    }),
                );
            } else if (folderRef) {
                parts.push(
                    renderReferencePill({
                        key,
                        label: folderRef.folderName,
                        title: filePath,
                        variant: "folder",
                        metrics: pillMetrics,
                        appearance,
                        iconPath: folderRef.path,
                        isFolder: true,
                    }),
                );
            } else {
                const parsedReference = parseVaultReference(filePath);
                if (parsedReference) {
                    const reference = serializedReference(parsedReference);
                    parts.push(
                        renderReferencePill({
                            key,
                            label: noteReferenceLabel(parsedReference),
                            title: filePath,
                            variant: "accent",
                            metrics: pillMetrics,
                            appearance,
                            iconPath: parsedReference.path,
                            line: parsedReference.line,
                            endLine: parsedReference.endLine,
                            onClick: () =>
                                void openChatNoteByReference(reference),
                            onContextMenu: (event) =>
                                onNoteContextMenu(event, reference),
                        }),
                    );
                } else {
                    parts.push(full);
                }
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
    fileReferenceAppearance = "pill",
    blockQuoteAppearance = "accent",
}: {
    content: string;
    pillMetrics: ChatPillMetrics;
    fileReferenceAppearance?: FileReferenceAppearance;
    blockQuoteAppearance?: "accent" | "plain";
}) {
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<MarkdownPillContextMenuPayload> | null>(null);
    const lines = content.split("\n");
    const elements: ReactNode[] = [];
    let listItems: MarkdownListItem[] = [];
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
        const firstMarkerNumber = listOrdered
            ? listItems[0]?.markerNumber
            : undefined;
        elements.push(
            <Tag
                key={elements.length}
                className={`my-1 space-y-0.5 pl-5 ${listOrdered ? "list-decimal" : "list-disc"}`}
                start={firstMarkerNumber}
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
                            fileReferenceAppearance,
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
                                            fileReferenceAppearance,
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
                                                fileReferenceAppearance,
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
            // Per-level type scale: size, weight, color token, letter-spacing,
            // line-height, vertical rhythm, and structural treatment.
            const headingStyles: Array<{
                className: string;
                color: string;
                letterSpacing: string;
                lineHeight: number;
                balance: boolean;
            }> = [
                {
                    className:
                        "text-[1.5em] font-semibold mt-6 mb-3 first:mt-0",
                    color: "var(--text-heading)",
                    letterSpacing: "-0.015em",
                    lineHeight: 1.2,
                    balance: true,
                },
                {
                    className:
                        "text-[1.25em] font-semibold mt-5 mb-2.5 first:mt-0",
                    color: "var(--text-heading)",
                    letterSpacing: "-0.01em",
                    lineHeight: 1.25,
                    balance: true,
                },
                {
                    className:
                        "text-[1.1em] font-semibold mt-4 mb-2 first:mt-0",
                    color: "var(--text-heading)",
                    letterSpacing: "-0.005em",
                    lineHeight: 1.3,
                    balance: false,
                },
                {
                    className:
                        "text-[1em] font-semibold mt-3 mb-1.5 first:mt-0",
                    color: "var(--text-heading)",
                    letterSpacing: "0",
                    lineHeight: 1.35,
                    balance: false,
                },
                {
                    className:
                        "text-[0.9em] font-semibold mt-3 mb-1 first:mt-0",
                    color: "var(--text-heading-muted)",
                    letterSpacing: "0.01em",
                    lineHeight: 1.4,
                    balance: false,
                },
                {
                    className:
                        "text-[0.8em] font-semibold uppercase mt-2 mb-1 first:mt-0",
                    color: "var(--text-heading-muted)",
                    letterSpacing: "0.05em",
                    lineHeight: 1.4,
                    balance: false,
                },
            ];
            const h = headingStyles[level - 1];
            elements.push(
                <div
                    key={elements.length}
                    className={`nw-md-heading ${h.className}`}
                    style={{
                        color: h.color,
                        letterSpacing: h.letterSpacing,
                        lineHeight: h.lineHeight,
                        textWrap: h.balance ? "balance" : undefined,
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
                        fileReferenceAppearance,
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
        const olMatch = /^[\s]*(\d+)[.)]\s+(.+)$/.exec(line);
        if (olMatch) {
            if (listItems.length > 0 && !listOrdered) flushList();
            listOrdered = true;
            listItems.push({
                ordered: true,
                markerNumber: Number.parseInt(olMatch[1], 10),
                text: olMatch[2],
            });
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
                    className={
                        blockQuoteAppearance === "accent"
                            ? "my-1 border-l-2 pl-3 italic"
                            : "my-1 italic"
                    }
                    style={{
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
                        fileReferenceAppearance,
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
                    fileReferenceAppearance,
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
    pillMetrics,
    chatFontSize = 14,
    fileReferenceAppearance = "pill",
}: {
    content: string;
    info?: string;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
    fileReferenceAppearance?: FileReferenceAppearance;
}) {
    const [copied, setCopied] = useState(false);
    const [showMarkdownSource, setShowMarkdownSource] = useState(false);
    const languageSupport = useMarkdownCodeLanguageSupport(info);
    const languageToken = extractFenceLanguageToken(info ?? "");
    const normalizedLanguage = languageToken?.toLowerCase();
    const languageLabel = formatCodeFenceLanguageLabel(info);
    const isMarkdownFence =
        normalizedLanguage === "markdown" || normalizedLanguage === "md";
    const isUnifiedDiff =
        normalizedLanguage === "diff" || normalizedLanguage === "patch";
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
            className={`chat-code-frame group relative my-1 min-w-0 max-w-full overflow-hidden${languageLabel ? "" : " chat-code-frame--unlabeled"}`}
        >
            <div className="chat-code-actions absolute z-10 flex items-center">
                {isMarkdownFence ? (
                    <button
                        type="button"
                        aria-label="Toggle markdown display mode"
                        title={showMarkdownSource ? "Show preview" : "Show source"}
                        onClick={() =>
                            setShowMarkdownSource((value) => !value)
                        }
                        className="chat-code-mode-button"
                        style={{ fontSize: languageLabelFontSize }}
                    >
                        {showMarkdownSource ? "Preview" : "Source"}
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={handleCopy}
                    aria-label="Copy code block"
                    title={copied ? "Copied" : "Copy"}
                    className="chat-code-copy-button flex items-center justify-center"
                    style={{
                        color: copied
                            ? "var(--accent)"
                            : "var(--text-secondary)",
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
            </div>
            {languageLabel ? (
                <div
                    className="chat-code-header"
                    style={{
                        fontSize: languageLabelFontSize,
                    }}
                >
                    <span>{languageLabel}</span>
                </div>
            ) : null}
            {isMarkdownFence && !showMarkdownSource ? (
                <div
                    className="chat-markdown-preview"
                    data-testid="chat-markdown-preview"
                    style={{ fontSize: chatFontSize }}
                >
                    <TextBlock
                        content={content}
                        pillMetrics={pillMetrics}
                        fileReferenceAppearance={fileReferenceAppearance}
                    />
                </div>
            ) : diffLines.length > 0 ? (
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
                    className="chat-code-block max-w-full overflow-y-auto leading-relaxed"
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
    blockQuoteAppearance = "accent",
    fileReferenceAppearance = "pill",
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
                        pillMetrics={pillMetrics}
                        chatFontSize={chatFontSize}
                        fileReferenceAppearance={fileReferenceAppearance}
                    />
                ) : (
                    <TextBlock
                        key={i}
                        content={block.content}
                        pillMetrics={pillMetrics}
                        blockQuoteAppearance={blockQuoteAppearance}
                        fileReferenceAppearance={fileReferenceAppearance}
                    />
                ),
            )}
        </div>
    );
});
