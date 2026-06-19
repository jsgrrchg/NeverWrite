// "Find in chat" highlighting via the CSS Custom Highlight API.
//
// We never mutate the rendered DOM/markdown. Instead we walk the visible text
// nodes inside the scroll container, build a `Range` per occurrence, and register
// them under named highlights styled by `::highlight(...)` in index.css.
// CSS.highlights is document-global, so each finder instance owns a slice of the
// aggregate highlights through a stable owner id.
//
// Matches may span several text nodes (markdown splits text across <em>, <code>,
// <a>, ... elements), so we flatten all text into one string with a segment map
// from a global UTF-16 offset back to its node + local offset. A sentinel
// separator is inserted between visible blocks so matches cannot bridge separate
// messages, paragraphs, list items, or code blocks.

export const CHAT_FIND_HIGHLIGHT = "chat-find";
export const CHAT_FIND_ACTIVE_HIGHLIGHT = "chat-find-active";

// Safety cap so a pathological 1-char query on a huge chat can't lock the UI.
export const MAX_CHAT_FIND_MATCHES = 2000;

const SEARCH_BLOCK_SEPARATOR = "\0";
const SEARCH_BLOCK_TAGS = new Set([
    "ARTICLE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
]);

type ChatFindHighlightOwnerId = string;

interface TextSegment {
    node: Text;
    start: number; // inclusive global offset
    end: number; // exclusive global offset
}

interface ChatFindHighlightEntry {
    ranges: Range[];
    activeRange?: Range;
}

const highlightEntries = new Map<
    ChatFindHighlightOwnerId,
    ChatFindHighlightEntry
>();

function syncChatFindHighlights(): void {
    const ranges: Range[] = [];
    const activeRanges: Range[] = [];

    for (const entry of highlightEntries.values()) {
        ranges.push(...entry.ranges);
        if (entry.activeRange) {
            activeRanges.push(entry.activeRange);
        }
    }

    if (ranges.length > 0) {
        CSS.highlights.set(CHAT_FIND_HIGHLIGHT, new Highlight(...ranges));
    } else {
        CSS.highlights.delete(CHAT_FIND_HIGHLIGHT);
    }

    if (activeRanges.length > 0) {
        CSS.highlights.set(
            CHAT_FIND_ACTIVE_HIGHLIGHT,
            new Highlight(...activeRanges),
        );
    } else {
        CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT);
    }
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

function findSearchBlock(node: Text, root: HTMLElement): Element | HTMLElement {
    let current = node.parentElement;
    while (current && current !== root) {
        if (
            current.hasAttribute("data-chat-row") ||
            SEARCH_BLOCK_TAGS.has(current.tagName)
        ) {
            return current;
        }
        current = current.parentElement;
    }
    return root;
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
    let previousBlock: Element | HTMLElement | null = null;
    let current = walker.nextNode() as Text | null;
    while (current) {
        const block = findSearchBlock(current, root);
        if (previousBlock && previousBlock !== block) {
            parts.push(SEARCH_BLOCK_SEPARATOR);
            cursor += SEARCH_BLOCK_SEPARATOR.length;
        }

        const len = current.data.length;
        segments.push({ node: current, start: cursor, end: cursor + len });
        parts.push(current.data);
        cursor += len;
        previousBlock = block;
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

const caseInsensitiveCollator =
    typeof Intl !== "undefined"
        ? new Intl.Collator(undefined, {
              usage: "search",
              sensitivity: "accent",
          })
        : null;

function matchesQueryAt(
    haystack: string,
    needle: string,
    index: number,
    caseSensitive: boolean,
): boolean {
    const candidate = haystack.slice(index, index + needle.length);
    if (caseSensitive) return candidate === needle;

    // Keep offsets in the original string. Lowercasing the full haystack can
    // change its UTF-16 length for some characters (for example, İ -> i + dot).
    if (caseInsensitiveCollator) {
        return caseInsensitiveCollator.compare(candidate, needle) === 0;
    }
    return candidate.toLowerCase() === needle.toLowerCase();
}

function findNextMatch(
    haystack: string,
    needle: string,
    from: number,
    caseSensitive: boolean,
): number {
    if (caseSensitive) return haystack.indexOf(needle, from);

    const lastStart = haystack.length - needle.length;
    for (let index = from; index <= lastStart; index++) {
        if (matchesQueryAt(haystack, needle, index, false)) {
            return index;
        }
    }
    return -1;
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
    if (query.includes(SEARCH_BLOCK_SEPARATOR)) return [];

    const { fullText, segments } = collectSegments(root);
    if (segments.length === 0) return [];

    const haystack = fullText;
    const needle = query;
    const needleLen = needle.length;
    if (needleLen === 0) return [];

    const ranges: Range[] = [];
    let from = 0;
    while (ranges.length < MAX_CHAT_FIND_MATCHES) {
        const idx = findNextMatch(haystack, needle, from, caseSensitive);
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

/** Register one finder's ranges + active match in the global highlight registry. */
export function applyChatFindHighlights(
    ownerId: ChatFindHighlightOwnerId,
    ranges: Range[],
    activeIndex: number,
): void {
    if (ranges.length === 0) {
        clearChatFindHighlights(ownerId);
        return;
    }
    highlightEntries.set(ownerId, {
        ranges,
        activeRange: ranges[activeIndex],
    });
    syncChatFindHighlights();
}

/** Re-register only the active highlight (cheap path used while navigating). */
export function setActiveChatFindHighlight(
    ownerId: ChatFindHighlightOwnerId,
    range: Range | undefined,
): void {
    const entry = highlightEntries.get(ownerId);
    if (!entry) return;
    highlightEntries.set(ownerId, {
        ...entry,
        activeRange: range,
    });
    syncChatFindHighlights();
}

/** Remove one finder's ranges from the document-wide highlight registry. */
export function clearChatFindHighlights(
    ownerId: ChatFindHighlightOwnerId,
): void {
    highlightEntries.delete(ownerId);
    syncChatFindHighlights();
}
