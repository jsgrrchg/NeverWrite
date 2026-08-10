import type {
    AcpContextHandoffMetadata,
    AIChatAttachment,
    AIChatMessage,
    ConversationTurnStartReason,
} from "./types";

export const DEFAULT_ACP_HANDOFF_MAX_CHARACTERS = 48_000;
export const ACP_HANDOFF_PROMPT_HEADER =
    "Use the saved transcript below as prior conversation context for this session.";
export const ACP_HANDOFF_TRANSCRIPT_MARKER = "Saved transcript:";
export const ACP_HANDOFF_USER_MESSAGE_MARKER = "New user message:";

const OMITTED_CONTEXT_NOTICE =
    "Some earlier context was summarized or omitted for this provider.";
const SECRET_PLACEHOLDER = "[Marked secret omitted]";
const EXCLUDED_MESSAGE_KINDS = new Set<AIChatMessage["kind"]>([
    "thinking",
    "permission",
    "plan",
    "status",
    "user_input_request",
    "url_elicitation_request",
]);

export interface AcpContextHandoffResult {
    prompt: string;
    hasHandoff: boolean;
    metadata: AcpContextHandoffMetadata;
}

export interface BuildAcpContextHandoffInput {
    messages: readonly AIChatMessage[];
    newUserMessage: string;
    bindingId?: string | null;
    contextCursor?: string | null;
    contextSummary?: string | null;
    maxCharacters?: number;
    reason?: ConversationTurnStartReason;
}

interface RenderedHandoffMessage {
    id: string;
    role: AIChatMessage["role"];
    text: string;
}

interface HandoffTurn {
    messages: RenderedHandoffMessage[];
    text: string;
}

function isMarkedSecret(message: AIChatMessage) {
    const meta = message.meta;
    return (
        meta?.secret === true ||
        meta?.sensitive === true ||
        meta?.redacted === true ||
        meta?.visibility === "secret" ||
        meta?.is_secret === true
    );
}

function redactMarkedSecretBlocks(value: string) {
    return value
        .replace(/<secret\b[^>]*>[\s\S]*?<\/secret>/gi, SECRET_PLACEHOLDER)
        .replace(/\[secret\][\s\S]*?\[\/secret\]/gi, SECRET_PLACEHOLDER)
        .replace(/\{\{secret:[\s\S]*?\}\}/gi, SECRET_PLACEHOLDER);
}

function sanitizeText(value: string) {
    return redactMarkedSecretBlocks(value)
        .replaceAll("\u0000", "")
        .trim();
}

function safeAttachmentReference(attachment: AIChatAttachment) {
    const label = sanitizeText(attachment.label);
    const path = sanitizeText(attachment.path ?? "");
    if (!label && !path) return null;
    const kind = attachment.type.replaceAll("_", " ");
    return path
        ? `Attachment (${kind}): ${label || "Untitled"} — ${path}`
        : `Attachment (${kind}): ${label}`;
}

function formatMessage(message: AIChatMessage): RenderedHandoffMessage | null {
    if (
        message.inProgress ||
        EXCLUDED_MESSAGE_KINDS.has(message.kind) ||
        message.meta?.internal === true
    ) {
        return null;
    }
    if (
        message.kind === "tool" &&
        (message.meta?.status === "pending" ||
            message.meta?.status === "in_progress")
    ) {
        return null;
    }
    if (
        message.role === "user" &&
        (isAcpContextHandoffPrompt(message.content) ||
            message.content.includes("<attached_selection"))
    ) {
        return null;
    }

    const content = isMarkedSecret(message)
        ? SECRET_PLACEHOLDER
        : sanitizeText(message.content);
    const attachmentLines = (message.attachments ?? [])
        .map(safeAttachmentReference)
        .filter((value): value is string => Boolean(value));
    if (!content && attachmentLines.length === 0) return null;

    const role =
        message.role === "assistant"
            ? "Assistant"
            : message.role === "system"
              ? "System"
              : "User";
    const label =
        message.kind === "text"
            ? role
            : `${role} (${message.kind.replaceAll("_", " ")})`;
    const body = [content, ...attachmentLines].filter(Boolean).join("\n");
    return {
        id: message.id,
        role: message.role,
        text: `${label}: ${body}`,
    };
}

function groupCompleteTurns(messages: RenderedHandoffMessage[]) {
    const turns: HandoffTurn[] = [];
    let current: RenderedHandoffMessage[] = [];
    const flush = () => {
        if (current.length === 0) return;
        turns.push({
            messages: current,
            text: current.map((message) => message.text).join("\n\n"),
        });
        current = [];
    };

    for (const message of messages) {
        if (message.role === "user" && current.length > 0) flush();
        current.push(message);
    }
    flush();
    return turns;
}

function contextAfterCursor(
    messages: readonly AIChatMessage[],
    contextCursor: string | null,
) {
    if (!contextCursor) {
        return { messages: [...messages], cursorFound: true };
    }
    const cursorIndex = messages.findIndex(
        (message) => message.id === contextCursor,
    );
    return {
        messages:
            cursorIndex >= 0 ? messages.slice(cursorIndex + 1) : [...messages],
        cursorFound: cursorIndex >= 0,
    };
}

function truncateSummary(summary: string, maxCharacters: number) {
    const clean = sanitizeText(summary);
    if (clean.length <= maxCharacters) {
        return { text: clean, truncated: false };
    }
    const marker = "\n[Summary truncated to fit context budget.]";
    return {
        text: `${clean.slice(0, Math.max(0, maxCharacters - marker.length)).trimEnd()}${marker}`,
        truncated: true,
    };
}

