export interface OutlineSelection {
    anchor: number;
    head: number;
}

export interface OutlineHeading {
    id: string;
    title: string;
    level: number;
    anchor: number;
    head: number;
}

export interface OutlineNode extends OutlineHeading {
    children: OutlineNode[];
}

const ATX_RE = /^\s*(#{1,6})\s+(.+?)\s*$/;
const SETEXT_H1_RE = /^===+\s*$/;
const SETEXT_H2_RE = /^---+\s*$/;
const TRAILING_HASHES_RE = /\s+#+\s*$/;

function cleanHeadingTitle(raw: string): string {
    return raw
        .trim()
        .replace(TRAILING_HASHES_RE, "")
        .replace(/!\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/!\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/!\[([^\]]*)\]\[[^\]]+\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\[[^\]]+\]/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[\^([^\]]+)\]/g, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/_(.*?)_/g, "$1")
        .replace(/~~(.*?)~~/g, "$1")
        .replace(/==(.*?)==/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

function splitFrontmatter(content: string): { body: string; offset: number } {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/);
    if (!match) {
        return { body: content, offset: 0 };
    }

    return {
        body: content.slice(match[0].length),
        offset: match[0].length,
    };
}

export function extractHeadings(content: string): OutlineHeading[] {
    const { body, offset: frontmatterOffset } = splitFrontmatter(content);
    const lines = body.split("\n");
    const headings: OutlineHeading[] = [];
    let offset = frontmatterOffset;
    let fenceMarker: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const trimmed = line.trim();
        const detectedFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

        if (detectedFence) {
            if (fenceMarker === null) {
                if (detectedFence[1][0] !== "`" || !detectedFence[2].includes("`")) {
                    fenceMarker = detectedFence[1];
                }
            } else if (
                detectedFence[1][0] === fenceMarker[0] &&
                detectedFence[1].length >= fenceMarker.length &&
                !detectedFence[2].trim()
            ) {
                fenceMarker = null;
            }
            offset += rawLine.length + 1;
            continue;
        }

        if (fenceMarker === null) {
            const atx = ATX_RE.exec(line);
            if (atx) {
                const level = atx[1].length;
                const title = cleanHeadingTitle(atx[2]);
                if (title) {
                    headings.push({
                        id: `${offset}:${level}:${index}`,
                        title,
                        level,
                        anchor: offset,
                        head: offset + rawLine.length,
                    });
                }
            } else if (trimmed) {
                const nextLine = lines[index + 1] ?? "";
                const nextTrimmed = nextLine.endsWith("\r")
                    ? nextLine.slice(0, -1).trim()
                    : nextLine.trim();
                const level = SETEXT_H1_RE.test(nextTrimmed)
                    ? 1
                    : SETEXT_H2_RE.test(nextTrimmed)
                      ? 2
                      : null;
                if (level !== null) {
                    const title = cleanHeadingTitle(trimmed);
                    if (title) {
                        headings.push({
                            id: `${offset}:${level}:${index}`,
                            title,
                            level,
                            anchor: offset,
                            head: offset + rawLine.length,
                        });
                    }
                }
            }
        }

        offset += rawLine.length + 1;
    }

    return headings;
}

export function buildOutlineTree(headings: OutlineHeading[]): OutlineNode[] {
    const root: OutlineNode = {
        id: "root",
        title: "",
        level: 0,
        anchor: 0,
        head: 0,
        children: [],
    };
    const stack: OutlineNode[] = [root];

    for (const heading of headings) {
        const node: OutlineNode = { ...heading, children: [] };
        while (
            stack.length > 1 &&
            stack[stack.length - 1].level >= heading.level
        ) {
            stack.pop();
        }
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    }

    return root.children;
}
