import {
    ChangeSet,
    EditorSelection,
    type EditorState,
} from "@codemirror/state";

export type SelectionToolbarAction =
    | "bold"
    | "italic"
    | "highlight"
    | "code"
    | "link"
    | "wikilink"
    | "quote"
    | "task";

export type SelectionTransformResult = {
    changes: ChangeSet | { from: number; to: number; insert: string };
    selection: EditorSelection;
    userEvent: string;
};

type Range = {
    from: number;
    to: number;
};

function getMainSelection(state: EditorState) {
    if (state.readOnly) return null;
    if (state.selection.ranges.length !== 1) return null;

    const range = state.selection.main;
    if (range.empty) return null;
    return range;
}

function toggleWrappedMainSelection(
    state: EditorState,
    prefix: string,
    suffix: string,
): SelectionTransformResult | null {
    const range = getMainSelection(state);
    if (!range) return null;

    const text = state.sliceDoc(range.from, range.to);
    const wrappedFrom = range.from - prefix.length;
    const wrappedTo = range.to + suffix.length;
    const hasPrefix =
        wrappedFrom >= 0 &&
        state.sliceDoc(wrappedFrom, range.from) === prefix;
    const hasSuffix =
        wrappedTo <= state.doc.length &&
        state.sliceDoc(range.to, wrappedTo) === suffix;
    const selectionIncludesPrefix = text.startsWith(prefix);
    const selectionIncludesSuffix = text.endsWith(suffix);

    if (hasPrefix && hasSuffix) {
        return {
            changes: { from: wrappedFrom, to: wrappedTo, insert: text },
            selection: EditorSelection.single(wrappedFrom, wrappedFrom + text.length),
            userEvent: "input",
        };
    }

    if (
        selectionIncludesPrefix &&
        selectionIncludesSuffix &&
        text.length >= prefix.length + suffix.length
    ) {
        const innerText = text.slice(prefix.length, text.length - suffix.length);
        return {
            changes: { from: range.from, to: range.to, insert: innerText },
            selection: EditorSelection.single(
                range.from,
                range.from + innerText.length,
            ),
            userEvent: "input",
        };
    }

    return {
        changes: { from: range.from, to: range.to, insert: `${prefix}${text}${suffix}` },
        selection: EditorSelection.single(
            range.from + prefix.length,
            range.from + prefix.length + text.length,
        ),
        userEvent: "input",
    };
}

function findEnclosingMarkdownLink(
    state: EditorState,
    range: Range,
): { whole: Range; text: Range } | null {
    if (range.from >= 1 && range.to + 2 <= state.doc.length) {
        const hasOpenBracket = state.sliceDoc(range.from - 1, range.from) === "[";
        const hasSeparator = state.sliceDoc(range.to, range.to + 2) === "](";
        if (hasOpenBracket && hasSeparator) {
            const closeParen = state
                .sliceDoc(range.to + 2, state.doc.length)
                .indexOf(")");
            if (closeParen !== -1) {
                return {
                    whole: {
                        from: range.from - 1,
                        to: range.to + 3 + closeParen,
                    },
                    text: range,
                };
            }
        }
    }

    if (range.from >= 2 && range.to < state.doc.length) {
        const hasSeparator = state.sliceDoc(range.from - 2, range.from) === "](";
        const hasCloseParen = state.sliceDoc(range.to, range.to + 1) === ")";
        if (hasSeparator && hasCloseParen) {
            const closeBracket = range.from - 2;
            const openBracket = state.sliceDoc(0, closeBracket).lastIndexOf("[");
            if (openBracket !== -1) {
                return {
                    whole: {
                        from: openBracket,
                        to: range.to + 1,
                    },
                    text: {
                        from: openBracket + 1,
                        to: closeBracket,
                    },
                };
            }
        }
    }

    return null;
}

