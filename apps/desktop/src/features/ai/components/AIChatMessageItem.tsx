import {
    memo,
    useCallback,
    useMemo,
    useState,
    type MouseEvent,
    type ReactElement,
} from "react";
import { openPath, revealItemInDir } from "@neverwrite/runtime";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import type {
    AIChatAttachment,
    AIChatMessage,
    AIFileDiff,
    AIPermissionOption,
    AIUrlElicitationAction,
    AIUserInputAction,
} from "../types";
import { ChatInlinePill } from "./ChatInlinePill";
import { ChatVaultReference } from "./ChatVaultReference";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatPillMetrics } from "./chatPillMetrics";
import type { ChatPillVariant } from "./chatPillPalette";
import { useChatStore } from "../store/chatStore";
import { selectVisibleTrackedFiles } from "../store/editedFilesBufferModel";
import {
    computeDiffStats,
    computeFileDiffStats,
    formatDiffStat,
    getFileNameFromPath,
} from "../diff/reviewDiff";
import { deriveChatChangeReviewDiffs } from "../diff/chatChangeReviewModel";
import { decodeSerializedPillValue } from "../composerParts";
import { DiffZoomControls } from "./DiffZoomControls";
import { EditedFileDiffPreview } from "./editedFilesPresentation";
import { openChatNoteByReference } from "../chatNoteNavigation";
import {
    canOpenAiEditedFileByAbsolutePath,
    openAiEditedFileByAbsolutePath,
} from "../chatFileNavigation";
import {
    getChatVaultReferenceBasename,
    parseChatVaultReferenceTarget,
} from "../chatVaultReferenceTarget";
import { useEditorStore } from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { toVaultRelativePath } from "../../../app/utils/vaultPaths";
import {
    buildLocalAiAttachmentPreviewUrl,
    buildCodexGeneratedImagePreviewUrl,
    buildVaultPreviewUrlFromAbsolutePath,
} from "../../../app/utils/filePreviewUrl";
import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { ChangeReviewToolRail } from "./ChangeReviewToolRail";
import { ResizableDiffContainer } from "./ResizableDiffContainer";
import {
    OpenSessionActionButton,
    ToolActivityItem,
    ToolIcon,
    type ToolTargetContextMenuPayload,
} from "./ToolActivityItem";
import { isActivityTimelineEntry } from "./activityTimelinePresentation";
import {
    useChatRowUiEntry,
    useStoredRowExpanded,
} from "./chatRowUiPresentation";

interface UserMentionContextMenuPayload {
    label: string;
    kind: "note" | "file";
    path?: string;
}

function isImageFileAttachment(attachment: AIChatAttachment) {
    return (
        attachment.type === "file" &&
        Boolean(attachment.filePath) &&
        attachment.mimeType?.startsWith("image/") === true
    );
}

function fileNameFromPath(path: string) {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isLocalAiAttachmentPreviewUrl(
    previewUrl: string | null,
    vaultPreviewUrl: string | null,
) {
    return !vaultPreviewUrl && previewUrl?.includes("/ai-attachment/") === true;
}

async function validateLocalAiAttachmentPreview(previewUrl: string | null) {
    if (!previewUrl) return false;
    try {
        const response = await fetch(previewUrl, { cache: "no-store" });
        return response.ok;
    } catch {
        return false;
    }
}

function UserMessageAttachmentThumbnail({
    attachment,
    vaultPath,
}: {
    attachment: AIChatAttachment;
    vaultPath: string | null;
}) {
    const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(
        null,
    );
    const [validatedLocalPreviewUrl, setValidatedLocalPreviewUrl] = useState<
        string | null
    >(null);
    const [copied, setCopied] = useState(false);
    const filePath = attachment.filePath;
    if (!filePath) return null;

    const vaultPreviewUrl = buildVaultPreviewUrlFromAbsolutePath(
        filePath,
        vaultPath,
    );
    const previewUrl =
        vaultPreviewUrl ?? buildLocalAiAttachmentPreviewUrl(filePath, vaultPath);
    const isLocalAiAttachmentPreview = isLocalAiAttachmentPreviewUrl(
        previewUrl,
        vaultPreviewUrl,
    );
    const unavailable = !previewUrl || failedPreviewUrl === previewUrl;
    const label = attachment.label || fileNameFromPath(filePath);
    const fileName = fileNameFromPath(filePath);

    const copyPath = () => {
        void navigator.clipboard?.writeText(filePath).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        });
    };

    const ensureLocalAiAttachmentValidated = async () => {
        if (!isLocalAiAttachmentPreview || !previewUrl) return false;
        if (validatedLocalPreviewUrl === previewUrl) return true;

        if (await validateLocalAiAttachmentPreview(previewUrl)) {
            setValidatedLocalPreviewUrl(previewUrl);
            return true;
        }

        setFailedPreviewUrl(previewUrl);
        return false;
    };

    const openInApp = async () => {
        const relativePath = toVaultRelativePath(filePath, vaultPath);
        if (!relativePath) {
            if (await ensureLocalAiAttachmentValidated()) {
                void openPath(filePath);
            }
            return;
        }
        useEditorStore.getState().openFile(
            relativePath,
            fileName,
            filePath,
            "",
            attachment.mimeType ?? "image/*",
            "image",
            { contentTruncated: false },
        );
    };

    const revealFile = async () => {
        const relativePath = toVaultRelativePath(filePath, vaultPath);
        if (
            relativePath ||
            (await ensureLocalAiAttachmentValidated())
        ) {
            void revealItemInDir(filePath);
        } else {
            setFailedPreviewUrl(previewUrl);
        }
    };

    return (
        <div
            className="flex min-w-0 items-stretch overflow-hidden rounded-md"
            style={{
                border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
                backgroundColor:
                    "color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-tertiary))",
            }}
        >
            <div
                className="flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden"
                style={{
                    backgroundColor: "var(--bg-primary)",
                    borderRight: "1px solid var(--border)",
                }}
            >
                {unavailable ? (
                    <div
                        className="px-2 text-center font-medium"
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.74em",
                            lineHeight: 1.2,
                        }}
                    >
                        Image unavailable
                    </div>
                ) : (
                    <img
                        src={previewUrl}
                        alt={label}
                        title={filePath}
                        className="block h-full w-full"
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => {
                            if (isLocalAiAttachmentPreview) {
                                setValidatedLocalPreviewUrl(previewUrl);
                            }
                            if (failedPreviewUrl === previewUrl) {
                                setFailedPreviewUrl(null);
                            }
                        }}
                        onError={() => setFailedPreviewUrl(previewUrl)}
                        style={{ objectFit: "cover" }}
                    />
                )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col justify-between gap-2 px-2.5 py-2">
                <div className="min-w-0">
                    <div
                        className="truncate font-medium"
                        title={filePath}
                        style={{
                            color: "var(--text-primary)",
                            fontSize: "0.82em",
                        }}
                    >
                        {label}
                    </div>
                    <div
                        className="truncate"
                        title={attachment.mimeType ?? undefined}
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.72em",
                            opacity: 0.82,
                        }}
                    >
                        {attachment.mimeType ?? "image"}
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    <ImageActionButton
                        icon="open"
                        onClick={() => void openInApp()}
                    >
                        Open
                    </ImageActionButton>
                    <ImageActionButton
                        icon="reveal"
                        onClick={() => void revealFile()}
                    >
                        Reveal in Finder
                    </ImageActionButton>
                    <ImageActionButton
                        icon={copied ? "check" : "copy"}
                        onClick={copyPath}
                    >
                        {copied ? "Copied" : "Copy Path"}
                    </ImageActionButton>
                </div>
            </div>
        </div>
    );
}

function UserMessageAttachments({
    attachments,
}: {
    attachments?: AIChatAttachment[];
}) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const imageAttachments = (attachments ?? []).filter(isImageFileAttachment);
    if (imageAttachments.length === 0) return null;

    return (
        <div className="mt-2 flex max-w-full flex-col gap-1.5">
            {imageAttachments.map((attachment) => (
                <UserMessageAttachmentThumbnail
                    key={attachment.id}
                    attachment={attachment}
                    vaultPath={vaultPath}
                />
            ))}
        </div>
    );
}

