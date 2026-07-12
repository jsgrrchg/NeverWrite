import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@neverwrite/runtime";
import {
    useSettingsStore,
    type EditorFontFamily,
} from "../../../app/store/settingsStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../dragEvents";
import {
    appendFileAttachmentPart,
    appendFolderMentionPart,
    appendMentionParts,
    normalizeComposerParts,
    serializeComposerParts,
} from "../composerParts";
import {
    AIChatCommandPicker,
    type AIChatSlashCommand,
} from "./AIChatCommandPicker";
import { AIChatMentionPicker } from "./AIChatMentionPicker";
import { presentComposerVaultReference } from "./chatVaultReferenceDom";
import {
    getChatVaultReferenceBasename,
    serializeChatVaultReferenceTarget,
} from "../chatVaultReferenceTarget";
import { getComposerPillLayoutStyle } from "./chatPillLayout";
import { CHAT_PILL_VARIANTS } from "./chatPillPalette";
import { getChatPillMetrics, type ChatPillMetrics } from "./chatPillMetrics";
import type {
    AIAvailableCommand,
    AIChatFileSummary,
    AIChatNoteSummary,
    AIChatSessionStatus,
    AIComposerPart,
    AIMentionSuggestion,
} from "../types";
import type {
    MouseEvent as ReactMouseEvent,
    ReactNode,
} from "react";
import { openChatNoteById } from "../chatNoteNavigation";
import { openAiEditedFileByAbsolutePath } from "../chatFileNavigation";
import { getEditorFontFamily } from "../../editor/editorExtensions";
import {
    useVaultStore,
    type VaultEntryDto,
} from "../../../app/store/vaultStore";
import { AI_MESSAGE_LABEL } from "../../../app/utils/branding";
import {
    shouldIncludeFileSummaryInFileScope,
    shouldIncludeMarkdownNotesInFileScope,
    shouldIncludeVaultEntryInFileScope,
    isTextLikeVaultEntry,
} from "../../../app/utils/vaultEntries";
import { AI_CHAT_CONTENT_COLUMN_STYLE } from "./chatContentLayout";
import {
    type ImageAttachmentValidationFailure,
    validateNewImageAttachmentReference,
} from "../imageAttachments";

const MIN_COMPOSER_HEIGHT = 64;
const MAX_COMPOSER_HEIGHT = 480;

interface AIChatComposerProps {
    sessionId?: string;
    parts: AIComposerPart[];
    notes: AIChatNoteSummary[];
    files?: AIChatFileSummary[];
    status: AIChatSessionStatus;
    runtimeName: string;
    runtimeId?: string;
    disabled?: boolean;
    requireCmdEnterToSend?: boolean;
    composerFontSize?: number;
    composerFontFamily?: EditorFontFamily;
    availableCommands?: AIAvailableCommand[];
    isStopping?: boolean;
    hasPendingSubmitAfterStop?: boolean;
    expanded?: boolean;
    contextBar?: ReactNode;
    footer?: ReactNode;
    placeholderText?: string;
    // Accent overlay rendered along the inner bottom edge of the composer
    // shell (e.g. the context-usage progress strip). Absolutely positioned,
    // should not capture pointer events.
    bottomAccent?: ReactNode;
    onChange: (parts: AIComposerPart[]) => void;
    onMentionAttach: (note: AIChatNoteSummary) => void;
    onFileMentionAttach?: (file: AIChatFileSummary) => void;
    onFolderAttach: (folderPath: string, name: string) => void;
    onToggleExpanded?: () => void;
    onAttachFile?: () => void;
    onPasteImage?: (file: File) => void;
    onImageAttachmentValidationFailure?: (
        reason: ImageAttachmentValidationFailure,
    ) => void;
    onFocus?: () => void;
    onSubmit: () => void;
    onStop: () => void;
}

interface MentionState {
    open: boolean;
    query: string;
    selectedIndex: number;
    items: AIMentionSuggestion[];
    x: number;
    y: number;
    range: Range | null;
}

interface ComposerContextMenuPayload {
    hasSelection: boolean;
    hasContent: boolean;
    mentionNoteId: string | null;
    mentionFilePath: string | null;
}

interface SlashState {
    open: boolean;
    query: string;
    selectedIndex: number;
    items: AIChatSlashCommand[];
    x: number;
    y: number;
    range: Range | null;
}

const EMPTY_MENTION_STATE: MentionState = {
    open: false,
    query: "",
    selectedIndex: 0,
    items: [],
    x: 0,
    y: 0,
    range: null,
};

const EMPTY_SLASH_STATE: SlashState = {
    open: false,
    query: "",
    selectedIndex: 0,
    items: [],
    x: 0,
    y: 0,
    range: null,
};

// Mirrors the bundled Codex ACP builtins so slash commands are available while
// the runtime's AvailableCommandsUpdate notification is still in flight.
const CODEX_BUILTIN_SLASH_COMMANDS: AIChatSlashCommand[] = [
    {
        id: "review",
        label: "/review",
        description: "Review my current changes and find issues",
        insertText: "/review ",
    },
    {
        id: "review-branch",
        label: "/review-branch",
        description: "Review the code changes against a specific branch",
        insertText: "/review-branch ",
    },
    {
        id: "review-commit",
        label: "/review-commit",
        description: "Review the code changes introduced by a commit",
        insertText: "/review-commit ",
    },
    {
        id: "init",
        label: "/init",
        description: "create an AGENTS.md file with instructions for Codex",
        insertText: "/init",
    },
    {
        id: "compact",
        label: "/compact",
        description: "summarize conversation to prevent hitting the context limit",
        insertText: "/compact",
    },
    {
        id: "logout",
        label: "/logout",
        description: "logout of Codex",
        insertText: "/logout",
    },
];

function getPendingRuntimeSlashCommands(runtimeId?: string) {
    if (runtimeId === "codex-acp") {
        return CODEX_BUILTIN_SLASH_COMMANDS;
    }

    return [];
}

function applyComposerPillStyles(
    element: HTMLSpanElement,
    metrics: ChatPillMetrics,
    palette: { background: string; color: string },
    options: { compact?: boolean } = {},
) {
    const layout = getComposerPillLayoutStyle(metrics, options);
    element.style.display = "inline-flex";
    element.style.alignItems = "center";
    element.style.padding = `${metrics.paddingY}px ${metrics.paddingX}px`;
    element.style.margin = `0 ${metrics.gapX}px`;
    element.style.borderRadius = `${metrics.radius}px`;
    element.style.border = "none";
    element.style.background = palette.background;
    element.style.color = palette.color;
    element.style.fontSize = `${metrics.fontSize}px`;
    element.style.lineHeight = String(metrics.lineHeight);
    element.style.verticalAlign = "baseline";
    element.style.transform = `translateY(${metrics.offsetY}px)`;
    element.style.whiteSpace = String(layout.whiteSpace);
    element.style.maxWidth = String(layout.maxWidth);
    element.style.overflow = String(layout.overflow);
    element.style.overflowWrap = String(layout.overflowWrap);
    element.style.textOverflow = String(layout.textOverflow);
    element.style.wordBreak = String(layout.wordBreak);
}

function getPillMetricsSignature(metrics: ChatPillMetrics) {
    return [
        metrics.fontSize,
        metrics.lineHeight,
        metrics.paddingX,
        metrics.paddingY,
        metrics.radius,
        metrics.gapX,
        metrics.maxWidth,
        metrics.offsetY,
    ].join(":");
}

