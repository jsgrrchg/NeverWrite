// "Find in chat" highlighting via the CSS Custom Highlight API.
//
// We never mutate the rendered DOM/markdown. Instead we walk the visible text
// nodes inside the scroll container, build a `Range` per occurrence, and register
// them under named highlights styled by `::highlight(...)` in index.css.
//
// Matches may span several text nodes (markdown splits text across <em>, <code>,
// <a>, ... elements), so we flatten all text into one string with a segment map
// from a global UTF-16 offset back to its node + local offset.

export const CHAT_FIND_HIGHLIGHT = "chat-find";
export const CHAT_FIND_ACTIVE_HIGHLIGHT = "chat-find-active";

// Safety cap so a pathological 1-char query on a huge chat can't lock the UI.
export const MAX_CHAT_FIND_MATCHES = 2000;

interface TextSegment {
    node: Text;
    start: number; // inclusive global offset
    end: number; // exclusive global offset
}

function isVisibleTextNode(node: Text): boolean {
    const el = node.parentElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    if (typeof el.checkVisibility === "function") {
        return el.checkVisibility();
    }
    // Fallback: offsetParent is null for display:none subtrees.
    return el.offsetParent !== null;
}

function collectSegments(root: HTMLElement): {
    fullText: string;
    segments: TextSegment[];
} {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const text = node as Text;
            if (!text.data || text.data.length === 0) {
                return NodeFilter.FILTER_REJECT;
            }
            return isVisibleTextNode(text)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        },
    });

    const segments: TextSegment[] = [];
    const parts: string[] = [];
    let cursor = 0;
    let current = walker.nextNode() as Text | null;
    while (current) {
        const len = current.data.length;
        segments.push({ node: current, start: cursor, end: cursor + len });
        parts.push(current.data);
        cursor += len;
        current = walker.nextNode() as Text | null;
    }
    return { fullText: parts.join(""), segments };
}

// Segment containing `offset` as a START position: start <= offset < end.
function locateStart(segments: TextSegment[], offset: number): TextSegment {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = segments[mid];
        if (offset < seg.start) hi = mid - 1;
        else if (offset >= seg.end) lo = mid + 1;
        else return seg;
    }
    return segments[segments.length - 1];
}

// Segment containing `offset` as an END position: start < offset <= end.
function locateEnd(segments: TextSegment[], offset: number): TextSegment {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = segments[mid];
        if (offset <= seg.start) hi = mid - 1;
        else if (offset > seg.end) lo = mid + 1;
        else return seg;
    }
    return segments[segments.length - 1];
}

/**
 * Build one Range per occurrence of `query` inside `root`'s visible text.
 * Case-insensitive unless `caseSensitive` is true. Returns ranges in document
 * order, capped at MAX_CHAT_FIND_MATCHES.
 */
export function buildRangesForQuery(
    root: HTMLElement,
    query: string,
    caseSensitive: boolean,
): Range[] {
    if (!query) return [];

    const { fullText, segments } = collectSegments(root);
    if (segments.length === 0) return [];

    const haystack = caseSensitive ? fullText : fullText.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const needleLen = needle.length;
    if (needleLen === 0) return [];

    const ranges: Range[] = [];
    let from = 0;
    while (ranges.length < MAX_CHAT_FIND_MATCHES) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        const endOffset = idx + needleLen;

        const startSeg = locateStart(segments, idx);
        const endSeg = locateEnd(segments, endOffset);

        const range = document.createRange();
        range.setStart(startSeg.node, idx - startSeg.start);
        range.setEnd(endSeg.node, endOffset - endSeg.start);
        ranges.push(range);

        from = endOffset; // non-overlapping, matches browser find semantics
    }
    return ranges;
}

/** Register all ranges + the active one in the global highlight registry. */
export function applyChatFindHighlights(
    ranges: Range[],
    activeIndex: number,
): void {
    if (ranges.length === 0) {
        clearChatFindHighlights();
        return;
    }
    CSS.highlights.set(CHAT_FIND_HIGHLIGHT, new Highlight(...ranges));
    const active = ranges[activeIndex];
    if (active) {
        CSS.highlights.set(CHAT_FIND_ACTIVE_HIGHLIGHT, new Highlight(active));
    } else {
        CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT);
    }
}

/** Re-register only the active highlight (cheap path used while navigating). */
export function setActiveChatFindHighlight(range: Range | undefined): void {
    if (range) {
        CSS.highlights.set(CHAT_FIND_ACTIVE_HIGHLIGHT, new Highlight(range));
    } else {
        CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT);
    }
}

/** Remove both highlights from the global (document-wide) registry. */
export function clearChatFindHighlights(): void {
    CSS.highlights.delete(CHAT_FIND_HIGHLIGHT);
    CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT);
}