/** Parse @mentions and @fetch in serialized user messages into styled pills. */
function renderUserContent(
    text: string,
    pillMetrics: ChatPillMetrics,
    onMentionContextMenu: (
        event: MouseEvent<HTMLElement>,
        payload: UserMentionContextMenuPayload,
    ) => void,
    attachments: AIChatAttachment[] = [],
): Array<string | ReactElement> {
    const parts: Array<string | ReactElement> = [];
    const unmatchedFileAttachments = attachments.filter(
        (attachment) =>
            attachment.type === "file" && Boolean(attachment.filePath),
    );
    const takeFileAttachment = (label: string) => {
        const index = unmatchedFileAttachments.findIndex(
            (attachment) => attachment.label === label,
        );
        if (index < 0) return null;
        return unmatchedFileAttachments.splice(index, 1)[0] ?? null;
    };
    // New bracketed format: [@note], [@📄 /path/file.ts], [@📁 folder], [Screenshot ...], [📎 file]
    // Escaped variants use a pipe plus URL-encoded payload, e.g. [@|%5B%20%5D].
    // Legacy format (backward compat): @fetch, /plan, @📁word, @word
    const mentionRegex =
        /(\[@📄\|[^\]]+\]|\[@📄 [^\]]+\]|\[@📁\|[^\]]+\]|\[@📁 [^\]]+\]|\[@\|[^\]]+\]|\[@[^\]]+\]|\[Screenshot\|[^\]]+\]|\[Screenshot [^\]]+\]|\[📎\|[^\]]+\]|\[📎 [^\]]+\]|@fetch\b|\/plan\b|@📁[^\s]+|@[^\s@]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = mentionRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(text.slice(lastIndex, match.index));
        }

        const token = match[0];

        if (token.startsWith("[Screenshot ") || token.startsWith("[Screenshot|")) {
            const pillLabel = token.startsWith("[Screenshot|")
                ? decodeSerializedPillValue(token.slice(12, -1))
                : token.slice(1, -1); // strip [ ]
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label={pillLabel}
                    metrics={pillMetrics}
                    variant="file"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token.startsWith("[📎 ") || token.startsWith("[📎|")) {
            const fileLabel = token.startsWith("[📎|")
                ? decodeSerializedPillValue(token.slice(4, -1))
                : token.slice(4, -1);
            const attachment = takeFileAttachment(fileLabel);
            const filePath = attachment?.filePath ?? fileLabel;
            const canOpen = Boolean(
                attachment?.filePath &&
                    canOpenAiEditedFileByAbsolutePath(attachment.filePath),
            );
            parts.push(
                <ChatVaultReference
                    key={key++}
                    kind="file"
                    label={fileLabel}
                    metrics={pillMetrics}
                    mimeType={attachment?.mimeType}
                    interactive={canOpen}
                    path={filePath}
                    onClick={
                        canOpen
                            ? () => {
                                  void openAiEditedFileByAbsolutePath(filePath);
                              }
                            : undefined
                    }
                    onContextMenu={
                        canOpen
                            ? (event) =>
                                  onMentionContextMenu(event, {
                                      kind: "file",
                                      label: fileLabel,
                                      path: filePath,
                                  })
                            : undefined
                    }
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token === "/plan") {
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label="/plan"
                    metrics={pillMetrics}
                    variant="neutral"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token === "@fetch") {
            parts.push(
                <ChatInlinePill
                    key={key++}
                    label="@fetch"
                    metrics={pillMetrics}
                    variant="success"
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token.startsWith("[@📁 ")) {
            const folderLabel = token.slice(5, -1); // strip [@📁 and ]
            parts.push(
                <ChatVaultReference
                    key={key++}
                    kind="folder"
                    label={folderLabel}
                    metrics={pillMetrics}
                    path={folderLabel}
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token.startsWith("[@📁|")) {
            const folderLabel = decodeSerializedPillValue(token.slice(5, -1));
            parts.push(
                <ChatVaultReference
                    key={key++}
                    kind="folder"
                    label={folderLabel}
                    metrics={pillMetrics}
                    path={folderLabel}
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        if (token.startsWith("[@📄 ") || token.startsWith("[@📄|")) {
            const filePath = (
                token.startsWith("[@📄|")
                    ? decodeSerializedPillValue(token.slice(5, -1))
                    : token.slice(4, -1)
                ).trim();
            const target = parseChatVaultReferenceTarget(filePath);
            const fileLabel = getChatVaultReferenceBasename(target.path);
            parts.push(
                <ChatVaultReference
                    key={key++}
                    kind="file"
                    label={fileLabel}
                    line={target.line}
                    endLine={target.endLine}
                    metrics={pillMetrics}
                    interactive
                    path={filePath}
                    onClick={() => {
                        void openAiEditedFileByAbsolutePath(filePath);
                    }}
                    onContextMenu={(event) =>
                        onMentionContextMenu(event, {
                            kind: "file",
                            label: fileLabel,
                            path: filePath,
                        })
                    }
                />,
            );
            lastIndex = match.index + token.length;
            continue;
        }

        // [@NoteName] (new) or @NoteName (legacy) — note/folder mention
        let noteLabel: string;
        let variant: ChatPillVariant = "accent";
        if (token.startsWith("[@|")) {
            noteLabel = decodeSerializedPillValue(token.slice(3, -1));
        } else if (token.startsWith("[@")) {
            noteLabel = token.slice(2, -1); // strip [@ and ]
        } else if (token.startsWith("@📁")) {
            noteLabel = token.slice(2).replace(/^\s*/u, ""); // strip @📁
            variant = "folder";
        } else {
            noteLabel = token.slice(1); // strip @
        }
        const target = parseChatVaultReferenceTarget(noteLabel);
        const isNote = variant === "accent";
        parts.push(
            <ChatVaultReference
                key={key++}
                kind={isNote ? "note" : "folder"}
                label={
                    target.line
                        ? getChatVaultReferenceBasename(target.path)
                        : noteLabel
                }
                line={target.line}
                endLine={target.endLine}
                metrics={pillMetrics}
                interactive={isNote}
                path={target.path}
                onClick={
                    isNote
                        ? () => {
                              void openChatNoteByReference(noteLabel);
                          }
                        : undefined
                }
                onContextMenu={
                    isNote
                        ? (event) =>
                              onMentionContextMenu(event, {
                                  kind: "note",
                                  label: noteLabel,
                              })
                        : undefined
                }
            />,
        );

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }

    return parts;
}

function UserTextMessage({
    message,
    pillMetrics,
}: {
    message: AIChatMessage;
    pillMetrics: ChatPillMetrics;
}) {
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<UserMentionContextMenuPayload> | null>(null);
    const [copied, setCopied] = useState(false);
    const formattedTime = formatUserMessageTime(message.timestamp);
    const canCopy = message.content.trim().length > 0;

    const copyMessage = () => {
        if (!canCopy) return;

        void navigator.clipboard.writeText(message.content).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };

    return (
        <div
            className="min-w-0 w-full max-w-full"
            data-user-message="true"
        >
            <div
                className="ml-auto min-w-0 w-[70%] max-w-full whitespace-pre-wrap rounded-lg px-3 py-2"
                data-user-message-bubble="true"
                style={{
                    color: "var(--text-primary)",
                    backgroundColor:
                        "color-mix(in srgb, var(--accent) 5%, var(--bg-tertiary))",
                    border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {renderUserContent(
                    message.content,
                    pillMetrics,
                    (event, payload) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload,
                        });
                    },
                    message.attachments,
                )}
                <UserMessageAttachments attachments={message.attachments} />
            </div>
            <div
                className="mt-1 flex min-h-5 items-center justify-end gap-1.5 px-0.5 text-text-secondary"
                data-user-message-metadata="true"
                style={{
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    fontSize: "10px",
                    opacity: 0.72,
                }}
            >
                {formattedTime ? (
                    <time dateTime={new Date(message.timestamp).toISOString()}>
                        {formattedTime}
                    </time>
                ) : null}
                {canCopy ? (
                    <button
                        aria-label={copied ? "Message copied" : "Copy message"}
                        className="flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--accent)]"
                        onClick={copyMessage}
                        style={copied ? { color: "var(--diff-add)" } : undefined}
                        title={copied ? "Copied" : "Copy message"}
                        type="button"
                    >
                        {copied ? <CopySuccessIcon /> : <CopyMessageIcon />}
                    </button>
                ) : null}
            </div>
            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={
                        contextMenu.payload.kind === "file" &&
                        contextMenu.payload.path
                            ? [
                                  {
                                      label: "Open",
                                      action: () => {
                                          void openAiEditedFileByAbsolutePath(
                                              contextMenu.payload.path!,
                                          );
                                      },
                                  },
                                  {
                                      label: "Open in New Tab",
                                      action: () => {
                                          void openAiEditedFileByAbsolutePath(
                                              contextMenu.payload.path!,
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
                                              contextMenu.payload.label,
                                          );
                                      },
                                  },
                                  {
                                      label: "Open in New Tab",
                                      action: () => {
                                          void openChatNoteByReference(
                                              contextMenu.payload.label,
                                              { newTab: true },
                                          );
                                      },
                                  },
                              ]
                    }
                />
            ) : null}
        </div>
    );
}

function formatUserMessageTime(timestamp: number) {
    if (!Number.isFinite(timestamp)) {
        return null;
    }

    return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
    }).format(timestamp);
}

function CopyMessageIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
            width="12"
        >
            <rect height="13" rx="2" width="13" x="8" y="8" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </svg>
    );
}

function CopySuccessIcon() {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
            width="12"
        >
            <path d="m5 12 4 4L19 6" />
        </svg>
    );
}

interface AIChatMessageItemProps {
    message: AIChatMessage;
    sessionId?: string | null;
    readOnly?: boolean;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
    visibleWorkCycleId?: string | null;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
        action?: AIUserInputAction,
    ) => void;
    onUrlElicitationOpen?: (requestId: string) => void;
    onUrlElicitationResponse?: (
        requestId: string,
        action: AIUrlElicitationAction,
    ) => void;
    onDismissMessage?: (messageId: string) => void;
}

function stripMarkdownBold(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

type DiffPresentationMode = "active" | "historical" | "none";

function getDiffPresentationMode(
    message: AIChatMessage,
    visibleWorkCycleId?: string | null,
) {
    if (!message.diffs?.length && !message.reviewDiffs?.length) {
        return "none";
    }

    if (!visibleWorkCycleId || !message.workCycleId) {
        return "active";
    }

    if (message.workCycleId === visibleWorkCycleId) {
        return "active";
    }

    return "historical";
}

function ThinkingMessage({
    message,
    sessionId,
}: {
    message: AIChatMessage;
    sessionId?: string | null;
}) {
    const [expanded, setExpanded] = useStoredRowExpanded(
        sessionId,
        message.id,
        false,
    );
    const content = stripMarkdownBold(message.content).trim();

    return (
        <div
            className="group min-w-0 max-w-full rounded-md px-2 py-1 transition-colors hover:bg-bg-elevated"
            data-reasoning-activity="true"
            style={{ color: "var(--text-secondary)", fontSize: "0.83em" }}
        >
            <button
                type="button"
                onClick={() => {
                    if (content || message.inProgress) setExpanded((v) => !v);
                }}
                className="flex min-h-7 w-full items-center gap-2 text-left"
                style={{
                    color: "var(--text-secondary)",
                    backgroundColor: "transparent",
                    border: "none",
                    cursor:
                        !content && !message.inProgress ? "default" : "pointer",
                    opacity: 0.8,
                    padding: 0,
                }}
            >
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "none",
                        transition: "transform 0.12s ease",
                    }}
                >
                    <path d="M4.5 2.5L8 6L4.5 9.5" />
                </svg>
                <span className="min-w-0 flex-1 truncate font-medium">
                    Reasoning{message.inProgress ? "..." : ""}
                </span>
                {message.inProgress ? (
                    <span
                        aria-label="Reasoning in progress"
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : null}
            </button>
            {expanded && (content || message.inProgress) && (
                <pre
                    className="mt-1 max-h-40 overflow-y-auto rounded px-2 py-1.5"
                    style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                        fontSize: "0.96em",
                        lineHeight: 1.4,
                        margin: 0,
                        overflowWrap: "anywhere",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {content}
                </pre>
            )}
        </div>
    );
}

