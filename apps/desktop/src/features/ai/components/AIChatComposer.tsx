import { useEffect, useMemo, useRef, useState } from "react";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { FILE_TREE_NOTE_DRAG_EVENT, type FileTreeNoteDragDetail } from "../dragEvents";
import { getWikilinkSuggestions } from "../../editor/extensions/wikilinkSuggester";
import {
    appendMentionParts,
    normalizeComposerParts,
    serializeComposerParts,
} from "../composerParts";
import {
    AIChatCommandPicker,
    type AIChatSlashCommand,
} from "./AIChatCommandPicker";
import { AIChatMentionPicker } from "./AIChatMentionPicker";
import type {
    AIChatNoteSummary,
    AIChatSessionStatus,
    AIComposerPart,
    AIMentionSuggestion,
} from "../types";
import type { ReactNode } from "react";

interface AIChatComposerProps {
    parts: AIComposerPart[];
    notes: AIChatNoteSummary[];
    status: AIChatSessionStatus;
    runtimeName: string;
    disabled?: boolean;
    contextBar?: ReactNode;
    footer?: ReactNode;
    onChange: (parts: AIComposerPart[]) => void;
    onMentionAttach: (note: AIChatNoteSummary) => void;
    onFolderAttach: (folderPath: string, name: string) => void;
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

const SLASH_COMMANDS: AIChatSlashCommand[] = [
    {
        id: "init",
        label: "/init",
        description: "Generate starter instructions for the current workspace.",
        insertText: "/init ",
    },
    {
        id: "review",
        label: "/review",
        description: "Review current uncommitted changes or add instructions after it.",
        insertText: "/review ",
    },
    {
        id: "review-branch",
        label: "/review-branch",
        description: "Review changes against a base branch.",
        insertText: "/review-branch ",
    },
    {
        id: "review-commit",
        label: "/review-commit",
        description: "Review a specific commit by SHA.",
        insertText: "/review-commit ",
    },
    {
        id: "compact",
        label: "/compact",
        description: "Compact the active thread before continuing.",
        insertText: "/compact",
    },
    {
        id: "undo",
        label: "/undo",
        description: "Ask Codex to undo the last change.",
        insertText: "/undo",
    },
    {
        id: "logout",
        label: "/logout",
        description: "Log out the current Codex account for this runtime.",
        insertText: "/logout",
    },
];

function createMentionNode(part: Extract<AIComposerPart, { type: "mention" }>) {
    const element = document.createElement("span");
    element.dataset.kind = "mention";
    element.dataset.noteId = part.noteId;
    element.dataset.label = part.label;
    element.dataset.path = part.path;
    element.contentEditable = "false";
    element.textContent = part.label;
    element.style.display = "inline-flex";
    element.style.alignItems = "center";
    element.style.padding = "1px 6px";
    element.style.margin = "0 1px";
    element.style.borderRadius = "4px";
    element.style.border = "none";
    element.style.background =
        "color-mix(in srgb, var(--accent) 15%, transparent)";
    element.style.color = "var(--accent)";
    element.style.fontSize = "0.88em";
    element.style.lineHeight = "1.3";
    element.style.verticalAlign = "baseline";
    element.style.whiteSpace = "nowrap";
    return element;
}

function createFolderMentionNode(part: Extract<AIComposerPart, { type: "folder_mention" }>) {
    const element = document.createElement("span");
    element.dataset.kind = "folder_mention";
    element.dataset.folderPath = part.folderPath;
    element.dataset.label = part.label;
    element.contentEditable = "false";
    element.textContent = `📁 ${part.label}`;
    element.style.display = "inline-flex";
    element.style.alignItems = "center";
    element.style.padding = "1px 6px";
    element.style.margin = "0 1px";
    element.style.borderRadius = "4px";
    element.style.border = "none";
    element.style.background =
        "color-mix(in srgb, var(--accent) 15%, transparent)";
    element.style.color = "var(--accent)";
    element.style.fontSize = "0.88em";
    element.style.lineHeight = "1.3";
    element.style.verticalAlign = "baseline";
    element.style.whiteSpace = "nowrap";
    return element;
}

function readPartsFromDom(root: HTMLElement): AIComposerPart[] {
    const parts: AIComposerPart[] = [];

    root.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push({
                id: crypto.randomUUID(),
                type: "text",
                text: node.textContent ?? "",
            });
            return;
        }