function toggleMarkdownLink(state: EditorState): SelectionTransformResult | null {
    const range = getMainSelection(state);
    if (!range) return null;

    const selectedText = state.sliceDoc(range.from, range.to);
    const fullLinkMatch = selectedText.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (fullLinkMatch) {
        const linkText = fullLinkMatch[1] ?? "";
        return {
            changes: {
                from: range.from,
                to: range.to,
                insert: linkText,
            },
            selection: EditorSelection.single(
                range.from,
                range.from + linkText.length,
            ),
            userEvent: "input",
        };
    }

    const enclosingLink = findEnclosingMarkdownLink(state, range);
    if (enclosingLink) {
        const text = state.sliceDoc(enclosingLink.text.from, enclosingLink.text.to);
        return {
            changes: {
                from: enclosingLink.whole.from,
                to: enclosingLink.whole.to,
                insert: text,
            },
            selection: EditorSelection.single(
                enclosingLink.whole.from,
                enclosingLink.whole.from + text.length,
            ),
            userEvent: "input",
        };
    }

    const text = state.sliceDoc(range.from, range.to);
    const urlPlaceholder = "url";
    const insert = `[${text}](${urlPlaceholder})`;
    const urlFrom = range.from + text.length + 3;

    return {
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.single(urlFrom, urlFrom + urlPlaceholder.length),
        userEvent: "input",
    };
}

function getSelectedLines(state: EditorState) {
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

function mapSelectionThroughChanges(state: EditorState, changes: ChangeSet) {
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

function toggleExactLinePrefix(
    state: EditorState,
    prefix: string,
): SelectionTransformResult | null {
    const range = getMainSelection(state);
    if (!range) return null;

    const lines = getSelectedLines(state);
    if (!lines.length) return null;

    const allPrefixed = lines.every((line) =>
        state.sliceDoc(line.from, line.from + prefix.length) === prefix,
    );

    const changes = ChangeSet.of(
        lines.map((line) =>
            allPrefixed
                ? {
                      from: line.from,
                      to: line.from + prefix.length,
                  }
                : {
                      from: line.from,
                      insert: prefix,
                  },
        ),
        state.doc.length,
    );

    return {
        changes,
        selection: mapSelectionThroughChanges(state, changes),
        userEvent: "input",
    };
}

function toggleTaskLines(state: EditorState): SelectionTransformResult | null {
    const range = getMainSelection(state);
    if (!range) return null;

    const lines = getSelectedLines(state);
    if (!lines.length) return null;

    const taskPrefixes = ["- [ ] ", "- [x] ", "- [X] "];
    const allTasks = lines.every((line) =>
        taskPrefixes.some(
            (prefix) =>
                state.sliceDoc(line.from, line.from + prefix.length) === prefix,
        ),
    );

    const changes = ChangeSet.of(
        lines.map((line) => {
            if (!allTasks) {
                return {
                    from: line.from,
                    insert: "- [ ] ",
                };
            }

            const matchedPrefix = taskPrefixes.find(
                (prefix) =>
                    state.sliceDoc(line.from, line.from + prefix.length) === prefix,
            );
            return {
                from: line.from,
                to: line.from + (matchedPrefix?.length ?? 0),
            };
        }),
        state.doc.length,
    );

    return {
        changes,
        selection: mapSelectionThroughChanges(state, changes),
        userEvent: "input",
    };
}

export function getSelectionTransform(
    state: EditorState,
    action: SelectionToolbarAction,
): SelectionTransformResult | null {
    switch (action) {
        case "bold":
            return toggleWrappedMainSelection(state, "**", "**");
        case "italic":
            return toggleWrappedMainSelection(state, "*", "*");
        case "highlight":
            return toggleWrappedMainSelection(state, "==", "==");
        case "code":
            return toggleWrappedMainSelection(state, "`", "`");
        case "link":
            return toggleMarkdownLink(state);
        case "wikilink":
            return toggleWrappedMainSelection(state, "[[", "]]");
        case "quote":
            return toggleExactLinePrefix(state, "> ");
        case "task":
            return toggleTaskLines(state);
        default:
            return null;
    }
}