function ToolMessage({
    message,
    sessionId,
    diffPresentationMode = "active",
}: {
    message: AIChatMessage;
    sessionId?: string | null;
    diffPresentationMode?: DiffPresentationMode;
}) {
    if (
        diffPresentationMode !== "none" &&
        (message.diffs?.length || message.reviewDiffs?.length)
    ) {
        return (
            <ChangeReviewPanel
                message={message}
                sessionId={sessionId}
                readOnly={diffPresentationMode === "historical"}
            />
        );
    }

    return <ToolActivityItem message={message} sessionId={sessionId} />;
}

export function PlanMessage({
    message,
    sessionId,
    pillMetrics,
    chatFontSize = 14,
    onDismiss,
}: {
    message: AIChatMessage;
    sessionId?: string | null;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
    onDismiss?: () => void;
}) {
    const [expanded, setExpanded] = useStoredRowExpanded(
        sessionId,
        message.id,
        true,
    );
    const entries = message.planEntries ?? [];
    const detail = message.planDetail?.trim() || null;
    const completedCount = entries.filter(
        (entry) => entry.status === "completed",
    ).length;
    const inProgress = entries.some((entry) => entry.status === "in_progress");
    const allDone = entries.length > 0 && completedCount === entries.length;
    const statusLabel = allDone
        ? "All Done"
        : inProgress
          ? "In Progress"
          : entries.length > 0
            ? "Planned"
            : "Draft";
    const canExpand = entries.length > 0 || !!detail;

    return (
        <div
            className="chat-plan-frame min-w-0 max-w-full overflow-hidden"
            data-plan-surface="true"
        >
            <div className="flex items-center gap-1 px-2.5 py-2">
                <button
                    type="button"
                    onClick={() => {
                        if (canExpand) setExpanded((value) => !value);
                    }}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left"
                    aria-expanded={expanded}
                    style={{
                        backgroundColor: "transparent",
                        border: "none",
                        cursor: canExpand ? "pointer" : "default",
                    }}
                >
                    <span
                        className="inline-block w-3 shrink-0 text-center"
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            fontWeight: 500,
                            lineHeight: 1.5,
                        }}
                    >
                        {canExpand ? (expanded ? "⌄" : ">") : "·"}
                    </span>
                    <span
                        className="min-w-0 flex-1 font-medium"
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            lineHeight: 1.5,
                        }}
                    >
                        {message.title ?? "Plan"}
                    </span>
                    <span
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.72em",
                        }}
                    >
                        {statusLabel}
                    </span>
                </button>
                {onDismiss ? (
                    <button
                        type="button"
                        aria-label="Dismiss plan banner"
                        title="Dismiss plan banner"
                        onClick={onDismiss}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                        style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                            opacity: 0.72,
                            transition:
                                "opacity 140ms ease, background-color 140ms ease",
                            fontSize: 14,
                            lineHeight: 1,
                        }}
                    >
                        <span aria-hidden="true">×</span>
                    </button>
                ) : null}
            </div>

            {expanded && detail ? (
                <div
                    className="px-7 pb-2"
                >
                    <div
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.78em",
                            lineHeight: 1.45,
                        }}
                    >
                        <MarkdownContent
                            content={detail}
                            pillMetrics={pillMetrics}
                            chatFontSize={chatFontSize}
                            fileReferenceAppearance="link"
                        />
                    </div>
                </div>
            ) : null}

            {expanded && entries.length > 0 ? (
                <div
                    className="activity-tree flex min-w-0 flex-col gap-1.5 px-2.5 pb-2.5"
                    data-plan-tree="true"
                    role="list"
                >
                    {entries.map((entry, index) => {
                        const isCompleted = entry.status === "completed";
                        const isActive = entry.status === "in_progress";
                        return (
                            <div
                                key={`${entry.content}:${index}`}
                                className="activity-tree-branch min-w-0 pl-10"
                                data-activity-rail-decoration="branch"
                                data-plan-entry-status={entry.status}
                                role="listitem"
                                style={{
                                    color: isCompleted
                                        ? "var(--text-secondary)"
                                        : "var(--text-primary)",
                                    opacity: isCompleted ? 0.74 : 1,
                                }}
                            >
                                <div className="flex min-w-0 items-start gap-2 py-0.5">
                                    <span
                                        aria-hidden="true"
                                        className="mt-1 inline-flex h-2 w-2 shrink-0 rounded-full"
                                        style={{
                                            backgroundColor: isCompleted
                                                ? "#84cc16"
                                                : isActive
                                                  ? "var(--accent)"
                                                  : "transparent",
                                            border: isCompleted || isActive
                                                ? "none"
                                                : "1px solid color-mix(in srgb, var(--text-secondary) 58%, transparent)",
                                            opacity: isCompleted ? 0.9 : 0.8,
                                        }}
                                    />
                                    <div
                                        className="min-w-0 flex-1"
                                        style={{
                                            fontSize: "0.76em",
                                            lineHeight: 1.5,
                                            overflowWrap: "anywhere",
                                            wordBreak: "break-word",
                                            textDecoration: isCompleted
                                                ? "line-through"
                                                : "none",
                                        }}
                                    >
                                        {entry.content}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : expanded && !detail ? (
                <div
                    className="px-2.5 pb-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.8em",
                    }}
                >
                    No plan steps yet.
                </div>
            ) : null}

            {expanded && entries.length > 0 ? (
                <div
                    className="px-2.5 pb-1.5 pt-0.5"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.74em",
                        opacity: 0.68,
                    }}
                >
                    {completedCount}/{entries.length}
                </div>
            ) : null}
        </div>
    );
}

function messageMetaString(message: AIChatMessage, key: string): string | null {
    const value = message.meta?.[key];
    return typeof value === "string" && value.trim() ? value : null;
}

type ImageActionIcon = "open" | "reveal" | "copy" | "check";

function ImageActionGlyph({ icon }: { icon: ImageActionIcon }) {
    const common = {
        width: 12,
        height: 12,
        viewBox: "0 0 12 12",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };
    if (icon === "open") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M7 2h3v3" />
                <path d="M10 2L5.5 6.5" />
                <path d="M9 7v2.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H5" />
            </svg>
        );
    }
    if (icon === "reveal") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M1.5 4.2a.7.7 0 0 1 .7-.7h2.3l1 1.2h4.8a.7.7 0 0 1 .7.7v3.9a.7.7 0 0 1-.7.7H2.2a.7.7 0 0 1-.7-.7Z" />
            </svg>
        );
    }
    if (icon === "check") {
        return (
            <svg {...common} aria-hidden="true">
                <path d="M2.5 6.4L4.7 8.6L9.5 3.8" />
            </svg>
        );
    }
    return (
        <svg {...common} aria-hidden="true">
            <rect x="3.5" y="3.5" width="6" height="7" rx="1" />
            <path d="M5 3.5V2.4a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V3.5" />
        </svg>
    );
}

function ImageActionButton({
    children,
    onClick,
    icon,
}: {
    children: string;
    onClick: () => void;
    icon: ImageActionIcon;
}) {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    return (
        <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1 font-medium leading-none transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-95"
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onBlur={() => setPressed(false)}
            style={{
                color: hovered || pressed
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                border: `1px solid color-mix(in srgb, var(--border) ${
                    hovered || pressed ? "100%" : "70%"
                }, transparent)`,
                backgroundColor: pressed
                    ? "color-mix(in srgb, var(--text-primary) 10%, var(--bg-secondary))"
                    : hovered
                      ? "color-mix(in srgb, var(--text-primary) 6%, var(--bg-secondary))"
                      : "transparent",
                fontSize: "0.74em",
            }}
        >
            <ImageActionGlyph icon={icon} />
            <span className="leading-none">{children}</span>
        </button>
    );
}

function GeneratedImageIcon({ stroke = "currentColor" }: { stroke?: string }) {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke={stroke}
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            aria-hidden="true"
        >
            <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
            <circle cx="5" cy="5.75" r="0.9" />
            <path d="M2 10l3-3 2.2 2.2L9.5 7l2.5 2.5" />
        </svg>
    );
}