        if (node instanceof HTMLElement) {
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
            } else if (
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
            }
        }
    });

    return normalizeComposerParts(parts);
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

function syncComposerDom(root: HTMLDivElement, parts: AIComposerPart[]) {
    root.replaceChildren();

    for (const part of parts) {
        if (part.type === "text") {
            root.append(document.createTextNode(part.text));
        } else if (part.type === "mention") {
            root.append(createMentionNode(part));
        } else if (part.type === "folder_mention") {
            root.append(createFolderMentionNode(part));
        }
    }
}

function isMentionElement(node: Node): node is HTMLElement {
    return (
        node instanceof HTMLElement &&
        (node.dataset.kind === "mention" || node.dataset.kind === "folder_mention")
    );
}

function removeAdjacentMention(root: HTMLDivElement) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;

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

function extractFolderPaths(notes: AIChatNoteSummary[]): string[] {
    const folders = new Set<string>();
    for (const note of notes) {
        const parts = note.id.split("/");
        for (let i = 1; i < parts.length; i++) {
            folders.add(parts.slice(0, i).join("/"));
        }
    }
    return [...folders].sort();
}

function normalizeForSearch(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function getMentionSuggestions(
    notes: AIChatNoteSummary[],
    folderPaths: string[],
    query: string,
    limit = 10,
): AIMentionSuggestion[] {
    const nq = normalizeForSearch(query);
    const results: AIMentionSuggestion[] = [];

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
    const noteSuggestions = getWikilinkSuggestions(notes, query, limit);
    for (const item of noteSuggestions) {
        const note = notes.find((n) => n.id === item.id);
        if (note) results.push({ kind: "note", note });
    }

    // Folders first, then notes, limited
    return results.slice(0, limit);
}

export function AIChatComposer({
    parts,
    notes,
    status,
    runtimeName,
    disabled = false,
    contextBar,
    footer,
    onChange,
    onMentionAttach,
    onFolderAttach,
    onSubmit,
    onStop,
}: AIChatComposerProps) {
    const composerRef = useRef<HTMLDivElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const [mentionState, setMentionState] = useState<MentionState>(
        EMPTY_MENTION_STATE,
    );
    const [slashState, setSlashState] = useState<SlashState>(EMPTY_SLASH_STATE);
    const [externalDragActive, setExternalDragActive] = useState(false);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<ComposerContextMenuPayload> | null>(null);
    const serializedValue = useMemo(() => serializeComposerParts(parts), [parts]);
    const folderPaths = useMemo(() => extractFolderPaths(notes), [notes]);

    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;

        if (serializeComposerParts(readPartsFromDom(composer)) === serializedValue) {
            return;
        }

        syncComposerDom(composer, parts);
    }, [parts, serializedValue]);

    const isStreaming = status === "streaming";
    const isEmpty = serializedValue.length === 0;

    const closeMentionPicker = () => setMentionState(EMPTY_MENTION_STATE);
    const closeSlashPicker = () => setSlashState(EMPTY_SLASH_STATE);

    const syncFromDom = () => {
        const composer = composerRef.current;
        if (!composer) return;
        onChange(readPartsFromDom(composer));
    };

    const updateMentionPicker = () => {
        const composer = composerRef.current;
        const selection = window.getSelection();
        if (!composer || !selection || !selection.rangeCount || !selection.isCollapsed) {
            closeMentionPicker();
            return;
        }

        const range = selection.getRangeAt(0);
        const anchorNode = range.startContainer;

        if (!composer.contains(anchorNode)) {
            closeMentionPicker();
            return;
        }

        if (anchorNode.nodeType !== Node.TEXT_NODE) {
            closeMentionPicker();
            return;
        }

        const textNode = anchorNode as Text;
        const textBeforeCaret = textNode.data.slice(0, range.startOffset);
        const match = textBeforeCaret.match(/(^|\s)@([^\s@]*)$/);
        if (!match) {
            closeMentionPicker();
            return;
        }

        const query = match[2] ?? "";
        const suggestions = getMentionSuggestions(notes, folderPaths, query, 10);

        const mentionRange = document.createRange();
        mentionRange.setStart(textNode, range.startOffset - query.length - 1);
        mentionRange.setEnd(textNode, range.startOffset);

        const rect = mentionRange.getBoundingClientRect();
        setMentionState({
            open: true,
            query,
            selectedIndex: 0,
            items: suggestions,
            x: rect.left,
            y: rect.top,
            range: mentionRange.cloneRange(),
        });
    };

    const updateSlashPicker = () => {
        const composer = composerRef.current;
        const selection = window.getSelection();
        if (!composer || !selection || !selection.rangeCount || !selection.isCollapsed) {
            closeSlashPicker();
            return;
        }

        const range = selection.getRangeAt(0);
        const anchorNode = range.startContainer;

        if (!composer.contains(anchorNode) || anchorNode.nodeType !== Node.TEXT_NODE) {
            closeSlashPicker();
            return;
        }

        const textNode = anchorNode as Text;
        const textBeforeCaret = textNode.data.slice(0, range.startOffset);
        const match = textBeforeCaret.match(/(^|\s)\/([^\s/]*)$/);
        if (!match) {
            closeSlashPicker();
            return;
        }

        const query = match[2] ?? "";
        const items = SLASH_COMMANDS.filter((command) =>
            command.id.toLowerCase().includes(query.toLowerCase()),
        );

        const slashRange = document.createRange();
        slashRange.setStart(textNode, range.startOffset - query.length - 1);
        slashRange.setEnd(textNode, range.startOffset);

        const rect = slashRange.getBoundingClientRect();
        setSlashState({
            open: true,
            query,
            selectedIndex: 0,
            items,
            x: rect.left,
            y: rect.top,
            range: slashRange.cloneRange(),
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
            span = createMentionNode({
                id: crypto.randomUUID(),
                type: "mention",
                noteId: item.note.id,
                label: item.note.title,
                path: item.note.path,
            });
        } else {
            span = createFolderMentionNode({
                id: crypto.randomUUID(),
                type: "folder_mention",
                folderPath: item.folderPath,
                label: item.name,
            });
        }

        const trailingSpace = document.createTextNode(" ");
        targetRange.deleteContents();
        targetRange.insertNode(trailingSpace);
        targetRange.insertNode(span);
        setCaretAfterNode(trailingSpace);
        syncFromDom();

        if (item.kind === "note") {
            onMentionAttach(item.note);
        } else {
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
        const textNode = document.createTextNode(command.insertText);
        targetRange.insertNode(textNode);
        setCaretAfterNode(textNode);
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

            if (detail.phase === "end") {
                setExternalDragActive(false);
                if (!isOver) return;

                // Folder drop
                if (detail.folder) {
                    onFolderAttach(detail.folder.path, detail.folder.name);
                    window.setTimeout(() => {
                        composerRef.current?.focus();
                    }, 0);
                    return;
                }

                // Notes drop
                if (detail.notes.length === 0) return;
                onChange(
                    appendMentionParts(
                        parts,
                        detail.notes.map((note) => ({
                            noteId: note.id,
                            label: note.title,
                            path: note.path,
                        })),
                    ),
                );
                detail.notes.forEach((note) => onMentionAttach(note));
                window.setTimeout(() => {
                    composerRef.current?.focus();
                }, 0);
            }
        };

        window.addEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleDrag);
        return () =>
            window.removeEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleDrag);
    }, [onChange, onMentionAttach, parts]);

    return (
        <div ref={shellRef} className="flex flex-col">
            {contextBar ? (
                <div className="px-3 pb-1.5">{contextBar}</div>
            ) : null}
            <div
                className="relative flex flex-col"
                style={{
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
                    boxShadow: externalDragActive
                        ? "0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent)"
                        : "none",
                    transition: "box-shadow 0.15s ease",
                }}
            >
                {isEmpty && (
                    <div
                        className="pointer-events-none absolute left-3.5 top-2.5 text-sm"
                        style={{ color: "var(--text-secondary)", opacity: 0.6 }}
                    >
                        Message {runtimeName} — @ to include context, / for commands
                    </div>
                )}
                <div
                    ref={composerRef}
                    contentEditable={!disabled}
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label="Message VaultAI"
                    onContextMenu={(event) => {
                        event.preventDefault();
                        const composer = composerRef.current;
                        const selection = window.getSelection();
                        const hasSelection =
                            !!composer &&
                            !!selection &&
                            !selection.isCollapsed &&
                            composer.contains(selection.anchorNode);
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload: {
                                hasSelection,
                                hasContent: serializedValue.trim().length > 0,
                            },
                        });
                    }}
                    onPaste={(event) => {
                        event.preventDefault();
                        const text = event.clipboardData.getData("text/plain");
                        if (text && composerRef.current) {
                            insertPlainTextAtSelection(composerRef.current, text);
                            syncFromDom();
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
                                            : (state.selectedIndex + 1) % state.items.length,
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
                                            : (state.selectedIndex - 1 + state.items.length) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "Enter") {
                                if (slashState.items.length > 0) {
                                    event.preventDefault();
                                    insertSlashCommand(
                                        slashState.items[slashState.selectedIndex]!,
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
                                            : (state.selectedIndex - 1 + state.items.length) %
                                              state.items.length,
                                }));
                                return;
                            }

                            if (event.key === "Enter") {
                                if (mentionState.items.length > 0) {
                                    event.preventDefault();
                                    insertMentionSuggestion(
                                        mentionState.items[mentionState.selectedIndex]!,
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

                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (isStreaming) onStop();
                            else onSubmit();
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
                    className="w-full whitespace-pre-wrap break-words text-sm"
                    style={{
                        color: "var(--text-primary)",
                        backgroundColor: "transparent",
                        border: "none",
                        outline: "none",
                        minHeight: 64,
                        maxHeight: 200,
                        overflowY: "auto",
                        padding: "10px 14px",
                        lineHeight: 1.5,
                        opacity: disabled ? 0.6 : 1,
                        cursor: disabled ? "default" : "text",
                    }}
                />
                <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
                    <div className="min-w-0 flex-1">{footer}</div>
                    <button
                        type="button"
                        onClick={isStreaming ? onStop : onSubmit}
                        disabled={disabled || (isEmpty && !isStreaming)}
                        className="flex shrink-0 items-center justify-center rounded-full"
                        style={{
                            width: 28,
                            height: 28,
                            color: isStreaming ? "#fff" : isEmpty ? "var(--text-secondary)" : "#fff",
                            backgroundColor: isStreaming
                                ? "#b91c1c"
                                : isEmpty
                                  ? "transparent"
                                  : "var(--accent)",
                            border: "none",
                            opacity: disabled || (isEmpty && !isStreaming) ? 0.4 : 1,
                            transition: "all 0.15s ease",
                        }}
                        aria-label={isStreaming ? "Stop" : "Send"}
                    >
                        {isStreaming ? (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                                <rect x="2" y="2" width="10" height="10" rx="2" />
                            </svg>
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 12V4M4 7l4-3 4 3" />
                            </svg>
                        )}
                    </button>
                </div>
                <AIChatMentionPicker
                    open={mentionState.open}
                    x={mentionState.x}
                    y={mentionState.y}
                    query={mentionState.query}
                    selectedIndex={mentionState.selectedIndex}
                    items={mentionState.items}
                    anchorElement={composerRef.current}
                    onHoverIndex={(index) =>
                        setMentionState((state) => ({ ...state, selectedIndex: index }))
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
                    anchorElement={composerRef.current}
                    onHoverIndex={(index) =>
                        setSlashState((state) => ({ ...state, selectedIndex: index }))
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
            </div>
        </div>
    );
}
