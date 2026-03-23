import type {
    AgentTextSpan,
    HunkWordDiffs,
    LineEdit,
    LinePatch,
    PerFileUndo,
    TextEdit,
    TextRangePatch,
    TrackedFile,
    WordDiffRange,
} from "../diff/actionLogTypes";

function emptyPatch(): LinePatch {
    return { edits: [] };
}

function emptyTextRangePatch(): TextRangePatch {
    return { spans: [] };
}

function patchIsEmpty(patch: LinePatch): boolean {
    return patch.edits.length === 0;
}

function rangesOverlap(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
): boolean {
    if (aStart === aEnd && bStart === bEnd) return aStart === bStart;
    return aStart < bEnd && bStart < aEnd;
}

function buildLineStartOffsets(text: string): number[] {
    const offsets = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
            offsets.push(index + 1);
        }
    }
    return offsets;
}

function lineIndexAtOffset(lineStarts: number[], offset: number): number {
    if (lineStarts.length === 0) return 0;
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return Math.max(0, high);
}

function insertionLineIndexAtOffset(
    lineStarts: number[],
    offset: number,
): number {
    let low = 0;
    let high = lineStarts.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] < offset) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

function lineIndexToOffset(lineStarts: number[], text: string, line: number) {
    if (line <= 0) return 0;
    if (line >= lineStarts.length) return text.length;
    return lineStarts[line];
}

function commonPrefixLength(a: string, b: string): number {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) {
        index += 1;
    }
    return index;
}

function commonSuffixLength(
    a: string,
    b: string,
    prefixLength: number,
): number {
    const maxSuffix = Math.min(a.length, b.length) - prefixLength;
    let index = 0;
    while (
        index < maxSuffix &&
        a[a.length - 1 - index] === b[b.length - 1 - index]
    ) {
        index += 1;
    }
    return index;
}

function buildTextRangePatchFromLinePatch(
    baseText: string,
    currentText: string,
    patch: LinePatch,
): TextRangePatch {
    if (patchIsEmpty(patch)) {
        return emptyTextRangePatch();
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const spans: AgentTextSpan[] = [];

    for (const edit of patch.edits) {
        const baseWindowStart = lineIndexToOffset(
            baseLineStarts,
            baseText,
            edit.oldStart,
        );
        const baseWindowEnd = lineIndexToOffset(
            baseLineStarts,
            baseText,
            edit.oldEnd,
        );
        const currentWindowStart = lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newStart,
        );
        const currentWindowEnd = lineIndexToOffset(
            currentLineStarts,
            currentText,
            edit.newEnd,
        );

        const baseWindowText = baseText.slice(baseWindowStart, baseWindowEnd);
        const currentWindowText = currentText.slice(
            currentWindowStart,
            currentWindowEnd,
        );

        if (baseWindowText === currentWindowText) {
            continue;
        }

        const prefixLength = commonPrefixLength(
            baseWindowText,
            currentWindowText,
        );
        const suffixLength = commonSuffixLength(
            baseWindowText,
            currentWindowText,
            prefixLength,
        );

        spans.push({
            baseFrom: baseWindowStart + prefixLength,
            baseTo: baseWindowEnd - suffixLength,
            currentFrom: currentWindowStart + prefixLength,
            currentTo: currentWindowEnd - suffixLength,
        });
    }

    return { spans };
}

function isLineBoundary(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) return true;
    return text[offset - 1] === "\n";
}

function isSingleLineTextRange(
    _text: string,
    lineStarts: number[],
    from: number,
    to: number,
): boolean {
    if (from >= to) return true;
    return (
        lineIndexAtOffset(lineStarts, from) ===
        lineIndexAtOffset(lineStarts, to - 1)
    );
}

