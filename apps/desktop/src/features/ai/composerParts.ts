import type { AIComposerPart } from "./types";

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
            if (part.type === "folder_mention") return `@📁${part.label}`;
            if (part.type === "mention") return `@${part.label}`;
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