function createMentionNode(
    part: Extract<AIComposerPart, { type: "mention" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "mention";
    element.dataset.noteId = part.noteId;
    element.dataset.label = part.label;
    element.dataset.path = part.path;
    element.contentEditable = "false";
    presentComposerVaultReference(element, {
        interactive: true,
        kind: "note",
        label: part.label,
        metrics,
        path: part.path,
    });
    return element;
}

function createFileMentionNode(
    part: Extract<AIComposerPart, { type: "file_mention" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "file_mention";
    element.dataset.label = part.label;
    element.dataset.path = part.path;
    element.dataset.relativePath = part.relativePath;
    if (part.mimeType) {
        element.dataset.mimeType = part.mimeType;
    }
    element.contentEditable = "false";
    presentComposerVaultReference(element, {
        interactive: true,
        kind: "file",
        label: part.label,
        metrics,
        mimeType: part.mimeType,
        path: part.path,
    });
    return element;
}

function createFolderMentionNode(
    part: Extract<AIComposerPart, { type: "folder_mention" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "folder_mention";
    element.dataset.folderPath = part.folderPath;
    element.dataset.label = part.label;
    element.contentEditable = "false";
    presentComposerVaultReference(element, {
        kind: "folder",
        label: part.label,
        metrics,
        path: part.folderPath,
    });
    return element;
}

function createFetchMentionNode(metrics: ChatPillMetrics) {
    const element = document.createElement("span");
    element.dataset.kind = "fetch_mention";
    element.contentEditable = "false";
    element.textContent = "@fetch";
    applyComposerPillStyles(element, metrics, CHAT_PILL_VARIANTS.success);
    return element;
}

function createPlanMentionNode(metrics: ChatPillMetrics) {
    const element = document.createElement("span");
    element.dataset.kind = "plan_mention";
    element.contentEditable = "false";
    element.textContent = "/plan";
    applyComposerPillStyles(element, metrics, CHAT_PILL_VARIANTS.neutral);
    return element;
}

function createSelectionMentionNode(
    part: Extract<AIComposerPart, { type: "selection_mention" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "selection_mention";
    if (part.noteId) {
        element.dataset.noteId = part.noteId;
    }
    element.dataset.label = part.label;
    element.dataset.path = part.path;
    element.dataset.selectedText = part.selectedText;
    element.dataset.startLine = String(part.startLine);
    element.dataset.endLine = String(part.endLine);
    element.contentEditable = "false";
    presentComposerVaultReference(element, {
        interactive: true,
        kind: part.noteId ? "note" : "file",
        label: getChatVaultReferenceBasename(part.path),
        line: part.startLine,
        endLine: part.endLine,
        metrics,
        path: part.path,
    });
    return element;
}

function createScreenshotNode(
    part: Extract<AIComposerPart, { type: "screenshot" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "screenshot";
    element.dataset.filePath = part.filePath;
    element.dataset.mimeType = part.mimeType;
    element.dataset.label = part.label;
    if (part.createdAt != null) {
        element.dataset.createdAt = String(part.createdAt);
    }
    element.contentEditable = "false";
    element.textContent = part.label;
    applyComposerPillStyles(element, metrics, CHAT_PILL_VARIANTS.file);
    return element;
}

function createFileAttachmentNode(
    part: Extract<AIComposerPart, { type: "file_attachment" }>,
    metrics: ChatPillMetrics,
) {
    const element = document.createElement("span");
    element.dataset.kind = "file_attachment";
    element.dataset.filePath = part.filePath;
    element.dataset.mimeType = part.mimeType;
    element.dataset.label = part.label;
    element.contentEditable = "false";
    element.textContent = part.label;
    applyComposerPillStyles(element, metrics, CHAT_PILL_VARIANTS.file);
    return element;
}

function appendTextPart(parts: AIComposerPart[], text: string) {
    if (!text) return;
    parts.push({
        id: crypto.randomUUID(),
        type: "text",
        text,
    });
}

function readPartsFromNode(node: Node, parts: AIComposerPart[]) {
    if (node.nodeType === Node.TEXT_NODE) {
        appendTextPart(parts, node.textContent ?? "");
        return;
    }

    if (!(node instanceof HTMLElement)) return;

    if (
        node.dataset.kind === "mention" &&
        node.dataset.noteId &&
        node.dataset.label &&
        node.dataset.path
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "mention",
            noteId: node.dataset.noteId,
            label: node.dataset.label,
            path: node.dataset.path,
        });
        return;
    }

    if (
        node.dataset.kind === "file_mention" &&
        node.dataset.label &&
        node.dataset.path &&
        node.dataset.relativePath
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "file_mention",
            label: node.dataset.label,
            path: node.dataset.path,
            relativePath: node.dataset.relativePath,
            mimeType: node.dataset.mimeType ?? null,
        });
        return;
    }

    if (
        node.dataset.kind === "folder_mention" &&
        node.dataset.folderPath &&
        node.dataset.label
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "folder_mention",
            folderPath: node.dataset.folderPath,
            label: node.dataset.label,
        });
        return;
    }

    if (node.dataset.kind === "fetch_mention") {
        parts.push({ id: crypto.randomUUID(), type: "fetch_mention" });
        return;
    }

    if (node.dataset.kind === "plan_mention") {
        parts.push({ id: crypto.randomUUID(), type: "plan_mention" });
        return;
    }

    if (
        node.dataset.kind === "selection_mention" &&
        node.dataset.label &&
        node.dataset.path &&
        node.dataset.selectedText &&
        node.dataset.startLine &&
        node.dataset.endLine
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "selection_mention",
            noteId: node.dataset.noteId ?? null,
            label: node.dataset.label,
            path: node.dataset.path,
            selectedText: node.dataset.selectedText,
            startLine: Number(node.dataset.startLine),
            endLine: Number(node.dataset.endLine),
        });
        return;
    }

    if (
        node.dataset.kind === "screenshot" &&
        node.dataset.filePath &&
        node.dataset.mimeType &&
        node.dataset.label
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "screenshot",
            filePath: node.dataset.filePath,
            mimeType: node.dataset.mimeType,
            label: node.dataset.label,
            createdAt: node.dataset.createdAt
                ? Number(node.dataset.createdAt)
                : undefined,
        });
        return;
    }

    if (
        node.dataset.kind === "file_attachment" &&
        node.dataset.filePath &&
        node.dataset.mimeType &&
        node.dataset.label
    ) {
        parts.push({
            id: crypto.randomUUID(),
            type: "file_attachment",
            filePath: node.dataset.filePath,
            mimeType: node.dataset.mimeType,
            label: node.dataset.label,
        });
        return;
    }

    if (node.tagName === "BR") {
        appendTextPart(parts, "\n");
        return;
    }

    const isBlock = /^(DIV|P|LI)$/.test(node.tagName);
    node.childNodes.forEach((child) => readPartsFromNode(child, parts));
    const lastPart = parts.at(-1);

    if (isBlock && lastPart?.type === "text" && !lastPart.text.endsWith("\n")) {
        appendTextPart(parts, "\n");
    }
}

function readPartsFromDom(root: HTMLElement): AIComposerPart[] {
    const parts: AIComposerPart[] = [];
    root.childNodes.forEach((node) => readPartsFromNode(node, parts));

    const normalized = normalizeComposerParts(parts);
    const last = normalized.at(-1);
    if (last?.type === "text") {
        last.text = last.text.replace(/\n+$/, "");
    }

    return normalizeComposerParts(normalized);
}

function assertNeverComposerPart(part: never): never {
    throw new Error(`Unsupported composer part: ${JSON.stringify(part)}`);
}

function getComposerPartsDomSignature(parts: AIComposerPart[]) {
    return JSON.stringify(
        parts.map((part) => {
            if (part.type === "text") {
                return { type: part.type, text: part.text };
            }
            if (part.type === "mention") {
                return {
                    type: part.type,
                    noteId: part.noteId,
                    label: part.label,
                    path: part.path,
                };
            }
            if (part.type === "file_mention") {
                return {
                    type: part.type,
                    label: part.label,
                    path: part.path,
                    relativePath: part.relativePath,
                    mimeType: part.mimeType ?? null,
                };
            }
            if (part.type === "folder_mention") {
                return {
                    type: part.type,
                    folderPath: part.folderPath,
                    label: part.label,
                };
            }
            if (part.type === "fetch_mention") {
                return { type: part.type };
            }
            if (part.type === "plan_mention") {
                return { type: part.type };
            }
            if (part.type === "selection_mention") {
                return {
                    type: part.type,
                    noteId: part.noteId ?? null,
                    label: part.label,
                    path: part.path,
                    selectedText: part.selectedText,
                    startLine: part.startLine,
                    endLine: part.endLine,
                };
            }
            if (part.type === "screenshot") {
                return {
                    type: part.type,
                    filePath: part.filePath,
                    mimeType: part.mimeType,
                    label: part.label,
                    createdAt: part.createdAt ?? null,
                };
            }
            if (part.type === "file_attachment") {
                return {
                    type: part.type,
                    filePath: part.filePath,
                    mimeType: part.mimeType,
                    label: part.label,
                };
            }
            return assertNeverComposerPart(part);
        }),
    );
}