function spanPartToLineRange(
    text: string,
    lineStarts: number[],
    from: number,
    to: number,
    counterpartText: string,
    counterpartFrom: number,
    counterpartTo: number,
): { start: number; end: number } {
    if (from === to && counterpartFrom === counterpartTo) {
        const point = insertionLineIndexAtOffset(lineStarts, from);
        return { start: point, end: point };
    }

    if (from === to) {
        const insertedText = counterpartText.slice(
            counterpartFrom,
            counterpartTo,
        );
        const inlineSingleLineInsert =
            !insertedText.includes("\n") &&
            !isLineBoundary(text, from) &&
            !isLineBoundary(counterpartText, counterpartFrom);

        if (inlineSingleLineInsert) {
            const line = lineIndexAtOffset(lineStarts, Math.max(0, from - 1));
            return { start: line, end: line + 1 };
        }

        const point = insertionLineIndexAtOffset(lineStarts, from);
        return { start: point, end: point };
    }

    const changedText = text.slice(from, to);
    const counterpartChangedText = counterpartText.slice(
        counterpartFrom,
        counterpartTo,
    );
    const inlineSingleLineChange =
        !changedText.includes("\n") &&
        !counterpartChangedText.includes("\n") &&
        isSingleLineTextRange(text, lineStarts, from, to);

    if (inlineSingleLineChange) {
        const line = lineIndexAtOffset(lineStarts, from);
        return { start: line, end: line + 1 };
    }

    return {
        start: lineIndexAtOffset(lineStarts, from),
        end: lineIndexAtOffset(lineStarts, to - 1) + 1,
    };
}

function mergeOverlappingLineEdits(edits: LineEdit[]): LineEdit[] {
    if (edits.length <= 1) return edits;

    const sorted = [...edits].sort((left, right) => {
        if (left.newStart !== right.newStart) {
            return left.newStart - right.newStart;
        }
        if (left.newEnd !== right.newEnd) {
            return left.newEnd - right.newEnd;
        }
        if (left.oldStart !== right.oldStart) {
            return left.oldStart - right.oldStart;
        }
        return left.oldEnd - right.oldEnd;
    });

    const merged: LineEdit[] = [{ ...sorted[0] }];
    for (const edit of sorted.slice(1)) {
        const previous = merged[merged.length - 1];
        const overlapsOld = rangesOverlap(
            previous.oldStart,
            previous.oldEnd,
            edit.oldStart,
            edit.oldEnd,
        );
        const overlapsNew = rangesOverlap(
            previous.newStart,
            previous.newEnd,
            edit.newStart,
            edit.newEnd,
        );

        if (overlapsOld || overlapsNew) {
            previous.oldStart = Math.min(previous.oldStart, edit.oldStart);
            previous.oldEnd = Math.max(previous.oldEnd, edit.oldEnd);
            previous.newStart = Math.min(previous.newStart, edit.newStart);
            previous.newEnd = Math.max(previous.newEnd, edit.newEnd);
            continue;
        }

        merged.push({ ...edit });
    }

    return merged;
}

