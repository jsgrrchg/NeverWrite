import type { AIComposerPart } from "./types";

/**
 * Strip pill serialization markers from text, returning a clean readable string.
 * Useful for displaying content in compact UI areas (queue summaries, chat titles).
 */
export function cleanPillMarkers(text: string): string {
    return text
        .replace(/\[@📁 ([^\]]+)\]/g, "$1")
        .replace(/\[@📄 ([^\]]+)\]/g, (_match, value: string) => {
            const normalized = String(value).split("/").pop();
            return normalized || String(value);
        })
        .replace(/\[@([^\]]+)\]/g, "$1")
        .replace(/\[Screenshot ([^\]]+)\]/g, "Screenshot $1")
        .replace(/\[📎 ([^\]]+)\]/g, "$1")
        .replace(/@fetch\b/g, "")
        .replace(/\/plan\b/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

interface SerializeComposerPartsForAIOptions {
    vaultPath?: string | null;
}

function normalizePathForAI(
    path: string,
    options: SerializeComposerPartsForAIOptions = {},
) {
    const trimmed = path.trim().replace(/^@+/, "");
    if (!trimmed) return trimmed;

    const normalized = trimmed.replace(/\\/g, "/");
    const isAbsolute =
        normalized.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.startsWith("//");
    if (isAbsolute) return normalized;

    const vaultPath = options.vaultPath?.trim().replace(/\\/g, "/");
    if (!vaultPath) return normalized;

    return `${vaultPath.replace(/\/+$/, "")}/${normalized.replace(/^\/+/, "")}`;
}

export function createEmptyComposerParts(): AIComposerPart[] {
    return [
        {
            id: crypto.randomUUID(),
            type: "text",
            text: "",
        },
    ];
}

export function serializeComposerParts(parts: AIComposerPart[]): string {
    return parts
        .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "fetch_mention") return "@fetch";
            if (part.type === "plan_mention") return "/plan";
            if (part.type === "folder_mention") return `[@📁 ${part.label}]`;
            if (part.type === "file_mention") return `[@📄 ${part.path}]`;
            if (part.type === "mention") return `[@${part.label}]`;
            if (part.type === "selection_mention") return `[@${part.label}]`;
            if (part.type === "screenshot") return `[${part.label}]`;
            if (part.type === "file_attachment") return `[📎 ${part.label}]`;
            return "";
        })
        .join("");
}

export function serializeComposerPartsForAI(
    parts: AIComposerPart[],
    options: SerializeComposerPartsForAIOptions = {},
): string {
    return parts
        .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "fetch_mention") return "@fetch";
            if (part.type === "plan_mention") return "/plan";
            if (part.type === "folder_mention")
                return normalizePathForAI(part.folderPath, options);
            if (part.type === "file_mention")
                return normalizePathForAI(part.path, options);
            if (part.type === "mention")
                return normalizePathForAI(part.path, options);
            if (part.type === "selection_mention")
                return `${normalizePathForAI(part.path, options)}:${part.startLine}-${part.endLine}`;
            if (part.type === "screenshot")
                return normalizePathForAI(part.filePath, options);
            if (part.type === "file_attachment")
                return normalizePathForAI(part.filePath, options);
            return "";
        })
        .join("");
}

export function normalizeComposerParts(
    parts: AIComposerPart[],
): AIComposerPart[] {
    const normalized: AIComposerPart[] = [];

    for (const part of parts) {
        if (part.type === "text") {
            const previous = normalized.at(-1);
            if (previous?.type === "text") {
                previous.text += part.text;
                continue;
            }
        }
        normalized.push(part);
    }

    if (normalized.length === 0) {
        return createEmptyComposerParts();
    }

    return normalized;
}