function GeneratedImageMessage({ message }: { message: AIChatMessage }) {
    const [loadFailed, setLoadFailed] = useState(false);
    const [copied, setCopied] = useState(false);
    const imagePath = messageMetaString(message, "image_path");
    const revisedPrompt = messageMetaString(message, "revised_prompt");
    const status = String(message.meta?.image_status ?? "");
    const isInProgress =
        message.inProgress || status === "pending" || status === "in_progress";
    const isFailed =
        status === "failed" || status === "error" || status === "cancelled";
    const previewUrl =
        imagePath && !isInProgress && !isFailed
            ? buildCodexGeneratedImagePreviewUrl(imagePath)
            : null;
    const title = isFailed
        ? "Image generation failed"
        : isInProgress
          ? "Generating image..."
          : "Generated image";

    const copyPath = useCallback(() => {
        if (!imagePath) return;
        void navigator.clipboard?.writeText(imagePath).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        });
    }, [imagePath]);

    if (isInProgress) {
        return (
            <div
                className="min-w-0 max-w-full rounded-xl px-3 py-2"
                style={{
                    border: "1px solid color-mix(in srgb, var(--accent) 25%, var(--border))",
                    backgroundColor:
                        "color-mix(in srgb, var(--accent) 5%, var(--bg-secondary))",
                }}
            >
                <div
                    className="flex items-center gap-2"
                    style={{ color: "var(--text-primary)" }}
                >
                    <GeneratedImageIcon stroke="var(--accent)" />
                    <span
                        className="font-medium"
                        style={{ fontSize: "0.84em" }}
                    >
                        Generating image...
                    </span>
                </div>
            </div>
        );
    }

    const unavailable = !previewUrl || loadFailed;
    const accent = isFailed ? "#ef4444" : "var(--accent)";
    const subtitle = revisedPrompt;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-xl"
            style={{
                maxWidth: "min(520px, 100%)",
                border: `1px solid color-mix(in srgb, ${accent} 22%, var(--border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 3%, var(--bg-secondary))`,
            }}
        >
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 14%, var(--border))`,
                }}
            >
                <GeneratedImageIcon stroke={accent} />
                <div className="min-w-0 flex-1">
                    <div
                        className="font-medium"
                        style={{
                            color: isFailed ? "#f87171" : "var(--text-primary)",
                            fontSize: "0.84em",
                        }}
                    >
                        {title}
                    </div>
                    {subtitle ? (
                        <div
                            className="truncate"
                            title={imagePath ?? subtitle}
                            style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.74em",
                                opacity: 0.85,
                            }}
                        >
                            {subtitle}
                        </div>
                    ) : null}
                </div>
            </div>

            {unavailable || isFailed ? (
                <div className="px-3 py-3">
                    <div
                        style={{
                            color: isFailed
                                ? "#f87171"
                                : "var(--text-secondary)",
                            fontSize: "0.84em",
                        }}
                    >
                        {isFailed
                            ? message.content || "Image generation failed"
                            : previewUrl
                              ? "Image file could not be loaded"
                              : "Image path is unavailable"}
                    </div>
                    {!isFailed ? (
                        <div
                            className="mt-1"
                            style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.76em",
                                opacity: 0.7,
                            }}
                        >
                            This generated image may have been moved or deleted.
                        </div>
                    ) : null}
                </div>
            ) : (
                <div
                    style={{
                        backgroundColor: "var(--bg-primary)",
                    }}
                >
                    <img
                        src={previewUrl ?? undefined}
                        alt={revisedPrompt ?? "Generated image"}
                        title={imagePath ?? undefined}
                        onError={() => setLoadFailed(true)}
                        className="block w-full"
                        style={{
                            maxHeight: 420,
                            objectFit: "contain",
                            backgroundColor: "var(--bg-primary)",
                        }}
                    />
                </div>
            )}

            {imagePath ? (
                <div
                    className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5"
                    style={{
                        borderTop: `1px solid color-mix(in srgb, ${accent} 12%, var(--border))`,
                    }}
                >
                    <ImageActionButton
                        icon="open"
                        onClick={() => void openPath(imagePath)}
                    >
                        Open Externally
                    </ImageActionButton>
                    <ImageActionButton
                        icon="reveal"
                        onClick={() => void revealItemInDir(imagePath)}
                    >
                        Reveal in Finder
                    </ImageActionButton>
                    <ImageActionButton
                        icon={copied ? "check" : "copy"}
                        onClick={copyPath}
                    >
                        {copied ? "Copied" : "Copy Path"}
                    </ImageActionButton>
                </div>
            ) : null}
        </div>
    );
}

function StatusMessage({ message }: { message: AIChatMessage }) {
    const statusKind = String(message.meta?.status_event ?? "status");
    const status = String(message.meta?.status ?? "");
    const emphasis = String(message.meta?.emphasis ?? "neutral");
    const title = message.title ?? message.content;
    const detail =
        message.content && message.content !== title ? message.content : null;

    if (emphasis === "error" || statusKind === "stream_error") {
        return (
            <div
                className="min-w-0 max-w-full rounded-lg px-2.5 py-2"
                style={{
                    border: "1px solid color-mix(in srgb, #dc2626 30%, var(--border))",
                    backgroundColor:
                        "color-mix(in srgb, #dc2626 8%, transparent)",
                }}
            >
                <div
                    className="flex items-center gap-2"
                    style={{ color: "#f87171" }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <circle cx="7" cy="7" r="5.5" />
                        <path d="M7 4.5v3M7 9.5h.005" />
                    </svg>
                    <span
                        className="font-medium"
                        style={{ fontSize: "0.84em" }}
                    >
                        {title}
                    </span>
                </div>
                {detail && (
                    <div
                        className="mt-1 whitespace-pre-wrap"
                        style={{
                            color: "var(--text-primary)",
                            fontSize: "0.8em",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                        }}
                    >
                        {detail}
                    </div>
                )}
            </div>
        );
    }

    if (statusKind === "model_reroute" || statusKind === "review_mode") {
        const accent = statusKind === "review_mode" ? "#0f766e" : "#0891b2";
        return (
            <div
                className="min-w-0 max-w-full rounded-lg px-2.5 py-2"
                style={{
                    border: `1px solid color-mix(in srgb, ${accent} 28%, var(--border))`,
                    backgroundColor: `color-mix(in srgb, ${accent} 6%, transparent)`,
                }}
            >
                <div
                    className="uppercase tracking-[0.14em] text-xs font-medium"
                    style={{ color: accent }}
                >
                    {title}
                </div>
                {detail && (
                    <div
                        className="mt-1 whitespace-pre-wrap"
                        style={{
                            color: "var(--text-primary)",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            fontSize: "0.83em",
                        }}
                    >
                        {detail}
                    </div>
                )}
            </div>
        );
    }

    const isInProgress = status === "in_progress";
    const isCompleted = status === "completed";

    return (
        <div
            className="min-w-0 max-w-full py-0.5"
            style={{
                color: "var(--text-secondary)",
                opacity: isCompleted ? 0.5 : 0.72,
                fontSize: "0.83em",
            }}
        >
            <div className="flex min-w-0 items-center gap-2">
                {isInProgress ? (
                    <span
                        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full shrink-0"
                        style={{ backgroundColor: "var(--accent)" }}
                    />
                ) : (
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                        style={{ opacity: isCompleted ? 0.8 : 0.55 }}
                    >
                        <circle cx="6" cy="6" r="4" />
                        {isCompleted ? (
                            <path d="M4.2 6.1L5.4 7.3L7.9 4.8" />
                        ) : null}
                    </svg>
                )}
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <OpenSessionActionButton message={message} />
            </div>
            {detail && (
                <div
                    className="mt-0.5 pl-5"
                    style={{
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        opacity: 0.8,
                    }}
                >
                    {detail}
                </div>
            )}
        </div>
    );
}

function ChangeReviewFileRow({
    diff,
    accent,
    expanded,
    onToggle,
    diffZoom,
    lineWrapping,
}: {
    diff: AIFileDiff;
    accent: string;
    expanded: boolean;
    onToggle: () => void;
    diffZoom: number;
    lineWrapping: boolean;
}) {
    const filename = getFileNameFromPath(diff.path);
    const previousFilename = diff.previous_path
        ? getFileNameFromPath(diff.previous_path)
        : diff.previous_path;
    const stats = useMemo(() => computeFileDiffStats(diff), [diff]);

    return (
        <div key={diff.path} className="min-w-0">
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-1.5 px-3 py-1"
                style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 8%, var(--border))`,
                    cursor: "pointer",
                    fontSize: "0.78em",
                    color: "var(--text-secondary)",
                }}
            >
                <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    style={{
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 0.15s ease",
                        flexShrink: 0,
                    }}
                >
                    <path d="M2 1.5L5.5 4L2 6.5" />
                </svg>
                <span
                    style={{
                        color:
                            diff.kind === "add"
                                ? "#16a34a"
                                : diff.kind === "delete"
                                  ? "#dc2626"
                                  : diff.kind === "move"
                                    ? "#c0841a"
                                    : "var(--text-primary)",
                        fontWeight: 500,
                    }}
                >
                    {filename}
                </span>
                <span
                    style={{
                        opacity: 0.5,
                        fontSize: "0.9em",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    <span>
                        {diff.kind === "add"
                            ? "new file"
                            : diff.kind === "delete"
                              ? "deleted"
                              : diff.kind === "move"
                                ? previousFilename
                                    ? `moved from ${previousFilename}`
                                    : "moved"
                                : "modified"}
                    </span>
                    {diff.reversible === false ? (
                        <span
                            className="rounded-full px-1.5 py-0.5"
                            style={{
                                fontSize: "0.82em",
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                color: "#b45309",
                                backgroundColor:
                                    "color-mix(in srgb, #f59e0b 14%, transparent)",
                            }}
                        >
                            partial
                        </span>
                    ) : null}
                </span>
                <span
                    style={{
                        marginLeft: "auto",
                        display: "flex",
                        gap: 6,
                        fontSize: "0.9em",
                    }}
                >
                    {stats.additions > 0 && (
                        <span style={{ color: "#16a34a" }}>
                            +
                            {formatDiffStat(stats.additions, stats.approximate)}
                        </span>
                    )}
                    {stats.deletions > 0 && (
                        <span style={{ color: "#dc2626" }}>
                            -
                            {formatDiffStat(stats.deletions, stats.approximate)}
                        </span>
                    )}
                </span>
            </button>

            {expanded && (
                <ResizableDiffContainer accent={accent}>
                    <EditedFileDiffPreview
                        diff={diff}
                        expanded={expanded}
                        diffZoom={diffZoom}
                        lineWrapping={lineWrapping}
                        testId={`diff-content:${diff.path}`}
                        showWhenEmpty={false}
                        compactLineNumbers
                        compactContextLines={0}
                    />
                </ResizableDiffContainer>
            )}
        </div>
    );
}

function ChangeReviewFileList({
    sessionId,
    messageId,
    diffs,
    accent,
    diffZoom,
    lineWrapping,
}: {
    sessionId?: string | null;
    messageId: string;
    diffs: AIFileDiff[];
    accent: string;
    diffZoom: number;
    lineWrapping: boolean;
}) {
    const { rowState, updateRow } = useChatRowUiEntry(sessionId, messageId);
    const expanded = rowState?.diffExpandedByPath ?? {};

    return (
        <div className="flex flex-col">
            {diffs.map((diff) => {
                return (
                    <ChangeReviewFileRow
                        key={diff.path}
                        diff={diff}
                        accent={accent}
                        diffZoom={diffZoom}
                        lineWrapping={lineWrapping}
                        expanded={expanded[diff.path] ?? false}
                        onToggle={() =>
                            updateRow((current) => ({
                                diffExpandedByPath: {
                                    ...(current.diffExpandedByPath ?? {}),
                                    [diff.path]:
                                        !current.diffExpandedByPath?.[
                                            diff.path
                                        ],
                                },
                            }))
                        }
                    />
                );
            })}
        </div>
    );
}

function getDiffPanelToolLabel(toolKind: string) {
    switch (toolKind) {
        case "edit":
            return "Edit";
        case "delete":
            return "Delete";
        case "move":
            return "Move";
        default:
            return "Change";
    }
}