function spansEqual(a: AgentTextSpan[], b: AgentTextSpan[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((span, index) => {
        const other = b[index];
        return (
            span.baseFrom === other.baseFrom &&
            span.baseTo === other.baseTo &&
            span.currentFrom === other.currentFrom &&
            span.currentTo === other.currentTo
        );
    });
}

function linePatchesEqual(a: LinePatch, b: LinePatch): boolean {
    if (a.edits.length !== b.edits.length) return false;
    return a.edits.every((edit, index) => {
        const other = b.edits[index];
        return (
            edit.oldStart === other.oldStart &&
            edit.oldEnd === other.oldEnd &&
            edit.newStart === other.newStart &&
            edit.newEnd === other.newEnd
        );
    });
}

function getLineEditForSpan(
    baseText: string,
    currentText: string,
    span: AgentTextSpan,
): LineEdit | null {
    const patch = deriveLinePatchFromTextRangesFallback(baseText, currentText, [
        span,
    ]);
    return patch.edits[0] ?? null;
}

function spanMatchesLineRange(
    baseText: string,
    currentText: string,
    span: AgentTextSpan,
    startLine: number,
    endLine: number,
): boolean {
    const edit = getLineEditForSpan(baseText, currentText, span);
    if (!edit) return false;
    return rangesOverlap(startLine, endLine, edit.newStart, edit.newEnd);
}

export function mapTextPositionThroughEditsFallback(
    position: number,
    edits: TextEdit[],
    assoc: -1 | 1,
): number {
    let delta = 0;

    for (const edit of edits) {
        const changeDelta =
            edit.newTo - edit.newFrom - (edit.oldTo - edit.oldFrom);

        if (edit.oldTo < position || (edit.oldTo === position && assoc > 0)) {
            delta += changeDelta;
            continue;
        }

        break;
    }

    return position + delta;
}

export function mapAgentSpanThroughTextEditsFallback(
    span: AgentTextSpan,
    edits: TextEdit[],
): AgentTextSpan | null {
    const touchedByUser = edits.some((edit) =>
        rangesOverlap(
            edit.oldFrom,
            edit.oldTo,
            span.currentFrom,
            span.currentTo,
        ),
    );

    if (touchedByUser) {
        return null;
    }

    return {
        ...span,
        currentFrom: mapTextPositionThroughEditsFallback(
            span.currentFrom,
            edits,
            1,
        ),
        currentTo: mapTextPositionThroughEditsFallback(
            span.currentTo,
            edits,
            -1,
        ),
    };
}

export function rebuildDiffBaseFromPendingSpansFallback(
    originalDiffBase: string,
    currentText: string,
    spans: AgentTextSpan[],
): string {
    if (spans.length === 0) {
        return currentText;
    }

    const sortedSpans = [...spans].sort(
        (left, right) => left.currentFrom - right.currentFrom,
    );
    const parts: string[] = [];
    let cursor = 0;

    for (const span of sortedSpans) {
        parts.push(currentText.slice(cursor, span.currentFrom));
        parts.push(originalDiffBase.slice(span.baseFrom, span.baseTo));
        cursor = span.currentTo;
    }

    parts.push(currentText.slice(cursor));
    return parts.join("");
}

export function buildPatchFromTextsFallback(
    oldText: string,
    newText: string,
): LinePatch {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    const table: number[][] = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );

    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            table[row][col] =
                oldLines[row - 1] === newLines[col - 1]
                    ? table[row - 1][col - 1] + 1
                    : Math.max(table[row - 1][col], table[row][col - 1]);
        }
    }

    const edits: LineEdit[] = [];
    let oldIndex = oldLines.length;
    let newIndex = newLines.length;
    let currentEdit: LineEdit | null = null;

    while (oldIndex > 0 || newIndex > 0) {
        if (
            oldIndex > 0 &&
            newIndex > 0 &&
            oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ) {
            if (currentEdit) {
                edits.push(currentEdit);
                currentEdit = null;
            }
            oldIndex -= 1;
            newIndex -= 1;
        } else if (
            newIndex > 0 &&
            (oldIndex === 0 ||
                table[oldIndex][newIndex - 1] >= table[oldIndex - 1][newIndex])
        ) {
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oldIndex,
                    oldEnd: oldIndex,
                    newStart: newIndex - 1,
                    newEnd: newIndex,
                };
            } else {
                currentEdit.newStart = newIndex - 1;
            }
            newIndex -= 1;
        } else {
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oldIndex - 1,
                    oldEnd: oldIndex,
                    newStart: newIndex,
                    newEnd: newIndex,
                };
            } else {
                currentEdit.oldStart = oldIndex - 1;
            }
            oldIndex -= 1;
        }
    }

    if (currentEdit) {
        edits.push(currentEdit);
    }

    edits.reverse();
    return { edits };
}

export function buildTextRangePatchFromTextsFallback(
    oldText: string,
    newText: string,
    linePatch?: LinePatch,
): TextRangePatch {
    if (oldText === newText) {
        return emptyTextRangePatch();
    }

    return buildTextRangePatchFromLinePatch(
        oldText,
        newText,
        linePatch ?? buildPatchFromTextsFallback(oldText, newText),
    );
}

interface WordDiffToken {
    text: string;
    from: number;
    to: number;
}

interface TokenEdit {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function lineContentRange(
    lineStarts: number[],
    text: string,
    lineIndex: number,
): { from: number; to: number } {
    const from = lineIndexToOffset(lineStarts, text, lineIndex);
    if (lineIndex + 1 >= lineStarts.length) {
        return { from, to: text.length };
    }

    return {
        from,
        to: Math.max(from, lineStarts[lineIndex + 1] - 1),
    };
}

function tokenizeWordDiffText(
    text: string,
    absoluteOffset: number,
): WordDiffToken[] {
    if (text.length === 0) return [];

    const tokens: WordDiffToken[] = [];
    const matcher = /\s+|\w+|[^\w\s]+/g;
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(text)) !== null) {
        tokens.push({
            text: match[0],
            from: absoluteOffset + match.index,
            to: absoluteOffset + match.index + match[0].length,
        });
    }

    if (tokens.length === 0) {
        tokens.push({
            text,
            from: absoluteOffset,
            to: absoluteOffset + text.length,
        });
    }

    return tokens;
}

