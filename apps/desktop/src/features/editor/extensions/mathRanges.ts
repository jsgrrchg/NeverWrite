import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { selectionTouchesRange } from "./selectionActivity";

export interface MathRange {
    from: number;
    to: number;
    contentFrom: number;
    contentTo: number;
    tex: string;
    display: boolean;
    block: boolean;
}

const excludedNodes = new Set([
    "FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag",
    "URL", "LinkTitle", "LinkReference", "LinkLabel", "Autolink", "Image", "Table",
]);

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

interface TextRegion {
    from: number;
    to: number;
}

function escaped(text: string, at: number): boolean {
    let slashes = 0;
    while (at > 0 && text[--at] === "\\") slashes++;
    return slashes % 2 === 1;
}

/** Excluded syntax that the Markdown tree does not model, sorted by position. */
function excludedTextRegions(text: string): TextRegion[] {
    const regions: TextRegion[] = [];
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
    if (frontmatter) regions.push({ from: 0, to: frontmatter[0].length });
    // Wikilink targets are note names, which may contain literal dollars.
    for (const wikilink of text.matchAll(WIKILINK_RE)) {
        regions.push({ from: wikilink.index, to: wikilink.index + wikilink[0].length });
    }
    return regions;
}

/**
 * Recognize math in parsed Markdown only; background parsing fills later ranges.
 * The syntax walk is limited to the span holding dollars and the scan jumps
 * between them, so reparsing on every keystroke stays cheap in long notes.
 */
export function parseMathRanges(state: EditorState): MathRange[] {
    const tree = syntaxTree(state);
    const text = state.doc.sliceString(0, tree.length);
    const ranges: MathRange[] = [];
    const firstDollar = text.indexOf("$");
    if (firstDollar < 0) return ranges;
    const excluded = excludedTextRegions(text);
    // Only syntax containing a dollar or separating two of them can matter.
    tree.iterate({
        from: firstDollar,
        to: text.lastIndexOf("$") + 1,
        enter(node) {
            if (excludedNodes.has(node.name)) {
                excluded.push({ from: node.from, to: node.to });
                return false;
            }
        },
    });
    excluded.sort((a, b) => a.from - b.from);
    let excludedIndex = 0;
    for (let from = firstDollar; from >= 0; from = text.indexOf("$", from + 1)) {
        while (excludedIndex < excluded.length && excluded[excludedIndex].to <= from) {
            excludedIndex++;
        }
        const boundary = excluded[excludedIndex];
        if (boundary && boundary.from <= from) {
            from = boundary.to - 1;
            continue;
        }
        if (escaped(text, from)) continue;
        let runEnd = from + 1;
        while (text[runEnd] === "$") runEnd++;
        const width = runEnd - from;
        if (width > 2) {
            from = runEnd - 1;
            continue;
        }
        const display = width === 2;
        const contentFrom = from + width;
        if (!display && (!text[contentFrom] || /\s/.test(text[contentFrom]))) continue;
        const openingLine = state.doc.lineAt(from);
        const standaloneOpening = /^ {0,3}$/.test(text.slice(openingLine.from, from));
        // Multiline display math must open on its own line. Embedded $$ stays inline.
        const multiline = display && standaloneOpening &&
            /^\s*$/.test(text.slice(contentFrom, openingLine.to));
        // Code, HTML or links after the opener end the formula.
        const limit = Math.min(
            boundary?.from ?? text.length,
            multiline ? text.length : openingLine.to,
        );
        let match: MathRange | null = null;
        for (let close = text.indexOf("$", contentFrom); close >= 0 && close < limit; close = text.indexOf("$", close + 1)) {
            if (escaped(text, close)) continue;
            let end = close + 1;
            while (text[end] === "$") end++;
            if (end - close !== width) {
                // An unmatched inline opener must not consume a display formula.
                if (!display) break;
                close = end - 1;
                continue;
            }
            if (!display && (/\s/.test(text[close - 1]) || /\d/.test(text[end] ?? ""))) break;
            const closingLine = state.doc.lineAt(close);
            if (multiline && (
                !/^ {0,3}$/.test(text.slice(closingLine.from, close)) ||
                !/^\s*$/.test(text.slice(end, closingLine.to))
            )) continue;
            const tex = text.slice(contentFrom, close).trim();
            if (!tex) break;
            match = {
                from, to: end, contentFrom, contentTo: close, tex, display,
                block: display && standaloneOpening && /^\s*$/.test(text.slice(end, closingLine.to)),
            };
            break;
        }
        if (match) {
            ranges.push(match);
            from = match.to - 1;
        } else {
            // Never reinterpret the second dollar of an unmatched display delimiter.
            from = runEnd - 1;
        }
    }
    return ranges;
}

/** Shared by inline and block decorations; selection changes reuse the parsed ranges. */
export const mathRangesField = StateField.define<readonly MathRange[]>({
    create: parseMathRanges,
    update(ranges, transaction) {
        return transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
            ? parseMathRanges(transaction.state)
            : ranges;
    },
});

export function getMathRanges(state: EditorState): readonly MathRange[] {
    return state.field(mathRangesField, false) ?? parseMathRanges(state);
}

/** Index of the first range ending after `pos`; ranges are sorted and disjoint. */
function firstRangeEndingAfter(ranges: readonly MathRange[], pos: number): number {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (ranges[middle].to <= pos) low = middle + 1;
        else high = middle;
    }
    return low;
}

/** Ranges overlapping `[from, to)`, e.g. the formulas of a viewport. */
export function mathRangesBetween(ranges: readonly MathRange[], from: number, to: number): readonly MathRange[] {
    const start = firstRangeEndingAfter(ranges, from);
    let end = start;
    while (end < ranges.length && ranges[end].from < to) end++;
    return ranges.slice(start, end);
}

/** True when `[from, to)` cuts through a formula instead of containing it whole. */
export function crossesMathRange(ranges: readonly MathRange[], from: number, to: number): boolean {
    const atStart = ranges[firstRangeEndingAfter(ranges, from)];
    if (atStart && atStart.from < from) return true;
    const atEnd = ranges[firstRangeEndingAfter(ranges, to)];
    return Boolean(atEnd && atEnd.from < to);
}

/** Positions can be mapped cheaply when formula content and reveal state agree. */
export function mathRenderingChanged(before: EditorState, after: EditorState, blocksOnly = false): boolean {
    const previous = getMathRanges(before).filter((range) => !blocksOnly || range.block);
    const current = getMathRanges(after).filter((range) => !blocksOnly || range.block);
    return previous.length !== current.length || previous.some((range, index) => {
        const next = current[index];
        return range.tex !== next.tex || range.display !== next.display || range.block !== next.block ||
            selectionTouchesRange(before, range.from, range.to) !== selectionTouchesRange(after, next.from, next.to);
    });
}