function PermissionDecisionButton({
    option,
    accent,
    disabled,
    onClick,
    style,
}: {
    option: AIPermissionOption;
    accent: string;
    disabled: boolean;
    onClick: () => void;
    style?: React.CSSProperties;
}) {
    const [hovered, setHovered] = useState(false);
    const isReject = option.kind.startsWith("reject");
    const interactive = !disabled;
    const hovering = hovered && interactive;

    const variantStyle: React.CSSProperties = !interactive
        ? {
              color: "var(--text-secondary)",
              backgroundColor:
                  "color-mix(in srgb, var(--text-secondary) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--text-secondary) 14%, transparent)",
              opacity: 0.5,
              cursor: "default",
          }
        : isReject
          ? {
                color: hovering
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                backgroundColor: hovering
                    ? "color-mix(in srgb, var(--text-primary) 7%, transparent)"
                    : "transparent",
                border: `1px solid color-mix(in srgb, var(--text-secondary) ${
                    hovering ? "32%" : "18%"
                }, transparent)`,
                opacity: 1,
                cursor: "pointer",
            }
          : {
                color: "#fff",
                backgroundColor: hovering
                    ? `color-mix(in srgb, ${accent} 88%, white)`
                    : accent,
                border: "1px solid transparent",
                opacity: 1,
                cursor: "pointer",
            };

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            onMouseEnter={() => interactive && setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors"
            style={{
                fontSize: "0.79em",
                ...variantStyle,
                ...style,
            }}
        >
            <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                {isReject ? (
                    <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" />
                ) : (
                    <path d="M2.5 6.2L4.9 8.6L9.6 3.6" />
                )}
            </svg>
            {option.name}
        </button>
    );
}

function DiffOpenButton({
    accent,
    onClick,
    onContextMenu,
}: {
    accent: string;
    onClick: () => void;
    onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            type="button"
            onClick={onClick}
            onContextMenu={onContextMenu}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="ml-0.5 inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors"
            style={{
                fontSize: "0.76em",
                fontWeight: 500,
                color: accent,
                backgroundColor: hovered
                    ? `color-mix(in srgb, ${accent} 12%, transparent)`
                    : "transparent",
                border: `1px solid ${
                    hovered
                        ? `color-mix(in srgb, ${accent} 28%, var(--border))`
                        : "transparent"
                }`,
                cursor: "pointer",
            }}
        >
            <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M7 2h3v3" />
                <path d="M10 2L5.5 6.5" />
                <path d="M9 7v2.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H5" />
            </svg>
            Open
        </button>
    );
}

function ChangeReviewPanel({
    message,
    sessionId,
    onPermissionResponse,
    readOnly = false,
}: {
    message: AIChatMessage;
    sessionId?: string | null;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    readOnly?: boolean;
}) {
    const messageReviewDiffs = message.reviewDiffs;
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const trackedFiles = useChatStore((state) =>
        selectVisibleTrackedFiles(state, sessionId ?? null),
    );
    const diffs = useMemo(
        () =>
            messageReviewDiffs ??
            deriveChatChangeReviewDiffs(
                message.diffs ?? [],
                trackedFiles,
                vaultPath,
            ),
        [message.diffs, messageReviewDiffs, trackedFiles, vaultPath],
    );
    const editDiffZoom = useChatStore((state) => state.editDiffZoom);
    const setEditDiffZoom = useChatStore((state) => state.setEditDiffZoom);
    const lineWrapping = useSettingsStore((state) => state.lineWrapping);
    const toolKind = String(message.meta?.tool ?? "");
    const isToolMessage = message.kind === "tool";
    const accent = isToolMessage
        ? toolKind === "delete"
            ? "#ef4444"
            : "#6b7280"
        : "#d97706";
    const status = String(message.meta?.status ?? "pending");
    const resolvedOptionId =
        message.meta?.resolved_option !== undefined &&
        message.meta?.resolved_option !== null
            ? String(message.meta.resolved_option)
            : null;
    const resolvedOptionLabel =
        message.permissionOptions?.find((o) => o.option_id === resolvedOptionId)
            ?.name ?? null;
    const isPending = status === "pending";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";

    const stats = computeDiffStats(diffs);
    const fileCount = diffs.length;
    const fileWord = fileCount === 1 ? "file" : "files";
    const target = message.meta?.target ? String(message.meta.target) : null;
    const openFilePath =
        isToolMessage && toolKind !== "delete"
            ? (target ?? (diffs.length === 1 ? diffs[0]?.path : null))
            : null;
    const canOpenFile = openFilePath
        ? canOpenAiEditedFileByAbsolutePath(openFilePath)
        : false;
    const actionLabel = isToolMessage
        ? getDiffPanelToolLabel(toolKind)
        : "Edit";
    const isSingleFile = diffs.length === 1;
    const singleDiff = isSingleFile ? diffs[0] : null;
    const singleFilename = singleDiff
        ? getFileNameFromPath(singleDiff.path)
        : null;
    const singleFileStats = singleDiff
        ? computeFileDiffStats(singleDiff)
        : null;
    const singleFileStatusLabel = singleDiff
        ? singleDiff.kind === "add"
            ? "new file"
            : singleDiff.kind === "delete"
              ? "deleted"
              : singleDiff.kind === "move"
                ? singleDiff.previous_path
                    ? `moved from ${getFileNameFromPath(singleDiff.previous_path)}`
                    : "moved"
                : "modified"
        : null;
    const displayStats =
        isSingleFile && singleFileStats ? singleFileStats : stats;
    const { rowState, updateRow } = useChatRowUiEntry(sessionId, message.id);
    const singleDiffExpanded = rowState?.singleDiffExpanded ?? false;
    const [openFileContextMenu, setOpenFileContextMenu] =
        useState<ContextMenuState<ToolTargetContextMenuPayload> | null>(null);
    if (isToolMessage) {
        return (
            <ChangeReviewToolRail
                diffs={diffs}
                diffZoom={editDiffZoom}
                lineWrapping={lineWrapping}
                message={message}
                onDiffZoomChange={setEditDiffZoom}
                sessionId={sessionId}
            />
        );
    }
    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: `1px solid color-mix(in srgb, ${accent} 25%, var(--border))`,
                backgroundColor: `color-mix(in srgb, ${accent} 4%, var(--bg-secondary))`,
            }}
        >
            {/* Summary bar */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                role={isSingleFile ? "button" : undefined}
                tabIndex={isSingleFile ? 0 : undefined}
                onClick={
                    isSingleFile
                        ? () =>
                              updateRow((current) => ({
                                  singleDiffExpanded: !(
                                      current.singleDiffExpanded ?? false
                                  ),
                              }))
                        : undefined
                }
                onKeyDown={
                    isSingleFile
                        ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  updateRow((current) => ({
                                      singleDiffExpanded: !(
                                          current.singleDiffExpanded ?? false
                                      ),
                                  }));
                              }
                          }
                        : undefined
                }
                style={{
                    borderBottom: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
                    cursor: isSingleFile ? "pointer" : undefined,
                }}
            >
                {/* Chevron for single-file expand/collapse */}
                {isSingleFile && (
                    <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        fill="none"
                        stroke="var(--text-secondary)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        className="shrink-0"
                        style={{
                            display: "block",
                            transform: singleDiffExpanded
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            transition: "transform 0.15s ease",
                        }}
                    >
                        <path d="M2 1.5L5.5 4L2 6.5" />
                    </svg>
                )}
                {isToolMessage ? (
                    isSingleFile && singleDiff?.path ? (
                        <span className="flex shrink-0 items-center">
                            <FileTypeIcon
                                fileName={singleDiff.path}
                                size={13}
                                opacity={0.86}
                            />
                        </span>
                    ) : (
                        <span
                            className="flex shrink-0 items-center"
                            style={{ color: accent }}
                        >
                            <ToolIcon kind={toolKind} />
                        </span>
                    )
                ) : (
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke={accent}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                    >
                        <path d="M7 1L2 12h10L7 1z" />
                        <path d="M7 5.5v2.5" />
                        <circle cx="7" cy="10" r="0.5" fill={accent} />
                    </svg>
                )}
                {isSingleFile ? (
                    <div
                        className="flex min-w-0 items-center gap-1.5"
                        style={{
                            overflow: "hidden",
                            maskImage:
                                "linear-gradient(to right, black calc(100% - 12px), transparent)",
                            WebkitMaskImage:
                                "linear-gradient(to right, black calc(100% - 12px), transparent)",
                        }}
                    >
                        <span
                            className="whitespace-nowrap"
                            style={{
                                overflowX: "auto",
                                scrollbarWidth: "none",
                                color: "var(--text-primary)",
                                fontWeight: 600,
                                fontSize: "0.83em",
                                cursor: canOpenFile ? "context-menu" : "auto",
                            }}
                            onContextMenu={
                                canOpenFile && openFilePath
                                    ? (event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setOpenFileContextMenu({
                                              x: event.clientX,
                                              y: event.clientY,
                                              payload: {
                                                  target: openFilePath,
                                              },
                                          });
                                      }
                                    : undefined
                            }
                        >
                            {`${actionLabel}${actionLabel.endsWith("e") ? "d" : "ed"} ${singleFilename}`}
                        </span>
                        {singleFileStatusLabel &&
                            singleFileStatusLabel !== "modified" && (
                                <span
                                    className="shrink-0 whitespace-nowrap"
                                    style={{
                                        color: "var(--text-secondary)",
                                        fontSize: "0.74em",
                                        opacity: 0.6,
                                    }}
                                >
                                    {singleFileStatusLabel}
                                </span>
                            )}
                        {singleDiff?.reversible === false && (
                            <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 whitespace-nowrap"
                                style={{
                                    fontSize: "0.68em",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                    color: "#b45309",
                                    backgroundColor:
                                        "color-mix(in srgb, #f59e0b 14%, transparent)",
                                }}
                            >
                                partial
                            </span>
                        )}
                    </div>
                ) : (
                    <>
                        <span
                            style={{
                                color: "var(--text-primary)",
                                fontWeight: 600,
                                fontSize: "0.83em",
                            }}
                        >
                            {actionLabel} {fileCount} {fileWord}
                        </span>
                        <span
                            style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.78em",
                                opacity: 0.7,
                            }}
                        >
                            ·
                        </span>
                    </>
                )}
                <span
                    style={{
                        display: "flex",
                        gap: 6,
                        fontSize: "0.78em",
                        flexShrink: 0,
                    }}
                >
                    {displayStats.additions > 0 && (
                        <span style={{ color: "#16a34a", fontWeight: 500 }}>
                            +
                            {formatDiffStat(
                                displayStats.additions,
                                displayStats.approximate,
                            )}
                        </span>
                    )}
                    {displayStats.deletions > 0 && (
                        <span style={{ color: "#dc2626", fontWeight: 500 }}>
                            -
                            {formatDiffStat(
                                displayStats.deletions,
                                displayStats.approximate,
                            )}
                        </span>
                    )}
                </span>
                <div
                    className="ml-auto flex items-center gap-0.5 pl-2"
                    onClick={
                        isSingleFile ? (e) => e.stopPropagation() : undefined
                    }
                >
                    <DiffZoomControls
                        accent={accent}
                        zoom={editDiffZoom}
                        onZoomChange={setEditDiffZoom}
                    />
                    {canOpenFile && openFilePath ? (
                        <DiffOpenButton
                            accent={accent}
                            onClick={() =>
                                void openAiEditedFileByAbsolutePath(
                                    openFilePath,
                                )
                            }
                            onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setOpenFileContextMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    payload: { target: openFilePath },
                                });
                            }}
                        />
                    ) : null}
                </div>
            </div>

            {/* Single-file inline diff preview */}
            {isSingleFile && singleDiff && singleDiffExpanded && (
                <ResizableDiffContainer accent={accent}>
                    <EditedFileDiffPreview
                        diff={singleDiff}
                        expanded={singleDiffExpanded}
                        diffZoom={editDiffZoom}
                        lineWrapping={lineWrapping}
                        testId={`diff-content:${singleDiff.path}`}
                        showWhenEmpty={false}
                        compactLineNumbers
                        compactContextLines={0}
                    />
                </ResizableDiffContainer>
            )}

            {/* File list with expandable diffs (multi-file only) */}
            {!isSingleFile && (
                <ChangeReviewFileList
                    sessionId={sessionId}
                    messageId={message.id}
                    diffs={diffs}
                    accent={accent}
                    diffZoom={editDiffZoom}
                    lineWrapping={lineWrapping}
                />
            )}
            {openFileContextMenu ? (
                <ContextMenu
                    menu={openFileContextMenu}
                    onClose={() => setOpenFileContextMenu(null)}
                    entries={[
                        {
                            label: "Open",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
                                    openFileContextMenu.payload.target,
                                );
                            },
                        },
                        {
                            label: "Open in New Tab",
                            action: () => {
                                void openAiEditedFileByAbsolutePath(
                                    openFileContextMenu.payload.target,
                                    { newTab: true },
                                );
                            },
                        },
                    ]}
                />
            ) : null}

            {/* Actions */}
            {!readOnly &&
            message.permissionRequestId &&
            message.permissionOptions?.length ? (
                <div
                    className="flex items-center gap-2 px-3 py-2"
                    style={{
                        borderTop: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
                    }}
                >
                    {message.permissionOptions.map((option) => {
                        const isReject = option.kind.startsWith("reject");
                        return (
                            <PermissionDecisionButton
                                key={option.option_id}
                                option={option}
                                accent={accent}
                                disabled={!isPending}
                                onClick={() =>
                                    onPermissionResponse?.(
                                        message.permissionRequestId!,
                                        option.option_id,
                                    )
                                }
                                style={
                                    isReject ? undefined : { marginLeft: "auto" }
                                }
                            />
                        );
                    })}
                </div>
            ) : null}

            {/* Status footer */}
            {(isResponding || isResolved) && (
                <div
                    className="px-3 py-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        borderTop: `1px solid color-mix(in srgb, ${accent} 15%, var(--border))`,
                        opacity: 0.7,
                        fontSize: "0.79em",
                    }}
                >
                    {isResponding
                        ? "Sending decision..."
                        : `Decision sent${resolvedOptionLabel ? `: ${resolvedOptionLabel}` : "."}`}
                </div>
            )}
        </div>
    );
}