function buildTokenDiffEdits(
    oldTokens: WordDiffToken[],
    newTokens: WordDiffToken[],
): TokenEdit[] {
    const rows = oldTokens.length + 1;
    const cols = newTokens.length + 1;
    const table: number[][] = Array.from({ length: rows }, () =>
        new Array<number>(cols).fill(0),
    );

    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            table[row][col] =
                oldTokens[row - 1].text === newTokens[col - 1].text
                    ? table[row - 1][col - 1] + 1
                    : Math.max(table[row - 1][col], table[row][col - 1]);
        }
    }

    const edits: TokenEdit[] = [];
    let oldIndex = oldTokens.length;
    let newIndex = newTokens.length;
    let currentEdit: TokenEdit | null = null;

    while (oldIndex > 0 || newIndex > 0) {
        if (
            oldIndex > 0 &&
            newIndex > 0 &&
            oldTokens[oldIndex - 1].text === newTokens[newIndex - 1].text
        ) {
            if (currentEdit) {
                edits.push(currentEdit);
                currentEdit = null;
            }
            oldIndex -= 1;
            newIndex -= 1;
        } else if (
            newIndex > 0 &&
            (oldIndex === 0 ||
                table[oldIndex][newIndex - 1] >= table[oldIndex - 1][newIndex])
        ) {
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oldIndex,
                    oldEnd: oldIndex,
                    newStart: newIndex - 1,
                    newEnd: newIndex,
                };
            } else {
                currentEdit.newStart = newIndex - 1;
            }
            newIndex -= 1;
        } else {
            if (!currentEdit) {
                currentEdit = {
                    oldStart: oldIndex - 1,
                    oldEnd: oldIndex,
                    newStart: newIndex,
                    newEnd: newIndex,
                };
            } else {
                currentEdit.oldStart = oldIndex - 1;
            }
            oldIndex -= 1;
        }
    }

    if (currentEdit) {
        edits.push(currentEdit);
    }

    edits.reverse();
    return edits;
}

function tokenBoundaryOffset(
    tokens: WordDiffToken[],
    tokenIndex: number,
    lineStart: number,
    lineEnd: number,
): number {
    if (tokenIndex <= 0) return lineStart;
    if (tokenIndex >= tokens.length) return lineEnd;
    return tokens[tokenIndex].from;
}

function trimWhitespaceRange(
    text: string,
    from: number,
    to: number,
): { from: number; to: number } {
    let start = from;
    let end = to;

    while (start < end && /\s/.test(text[start] ?? "")) {
        start += 1;
    }
    while (end > start && /\s/.test(text[end - 1] ?? "")) {
        end -= 1;
    }

    return { from: start, to: end };
}

function mergeWordDiffRanges(ranges: WordDiffRange[]): WordDiffRange[] {
    if (ranges.length <= 1) return ranges;

    const sorted = [...ranges].sort((left, right) => left.from - right.from);
    const merged: WordDiffRange[] = [sorted[0]];

    for (const range of sorted.slice(1)) {
        const previous = merged[merged.length - 1];
        if (range.from <= previous.to && range.baseFrom <= previous.baseTo) {
            previous.to = Math.max(previous.to, range.to);
            previous.baseTo = Math.max(previous.baseTo, range.baseTo);
            continue;
        }
        merged.push({ ...range });
    }

    return merged;
}

function computeWordDiffsForLine(
    baseText: string,
    currentText: string,
    baseRange: { from: number; to: number },
    currentRange: { from: number; to: number },
): HunkWordDiffs | null {
    const baseLine = baseText.slice(baseRange.from, baseRange.to);
    const currentLine = currentText.slice(currentRange.from, currentRange.to);

    if (baseLine === currentLine) {
        return null;
    }

    const oldTokens = tokenizeWordDiffText(baseLine, baseRange.from);
    const newTokens = tokenizeWordDiffText(currentLine, currentRange.from);
    const tokenEdits = buildTokenDiffEdits(oldTokens, newTokens);

    if (tokenEdits.length === 0) {
        return null;
    }

    const bufferRanges: WordDiffRange[] = [];
    const baseRanges: WordDiffRange[] = [];

    for (const edit of tokenEdits) {
        const baseFrom = tokenBoundaryOffset(
            oldTokens,
            edit.oldStart,
            baseRange.from,
            baseRange.to,
        );
        const baseTo = tokenBoundaryOffset(
            oldTokens,
            edit.oldEnd,
            baseRange.from,
            baseRange.to,
        );
        const currentFrom = tokenBoundaryOffset(
            newTokens,
            edit.newStart,
            currentRange.from,
            currentRange.to,
        );
        const currentTo = tokenBoundaryOffset(
            newTokens,
            edit.newEnd,
            currentRange.from,
            currentRange.to,
        );

        const trimmedBase = trimWhitespaceRange(baseText, baseFrom, baseTo);
        const trimmedCurrent = trimWhitespaceRange(
            currentText,
            currentFrom,
            currentTo,
        );

        if (trimmedCurrent.from < trimmedCurrent.to) {
            bufferRanges.push({
                from: trimmedCurrent.from,
                to: trimmedCurrent.to,
                baseFrom: trimmedBase.from,
                baseTo: trimmedBase.to,
            });
        }

        if (trimmedBase.from < trimmedBase.to) {
            baseRanges.push({
                from: trimmedBase.from,
                to: trimmedBase.to,
                baseFrom: trimmedBase.from,
                baseTo: trimmedBase.to,
            });
        }
    }

    if (bufferRanges.length === 0 && baseRanges.length === 0) {
        return null;
    }

    return {
        bufferRanges: mergeWordDiffRanges(bufferRanges),
        baseRanges: mergeWordDiffRanges(baseRanges),
    };
}

