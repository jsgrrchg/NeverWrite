import {
    ChangeSet,
    EditorSelection,
    type EditorState,
} from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { indentMore, indentLess } from "@codemirror/commands";

export const MARKDOWN_LIST_LINE_RE =
    /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
export const MARKDOWN_LIST_ITEM_RE =
    /^([ \t]*)(?:(\d+)([.)])|([-+*]))[ \t]+(?:\[( |x|X|~|\/)\][ \t]+)?(.*)$/;

export type MarkdownTaskMarker = " " | "x" | "X" | "~" | "/" | null;

export type MarkdownListItem = {
    indent: string;
    marker: string;
    orderedNumber: number | null;
    orderedDelimiter: ")" | "." | null;
    taskMarker: MarkdownTaskMarker;
    isTask: boolean;
    content: string;
    prefixLength: number;
    isEmpty: boolean;
};

export function parseMarkdownListItem(
    lineText: string,
): MarkdownListItem | null {
    const match = lineText.match(MARKDOWN_LIST_ITEM_RE);
    if (!match) return null;

    const [
        fullMatch,
        indent,
        orderedDigits,
        orderedDelimiterRaw,
        bulletMarker,
        taskMarker,
        content,
    ] = match;
    const orderedDelimiter =
        orderedDelimiterRaw === "." || orderedDelimiterRaw === ")"
            ? orderedDelimiterRaw
            : null;
    const orderedNumber = orderedDigits
        ? Number.parseInt(orderedDigits, 10)
        : null;
    const marker = orderedDigits
        ? `${orderedDigits}${orderedDelimiter ?? "."}`
        : (bulletMarker ?? "-");

    return {
        indent,
        marker,
        orderedNumber,
        orderedDelimiter,
        taskMarker: (taskMarker as MarkdownTaskMarker | undefined) ?? null,
        isTask: taskMarker !== undefined,
        content,
        prefixLength: fullMatch.length - content.length,
        isEmpty: content.trim().length === 0,
    };
}

export function buildContinuedListPrefix(item: MarkdownListItem): string {
    const orderedMarker =
        item.orderedNumber !== null
            ? `${item.orderedNumber + 1}${item.orderedDelimiter ?? "."}`
            : item.marker;
    const taskSuffix = item.isTask ? "[ ] " : "";
    return `${item.indent}${orderedMarker} ${taskSuffix}`;
}

export function continueMarkdownListItem({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (state.selection.ranges.length !== 1) return false;

    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.from);
    const item = parseMarkdownListItem(line.text);
    if (!item) return false;

    if (item.isEmpty) {
        dispatch(
            state.update({
                changes: { from: line.from, to: line.to, insert: "" },
                selection: EditorSelection.cursor(line.from),
                scrollIntoView: true,
                userEvent: "input",
            }),
        );
        return true;
    }

    const contentStart = line.from + item.prefixLength;
    const insertAt = range.from <= contentStart ? line.to : range.from;
    const insert = `\n${buildContinuedListPrefix(item)}`;
    const anchor = insertAt + insert.length;

    dispatch(
        state.update({
            changes: { from: insertAt, to: insertAt, insert },
            selection: EditorSelection.cursor(anchor),
            scrollIntoView: true,
            userEvent: "input",
        }),
    );

    return true;
}

export function backspaceMarkdownListMarker({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (state.selection.ranges.length !== 1) return false;

    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.from);
    const item = parseMarkdownListItem(line.text);
    if (!item?.isEmpty) return false;

    const prefixEnd = line.from + item.prefixLength;
    if (range.from < line.from || range.from > prefixEnd) return false;

    const unit = state.facet(indentUnit);
    const deleteIndentLength = getOutdentDeleteLength(item.indent, unit.length);

    if (deleteIndentLength > 0) {
        dispatch(
            state.update({
                changes: {
                    from: line.from,
                    to: line.from + deleteIndentLength,
                },
                selection: EditorSelection.cursor(
                    Math.max(line.from, range.from - deleteIndentLength),
                ),
                scrollIntoView: true,
                userEvent: "delete.backward",
            }),
        );
        return true;
    }

    dispatch(
        state.update({
            changes: { from: line.from, to: line.to, insert: "" },
            selection: EditorSelection.cursor(line.from),
            scrollIntoView: true,
            userEvent: "delete.backward",
        }),
    );

    return true;
}