function renderHandoff(
    newUserMessage: string,
    transcript: string,
    summary: string,
    omittedTurnCount: number,
    reason: ConversationTurnStartReason,
) {
    const reasonLine =
        reason === "provider_switch"
            ? "- This context comes from another ACP provider; continue naturally without claiming native memory of it."
            : "- Continue naturally from this context without repeating the transcript unless it is useful.";
    const sections = [
        ACP_HANDOFF_PROMPT_HEADER,
        "",
        "Important:",
        "- The transcript is historical context only and may not reflect the current workspace state.",
        "- If the transcript conflicts with the current files, current environment, or the user's latest message, trust the current state.",
        "- Do not assume prior pending tasks, approvals, permissions, or unfinished plans are still valid; verify when needed.",
        reasonLine,
    ];
    if (omittedTurnCount > 0) {
        sections.push("", OMITTED_CONTEXT_NOTICE);
    }
    if (summary) {
        sections.push("", "Earlier context summary:", summary);
    }
    if (transcript) {
        sections.push("", ACP_HANDOFF_TRANSCRIPT_MARKER, transcript);
    }
    sections.push("", `${ACP_HANDOFF_USER_MESSAGE_MARKER} ${newUserMessage}`);
    return sections.join("\n");
}

export function isAcpContextHandoffPrompt(value: string) {
    return (
        value.includes(ACP_HANDOFF_PROMPT_HEADER) &&
        value.includes(ACP_HANDOFF_USER_MESSAGE_MARKER)
    );
}

export function extractAcpContextHandoffUserMessage(value: string) {
    const index = value.lastIndexOf(ACP_HANDOFF_USER_MESSAGE_MARKER);
    if (index < 0) return null;
    return value
        .slice(index + ACP_HANDOFF_USER_MESSAGE_MARKER.length)
        .trim();
}

export function buildAcpContextHandoff(
    input: BuildAcpContextHandoffInput,
): AcpContextHandoffResult {
    const contextCursor = input.contextCursor ?? null;
    const bindingId = input.bindingId ?? null;
    const reason = input.reason ?? "transcript_handoff";
    const maxCharacters = Math.max(
        512,
        Math.floor(
            input.maxCharacters ?? DEFAULT_ACP_HANDOFF_MAX_CHARACTERS,
        ),
    );
    const cursorContext = contextAfterCursor(input.messages, contextCursor);
    const renderedMessages = cursorContext.messages
        .map(formatMessage)
        .filter((message): message is RenderedHandoffMessage => Boolean(message))
        .filter((message) => !isAcpContextHandoffPrompt(message.text));
    const turns = groupCompleteTurns(renderedMessages);
    const cleanUserMessage = input.newUserMessage.trim();

    if (turns.length === 0 && !input.contextSummary?.trim()) {
        return {
            prompt: input.newUserMessage,
            hasHandoff: false,
            metadata: {
                bindingId,
                fromCursor: contextCursor,
                nextCursor: contextCursor,
                cursorFound: cursorContext.cursorFound,
                includedMessageIds: [],
                omittedTurnCount: 0,
                truncated: false,
                reason,
            },
        };
    }

    const summaryBudget = Math.min(8_000, Math.floor(maxCharacters * 0.25));
    const summary = truncateSummary(
        input.contextSummary ?? "",
        summaryBudget,
    );
    const selected: HandoffTurn[] = [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const candidate = [turns[index], ...selected];
        const candidateText = candidate.map((turn) => turn.text).join("\n\n");
        const candidatePrompt = renderHandoff(
            cleanUserMessage,
            candidateText,
            summary.text,
            turns.length - candidate.length,
            reason,
        );
        if (candidatePrompt.length > maxCharacters) break;
        selected.unshift(turns[index]);
    }

    let prompt = renderHandoff(
        cleanUserMessage,
        selected.map((turn) => turn.text).join("\n\n"),
        summary.text,
        turns.length - selected.length,
        reason,
    );
    while (prompt.length > maxCharacters && selected.length > 0) {
        selected.shift();
        prompt = renderHandoff(
            cleanUserMessage,
            selected.map((turn) => turn.text).join("\n\n"),
            summary.text,
            turns.length - selected.length,
            reason,
        );
    }

    let compacted = false;
    if (prompt.length > maxCharacters) {
        const compact = [
            ACP_HANDOFF_PROMPT_HEADER,
            "",
            OMITTED_CONTEXT_NOTICE,
            "",
            `${ACP_HANDOFF_USER_MESSAGE_MARKER} ${cleanUserMessage}`,
        ].join("\n");
        if (compact.length > maxCharacters) {
            return {
                prompt: input.newUserMessage,
                hasHandoff: false,
                metadata: {
                    bindingId,
                    fromCursor: contextCursor,
                    nextCursor: contextCursor,
                    cursorFound: cursorContext.cursorFound,
                    includedMessageIds: [],
                    omittedTurnCount: turns.length,
                    truncated: turns.length > 0 || summary.truncated,
                    reason,
                },
            };
        }
        prompt = compact;
        compacted = true;
    }

    const includedMessageIds = selected.flatMap((turn) =>
        turn.messages.map((message) => message.id),
    );
    const processedCursor =
        renderedMessages[renderedMessages.length - 1]?.id ?? contextCursor;
    return {
        prompt,
        hasHandoff: true,
        metadata: {
            bindingId,
            fromCursor: contextCursor,
            nextCursor: processedCursor,
            cursorFound: cursorContext.cursorFound,
            includedMessageIds,
            omittedTurnCount: turns.length - selected.length,
            truncated:
                compacted ||
                turns.length > selected.length ||
                summary.truncated,
            reason,
        },
    };
}