function ErrorMessage({
    message,
    onDismiss,
}: {
    message: AIChatMessage;
    onDismiss?: (messageId: string) => void;
}) {
    return (
        <div
            className="group flex min-w-0 max-w-full items-start gap-2 rounded-lg px-2.5 py-2 pr-1.5"
            style={{
                color: "#fca5a5",
                backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
                fontSize: "0.85em",
            }}
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0"
                style={{ color: "#f87171" }}
            >
                <circle cx="7" cy="7" r="5.5" />
                <path d="M7 4.5v3M7 9.5h.005" />
            </svg>
            <span
                className="min-w-0 whitespace-pre-wrap"
                style={{
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                }}
            >
                {message.content}
            </span>
            {onDismiss ? (
                <button
                    type="button"
                    aria-label="Dismiss error"
                    title="Dismiss"
                    onClick={() => onDismiss(message.id)}
                    className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                    style={{
                        color: "#fecaca",
                        backgroundColor: "transparent",
                    }}
                    onMouseEnter={(event) => {
                        event.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, #fecaca 12%, transparent)";
                    }}
                    onMouseLeave={(event) => {
                        event.currentTarget.style.backgroundColor =
                            "transparent";
                    }}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                    >
                        <path d="M3 3l6 6M9 3L3 9" />
                    </svg>
                </button>
            ) : null}
        </div>
    );
}

function PermissionMessage({
    message,
    sessionId,
    pillMetrics,
    chatFontSize = 14,
    diffPresentationMode = "active",
    onPermissionResponse,
}: {
    message: AIChatMessage;
    sessionId?: string | null;
    pillMetrics: ChatPillMetrics;
    chatFontSize?: number;
    diffPresentationMode?: DiffPresentationMode;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
}) {
    // Extract first line as title, rest as details
    const lines = message.content.split("\n");
    const title = lines[0];
    const details = lines.slice(1).join("\n").trim();
    const MAX_PREVIEW = 120;
    const MAX_HEADER_PREVIEW = 72;
    const isLong = details.length > MAX_PREVIEW;
    const hasLongTitle = title.length > MAX_HEADER_PREVIEW;
    const canExpand = hasLongTitle || isLong;
    const [expanded, setExpanded] = useStoredRowExpanded(
        sessionId,
        message.id,
        !canExpand,
    );

    if (diffPresentationMode !== "none" && message.diffs?.length) {
        return (
            <ChangeReviewPanel
                message={message}
                sessionId={sessionId}
                onPermissionResponse={onPermissionResponse}
                readOnly={diffPresentationMode === "historical"}
            />
        );
    }

    const target = message.meta?.target ? String(message.meta.target) : null;
    const shortTarget = target?.split("/").pop() ?? null;
    const status = String(message.meta?.status ?? "pending");
    const resolvedOptionId =
        message.meta?.resolved_option !== undefined &&
        message.meta?.resolved_option !== null
            ? String(message.meta.resolved_option)
            : null;
    const resolvedOptionLabel =
        message.permissionOptions?.find(
            (option) => option.option_id === resolvedOptionId,
        )?.name ?? null;
    const isPending = status === "pending";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";
    const preview = isLong ? `${details.slice(0, MAX_PREVIEW)}...` : details;

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #d97706 25%, var(--border))",
                backgroundColor:
                    "color-mix(in srgb, #d97706 4%, var(--bg-secondary))",
            }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom:
                        details || shortTarget
                            ? "1px solid color-mix(in srgb, #d97706 15%, var(--border))"
                            : "none",
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="#d97706"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                >
                    <path d="M7 1.5L12 4.5V9.5L7 12.5L2 9.5V4.5L7 1.5Z" />
                    <path d="M7 5.5V7.5" />
                    <circle cx="7" cy="9.5" r="0.5" fill="#d97706" />
                </svg>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-primary)",
                        fontSize: "0.85em",
                        whiteSpace: expanded ? "normal" : "nowrap",
                        overflow: "hidden",
                        textOverflow: expanded ? "clip" : "ellipsis",
                    }}
                >
                    {title}
                </span>
                {canExpand && (
                    <button
                        type="button"
                        onClick={() => setExpanded((value) => !value)}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 18,
                            height: 18,
                            flexShrink: 0,
                            border: "none",
                            borderRadius: 4,
                            background: "transparent",
                            color: "#d97706",
                            cursor: "pointer",
                            opacity: 0.7,
                        }}
                        aria-label={
                            expanded
                                ? "Collapse permission message"
                                : "Expand permission message"
                        }
                        title={expanded ? "Collapse message" : "Expand message"}
                    >
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                                transform: expanded
                                    ? "rotate(180deg)"
                                    : "rotate(0deg)",
                                transition: "transform 0.15s ease",
                            }}
                        >
                            <path d="M2.5 4L5 6.5L7.5 4" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Body */}
            {(details || shortTarget) && (
                <div className="px-3 py-2">
                    {shortTarget && (
                        <div
                            className="mb-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                            style={{
                                backgroundColor:
                                    "color-mix(in srgb, #d97706 10%, transparent)",
                                color: "#d97706",
                                fontSize: "0.79em",
                            }}
                        >
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M1.5 8.5V2a.5.5 0 01.5-.5h2.5L6 3h2.5a.5.5 0 01.5.5V8.5a.5.5 0 01-.5.5h-6a.5.5 0 01-.5-.5z" />
                            </svg>
                            {shortTarget}
                        </div>
                    )}
                    {details && (
                        <div
                            className="leading-relaxed"
                            style={{
                                color: "var(--text-secondary)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                fontSize: "0.79em",
                            }}
                        >
                            <MarkdownContent
                                content={expanded ? details : preview}
                                pillMetrics={pillMetrics}
                                chatFontSize={chatFontSize}
                                fileReferenceAppearance="link"
                            />
                            {isLong && (
                                <button
                                    type="button"
                                    onClick={() => setExpanded((v) => !v)}
                                    className="mt-1"
                                    style={{
                                        color: "#d97706",
                                        background: "none",
                                        border: "none",
                                        cursor: "pointer",
                                        padding: 0,
                                    }}
                                >
                                    {expanded ? "Show less" : "Show more"}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            {message.permissionRequestId &&
            message.permissionOptions?.length ? (
                <div
                    className="flex flex-wrap gap-2 px-3 py-2"
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
                    }}
                >
                    {message.permissionOptions.map((option) => (
                        <PermissionDecisionButton
                            key={option.option_id}
                            option={option}
                            accent="#d97706"
                            disabled={!isPending}
                            onClick={() =>
                                onPermissionResponse?.(
                                    message.permissionRequestId!,
                                    option.option_id,
                                )
                            }
                        />
                    ))}
                </div>
            ) : null}

            {/* Status footer */}
            {(isResponding || isResolved) && (
                <div
                    className="px-3 py-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        borderTop:
                            "1px solid color-mix(in srgb, #d97706 15%, var(--border))",
                        opacity: 0.7,
                        fontSize: "0.79em",
                    }}
                >
                    {isResponding
                        ? "Sending decision..."
                        : `Decision sent${resolvedOptionLabel ? `: ${resolvedOptionLabel}` : "."}`}
                </div>
            )}
        </div>
    );
}