function setCaretAfterNode(node: Node) {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function insertPlainTextAtSelection(root: HTMLDivElement, text: string) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;

    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    setCaretAfterNode(textNode);
}

function selectAllComposerContent(root: HTMLDivElement) {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(root);
    selection.removeAllRanges();
    selection.addRange(range);
}

function appendValidatedFileAttachmentPart(
    parts: AIComposerPart[],
    file: {
        filePath: string;
        mimeType: string;
        label: string;
        sizeBytes?: number | null;
    },
    runtimeId?: string | null,
    onImageAttachmentValidationFailure?: (
        reason: ImageAttachmentValidationFailure,
    ) => void,
) {
    if (file.mimeType.startsWith("image/")) {
        const validation = validateNewImageAttachmentReference(
            { mimeType: file.mimeType, sizeBytes: file.sizeBytes },
            parts,
            runtimeId,
        );
        if (!validation.ok) {
            onImageAttachmentValidationFailure?.(validation.reason);
            return parts;
        }
    }

    return appendFileAttachmentPart(parts, file);
}

function normalizeAttachmentLookupPath(path: string) {
    return path.replace(/\\/g, "/");
}

function getKnownFileSizeBytes(
    filePath: string,
    fileSizeByPath: Map<string, number>,
) {
    return fileSizeByPath.get(normalizeAttachmentLookupPath(filePath)) ?? null;
}

function syncComposerDom(
    root: HTMLDivElement,
    parts: AIComposerPart[],
    metrics: ChatPillMetrics,
    pillMetricsSignature: string,
) {
    root.replaceChildren();

    for (const part of parts) {
        if (part.type === "text") {
            root.append(document.createTextNode(part.text));
        } else if (part.type === "mention") {
            root.append(createMentionNode(part, metrics));
        } else if (part.type === "file_mention") {
            root.append(createFileMentionNode(part, metrics));
        } else if (part.type === "folder_mention") {
            root.append(createFolderMentionNode(part, metrics));
        } else if (part.type === "fetch_mention") {
            root.append(createFetchMentionNode(metrics));
        } else if (part.type === "plan_mention") {
            root.append(createPlanMentionNode(metrics));
        } else if (part.type === "selection_mention") {
            root.append(createSelectionMentionNode(part, metrics));
        } else if (part.type === "screenshot") {
            root.append(createScreenshotNode(part, metrics));
        } else if (part.type === "file_attachment") {
            root.append(createFileAttachmentNode(part, metrics));
        }
    }

    root.dataset.pillMetricsSignature = pillMetricsSignature;
}

function isMentionElement(node: Node): node is HTMLElement {
    return (
        node instanceof HTMLElement &&
        (node.dataset.kind === "mention" ||
            node.dataset.kind === "file_mention" ||
            node.dataset.kind === "folder_mention" ||
            node.dataset.kind === "fetch_mention" ||
            node.dataset.kind === "plan_mention" ||
            node.dataset.kind === "selection_mention" ||
            node.dataset.kind === "screenshot" ||
            node.dataset.kind === "file_attachment")
    );
}

function removeAdjacentMention(root: HTMLDivElement) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed)
        return false;

    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const offset = range.startOffset;

    if (container === root && offset > 0) {
        const previous = root.childNodes[offset - 1];
        if (previous && isMentionElement(previous)) {
            previous.remove();
            return true;
        }
    }

    if (container.nodeType === Node.TEXT_NODE) {
        const textNode = container as Text;
        if (offset === 0) {
            const previous = textNode.previousSibling;
            if (previous && isMentionElement(previous)) {
                previous.remove();
                return true;
            }
        }
    }

    return false;
}

function extractFolderPaths(
    notes: AIChatNoteSummary[],
    entries: Array<Pick<VaultEntryDto, "kind" | "relative_path">>,
): string[] {
    const folders = new Set<string>();
    for (const note of notes) {
        const parts = note.id.split("/");
        for (let i = 1; i < parts.length; i++) {
            folders.add(parts.slice(0, i).join("/"));
        }
    }
    for (const entry of entries) {
        if (entry.kind !== "folder" || !entry.relative_path) continue;
        folders.add(entry.relative_path);
    }
    return [...folders].sort();
}

function getComposerPillElementFromNode(node: EventTarget | null) {
    const element =
        node instanceof HTMLElement
            ? node
            : node instanceof Text
              ? node.parentElement
              : null;
    return (
        element?.closest<HTMLElement>(
            "[data-kind='mention'], [data-kind='file_mention'], [data-kind='selection_mention']",
        ) ?? null
    );
}

function getComposerPillFileReference(element: HTMLElement | null) {
    if (element?.dataset.kind === "file_mention") {
        return element.dataset.path ?? null;
    }
    if (
        element?.dataset.kind === "selection_mention" &&
        element.dataset.path &&
        element.dataset.startLine
    ) {
        return serializeChatVaultReferenceTarget({
            path: element.dataset.path,
            line: Number(element.dataset.startLine),
            endLine: element.dataset.endLine
                ? Number(element.dataset.endLine)
                : null,
        });
    }
    return null;
}

function getComposerPillTargetFromContextMenuEvent(
    event: ReactMouseEvent<HTMLElement>,
) {
    const path = event.nativeEvent.composedPath?.() ?? [];
    for (const node of path) {
        const mention = getComposerPillElementFromNode(node);
        if (mention) {
            return {
                noteId:
                    mention.dataset.kind === "mention"
                        ? (mention.dataset.noteId ?? null)
                        : null,
                filePath: getComposerPillFileReference(mention),
            };
        }
    }

    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const mention = getComposerPillElementFromNode(hovered);
    return {
        noteId:
            mention?.dataset.kind === "mention"
                ? (mention.dataset.noteId ?? null)
                : null,
        filePath: getComposerPillFileReference(mention),
    };
}

function normalizeForSearch(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function getTextPositionForOffset(root: HTMLElement, charOffset: number) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let traversed = 0;
    let lastTextNode: Text | null = null;

    while (true) {
        const currentNode = walker.nextNode();
        if (!(currentNode instanceof Text)) break;

        const nextTraversed = traversed + currentNode.data.length;
        if (charOffset <= nextTraversed) {
            return {
                node: currentNode,
                offset: charOffset - traversed,
            };
        }

        traversed = nextTraversed;
        lastTextNode = currentNode;
    }

    if (lastTextNode && charOffset === traversed) {
        return {
            node: lastTextNode,
            offset: lastTextNode.data.length,
        };
    }

    return null;
}

function getInlineTriggerMatch(root: HTMLElement, pattern: RegExp) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) {
        return null;
    }

    const caretRange = selection.getRangeAt(0);
    if (!root.contains(caretRange.startContainer)) {
        return null;
    }

    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(root);
    prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset);

    const prefixText = prefixRange.toString();
    const match = prefixText.match(pattern);
    if (!match) {
        return null;
    }

    const query = match[2] ?? "";
    const triggerLength = query.length + 1;
    const triggerStart = prefixText.length - triggerLength;
    const start = getTextPositionForOffset(root, triggerStart);
    const end = getTextPositionForOffset(root, prefixText.length);

    if (!start || !end) {
        return null;
    }

    const triggerRange = document.createRange();
    triggerRange.setStart(start.node, start.offset);
    triggerRange.setEnd(end.node, end.offset);

    return {
        query,
        range: triggerRange,
    };
}

const FETCH_KEYWORDS = ["fetch", "web", "search", "buscar", "internet"];
function getNoteFileNameForSearch(note: AIChatNoteSummary) {
    return note.path.split("/").pop() ?? note.path;
}

function getNoteMentionLabel(
    note: AIChatNoteSummary,
    showExtensions: boolean,
    preferFileName: boolean,
) {
    if (!preferFileName) {
        return note.title;
    }

    const fileName = getNoteFileNameForSearch(note);
    return showExtensions ? fileName : fileName.replace(/\.md$/i, "");
}

function getFileMentionLabel(file: AIChatFileSummary, showExtensions: boolean) {
    if (showExtensions) {
        return file.fileName;
    }

    return file.title || file.fileName;
}

