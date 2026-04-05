const WIKILINK_RE = /\[\[([^\][]+)\]\]/g;

export interface WikilinkMatch {
    from: number;
    to: number;
    target: string;
    alias?: string;
}

export function findWikilinks(doc: string): WikilinkMatch[] {
    const results: WikilinkMatch[] = [];
    let match;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(doc)) !== null) {
        const inner = match[1];
        const pipeIndex = inner.indexOf("|");
        const target =
            pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
        const alias =
            pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : undefined;
        results.push({
            from: match.index,
            to: match.index + match[0].length,
            target,
            alias,
        });
    }
    return results;
}