export function getSelectedLines(state: EditorState) {
    const seen = new Set<number>();
    const lines: Array<ReturnType<EditorState["doc"]["line"]>> = [];

    for (const range of state.selection.ranges) {
        const startLine = state.doc.lineAt(range.from);
        let endPos = range.to;

        if (!range.empty) {
            const rawEndLine = state.doc.lineAt(range.to);
            if (range.to === rawEndLine.from && range.to > range.from) {
                endPos = range.to - 1;
            }
        }

        const endLine = state.doc.lineAt(endPos);
        for (
            let lineNumber = startLine.number;
            lineNumber <= endLine.number;
            lineNumber++
        ) {
            const line = state.doc.line(lineNumber);
            if (seen.has(line.from)) continue;
            seen.add(line.from);
            lines.push(line);
        }
    }

    return lines;
}

export function getListLines(state: EditorState) {
    const lines = getSelectedLines(state);
    if (!lines.length) return null;
    if (lines.some((line) => !MARKDOWN_LIST_LINE_RE.test(line.text))) {
        return null;
    }
    return lines;
}

export function mapSelectionThroughChanges(
    state: EditorState,
    changes: ChangeSet,
) {
    return EditorSelection.create(
        state.selection.ranges.map((range) =>
            EditorSelection.range(
                changes.mapPos(range.from, 1),
                changes.mapPos(range.to, 1),
            ),
        ),
        state.selection.mainIndex,
    );
}

export function indentMarkdownListItems({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;

    const lines = getListLines(state);
    if (!lines) return false;

    const unit = state.facet(indentUnit);
    const changes = ChangeSet.of(
        lines.map((line) => ({ from: line.from, insert: unit })),
        state.doc.length,
    );

    dispatch(
        state.update({
            changes,
            selection: mapSelectionThroughChanges(state, changes),
            scrollIntoView: true,
            userEvent: "input.indent",
        }),
    );

    return true;
}

export function getOutdentDeleteLength(prefix: string, maxColumns: number) {
    let consumed = 0;
    let columns = 0;

    while (consumed < prefix.length && columns < maxColumns) {
        const char = prefix[consumed];
        if (char === " ") {
            consumed++;
            columns++;
            continue;
        }
        if (char === "\t") {
            consumed++;
            break;
        }
        break;
    }

    return consumed;
}

export function outdentMarkdownListItems({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;

    const lines = getListLines(state);
    if (!lines) return false;

    const unit = state.facet(indentUnit);
    const specs = lines
        .map((line) => {
            const match = line.text.match(MARKDOWN_LIST_LINE_RE);
            const prefix = match?.[1] ?? "";
            const deleteLength = getOutdentDeleteLength(prefix, unit.length);
            if (!deleteLength) return null;
            return {
                from: line.from,
                to: line.from + deleteLength,
            };
        })
        .filter((spec): spec is { from: number; to: number } => spec !== null);

    if (!specs.length) return false;

    const changes = ChangeSet.of(specs, state.doc.length);

    dispatch(
        state.update({
            changes,
            selection: mapSelectionThroughChanges(state, changes),
            scrollIntoView: true,
            userEvent: "input.indent",
        }),
    );

    return true;
}

export function insertConfiguredTab({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (state.readOnly) return false;
    if (indentMarkdownListItems({ state, dispatch })) return true;
    if (state.selection.ranges.some((range) => !range.empty)) {
        return indentMore({ state, dispatch });
    }

    const unit = state.facet(indentUnit);
    const changes = state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: unit },
        range: EditorSelection.cursor(range.from + unit.length),
    }));

    dispatch(
        state.update(changes, {
            scrollIntoView: true,
            userEvent: "input",
        }),
    );

    return true;
}

export function removeConfiguredTab({
    state,
    dispatch,
}: {
    state: EditorState;
    dispatch: (transaction: ReturnType<EditorState["update"]>) => void;
}) {
    if (outdentMarkdownListItems({ state, dispatch })) return true;
    return indentLess({ state, dispatch });
}