function getNoteMentionSuggestions(
    notes: AIChatNoteSummary[],
    query: string,
    limit: number,
    preferFileName: boolean,
) {
    const normalizedQuery = normalizeForSearch(query);

    return [...notes]
        .map((note) => {
            const normalizedTitle = normalizeForSearch(note.title);
            const normalizedPath = normalizeForSearch(note.path);
            const normalizedFileName = normalizeForSearch(
                getNoteFileNameForSearch(note),
            );
            let rank = 2;
            if (normalizedQuery.length > 0) {
                if (preferFileName) {
                    rank = normalizedFileName.startsWith(normalizedQuery)
                        ? 0
                        : normalizedPath.startsWith(normalizedQuery)
                          ? 1
                          : normalizedFileName.includes(normalizedQuery)
                            ? 2
                            : normalizedPath.includes(normalizedQuery)
                              ? 3
                              : normalizedTitle.startsWith(normalizedQuery)
                                ? 4
                                : 5;
                } else {
                    rank = normalizedTitle.startsWith(normalizedQuery)
                        ? 0
                        : normalizedPath.startsWith(normalizedQuery)
                          ? 1
                          : 2;
                }
            }
            const matches =
                !normalizedQuery ||
                (preferFileName
                    ? normalizedFileName.includes(normalizedQuery) ||
                      normalizedPath.includes(normalizedQuery) ||
                      normalizedTitle.includes(normalizedQuery)
                    : normalizedTitle.includes(normalizedQuery)) ||
                normalizedPath.includes(normalizedQuery);

            return {
                note,
                matches,
                rank,
            };
        })
        .filter((item) => item.matches)
        .sort((left, right) => {
            if (left.rank !== right.rank) {
                return left.rank - right.rank;
            }
            const leftPrimary = preferFileName
                ? getNoteFileNameForSearch(left.note)
                : left.note.title;
            const rightPrimary = preferFileName
                ? getNoteFileNameForSearch(right.note)
                : right.note.title;
            return leftPrimary.localeCompare(rightPrimary);
        })
        .slice(0, limit)
        .map((item) => item.note);
}

function getMentionSuggestions(
    notes: AIChatNoteSummary[],
    files: AIChatFileSummary[],
    folderPaths: string[],
    query: string,
    includeFiles: boolean,
    preferFileName: boolean,
    showExtensions: boolean,
    limit = 10,
): AIMentionSuggestion[] {
    const nq = normalizeForSearch(query);
    const results: AIMentionSuggestion[] = [];

    // Always show @fetch at the top when query is empty or matches fetch keywords
    if (
        !nq ||
        FETCH_KEYWORDS.some(
            (kw) => kw.startsWith(nq) || nq.startsWith(kw.slice(0, nq.length)),
        )
    ) {
        results.push({ kind: "fetch" });
    }

    // Match folders
    for (const fp of folderPaths) {
        const name = fp.split("/").pop() ?? fp;
        const normalized = normalizeForSearch(name);
        const normalizedFull = normalizeForSearch(fp);
        if (!nq || normalized.includes(nq) || normalizedFull.includes(nq)) {
            results.push({ kind: "folder", folderPath: fp, name });
        }
    }

    // Match notes
    const noteSuggestions = getNoteMentionSuggestions(
        notes,
        query,
        limit,
        preferFileName,
    );
    for (const note of noteSuggestions) {
        results.push({
            kind: "note",
            note,
            label: getNoteMentionLabel(note, showExtensions, preferFileName),
        });
    }

    if (includeFiles) {
        const fileSuggestions = [...files]
            .map((file) => {
                const normalizedFileName = normalizeForSearch(file.fileName);
                const normalizedRelativePath = normalizeForSearch(
                    file.relativePath,
                );
                const primaryStartsWith =
                    nq.length > 0 && normalizedFileName.startsWith(nq);
                const pathStartsWith =
                    nq.length > 0 && normalizedRelativePath.startsWith(nq);
                const matches =
                    !nq ||
                    normalizedFileName.includes(nq) ||
                    normalizedRelativePath.includes(nq);

                return {
                    file,
                    matches,
                    rank: primaryStartsWith ? 0 : pathStartsWith ? 1 : 2,
                };
            })
            .filter((item) => item.matches)
            .sort((left, right) => {
                if (left.rank !== right.rank) {
                    return left.rank - right.rank;
                }

                return left.file.fileName.localeCompare(right.file.fileName);
            })
            .slice(0, limit);

        for (const item of fileSuggestions) {
            results.push({
                kind: "file",
                file: item.file,
                label: getFileMentionLabel(item.file, showExtensions),
            });
        }
    }

    // Fetch first, then folders, then matching notes/files, limited.
    return results.slice(0, limit);
}