export function appendFolderMentionPart(
    parts: AIComposerPart[],
    folderPath: string,
    label: string,
): AIComposerPart[] {
    const next = [...parts];

    const last = next.at(-1);
    if (!last || last.type !== "text") {
        next.push({ id: crypto.randomUUID(), type: "text", text: "" });
    }

    const currentLast = next.at(-1);
    if (currentLast?.type === "text" && currentLast.text.length > 0) {
        currentLast.text += currentLast.text.endsWith(" ") ? "" : " ";
    }

    next.push({
        id: crypto.randomUUID(),
        type: "folder_mention",
        folderPath,
        label,
    });
    next.push({ id: crypto.randomUUID(), type: "text", text: " " });

    return normalizeComposerParts(next);
}

export function appendMentionParts(
    parts: AIComposerPart[],
    mentions: Array<{ noteId: string; label: string; path: string }>,
): AIComposerPart[] {
    const next = [...parts];

    const last = next.at(-1);
    if (!last || last.type !== "text") {
        next.push({
            id: crypto.randomUUID(),
            type: "text",
            text: "",
        });
    }

    const currentLast = next.at(-1);
    if (currentLast?.type === "text" && currentLast.text.length > 0) {
        currentLast.text += currentLast.text.endsWith(" ") ? "" : " ";
    }

    mentions.forEach((mention, index) => {
        next.push({
            id: crypto.randomUUID(),
            type: "mention",
            noteId: mention.noteId,
            label: mention.label,
            path: mention.path,
        });
        next.push({
            id: crypto.randomUUID(),
            type: "text",
            text: index === mentions.length - 1 ? " " : " ",
        });
    });

    return normalizeComposerParts(next);
}

export function appendSelectionMentionPart(
    parts: AIComposerPart[],
    selection: {
        noteId: string | null;
        label: string;
        path: string;
        selectedText: string;
        startLine: number;
        endLine: number;
    },
): AIComposerPart[] {
    const next = [...parts];

    const last = next.at(-1);
    if (!last || last.type !== "text") {
        next.push({ id: crypto.randomUUID(), type: "text", text: "" });
    }

    const currentLast = next.at(-1);
    if (currentLast?.type === "text" && currentLast.text.length > 0) {
        currentLast.text += currentLast.text.endsWith(" ") ? "" : " ";
    }

    next.push({
        id: crypto.randomUUID(),
        type: "selection_mention",
        ...selection,
    });
    next.push({ id: crypto.randomUUID(), type: "text", text: " " });

    return normalizeComposerParts(next);
}

export function appendScreenshotPart(
    parts: AIComposerPart[],
    screenshot: { filePath: string; mimeType: string; label: string },
): AIComposerPart[] {
    const next = [...parts];

    const last = next.at(-1);
    if (!last || last.type !== "text") {
        next.push({ id: crypto.randomUUID(), type: "text", text: "" });
    }

    const currentLast = next.at(-1);
    if (currentLast?.type === "text" && currentLast.text.length > 0) {
        currentLast.text += currentLast.text.endsWith(" ") ? "" : " ";
    }

    next.push({
        id: crypto.randomUUID(),
        type: "screenshot",
        ...screenshot,
    });
    next.push({ id: crypto.randomUUID(), type: "text", text: " " });

    return normalizeComposerParts(next);
}

export function appendFileAttachmentPart(
    parts: AIComposerPart[],
    file: { filePath: string; mimeType: string; label: string },
): AIComposerPart[] {
    const next = [...parts];

    const last = next.at(-1);
    if (!last || last.type !== "text") {
        next.push({ id: crypto.randomUUID(), type: "text", text: "" });
    }

    const currentLast = next.at(-1);
    if (currentLast?.type === "text" && currentLast.text.length > 0) {
        currentLast.text += currentLast.text.endsWith(" ") ? "" : " ";
    }

    next.push({
        id: crypto.randomUUID(),
        type: "file_attachment",
        ...file,
    });
    next.push({ id: crypto.randomUUID(), type: "text", text: " " });

    return normalizeComposerParts(next);
}