function nextUserInputSelection(
    currentSelected: string[],
    optionLabel: string,
    allowsMultiple: boolean,
) {
    if (!allowsMultiple) {
        return [optionLabel];
    }

    return currentSelected.includes(optionLabel)
        ? currentSelected.filter((value) => value !== optionLabel)
        : [...currentSelected, optionLabel];
}

function UserInputRequestMessage({
    message,
    sessionId,
    onUserInputResponse,
}: {
    message: AIChatMessage;
    sessionId?: string | null;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
        action?: AIUserInputAction,
    ) => void;
}) {
    const status = String(message.meta?.status ?? "pending");
    const questions = message.userInputQuestions ?? [];
    const isPending = status === "pending" || status === "error";
    const isResponding = status === "responding";
    const isResolved = status === "resolved";
    const isError = status === "error";
    const answered = message.meta?.answered !== false;
    const { rowState, updateRow } = useChatRowUiEntry(sessionId, message.id);
    const selectedOptions = rowState?.userInputSelectedOptions ?? {};
    const textAnswers = rowState?.userInputTextAnswers ?? {};
    const otherAnswers = rowState?.userInputOtherAnswers ?? {};
    const [focusedOptionKey, setFocusedOptionKey] = useState<string | null>(
        null,
    );

    const selectedValuesForQuestion = (questionId: string) =>
        selectedOptions[questionId] ?? [];

    const submitAnswers = (cancelled = false) => {
        if (!message.userInputRequestId) return;
        if (cancelled) {
            onUserInputResponse?.(message.userInputRequestId, {}, "cancel");
            return;
        }

        const answers = questions.reduce<Record<string, string[]>>(
            (accumulator, question) => {
                const values: string[] = [];
                const selected = selectedValuesForQuestion(question.id)
                    .map((value) => value.trim())
                    .filter(Boolean);
                const text = textAnswers[question.id]?.trim();
                const other = otherAnswers[question.id]?.trim();
                const customAnswerId = question.custom_answer_id?.trim();

                values.push(...selected);
                if (text) values.push(text);
                if (other && customAnswerId) {
                    accumulator[customAnswerId] = [other];
                } else if (other) values.push(`user_note: ${other}`);

                if (values.length > 0) {
                    accumulator[question.id] = values;
                }
                return accumulator;
            },
            {},
        );

        onUserInputResponse?.(message.userInputRequestId, answers, "accept");
    };

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #c2410c 24%, var(--border))",
                backgroundColor:
                    "color-mix(in srgb, #c2410c 4%, var(--bg-secondary))",
            }}
        >
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom:
                        questions.length > 0
                            ? "1px solid color-mix(in srgb, #c2410c 15%, var(--border))"
                            : "none",
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="#c2410c"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                >
                    <path d="M2 3.5A1.5 1.5 0 013.5 2h7A1.5 1.5 0 0112 3.5v5A1.5 1.5 0 0110.5 10h-4L4 12V10H3.5A1.5 1.5 0 012 8.5v-5z" />
                    <path d="M4.5 5.25h5M4.5 7.25h3.5" />
                </svg>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-primary)",
                        fontSize: "0.85em",
                    }}
                >
                    {message.title ?? "Input requested"}
                </span>
            </div>

            <div className="flex flex-col gap-3 px-3 py-3">
                {questions.map((question) => {
                    const options = question.options ?? [];
                    const allowsMultiple = question.allows_multiple === true;
                    const selected = selectedValuesForQuestion(question.id);
                    const textValue = textAnswers[question.id] ?? "";
                    const otherValue = otherAnswers[question.id] ?? "";
                    const showsOtherInput =
                        question.is_other || Boolean(question.custom_answer_id);
                    const otherInputId = `${message.id}-${question.id}-other`;

                    return (
                        <div key={question.id} className="min-w-0">
                            <div
                                className="mb-1"
                                style={{
                                    color: "var(--text-primary)",
                                    fontSize: "0.8em",
                                    fontWeight: 600,
                                }}
                            >
                                {question.header}
                            </div>
                            <div
                                className="mb-2"
                                style={{
                                    color: "var(--text-secondary)",
                                    fontSize: "0.79em",
                                    overflowWrap: "anywhere",
                                    wordBreak: "break-word",
                                }}
                            >
                                {question.question}
                            </div>

                            {options.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {options.map((option) => {
                                        const optionValue =
                                            option.value ?? option.label;
                                        const optionKey = `${question.id}:${option.label}:${optionValue}`;
                                        const optionTitle = [
                                            option.description,
                                            option.preview,
                                        ]
                                            .filter(Boolean)
                                            .join("\n\n");
                                        const isSelected =
                                            selected.includes(optionValue);
                                        const showPreview = Boolean(
                                            option.preview &&
                                                (isSelected ||
                                                    focusedOptionKey ===
                                                        optionKey),
                                        );
                                        return (
                                            <button
                                                key={optionKey}
                                                type="button"
                                                disabled={!isPending}
                                                aria-pressed={isSelected}
                                                onFocus={() =>
                                                    setFocusedOptionKey(
                                                        optionKey,
                                                    )
                                                }
                                                onBlur={() => {
                                                    setFocusedOptionKey(
                                                        (current) =>
                                                            current ===
                                                            optionKey
                                                                ? null
                                                                : current,
                                                    );
                                                }}
                                                onClick={() => {
                                                    updateRow((current) => {
                                                        const currentOptions =
                                                            current.userInputSelectedOptions ??
                                                            {};
                                                        const currentSelected =
                                                            currentOptions[
                                                                question.id
                                                            ] ?? [];
                                                        const nextSelected =
                                                            nextUserInputSelection(
                                                                currentSelected,
                                                                optionValue,
                                                                allowsMultiple,
                                                            );

                                                        return {
                                                            userInputSelectedOptions:
                                                                {
                                                                    ...currentOptions,
                                                                    [question.id]:
                                                                        nextSelected,
                                                                },
                                                        };
                                                    });
                                                }}
                                                className="rounded-md px-2.5 py-1.5 text-left transition-[background-color,border-color,color,box-shadow,transform] duration-100 ease-out active:translate-y-px active:scale-[0.99] active:shadow-inner"
                                                style={{
                                                    fontSize: "0.78em",
                                                    color: isSelected
                                                        ? "#fff"
                                                        : "var(--text-primary)",
                                                    backgroundColor: isSelected
                                                        ? "#c2410c"
                                                        : "color-mix(in srgb, #c2410c 7%, var(--bg-tertiary))",
                                                    border: "1px solid color-mix(in srgb, #c2410c 18%, var(--border))",
                                                    opacity: isPending
                                                        ? 1
                                                        : 0.55,
                                                    cursor: isPending
                                                        ? "pointer"
                                                        : "default",
                                                }}
                                                title={optionTitle || undefined}
                                            >
                                                <span
                                                    className="block font-medium"
                                                    style={{
                                                        lineHeight: 1.25,
                                                    }}
                                                >
                                                    {option.label}
                                                </span>
                                                {option.description ? (
                                                    <span
                                                        className="mt-0.5 block"
                                                        style={{
                                                            color: isSelected
                                                                ? "rgba(255,255,255,0.82)"
                                                                : "var(--text-secondary)",
                                                            fontSize: "0.92em",
                                                            lineHeight: 1.25,
                                                            overflowWrap:
                                                                "anywhere",
                                                            wordBreak:
                                                                "break-word",
                                                        }}
                                                    >
                                                        {option.description}
                                                    </span>
                                                ) : null}
                                                {showPreview ? (
                                                    <span
                                                        className="mt-1 block whitespace-pre-wrap rounded px-1.5 py-1"
                                                        style={{
                                                            backgroundColor:
                                                                isSelected
                                                                    ? "rgba(255,255,255,0.14)"
                                                                    : "color-mix(in srgb, var(--bg-primary) 72%, transparent)",
                                                            color: isSelected
                                                                ? "rgba(255,255,255,0.88)"
                                                                : "var(--text-secondary)",
                                                            fontFamily:
                                                                "var(--font-mono)",
                                                            fontSize: "0.88em",
                                                            lineHeight: 1.25,
                                                            overflowWrap:
                                                                "anywhere",
                                                            wordBreak:
                                                                "break-word",
                                                        }}
                                                    >
                                                        {option.preview}
                                                    </span>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}

                            {options.length === 0 && (
                                <input
                                    type={
                                        question.is_secret ? "password" : "text"
                                    }
                                    value={textValue}
                                    disabled={!isPending}
                                    onChange={(event) =>
                                        updateRow((current) => ({
                                            userInputTextAnswers: {
                                                ...(current.userInputTextAnswers ??
                                                    {}),
                                                [question.id]:
                                                    event.target.value,
                                            },
                                        }))
                                    }
                                    className="w-full rounded-md px-2.5 py-2"
                                    style={{
                                        backgroundColor: "var(--bg-tertiary)",
                                        border: "1px solid var(--border)",
                                        color: "var(--text-primary)",
                                        fontSize: "0.8em",
                                    }}
                                />
                            )}

                            {showsOtherInput && (
                                <div className="mt-2">
                                    {question.custom_answer_id ? (
                                        <label
                                            htmlFor={otherInputId}
                                            className="mb-1 block"
                                            style={{
                                                color: "var(--text-primary)",
                                                fontSize: "0.76em",
                                                fontWeight: 600,
                                            }}
                                        >
                                            Other
                                        </label>
                                    ) : null}
                                    <textarea
                                        id={otherInputId}
                                        value={otherValue}
                                        disabled={!isPending}
                                        onChange={(event) =>
                                            updateRow((current) => ({
                                                userInputOtherAnswers: {
                                                    ...(current.userInputOtherAnswers ??
                                                        {}),
                                                    [question.id]:
                                                        event.target.value,
                                                },
                                            }))
                                        }
                                        placeholder={
                                            question.custom_answer_id
                                                ? "Other"
                                                : "Additional note"
                                        }
                                        rows={2}
                                        className="w-full resize-y rounded-md px-2.5 py-2"
                                        style={{
                                            backgroundColor:
                                                "var(--bg-tertiary)",
                                            border: "1px solid var(--border)",
                                            color: "var(--text-primary)",
                                            fontSize: "0.8em",
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {message.userInputRequestId ? (
                <div
                    className="flex flex-wrap gap-2 px-3 py-2"
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, #c2410c 15%, var(--border))",
                    }}
                >
                    <button
                        type="button"
                        disabled={!isPending}
                        onClick={() => submitAnswers(true)}
                        className="rounded-md px-3 py-1 font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-100 ease-out active:translate-y-px active:scale-[0.97] active:shadow-inner"
                        style={{
                            fontSize: "0.79em",
                            color: "var(--text-secondary)",
                            backgroundColor:
                                "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--text-secondary) 18%, transparent)",
                            opacity: isPending ? 1 : 0.5,
                            cursor: isPending ? "pointer" : "default",
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!isPending}
                        onClick={() => submitAnswers(false)}
                        className="rounded-md px-3 py-1 font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-100 ease-out active:translate-y-px active:scale-[0.97] active:shadow-inner"
                        style={{
                            fontSize: "0.79em",
                            color: "#fff",
                            backgroundColor: "#c2410c",
                            border: "1px solid color-mix(in srgb, #c2410c 35%, transparent)",
                            opacity: isPending ? 1 : 0.5,
                            cursor: isPending ? "pointer" : "default",
                        }}
                    >
                        Submit
                    </button>
                </div>
            ) : null}

            {(isResponding || isResolved || isError) && (
                <div
                    className="px-3 py-1.5"
                    style={{
                        color: "var(--text-secondary)",
                        borderTop:
                            "1px solid color-mix(in srgb, #c2410c 15%, var(--border))",
                        opacity: 0.7,
                        fontSize: "0.79em",
                    }}
                >
                    {isResponding
                        ? "Sending input..."
                        : isError
                          ? "Input failed. Try again."
                          : answered
                            ? "Input sent."
                            : "Input skipped."}
                </div>
            )}
        </div>
    );
}

function UrlElicitationRequestMessage({
    message,
    onOpen,
    onRespond,
}: {
    message: AIChatMessage;
    onOpen?: (requestId: string) => void;
    onRespond?: (requestId: string, action: AIUrlElicitationAction) => void;
}) {
    const status = String(message.meta?.status ?? "pending");
    const isOpening = status === "opening";
    const isResponding = status === "responding";
    const isCompleted = status === "completed";
    const isCancelled = status === "cancelled";
    const isError = status === "error";
    const isActionable =
        status === "pending" || status === "error" || status === "opening";
    const isDisabled = isOpening || isResponding || isCompleted || isCancelled;
    const requestId = message.urlElicitationRequestId;
    const url = message.urlElicitationUrl ?? message.content;
    const hasOpened = Boolean(message.meta?.opened);

    const footerText = isOpening
        ? "Opening URL..."
        : isResponding
          ? "Sending confirmation..."
          : isCompleted
            ? "Completed."
            : isCancelled
              ? "Cancelled."
              : isError
                ? "Failed. Try again."
                : "Waiting for confirmation...";

    return (
        <div
            className="min-w-0 max-w-full overflow-hidden rounded-lg"
            style={{
                border: "1px solid color-mix(in srgb, #2563eb 22%, var(--border))",
                backgroundColor:
                    "color-mix(in srgb, #2563eb 4%, var(--bg-secondary))",
            }}
        >
            <div
                className="flex items-center gap-2 px-3 py-2"
                style={{
                    borderBottom:
                        "1px solid color-mix(in srgb, #2563eb 14%, var(--border))",
                }}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                    aria-hidden="true"
                >
                    <path d="M5.25 8.75L8.75 5.25" />
                    <path d="M6 3.5l.8-.8a2.3 2.3 0 013.25 3.25l-.8.8" />
                    <path d="M8 10.5l-.8.8a2.3 2.3 0 01-3.25-3.25l.8-.8" />
                </svg>
                <span
                    className="min-w-0 flex-1 font-medium"
                    style={{
                        color: "var(--text-primary)",
                        fontSize: "0.85em",
                    }}
                >
                    {message.title ?? "Open URL"}
                </span>
            </div>

            <div className="flex flex-col gap-2 px-3 py-3">
                <div
                    title={url}
                    className="min-w-0 truncate rounded-md px-2.5 py-2"
                    style={{
                        color: "var(--text-primary)",
                        backgroundColor:
                            "color-mix(in srgb, #2563eb 6%, var(--bg-tertiary))",
                        border: "1px solid color-mix(in srgb, #2563eb 14%, var(--border))",
                        fontSize: "0.79em",
                    }}
                >
                    {url}
                </div>
                {hasOpened && !isCompleted && !isCancelled ? (
                    <div
                        style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.76em",
                        }}
                    >
                        URL opened.
                    </div>
                ) : null}
            </div>

            {requestId ? (
                <div
                    className="flex flex-wrap gap-2 px-3 py-2"
                    style={{
                        borderTop:
                            "1px solid color-mix(in srgb, #2563eb 14%, var(--border))",
                    }}
                >
                    <button
                        type="button"
                        disabled={isDisabled}
                        onClick={() => onOpen?.(requestId)}
                        className="rounded-md px-3 py-1 font-medium"
                        style={{
                            fontSize: "0.79em",
                            color: "var(--text-primary)",
                            backgroundColor:
                                "color-mix(in srgb, #2563eb 8%, var(--bg-tertiary))",
                            border: "1px solid color-mix(in srgb, #2563eb 20%, var(--border))",
                            opacity: isDisabled ? 0.5 : 1,
                            cursor: isDisabled ? "default" : "pointer",
                        }}
                    >
                        Open
                    </button>
                    <button
                        type="button"
                        disabled={!isActionable || isDisabled}
                        onClick={() => onRespond?.(requestId, "cancel")}
                        className="rounded-md px-3 py-1 font-medium"
                        style={{
                            fontSize: "0.79em",
                            color: "var(--text-secondary)",
                            backgroundColor:
                                "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                            border: "1px solid color-mix(in srgb, var(--text-secondary) 18%, transparent)",
                            opacity: !isActionable || isDisabled ? 0.5 : 1,
                            cursor:
                                !isActionable || isDisabled
                                    ? "default"
                                    : "pointer",
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!isActionable || isDisabled}
                        onClick={() => onRespond?.(requestId, "complete")}
                        className="rounded-md px-3 py-1 font-medium"
                        style={{
                            fontSize: "0.79em",
                            color: "#fff",
                            backgroundColor: "#2563eb",
                            border: "1px solid color-mix(in srgb, #2563eb 35%, transparent)",
                            opacity: !isActionable || isDisabled ? 0.5 : 1,
                            cursor:
                                !isActionable || isDisabled
                                    ? "default"
                                    : "pointer",
                        }}
                    >
                        Done
                    </button>
                </div>
            ) : null}

            <div
                className="px-3 py-1.5"
                style={{
                    color: "var(--text-secondary)",
                    borderTop:
                        "1px solid color-mix(in srgb, #2563eb 14%, var(--border))",
                    opacity: 0.72,
                    fontSize: "0.79em",
                }}
            >
                {footerText}
            </div>
        </div>
    );
}

export const AIChatMessageItem = memo(function AIChatMessageItem({
    message,
    sessionId,
    readOnly = false,
    pillMetrics,
    chatFontSize = 14,
    visibleWorkCycleId = null,
    onPermissionResponse,
    onUserInputResponse,
    onUrlElicitationOpen,
    onUrlElicitationResponse,
    onDismissMessage,
}: AIChatMessageItemProps) {
    const diffPresentationMode = readOnly
        ? message.diffs?.length || message.reviewDiffs?.length
            ? "historical"
            : "none"
        : getDiffPresentationMode(message, visibleWorkCycleId);

    // User text — full width, subtle box (Zed style)
    if (message.kind === "text" && message.role === "user") {
        return (
            <UserTextMessage
                message={message}
                pillMetrics={pillMetrics}
            />
        );
    }

    // Thinking — collapsible single line
    if (message.kind === "thinking") {
        return <ThinkingMessage message={message} sessionId={sessionId} />;
    }

    // Tool activity — subtle one-liner
    if (message.kind === "tool") {
        return (
            <ToolMessage
                message={message}
                sessionId={sessionId}
                diffPresentationMode={diffPresentationMode}
            />
        );
    }

    if (message.kind === "plan") {
        return (
            <PlanMessage
                message={message}
                sessionId={sessionId}
                pillMetrics={pillMetrics}
                chatFontSize={chatFontSize}
            />
        );
    }

    if (message.kind === "status") {
        if (isActivityTimelineEntry(message)) {
            return <ToolActivityItem message={message} sessionId={sessionId} />;
        }
        return <StatusMessage message={message} />;
    }

    if (message.kind === "image") {
        return <GeneratedImageMessage message={message} />;
    }

    // Error — inline with icon
    if (message.kind === "error") {
        return (
            <ErrorMessage
                message={message}
                onDismiss={readOnly ? undefined : onDismissMessage}
            />
        );
    }

    // Permission — minimal card
    if (message.kind === "permission") {
        return (
            <PermissionMessage
                message={message}
                sessionId={sessionId}
                pillMetrics={pillMetrics}
                chatFontSize={chatFontSize}
                diffPresentationMode={diffPresentationMode}
                onPermissionResponse={onPermissionResponse}
            />
        );
    }

    if (message.kind === "user_input_request") {
        return (
            <UserInputRequestMessage
                message={message}
                sessionId={sessionId}
                onUserInputResponse={onUserInputResponse}
            />
        );
    }

    if (message.kind === "url_elicitation_request") {
        return (
            <UrlElicitationRequestMessage
                message={message}
                onOpen={onUrlElicitationOpen}
                onRespond={onUrlElicitationResponse}
            />
        );
    }

    // Assistant text — flat, no card
    return (
        <div
            className="min-w-0 max-w-full"
            style={{
                color: "var(--text-primary)",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
            }}
        >
            <MarkdownContent
                content={message.content}
                pillMetrics={pillMetrics}
                chatFontSize={chatFontSize}
                fileReferenceAppearance="link"
            />
        </div>
    );
});