export function AIChatComposer({
    sessionId,
    parts,
    notes,
    files,
    status,
    runtimeName,
    runtimeId,
    disabled = false,
    requireCmdEnterToSend = false,
    composerFontSize = 14,
    composerFontFamily = "system",
    availableCommands = [],
    isStopping = false,
    hasPendingSubmitAfterStop = false,
    expanded = false,
    contextBar,
    footer,
    placeholderText,
    bottomAccent,
    onChange,
    onMentionAttach,
    onFileMentionAttach,
    onFolderAttach,
    onToggleExpanded,
    onPasteImage,
    onImageAttachmentValidationFailure,
    onFocus,
    onSubmit,
    onStop,
}: AIChatComposerProps) {
    const fileTreeContentMode = useSettingsStore((s) => s.fileTreeContentMode);
    const fileTreeShowExtensions = useSettingsStore(
        (s) => s.fileTreeShowExtensions,
    );
    const fileTreeExtensionFilter = useSettingsStore(
        (s) => s.fileTreeExtensionFilter,
    );
    const fallbackEntries = useVaultStore((state) => state.entries);
    const composerRef = useRef<HTMLDivElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const fileSizeByPathRef = useRef<Map<string, number>>(new Map());
    const [composerElement, setComposerElement] =
        useState<HTMLDivElement | null>(null);
    const [mentionState, setMentionState] =
        useState<MentionState>(EMPTY_MENTION_STATE);
    const [slashState, setSlashState] = useState<SlashState>(EMPTY_SLASH_STATE);
    const [externalDragActive, setExternalDragActive] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ComposerContextMenuPayload> | null>(null);
    const [customHeight, setCustomHeight] = useState<number | null>(null);
    const resizeSession = useRef<{
        startY: number;
        startHeight: number;
        pointerId: number;
    } | null>(null);
    const resizeHandleRef = useRef<HTMLDivElement>(null);
    const serializedValue = useMemo(
        () => serializeComposerParts(parts),
        [parts],
    );
    const partsDomSignature = useMemo(
        () => getComposerPartsDomSignature(parts),
        [parts],
    );
    const folderPaths = useMemo(
        () => extractFolderPaths(notes, fallbackEntries),
        [fallbackEntries, notes],
    );
    const visibleMentionNotes = useMemo(() => {
        return shouldIncludeMarkdownNotesInFileScope({
            contentMode: fileTreeContentMode,
            extensionFilter: fileTreeExtensionFilter,
        })
            ? notes
            : [];
    }, [fileTreeContentMode, fileTreeExtensionFilter, notes]);
    const mentionableFiles = useMemo(() => {
        if (files) {
            return files.filter((file) =>
                shouldIncludeFileSummaryInFileScope(file, {
                    contentMode: fileTreeContentMode,
                    extensionFilter: fileTreeExtensionFilter,
                }),
            );
        }

        return fallbackEntries
            .filter(
                (entry) =>
                    entry.kind === "file" &&
                    isTextLikeVaultEntry(entry) &&
                    shouldIncludeVaultEntryInFileScope(entry, {
                        contentMode: fileTreeContentMode,
                        extensionFilter: fileTreeExtensionFilter,
                    }),
            )
            .map((entry) => ({
                id: entry.id,
                title: entry.title,
                path: entry.path,
                relativePath: entry.relative_path,
                fileName: entry.file_name,
                mimeType: entry.mime_type,
            }));
    }, [
        fallbackEntries,
        files,
        fileTreeContentMode,
        fileTreeExtensionFilter,
    ]);
    useEffect(() => {
        const next = new Map<string, number>();
        for (const entry of fallbackEntries) {
            if (typeof entry.size !== "number") continue;
            next.set(normalizeAttachmentLookupPath(entry.path), entry.size);
        }
        fileSizeByPathRef.current = next;
    }, [fallbackEntries]);
    const pillMetrics = useMemo(
        () => getChatPillMetrics(composerFontSize),
        [composerFontSize],
    );
    const pillMetricsSignature = useMemo(
        () => getPillMetricsSignature(pillMetrics),
        [pillMetrics],
    );
    const composerPadding = useMemo(
        () =>
            expanded
                ? {
                      top: 14,
                      right: 36,
                      bottom: 18,
                      left: 16,
                  }
                : {
                      top: 10,
                      right: 36,
                      bottom: 10,
                      left: 14,
                  },
        [expanded],
    );
    const bindComposerRef = useCallback((element: HTMLDivElement | null) => {
        composerRef.current = element;
        setComposerElement((current) =>
            current === element ? current : element,
        );
    }, []);

    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;

        if (
            getComposerPartsDomSignature(readPartsFromDom(composer)) ===
                partsDomSignature &&
            composer.dataset.pillMetricsSignature === pillMetricsSignature
        ) {
            return;
        }

        syncComposerDom(composer, parts, pillMetrics, pillMetricsSignature);
    }, [parts, partsDomSignature, pillMetrics, pillMetricsSignature]);

    const isStreaming = status === "streaming";
    const isStopTransitionActive = isStopping || hasPendingSubmitAfterStop;
    const isEmpty = serializedValue.length === 0;
    const canSubmit = !disabled && !isEmpty && !hasPendingSubmitAfterStop;
    const stopTransitionLabel = hasPendingSubmitAfterStop
        ? "Sending next message after stop..."
        : "Stopping previous run...";
    const stopButtonVisible = isStreaming || isStopping;
    const stopButtonOpacity = !stopButtonVisible
        ? 0
        : disabled || isStopping
          ? 0.4
          : 1;

    const closeMentionPicker = () => setMentionState(EMPTY_MENTION_STATE);
    const closeSlashPicker = () => setSlashState(EMPTY_SLASH_STATE);

    const partsRef = useRef(parts);
    const onChangeRef = useRef(onChange);
    const onMentionAttachRef = useRef(onMentionAttach);
    const onFileMentionAttachRef = useRef(onFileMentionAttach);
    const onFolderAttachRef = useRef(onFolderAttach);
    const runtimeIdRef = useRef(runtimeId);
    const onImageAttachmentValidationFailureRef = useRef(
        onImageAttachmentValidationFailure,
    );

    useEffect(() => {
        partsRef.current = parts;
        runtimeIdRef.current = runtimeId;
        onChangeRef.current = onChange;
        onMentionAttachRef.current = onMentionAttach;
        onFileMentionAttachRef.current = onFileMentionAttach;
        onFolderAttachRef.current = onFolderAttach;
        onImageAttachmentValidationFailureRef.current =
            onImageAttachmentValidationFailure;
    }, [
        onChange,
        onFileMentionAttach,
        onFolderAttach,
        onImageAttachmentValidationFailure,
        onMentionAttach,
        parts,
        runtimeId,
    ]);

    const syncFromDom = () => {
        const composer = composerRef.current;
        if (!composer) return;
        onChange(readPartsFromDom(composer));
    };

    const focusComposerAtEnd = useCallback(() => {
        window.setTimeout(() => {
            const composer = composerRef.current;
            if (!composer) return;
            composer.focus();
            const last = composer.lastChild;
            if (last) setCaretAfterNode(last);
        }, 0);
    }, []);

    const prevPartsCountRef = useRef(parts.length);
    useEffect(() => {
        if (parts.length > prevPartsCountRef.current) {
            focusComposerAtEnd();
        }
        prevPartsCountRef.current = parts.length;
    }, [parts.length, focusComposerAtEnd]);

    const updateMentionPicker = () => {
        const composer = composerRef.current;
        if (!composer) {
            closeMentionPicker();
            return;
        }

        const trigger = getInlineTriggerMatch(composer, /(^|\s)@([^\s@]*)$/);
        if (!trigger) {
            closeMentionPicker();
            return;
        }

        const suggestions = getMentionSuggestions(
            visibleMentionNotes,
            mentionableFiles,
            folderPaths,
            trigger.query,
            mentionableFiles.length > 0,
            fileTreeContentMode === "all_files",
            fileTreeShowExtensions,
            10,
        );
        const rect = trigger.range.getBoundingClientRect();
        setMentionState({
            open: true,
            query: trigger.query,
            selectedIndex: 0,
            items: suggestions,
            x: rect.left,
            y: rect.top,
            range: trigger.range.cloneRange(),
        });
    };

    const updateSlashPicker = () => {
        const composer = composerRef.current;
        if (!composer) {
            closeSlashPicker();
            return;
        }

        const trigger = getInlineTriggerMatch(composer, /(^|\s)\/([^\s/]*)$/);
        if (!trigger) {
            closeSlashPicker();
            return;
        }

        const runtimeCommands: AIChatSlashCommand[] = availableCommands.map(
            (command) => ({
                id: command.id,
                label: command.label,
                description: command.description,
                insertText: command.insert_text,
            }),
        );
        const commandSource = runtimeCommands.length
            ? runtimeCommands
            : getPendingRuntimeSlashCommands(runtimeId);
        const normalizedQuery = trigger.query.toLowerCase();
        const items = commandSource.filter((command) => {
            const haystack = [command.id, command.label, command.description]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            return haystack.includes(normalizedQuery);
        });
        const rect = trigger.range.getBoundingClientRect();
        setSlashState({
            open: true,
            query: trigger.query,
            selectedIndex: 0,
            items,
            x: rect.left,
            y: rect.top,
            range: trigger.range.cloneRange(),
        });
        closeMentionPicker();
    };

    const updateInlinePickers = () => {
        updateMentionPicker();
        updateSlashPicker();
    };

    const insertMentionSuggestion = (item: AIMentionSuggestion) => {
        const composer = composerRef.current;
        const targetRange = mentionState.range;
        if (!composer || !targetRange) return;

        let span: HTMLSpanElement;
        if (item.kind === "note") {
            span = createMentionNode(
                {
                    id: crypto.randomUUID(),
                    type: "mention",
                    noteId: item.note.id,
                    label: item.label,
                    path: item.note.path,
                },
                pillMetrics,
            );
        } else if (item.kind === "file") {
            span = createFileMentionNode(
                {
                    id: crypto.randomUUID(),
                    type: "file_mention",
                    label: item.label,
                    path: item.file.path,
                    relativePath: item.file.relativePath,
                    mimeType: item.file.mimeType,
                },
                pillMetrics,
            );
        } else if (item.kind === "folder") {
            span = createFolderMentionNode(
                {
                    id: crypto.randomUUID(),
                    type: "folder_mention",
                    folderPath: item.folderPath,
                    label: item.name,
                },
                pillMetrics,
            );
        } else if (item.kind === "plan") {
            span = createPlanMentionNode(pillMetrics);
        } else {
            span = createFetchMentionNode(pillMetrics);
        }

        const trailingSpace = document.createTextNode(" ");
        targetRange.deleteContents();
        targetRange.insertNode(trailingSpace);
        targetRange.insertNode(span);
        setCaretAfterNode(trailingSpace);
        syncFromDom();

        if (item.kind === "note") {
            onMentionAttach(item.note);
        } else if (item.kind === "file") {
            onFileMentionAttachRef.current?.(item.file);
        } else if (item.kind === "folder") {
            onFolderAttach(item.folderPath, item.name);
        }

        closeMentionPicker();
        composer.focus();
    };

    const insertSlashCommand = (command: AIChatSlashCommand) => {
        const composer = composerRef.current;
        const targetRange = slashState.range;
        if (!composer || !targetRange) return;

        targetRange.deleteContents();
        if (command.id === "plan") {
            const trailingSpace = document.createTextNode(" ");
            const planNode = createPlanMentionNode(pillMetrics);
            targetRange.insertNode(trailingSpace);
            targetRange.insertNode(planNode);
            setCaretAfterNode(trailingSpace);
        } else {
            const textNode = document.createTextNode(command.insertText);
            targetRange.insertNode(textNode);
            setCaretAfterNode(textNode);
        }
        syncFromDom();
        closeSlashPicker();
        composer.focus();
    };

    const copySelection = async () => {
        const composer = composerRef.current;
        const selection = window.getSelection();
        if (!composer || !selection || selection.isCollapsed) return;
        if (!composer.contains(selection.anchorNode)) return;
        await navigator.clipboard.writeText(selection.toString());
    };

    const cutSelection = async () => {
        const composer = composerRef.current;
        const selection = window.getSelection();
        if (!composer || !selection || selection.isCollapsed) return;
        if (!composer.contains(selection.anchorNode)) return;

        await navigator.clipboard.writeText(selection.toString());
        const range = selection.getRangeAt(0);
        range.deleteContents();
        syncFromDom();
        composer.focus();
    };

    const pasteFromClipboard = async () => {
        const composer = composerRef.current;
        if (!composer) return;

        const text = await navigator.clipboard.readText();
        if (!text) return;

        composer.focus();
        insertPlainTextAtSelection(composer, text);
        syncFromDom();
    };

    useEffect(() => {
        const handleDrag = (event: Event) => {
            const customEvent = event as CustomEvent<FileTreeNoteDragDetail>;
            const detail = customEvent.detail;
            const shell = shellRef.current;
            if (!shell) return;

            if (detail.phase === "cancel") {
                setExternalDragActive(false);
                return;
            }

            const rect = shell.getBoundingClientRect();
            const isOver =
                detail.x >= rect.left &&
                detail.x <= rect.right &&
                detail.y >= rect.top &&
                detail.y <= rect.bottom;

            if (detail.phase === "move" || detail.phase === "start") {
                setExternalDragActive(isOver);
                return;
            }

            if (detail.phase === "end" || detail.phase === "attach") {
                setExternalDragActive(false);
                if (detail.phase === "end" && !isOver) return;
                if (
                    detail.phase === "attach" &&
                    detail.targetSessionId &&
                    detail.targetSessionId !== sessionId
                ) {
                    return;
                }

                let current = partsRef.current;
                let didAttach = false;
                const folders =
                    detail.folders ??
                    (detail.folder ? [detail.folder] : []);

                // Folder drop
                for (const folder of folders) {
                    current = appendFolderMentionPart(
                        current,
                        folder.path,
                        folder.name,
                    );
                    onFolderAttachRef.current(folder.path, folder.name);
                    didAttach = true;
                }

                // File drop (PDFs, etc.) — inline pills
                if (detail.files && detail.files.length > 0) {
                    for (const file of detail.files) {
                        const next = appendValidatedFileAttachmentPart(
                            current,
                            {
                                filePath: file.filePath,
                                mimeType: file.mimeType,
                                label: file.fileName,
                                sizeBytes:
                                    file.sizeBytes ??
                                    getKnownFileSizeBytes(
                                        file.filePath,
                                        fileSizeByPathRef.current,
                                    ),
                            },
                            runtimeIdRef.current,
                            onImageAttachmentValidationFailureRef.current,
                        );
                        if (next !== current) {
                            didAttach = true;
                            current = next;
                        }
                    }
                }

                // Notes drop
                if (detail.notes.length > 0) {
                    current = appendMentionParts(
                        current,
                        detail.notes.map((note) => ({
                            noteId: note.id,
                            label: note.title,
                            path: note.path,
                        })),
                    );
                    detail.notes.forEach((note) =>
                        onMentionAttachRef.current(note),
                    );
                    didAttach = true;
                }

                if (!didAttach) return;
                onChangeRef.current(current);
                focusComposerAtEnd();
            }
        };

        window.addEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleDrag);
        return () =>
            window.removeEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleDrag);
    }, [focusComposerAtEnd, sessionId]);

    // Native Finder/Explorer file drop
    useEffect(() => {
        let mounted = true;
        let unlisten: (() => void) | null = null;

        void getCurrentWebview()
            .onDragDropEvent((event) => {
                const shell = shellRef.current;
                if (!shell) return;
                const { type } = event.payload;

                if (type === "enter" || type === "over") {
                    const pos = (
                        event.payload as { position?: { x: number; y: number } }
                    ).position;
                    if (pos) {
                        const rect = shell.getBoundingClientRect();
                        const isOver =
                            pos.x >= rect.left &&
                            pos.x <= rect.right &&
                            pos.y >= rect.top &&
                            pos.y <= rect.bottom;
                        setExternalDragActive(isOver);
                    }
                    return;
                }

                if (type === "drop") {
                    setExternalDragActive(false);
                    const pos = (
                        event.payload as { position?: { x: number; y: number } }
                    ).position;
                    if (!pos) return;
                    const rect = shell.getBoundingClientRect();
                    const isOver =
                        pos.x >= rect.left &&
                        pos.x <= rect.right &&
                        pos.y >= rect.top &&
                        pos.y <= rect.bottom;
                    if (!isOver) return;

                    const paths: string[] =
                        (event.payload as { paths?: string[] }).paths ?? [];
                    const mimeMap: Record<string, string> = {
                        png: "image/png",
                        jpg: "image/jpeg",
                        jpeg: "image/jpeg",
                        gif: "image/gif",
                        webp: "image/webp",
                        svg: "image/svg+xml",
                        pdf: "application/pdf",
                        json: "application/json",
                        xml: "application/xml",
                        yaml: "text/yaml",
                        yml: "text/yaml",
                        toml: "text/toml",
                        csv: "text/csv",
                        txt: "text/plain",
                        md: "text/markdown",
                    };
                    let currentParts = partsRef.current;
                    let didAttach = false;
                    for (const filePath of paths) {
                        const fileName = filePath.split("/").pop() ?? "file";
                        const dotIdx = fileName.lastIndexOf(".");
                        const hasExt =
                            dotIdx > 0 && dotIdx < fileName.length - 1;

                        if (!hasExt) {
                            // No extension → treat as folder
                            onFolderAttachRef.current(filePath, fileName);
                            currentParts = appendFolderMentionPart(
                                currentParts,
                                filePath,
                                fileName,
                            );
                            didAttach = true;
                        } else {
                            const ext = fileName
                                .slice(dotIdx + 1)
                                .toLowerCase();
                            const nextParts = appendValidatedFileAttachmentPart(
                                currentParts,
                                {
                                    filePath,
                                    mimeType:
                                        mimeMap[ext] ??
                                        "application/octet-stream",
                                    label: fileName,
                                    sizeBytes: getKnownFileSizeBytes(
                                        filePath,
                                        fileSizeByPathRef.current,
                                    ),
                                },
                                runtimeIdRef.current,
                                onImageAttachmentValidationFailureRef.current,
                            );
                            if (nextParts !== currentParts) {
                                didAttach = true;
                                currentParts = nextParts;
                            }
                        }
                    }
                    if (!didAttach) return;
                    onChangeRef.current(currentParts);
                    focusComposerAtEnd();
                    return;
                }

                // "leave" / "cancel"
                setExternalDragActive(false);
            })
            .then((fn) => {
                if (mounted) {
                    unlisten = fn;
                    return;
                }
                void fn();
            });

        return () => {
            mounted = false;
            const cleanup = unlisten;
            unlisten = null;
            void cleanup?.();
        };
    }, [focusComposerAtEnd]);

    const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const box = e.currentTarget.parentElement;
        if (!box) return;
        const startHeight = box.getBoundingClientRect().height;
        resizeSession.current = {
            startY: e.clientY,
            startHeight,
            pointerId: e.pointerId,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing-composer");
    };

    const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const s = resizeSession.current;
        if (!s) return;
        const delta = s.startY - e.clientY;
        const next = Math.max(
            MIN_COMPOSER_HEIGHT,
            Math.min(MAX_COMPOSER_HEIGHT, s.startHeight + delta),
        );
        setCustomHeight(next);
    };

    const onResizeUp = () => {
        const s = resizeSession.current;
        if (!s) return;
        const handle = resizeHandleRef.current;
        if (handle && handle.hasPointerCapture(s.pointerId)) {
            handle.releasePointerCapture(s.pointerId);
        }
        document.body.classList.remove("resizing-composer");
        resizeSession.current = null;
    };
    const contentColumnClassName =
        expanded || customHeight != null
            ? "relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
            : "relative flex min-w-0 flex-col";

    return (
        <div
            ref={shellRef}
            data-ai-composer-drop-zone="true"
            data-ai-composer-session-id={sessionId}
            className={
                expanded
                    ? "flex h-full min-h-0 flex-1 flex-col"
                    : "flex flex-col"
            }
        >
            {contextBar ? (
                <div className={expanded ? "px-2 pb-1.5" : "px-3 pb-1.5"}>
                    <div
                        className="min-w-0"
                        style={AI_CHAT_CONTENT_COLUMN_STYLE}
                    >
                        {contextBar}
                    </div>
                </div>
            ) : null}
            <div
                data-testid="chat-composer-shell"
                className={
                    expanded
                        ? "relative flex h-full min-h-0 flex-1 flex-col"
                        : "relative flex flex-col"
                }
                style={{
                    border: "none",
                    borderTop: "1px solid var(--border)",
                    borderRadius: 0,
                    backgroundColor: "var(--bg-tertiary)",
                    boxShadow: externalDragActive
                        ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                        : "none",
                    transition: "box-shadow 0.15s ease",
                    ...(expanded || customHeight == null
                        ? {}
                        : { height: customHeight }),
                }}
            >
                <div
                    className={contentColumnClassName}
                    data-testid="chat-composer-content-column"
                    style={AI_CHAT_CONTENT_COLUMN_STYLE}
                >
                    {!expanded && (
                        <div
                            ref={resizeHandleRef}
                            onPointerDown={onResizeDown}
                            onPointerMove={onResizeMove}
                            onPointerUp={onResizeUp}
                            onPointerCancel={onResizeUp}
                            className="group absolute left-0 right-0 flex cursor-row-resize items-center justify-center touch-none"
                            style={{
                                top: -4,
                                height: 9,
                                zIndex: 2,
                            }}
                        >
                            <div
                                className="rounded-full transition-colors duration-150"
                                style={{
                                    width: 32,
                                    height: 3,
                                    backgroundColor: "var(--border)",
                                }}
                            />
                        </div>
                    )}
                    <button
                        type="button"
                        tabIndex={-1}
                        onClick={onToggleExpanded}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor =
                                "color-mix(in srgb, var(--bg-tertiary) 80%, transparent)";
                            e.currentTarget.style.color = "var(--text-primary)";
                            e.currentTarget.style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor =
                                "transparent";
                            e.currentTarget.style.color =
                                "var(--text-secondary)";
                            e.currentTarget.style.opacity = "0.45";
                        }}
                        className="absolute right-2 top-2 flex items-center justify-center rounded"
                        style={{
                            width: 22,
                            height: 22,
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "none",
                            opacity: 0.45,
                            outline: "none",
                            zIndex: 1,
                            transition:
                                "background-color 100ms ease, color 100ms ease, opacity 100ms ease",
                        }}
                        title={
                            expanded ? "Collapse composer" : "Expand composer"
                        }
                        aria-label={
                            expanded ? "Collapse composer" : "Expand composer"
                        }
                    >
                        {expanded ? (
                            <svg
                                width="13"
                                height="13"
                                viewBox="0 0 14 14"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {/* Collapse: inner brackets at (5,5) and (9,9)
                                    with diagonals out to the outer corners — reads
                                    as arrows pulling inward toward the centre. */}
                                <path d="M5 1V5H1M9 13V9H13M5 5L1 1M9 9L13 13" />
                            </svg>
                        ) : (
                            <svg
                                width="13"
                                height="13"
                                viewBox="0 0 14 14"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {/* Expand: outer brackets at the corners with
                                    diagonals pushing outward — arrows reaching
                                    toward the corners. */}
                                <path d="M9 1h4v4M5 13H1V9M13 1l-5 5M1 13l5-5" />
                            </svg>
                        )}
                    </button>
                    {isEmpty && (
                    <div
                        className="pointer-events-none absolute left-3.5 top-2.5"
                        style={{
                            right: 32,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            color: "var(--text-secondary)",
                            opacity: 0.6,
                            fontSize: composerFontSize,
                            fontFamily: getEditorFontFamily(composerFontFamily),
                            top: expanded ? 14 : 10,
                            left: expanded ? 16 : 14,
                        }}
                    >
                        {placeholderText ??
                            (disabled
                                ? "Set up a provider in Settings → AI providers"
                                : `Message ${runtimeName} — @ to include context, / for commands`)}
                    </div>
                    )}
                    <div
                        ref={bindComposerRef}
                        contentEditable={!disabled}
                        suppressContentEditableWarning
                        role="textbox"
                        aria-label={AI_MESSAGE_LABEL}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        const composer = composerRef.current;
                        const selection = window.getSelection();
                        const hasSelection =
                            !!composer &&
                            !!selection &&
                            !selection.isCollapsed &&
                            composer.contains(selection.anchorNode);
                        const pillTarget =
                            getComposerPillTargetFromContextMenuEvent(event);
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload: {
                                hasSelection,
                                hasContent: serializedValue.trim().length > 0,
                                mentionNoteId: pillTarget.noteId,
                                mentionFilePath: pillTarget.filePath,
                            },
                        });
                    }}
                    onPaste={(event) => {
                        event.preventDefault();
                        // Check for pasted images first
                        if (onPasteImage) {
                            const items = event.clipboardData.items;
                            for (let i = 0; i < items.length; i++) {
                                const item = items[i];
                                if (
                                    item.kind === "file" &&
                                    item.type.startsWith("image/")
                                ) {
                                    const file = item.getAsFile();
                                    if (file) {
                                        onPasteImage(file);
                                        return;
                                    }
                                }
                            }
                        }
                        const text = event.clipboardData.getData("text/plain");
                        if (text && composerRef.current) {
                            insertPlainTextAtSelection(
                                composerRef.current,
                                text,
                            );
                            syncFromDom();
                            updateInlinePickers();
                        }
                    }}
                    onInput={() => {
                        syncFromDom();
                        updateInlinePickers();
                    }}
                    onKeyDown={(event) => {
                        if (disabled) return;

                        if (slashState.open) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setSlashState((state) => ({
                                    ...state,
                                    selectedIndex:
                                        state.items.length === 0
                                            ? 0
                                            : (state.selectedIndex + 1) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setSlashState((state) => ({
                                    ...state,
                                    selectedIndex:
                                        state.items.length === 0
                                            ? 0
                                            : (state.selectedIndex -
                                                  1 +
                                                  state.items.length) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "Enter") {
                                if (slashState.items.length > 0) {
                                    event.preventDefault();
                                    insertSlashCommand(
                                        slashState.items[
                                            slashState.selectedIndex
                                        ]!,
                                    );
                                }
                                return;
                            }

                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeSlashPicker();
                                return;
                            }
                        }

                        if (mentionState.open) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setMentionState((state) => ({
                                    ...state,
                                    selectedIndex:
                                        state.items.length === 0
                                            ? 0
                                            : (state.selectedIndex + 1) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setMentionState((state) => ({
                                    ...state,
                                    selectedIndex:
                                        state.items.length === 0
                                            ? 0
                                            : (state.selectedIndex -
                                                  1 +
                                                  state.items.length) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "Enter") {
                                if (mentionState.items.length > 0) {
                                    event.preventDefault();
                                    insertMentionSuggestion(
                                        mentionState.items[
                                            mentionState.selectedIndex
                                        ]!,
                                    );
                                }
                                return;
                            }

                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMentionPicker();
                                return;
                            }
                        }

                        if (
                            event.key === "Backspace" &&
                            composerRef.current &&
                            removeAdjacentMention(composerRef.current)
                        ) {
                            event.preventDefault();
                            syncFromDom();
                            return;
                        }

                        const shouldSend = requireCmdEnterToSend
                            ? event.key === "Enter" && event.metaKey
                            : event.key === "Enter" && !event.shiftKey;
                        if (shouldSend) {
                            event.preventDefault();
                            if (canSubmit) {
                                onSubmit();
                            } else if (isStreaming) {
                                onStop();
                            }
                        }
                    }}
                    onBlur={() => {
                        window.setTimeout(() => {
                            const active = document.activeElement;
                            if (
                                active instanceof HTMLElement &&
                                (active.dataset.aiMentionPicker === "true" ||
                                    active.dataset.aiCommandPicker === "true")
                            ) {
                                return;
                            }
                            closeMentionPicker();
                            closeSlashPicker();
                        }, 0);
                    }}
                    onFocus={() => {
                        onFocus?.();
                    }}
                    className={`w-full whitespace-pre-wrap break-words${expanded || customHeight != null ? " min-h-0 flex-1" : ""}`}
                    style={{
                        color: "var(--text-primary)",
                        backgroundColor: "transparent",
                        border: "none",
                        outline: "none",
                        minHeight: expanded
                            ? undefined
                            : customHeight != null
                              ? 0
                              : MIN_COMPOSER_HEIGHT,
                        maxHeight: expanded
                            ? undefined
                            : customHeight != null
                              ? undefined
                              : 200,
                        overflowY: "auto",
                        padding: `${composerPadding.top}px ${composerPadding.right}px ${composerPadding.bottom}px ${composerPadding.left}px`,
                        lineHeight: 1.5,
                        fontSize: composerFontSize,
                        fontFamily: getEditorFontFamily(composerFontFamily),
                        opacity: disabled ? 0.6 : 1,
                        cursor: disabled ? "default" : "text",
                    }}
                />
                <div
                    className="mt-auto flex items-center justify-between gap-2 px-2 pb-1.5"
                    style={{
                        paddingTop: expanded ? 10 : 0,
                        minHeight: expanded ? 42 : undefined,
                    }}
                >
                    <div
                        className="relative min-w-0 flex-1"
                        // Footer and transition label share the same slot via
                        // an opacity crossfade. Both are always mounted so the
                        // dropdowns do not flash on/off when the user stops a
                        // run or queues a follow-up message. minHeight matches
                        // the footer so the row never grows vertically.
                        style={{ minHeight: 24 }}
                    >
                        <div
                            style={{
                                opacity: isStopTransitionActive ? 0 : 1,
                                pointerEvents: isStopTransitionActive
                                    ? "none"
                                    : "auto",
                                transition: "opacity 160ms ease-out",
                            }}
                            aria-hidden={isStopTransitionActive || undefined}
                        >
                            {footer}
                        </div>
                        <div
                            className="pointer-events-none absolute inset-0 flex items-center truncate px-1 text-xs"
                            style={{
                                color: "var(--text-secondary)",
                                opacity: isStopTransitionActive ? 1 : 0,
                                transition: "opacity 160ms ease-out",
                            }}
                            aria-hidden={!isStopTransitionActive || undefined}
                        >
                            {stopTransitionLabel}
                        </div>
                    </div>
                    {/* Stop is rendered unconditionally and placed before
                        Send in DOM order so Send stays anchored to the right
                        edge regardless of streaming state. Visibility toggles
                        via opacity + pointer-events for a smooth fade with no
                        layout shift. */}
                        <button
                            type="button"
                            onClick={onStop}
                            disabled={!stopButtonVisible || disabled || isStopping}
                            aria-hidden={!stopButtonVisible || undefined}
                            tabIndex={stopButtonVisible ? 0 : -1}
                            className="nw-composer-action flex shrink-0 cursor-pointer items-center justify-center rounded-full"
                            style={{
                                width: 28,
                                height: 28,
                                color: "#fff",
                                backgroundColor: "#b91c1c",
                                border: "none",
                                opacity: stopButtonOpacity,
                                pointerEvents: stopButtonVisible
                                    ? "auto"
                                    : "none",
                                // No overshoot on transform: the bouncy ease
                                // used elsewhere would briefly grow the button
                                // past scale 1 while it is also fading out,
                                // which reads as a flash. Smooth ease-out keeps
                                // the press feel without that interaction.
                                transition:
                                    "transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1), filter 120ms ease-out, box-shadow 120ms ease-out, background-color 150ms ease, opacity 180ms ease-out",
                            }}
                            aria-label={isStopping ? "Stopping" : "Stop"}
                            title={isStopping ? "Stopping" : "Stop"}
                        ><svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="currentColor"
                        >
                            <rect
                                x="2"
                                y="2"
                                width="10"
                                height="10"
                                rx="2"
                            />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={!canSubmit}
                        className="nw-composer-action flex shrink-0 cursor-pointer items-center justify-center rounded-full"
                        style={{
                            width: 28,
                            height: 28,
                            color: isEmpty ? "var(--text-secondary)" : "#fff",
                            backgroundColor: isEmpty
                                ? "transparent"
                                : "var(--accent)",
                            border: "none",
                            opacity: canSubmit ? 1 : 0.4,
                            transition:
                                "transform 120ms cubic-bezier(0.34, 1.56, 0.64, 1), filter 120ms ease-out, box-shadow 120ms ease-out, background-color 150ms ease, color 150ms ease, opacity 150ms ease",
                        }}
                        aria-label={
                            hasPendingSubmitAfterStop
                                ? "Waiting for stop"
                                : isStreaming
                                  ? "Queue"
                                  : "Send"
                        }
                        title={
                            hasPendingSubmitAfterStop
                                ? "Waiting for stop"
                                : isStreaming
                                  ? "Queue"
                                  : "Send"
                        }
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M8 12V4M4 7l4-3 4 3" />
                        </svg>
                    </button>
                </div>
                <AIChatMentionPicker
                    open={mentionState.open}
                    x={mentionState.x}
                    y={mentionState.y}
                    query={mentionState.query}
                    selectedIndex={mentionState.selectedIndex}
                    items={mentionState.items}
                    anchorElement={composerElement}
                    onHoverIndex={(index) =>
                        setMentionState((state) => ({
                            ...state,
                            selectedIndex: index,
                        }))
                    }
                    onSelect={insertMentionSuggestion}
                    onClose={closeMentionPicker}
                />
                <AIChatCommandPicker
                    open={slashState.open}
                    x={slashState.x}
                    y={slashState.y}
                    query={slashState.query}
                    selectedIndex={slashState.selectedIndex}
                    items={slashState.items}
                    anchorElement={composerElement}
                    onHoverIndex={(index) =>
                        setSlashState((state) => ({
                            ...state,
                            selectedIndex: index,
                        }))
                    }
                    onSelect={insertSlashCommand}
                    onClose={closeSlashPicker}
                />
                {contextMenu && (
                    <ContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        minWidth={150}
                        entries={[
                            ...(contextMenu.payload.mentionNoteId
                                ? [
                                      {
                                          label: "Open",
                                          action: () => {
                                              void openChatNoteById(
                                                  contextMenu.payload
                                                      .mentionNoteId!,
                                              );
                                          },
                                      } as const,
                                      {
                                          label: "Open in New Tab",
                                          action: () => {
                                              void openChatNoteById(
                                                  contextMenu.payload
                                                      .mentionNoteId!,
                                                  { newTab: true },
                                              );
                                          },
                                      } as const,
                                      { type: "separator" as const },
                                  ]
                                : []),
                            ...(contextMenu.payload.mentionFilePath
                                ? [
                                      {
                                          label: "Open",
                                          action: () => {
                                              void openAiEditedFileByAbsolutePath(
                                                  contextMenu.payload
                                                      .mentionFilePath!,
                                              );
                                          },
                                      } as const,
                                      {
                                          label: "Open in New Tab",
                                          action: () => {
                                              void openAiEditedFileByAbsolutePath(
                                                  contextMenu.payload
                                                      .mentionFilePath!,
                                                  { newTab: true },
                                              );
                                          },
                                      } as const,
                                      { type: "separator" as const },
                                  ]
                                : []),
                            {
                                label: "Cut",
                                disabled: !contextMenu.payload.hasSelection,
                                action: () => {
                                    void cutSelection();
                                },
                            },
                            {
                                label: "Copy",
                                disabled: !contextMenu.payload.hasSelection,
                                action: () => {
                                    void copySelection();
                                },
                            },
                            {
                                label: "Paste",
                                action: () => {
                                    void pasteFromClipboard();
                                },
                            },
                            { type: "separator" },
                            {
                                label: "Select All",
                                disabled: !contextMenu.payload.hasContent,
                                action: () => {
                                    const composer = composerRef.current;
                                    if (!composer) return;
                                    composer.focus();
                                    selectAllComposerContent(composer);
                                },
                            },
                        ]}
                    />
                )}
                {bottomAccent}
                </div>
            </div>
        </div>
    );
}
