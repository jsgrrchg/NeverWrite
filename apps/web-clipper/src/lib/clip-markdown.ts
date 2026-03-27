import type { ClipData } from "./clipper-contract";
import type { ClipContentMode } from "./types";

function quoteYaml(value: string): string {
    if (value.length === 0) {
        return '""';
    }

    if (
        /^(true|false|null|~)$/i.test(value) ||
        /^-?\d+(\.\d+)?$/.test(value) ||
        /^\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.+-Zz]+)?$/.test(value)
    ) {
        return JSON.stringify(value);
    }

    if (
        /^[A-Za-z0-9 _./:@%+,\-]+$/.test(value) &&
        !value.includes(": ") &&
        !value.startsWith("-")
    ) {
        return value;
    }

    return JSON.stringify(value);
}

function buildClipBody(
    clipData: ClipData,
    contentMode: ClipContentMode,
): string {
    switch (contentMode) {
        case "selection":
            return clipData.selection?.markdown || clipData.content.markdown;
        case "url-only":
            return [
                `[Open source](${clipData.metadata.url})`,
                "",
                clipData.metadata.description ||
                    "Bookmark-only clip. Full content disabled for this capture.",
            ].join("\n");
        default:
            return clipData.content.markdown;
    }
}

export function buildClipMarkdown(input: {
    clipData: ClipData;
    title: string;
    tags: string[];
    notes?: string;
    contentMode: ClipContentMode;
}): string {
    const resolvedTitle = input.title.trim() || input.clipData.metadata.title;
    const body = buildClipBody(input.clipData, input.contentMode).trim();
    const notes = input.notes?.trim() ?? "";
    const lines = [
        "---",
        `title: ${quoteYaml(resolvedTitle)}`,
        `source: ${quoteYaml(input.clipData.metadata.url)}`,
        `domain: ${quoteYaml(input.clipData.metadata.domain)}`,
    ];

    if (input.clipData.metadata.author) {
        lines.push(`author: ${quoteYaml(input.clipData.metadata.author)}`);
    }
    if (input.clipData.metadata.published) {
        lines.push(
            `published: ${quoteYaml(input.clipData.metadata.published)}`,
        );
    }
    if (input.clipData.metadata.description) {
        lines.push(
            `description: ${quoteYaml(input.clipData.metadata.description)}`,
        );
    }
    if (input.clipData.metadata.language) {
        lines.push(`language: ${quoteYaml(input.clipData.metadata.language)}`);
    }
    if (input.clipData.extractedAt) {
        lines.push(`clipped_at: ${quoteYaml(input.clipData.extractedAt)}`);
    }
    if (input.tags.length > 0) {
        lines.push("tags:");
        for (const tag of input.tags) {
            lines.push(`  - ${quoteYaml(tag)}`);
        }
    }

    lines.push("---", "", `# ${resolvedTitle}`);

    if (notes) {
        lines.push("", `> **Notes:** ${notes}`);
    }
    if (body) {
        lines.push("", body);
    }

    return lines.join("\n").trim();
}
