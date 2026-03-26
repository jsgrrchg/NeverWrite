import {
    parseFrontmatterRaw,
    serializeFrontmatterRaw,
    type FrontmatterEntry,
} from "./FrontmatterPanel";

export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

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