export function computeWordDiffsForHunkFallback(
    baseText: string,
    currentText: string,
    edit: LineEdit,
    options: {
        maxLines?: number;
        maxChars?: number;
    } = {},
): HunkWordDiffs | null {
    const oldLineCount = edit.oldEnd - edit.oldStart;
    const newLineCount = edit.newEnd - edit.newStart;
    const maxLines = options.maxLines ?? 5;
    const maxChars = options.maxChars ?? 240;

    if (oldLineCount <= 0 || newLineCount <= 0) {
        return null;
    }
    if (oldLineCount !== newLineCount) {
        return null;
    }
    if (oldLineCount > maxLines) {
        return null;
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const baseWindowStart = lineIndexToOffset(
        baseLineStarts,
        baseText,
        edit.oldStart,
    );
    const baseWindowEnd = lineIndexToOffset(
        baseLineStarts,
        baseText,
        edit.oldEnd,
    );
    const currentWindowStart = lineIndexToOffset(
        currentLineStarts,
        currentText,
        edit.newStart,
    );
    const currentWindowEnd = lineIndexToOffset(
        currentLineStarts,
        currentText,
        edit.newEnd,
    );

    if (
        Math.max(
            baseWindowEnd - baseWindowStart,
            currentWindowEnd - currentWindowStart,
        ) > maxChars
    ) {
        return null;
    }

    const bufferRanges: WordDiffRange[] = [];
    const baseRanges: WordDiffRange[] = [];

    for (let lineOffset = 0; lineOffset < oldLineCount; lineOffset += 1) {
        const baseRange = lineContentRange(
            baseLineStarts,
            baseText,
            edit.oldStart + lineOffset,
        );
        const currentRange = lineContentRange(
            currentLineStarts,
            currentText,
            edit.newStart + lineOffset,
        );
        const lineDiff = computeWordDiffsForLine(
            baseText,
            currentText,
            baseRange,
            currentRange,
        );

        if (!lineDiff) continue;
        bufferRanges.push(...lineDiff.bufferRanges);
        baseRanges.push(...lineDiff.baseRanges);
    }

    if (bufferRanges.length === 0 && baseRanges.length === 0) {
        return null;
    }

    return {
        bufferRanges: mergeWordDiffRanges(bufferRanges),
        baseRanges: mergeWordDiffRanges(baseRanges),
    };
}

export function deriveLinePatchFromTextRangesFallback(
    baseText: string,
    currentText: string,
    spans: AgentTextSpan[],
): LinePatch {
    if (spans.length === 0) {
        return emptyPatch();
    }

    const baseLineStarts = buildLineStartOffsets(baseText);
    const currentLineStarts = buildLineStartOffsets(currentText);
    const edits = spans.map((span) => {
        const oldRange = spanPartToLineRange(
            baseText,
            baseLineStarts,
            span.baseFrom,
            span.baseTo,
            currentText,
            span.currentFrom,
            span.currentTo,
        );
        const newRange = spanPartToLineRange(
            currentText,
            currentLineStarts,
            span.currentFrom,
            span.currentTo,
            baseText,
            span.baseFrom,
            span.baseTo,
        );

        return {
            oldStart: oldRange.start,
            oldEnd: oldRange.end,
            newStart: newRange.start,
            newEnd: newRange.end,
        };
    });

    return { edits: mergeOverlappingLineEdits(edits) };
}

export function syncDerivedLinePatchFallback(file: TrackedFile): TrackedFile {
    const unreviewedRanges = file.unreviewedRanges
        ? file.unreviewedRanges
        : buildTextRangePatchFromTextsFallback(
              file.diffBase,
              file.currentText,
              file.unreviewedEdits,
          );
    const unreviewedEdits = deriveLinePatchFromTextRangesFallback(
        file.diffBase,
        file.currentText,
        unreviewedRanges.spans,
    );

    if (
        file.unreviewedRanges &&
        spansEqual(file.unreviewedRanges.spans, unreviewedRanges.spans) &&
        linePatchesEqual(file.unreviewedEdits, unreviewedEdits)
    ) {
        return file;
    }

    return {
        ...file,
        unreviewedRanges,
        unreviewedEdits,
    };
}

export function applyNonConflictingEditsFallback(
    file: TrackedFile,
    userEdits: TextEdit[],
    newFullText: string,
): TrackedFile {
    const syncedFile = syncDerivedLinePatchFallback(file);

    if (userEdits.length === 0) {
        return {
            ...syncedFile,
            currentText: newFullText,
            version: syncedFile.version + 1,
        };
    }

    if (
        syncedFile.unreviewedRanges == null ||
        syncedFile.unreviewedRanges.spans.length === 0
    ) {
        return {
            ...syncedFile,
            diffBase: newFullText,
            currentText: newFullText,
            unreviewedRanges: emptyTextRangePatch(),
            unreviewedEdits: emptyPatch(),
            version: syncedFile.version + 1,
        };
    }

    const survivingSpans = syncedFile.unreviewedRanges.spans
        .map((span) => mapAgentSpanThroughTextEditsFallback(span, userEdits))
        .filter((span): span is AgentTextSpan => span !== null);
    const newDiffBase = rebuildDiffBaseFromPendingSpansFallback(
        syncedFile.diffBase,
        newFullText,
        survivingSpans,
    );
    const unreviewedRanges =
        survivingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTextsFallback(newDiffBase, newFullText);
    const unreviewedEdits = deriveLinePatchFromTextRangesFallback(
        newDiffBase,
        newFullText,
        unreviewedRanges.spans,
    );

    return {
        ...syncedFile,
        diffBase: newDiffBase,
        currentText: newFullText,
        unreviewedRanges,
        unreviewedEdits,
        version: syncedFile.version + 1,
    };
}

export function keepEditsInRangeFallback(
    file: TrackedFile,
    startLine: number,
    endLine: number,
): TrackedFile {
    const syncedFile = syncDerivedLinePatchFallback(file);
    const currentSpans = syncedFile.unreviewedRanges?.spans ?? [];
    const remainingSpans = currentSpans.filter(
        (span) =>
            !spanMatchesLineRange(
                syncedFile.diffBase,
                syncedFile.currentText,
                span,
                startLine,
                endLine,
            ),
    );
    const newDiffBase = rebuildDiffBaseFromPendingSpansFallback(
        syncedFile.diffBase,
        syncedFile.currentText,
        remainingSpans,
    );
    const unreviewedRanges =
        remainingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTextsFallback(
                  newDiffBase,
                  syncedFile.currentText,
              );
    const unreviewedEdits = deriveLinePatchFromTextRangesFallback(
        newDiffBase,
        syncedFile.currentText,
        unreviewedRanges.spans,
    );

    return {
        ...syncedFile,
        diffBase: newDiffBase,
        unreviewedRanges,
        unreviewedEdits,
        version: syncedFile.version + 1,
    };
}

export function rejectAllEditsFallback(file: TrackedFile): {
    file: TrackedFile;
    undoData: PerFileUndo;
} {
    const syncedFile = syncDerivedLinePatchFallback(file);
    const currentLines = syncedFile.currentText.split("\n");

    const editsToRestore = syncedFile.unreviewedEdits.edits.map((edit) => ({
        startLine: edit.newStart,
        endLine: edit.newEnd,
        text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
    }));

    const undoData: PerFileUndo = {
        path: syncedFile.path,
        editsToRestore,
        previousStatus: syncedFile.status,
    };

    return {
        file: {
            ...syncedFile,
            currentText: syncedFile.diffBase,
            unreviewedRanges: emptyTextRangePatch(),
            unreviewedEdits: emptyPatch(),
            version: syncedFile.version + 1,
        },
        undoData,
    };
}

export function rejectEditsInRangesFallback(
    file: TrackedFile,
    ranges: Array<{ start: number; end: number }>,
): { file: TrackedFile; undoData: PerFileUndo } {
    const syncedFile = syncDerivedLinePatchFallback(file);
    const currentLines = syncedFile.currentText.split("\n");
    const currentSpans = syncedFile.unreviewedRanges?.spans ?? [];
    const rejectedSpans = currentSpans.filter((span) =>
        ranges.some((range) =>
            spanMatchesLineRange(
                syncedFile.diffBase,
                syncedFile.currentText,
                span,
                range.start,
                range.end,
            ),
        ),
    );
    const remainingSpans = currentSpans.filter(
        (span) => !rejectedSpans.includes(span),
    );

    const editsToRestore: PerFileUndo["editsToRestore"] = [];
    for (const span of rejectedSpans) {
        const edit = getLineEditForSpan(
            syncedFile.diffBase,
            syncedFile.currentText,
            span,
        );
        if (!edit) continue;

        editsToRestore.push({
            startLine: edit.newStart,
            endLine: edit.newEnd,
            text: currentLines.slice(edit.newStart, edit.newEnd).join("\n"),
        });
    }

    const newCurrentText = rebuildDiffBaseFromPendingSpansFallback(
        syncedFile.diffBase,
        syncedFile.currentText,
        rejectedSpans,
    );
    const unreviewedRanges =
        remainingSpans.length === 0
            ? emptyTextRangePatch()
            : buildTextRangePatchFromTextsFallback(
                  syncedFile.diffBase,
                  newCurrentText,
              );
    const unreviewedEdits = deriveLinePatchFromTextRangesFallback(
        syncedFile.diffBase,
        newCurrentText,
        unreviewedRanges.spans,
    );

    const undoData: PerFileUndo = {
        path: syncedFile.path,
        editsToRestore,
        previousStatus: syncedFile.status,
    };

    return {
        file: {
            ...syncedFile,
            currentText: newCurrentText,
            unreviewedRanges,
            unreviewedEdits,
            version: syncedFile.version + 1,
        },
        undoData,
    };
}

export function applyRejectUndoFallback(
    file: TrackedFile,
    undo: PerFileUndo,
): TrackedFile {
    const syncedFile = syncDerivedLinePatchFallback(file);
    const lines = syncedFile.currentText.split("\n");
    let delta = 0;

    for (const entry of undo.editsToRestore) {
        const restoreLines = entry.text.split("\n");
        const spliceStart = entry.startLine + delta;
        const matchingEdit = syncedFile.unreviewedEdits.edits.find(
            (edit) => edit.newStart === entry.startLine + delta,
        );
        const deleteCount = matchingEdit
            ? matchingEdit.newEnd - matchingEdit.newStart
            : restoreLines.length;

        lines.splice(spliceStart, deleteCount, ...restoreLines);
        delta += restoreLines.length - deleteCount;
    }

    const newCurrentText = lines.join("\n");
    const unreviewedEdits =
        syncedFile.diffBase === newCurrentText
            ? emptyPatch()
            : buildPatchFromTextsFallback(syncedFile.diffBase, newCurrentText);
    const unreviewedRanges = buildTextRangePatchFromLinePatch(
        syncedFile.diffBase,
        newCurrentText,
        unreviewedEdits,
    );

    return {
        ...syncedFile,
        currentText: newCurrentText,
        unreviewedRanges,
        unreviewedEdits,
        status: undo.previousStatus,
        version: syncedFile.version + 1,
    };
}

export function partitionSpansByOverlapFallback(
    spans: AgentTextSpan[],
    ranges: Array<{ start: number; end: number }>,
    baseText: string,
    currentText: string,
): {
    overlapping: AgentTextSpan[];
    nonOverlapping: AgentTextSpan[];
} {
    const overlapping: AgentTextSpan[] = [];
    const nonOverlapping: AgentTextSpan[] = [];

    for (const span of spans) {
        const hasOverlap = ranges.some((range) =>
            spanMatchesLineRange(
                baseText,
                currentText,
                span,
                range.start,
                range.end,
            ),
        );

        if (hasOverlap) {
            overlapping.push(span);
        } else {
            nonOverlapping.push(span);
        }
    }

    return { overlapping, nonOverlapping };
}
