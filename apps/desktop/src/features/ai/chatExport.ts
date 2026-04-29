import { vaultInvoke } from "../../app/utils/vaultInvoke";
import type { NoteDto } from "../../app/store/vaultStore";
import { getSessionRuntimeName, getSessionTitle } from "./sessionPresentation";
import { getSessionTranscriptMessages } from "./transcriptModel";
import type { AIChatMessage, AIChatSession, AIRuntimeOption } from "./types";

interface SavedNoteDetail {
    title: string;
    path: string;
    content?: string;
}

interface ExportChatSessionInput {
    session: AIChatSession;
    runtimes: AIRuntimeOption[];
    notes: NoteDto[];
    createNote: (name: string) => Promise<NoteDto | null>;
    openNote: (noteId: string, title: string, content: string) => void;
}

function sanitizeNoteNameSegment(value: string) {
    const sanitized = value
        .replace(/[[\\/:*?"<>|#^\]\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");

    return sanitized || "Exported chat";
}

function formatIsoTimestamp(timestamp: number) {
    return new Date(timestamp).toISOString();
}

function getMessageRoleLabel(message: AIChatMessage) {
    switch (message.role) {
        case "user":
            return "User";
        case "assistant":
            return "Assistant";
        case "system":
            return "System";
        default:
            return "Message";
    }
}

function getMessageKindLabel(message: AIChatMessage) {
    switch (message.kind) {
        case "text":
            return null;
        case "thinking":
            return "Thinking";
        case "tool":
            return "Tool";
        case "plan":
            return "Plan";
        case "status":
            return "Status";
        case "permission":
            return "Permission";
        case "user_input_request":
            return "Input request";
        case "image":
            return "Image";
        case "error":
            return "Error";
        default:
            return null;
    }
}

function formatMessageHeading(message: AIChatMessage) {
    const role = getMessageRoleLabel(message);
    const kind = getMessageKindLabel(message);
    const detail = kind ?? message.title ?? null;

    return detail ? `${role} · ${detail}` : role;
}

function formatMessageContent(message: AIChatMessage) {
    if (message.kind === "image") {
        const lines = [message.content.trim() || "Generated image"];
        const path =
            typeof message.meta?.image_path === "string"
                ? message.meta.image_path
                : null;
        const revisedPrompt =
            typeof message.meta?.revised_prompt === "string"
                ? message.meta.revised_prompt
                : null;

        if (path) {
            lines.push("", `Path: \`${path}\``);
        }
        if (revisedPrompt) {
            lines.push("", `Revised prompt: ${revisedPrompt}`);
        }

        return lines.join("\n");
    }

    const content = message.content.trim();
    if (!content) {
        return "_No content_";
    }

    return content;
}

function formatAttachmentLine(
    sessionAttachment: AIChatSession["attachments"][number],
) {
    const typeLabel =
        sessionAttachment.type === "folder"
            ? "Folder"
            : sessionAttachment.type === "file"
              ? "File"
              : sessionAttachment.type === "selection"
                ? "Selection"
                : "Note";

    const detail = sessionAttachment.path ?? sessionAttachment.noteId ?? "";
    return detail
        ? `- ${typeLabel}: ${sessionAttachment.label} (${detail})`
        : `- ${typeLabel}: ${sessionAttachment.label}`;
}

export function buildChatExportNoteName(
    session: AIChatSession,
    existingNoteIds: string[],
) {
    const baseTitle = sanitizeNoteNameSegment(getSessionTitle(session));
    const baseName = `Exported chat - ${baseTitle}`;
    const existing = new Set(existingNoteIds);

    let candidate = baseName;
    let counter = 2;
    while (existing.has(`${candidate}.md`)) {
        candidate = `${baseName} ${counter}`;
        counter += 1;
    }

    return candidate;
}

export function buildChatExportMarkdown(
    session: AIChatSession,
    runtimes: AIRuntimeOption[],
    exportedAt = new Date(),
) {
    const messages = getSessionTranscriptMessages(session);
    const title = getSessionTitle(session);
    const runtimeName = getSessionRuntimeName(session, runtimes);
    const lines: string[] = [
        `# Exported chat: ${title}`,
        "",
        `- Exported at: ${exportedAt.toISOString()}`,
        `- Runtime: ${runtimeName}`,
        `- Session ID: \`${session.sessionId}\``,
        `- History ID: \`${session.historySessionId}\``,
        `- Status: \`${session.status}\``,
    ];

    if (session.attachments.length > 0) {
        lines.push("", "## Attached context", "");
        session.attachments.forEach((attachment) => {
            lines.push(formatAttachmentLine(attachment));
        });
    }

    lines.push("", "## Conversation", "");

    if (messages.length === 0) {
        lines.push("_No messages_");
        return `${lines.join("\n")}\n`;
    }

    messages.forEach((message, index) => {
        if (index > 0) {
            lines.push("", "---", "");
        }

        lines.push(`### ${formatMessageHeading(message)}`);
        lines.push("");
        lines.push(`_${formatIsoTimestamp(message.timestamp)}_`);
        lines.push("");
        lines.push(formatMessageContent(message));
    });

    return `${lines.join("\n")}\n`;
}

export async function exportChatSessionToVaultNote({
    session,
    runtimes,
    notes,
    createNote,
    openNote,
}: ExportChatSessionInput) {
    const noteName = buildChatExportNoteName(
        session,
        notes.map((note) => note.id),
    );
    const content = buildChatExportMarkdown(session, runtimes);
    const created = await createNote(noteName);
    if (!created) {
        return null;
    }

    const detail = await vaultInvoke<SavedNoteDetail>("save_note", {
        noteId: created.id,
        content,
    });

    openNote(created.id, detail.title ?? created.title, content);

    return {
        noteId: created.id,
        path: detail.path ?? created.path,
        title: detail.title ?? created.title,
        content,
    };
}
