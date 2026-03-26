import {
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
    type FrontmatterEntry,
} from "./FrontmatterPanel";

export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

export type LeadingContentCollapseRange = {
    from: number;
    to: number;
};

function getLineEndOffset(body: string, from: number) {
    const nextNewline = body.indexOf("\n", from);
    if (nextNewline === -1) {
        return body.length;
    }
    return nextNewline > from && body[nextNewline - 1] === "\r"
        ? nextNewline - 1
        : nextNewline;
}

function getNextLineStartOffset(body: string, from: number) {
    if (from >= body.length) {
        return body.length;
    }
    if (body[from] === "\r" && body[from + 1] === "\n") {
        return from + 2;
    }
    if (body[from] === "\n") {
        return from + 1;
    }
    return from;
}

function extendPastTrailingBlankLine(body: string, to: number) {
    if (to >= body.length) {
        return body.length;
    }

    const nextLineStart = getNextLineStartOffset(body, to);
    const nextLineEnd = getLineEndOffset(body, nextLineStart);
    const nextLine = body.slice(nextLineStart, nextLineEnd);
    return nextLine.trim().length === 0 ? nextLineEnd : to;
}

export function getLeadingContentCollapseRanges(
    body: string,
): LeadingContentCollapseRange[] {
    const ranges: LeadingContentCollapseRange[] = [];
    let contentStart = 0;

    const frontmatterMatch = body.match(FRONTMATTER_RE);
    if (frontmatterMatch) {
        const frontmatterTo = extendPastTrailingBlankLine(
            body,
            frontmatterMatch[0].length,
        );
        ranges.push({ from: 0, to: frontmatterTo });
        contentStart = frontmatterTo;
    }

    const afterFrontmatter = body.slice(contentStart, contentStart + 500);
    const headingMatch = afterFrontmatter.match(/^(\s*)(# .+)/);
    if (headingMatch) {
        const headingFrom = contentStart + headingMatch[1].length;
        const headingTo = extendPastTrailingBlankLine(
            body,
            contentStart + headingMatch[0].length,
        );
        if (headingFrom < headingTo) {
            ranges.push({ from: headingFrom, to: headingTo });
        }
    }

    return ranges;
}

export function remapPositionPastLeadingContentCollapse(
    body: string,
    position: number,
) {
    for (const range of getLeadingContentCollapseRanges(body)) {
        if (position >= range.from && position < range.to) {
            return range.to;
        }
    }

    return position;
}

export function getNoteLocation(noteId: string) {
    const parts = noteId.split("/").filter(Boolean);
    return {
        parent: parts.slice(0, -1).join(" / "),
    };
}

export function extractFirstHeading(body: string): string | null {
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("# ")) {
            return trimmed.slice(2).trim();
        }
        break;
    }
    return null;
}

export function deriveDisplayedTitle(
    frontmatterRaw: string | null,
    body: string,
    fallback: string,
) {
    // When frontmatterRaw is provided explicitly, use it.
    // Otherwise try to extract frontmatter from the body itself
    // (source mode keeps frontmatter inline in the editor).
    const rawSource = frontmatterRaw ?? body.match(FRONTMATTER_RE)?.[0] ?? null;
    const fmTitle = rawSource
        ? parseFrontmatterRaw(rawSource).find((entry) => entry.key === "title")
              ?.value
        : null;
    if (typeof fmTitle === "string" && fmTitle.trim()) {
        return fmTitle.trim();
    }
    // Strip frontmatter before looking for a heading
    const contentBody = body.replace(FRONTMATTER_RE, "");
    return extractFirstHeading(contentBody) ?? fallback;
}

export function upsertFrontmatterTitle(raw: string, title: string): string {
    const entries = parseFrontmatterRaw(raw);
    const nextEntries: FrontmatterEntry[] = [];
    let found = false;

    for (const entry of entries) {
        if (entry.key === "title") {
            nextEntries.push({ key: "title", value: title });
            found = true;
        } else {
            nextEntries.push(entry);
        }
    }

    if (!found) {
        nextEntries.unshift({ key: "title", value: title });
    }

    return (
        serializeFrontmatterRaw(nextEntries) ?? `---\ntitle: ${title}\n---\n`
    );
}

export function replaceOrInsertLeadingHeading(
    body: string,
    title: string,
): string {
    const lines = body.split(/\r?\n/);
    const lineBreak = body.includes("\r\n") ? "\r\n" : "\n";

    for (let index = 0; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("# ")) {
            const indent = lines[index].match(/^\s*/)?.[0] ?? "";
            lines[index] = `${indent}# ${title}`;
            return lines.join(lineBreak);
        }
        break;
    }

    return `# ${title}${lineBreak}${lineBreak}${body}`.trimEnd();
}
