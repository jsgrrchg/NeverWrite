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

export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type Range = {
    from: number;
    to: number;
};

type HeadingBlock = {
    from: number;
    to: number;
    indent: string;
    content: string;
    currentLevel: HeadingLevel | null;
};

type FencedCodeBlock = {
    openLine: ReturnType<EditorState["doc"]["line"]>;
    closeLine: ReturnType<EditorState["doc"]["line"]>;
    indent: string;
    marker: string;
    language: string;
};

const ATX_HEADING_RE =
    /^(\s{0,3})(#{1,6})(?:[ \t]+|$)(.*?)(?:[ \t]+#+[ \t]*)?$/;
const SETEXT_HEADING_RE = /^\s{0,3}(=+|-+)\s*$/;
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE_RE = /^(\s*)(`{3,}|~{3,})\s*$/;

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
        wrappedFrom >= 0 && state.sliceDoc(wrappedFrom, range.from) === prefix;
    const hasSuffix =
        wrappedTo <= state.doc.length &&
        state.sliceDoc(range.to, wrappedTo) === suffix;
    const selectionIncludesPrefix = text.startsWith(prefix);
    const selectionIncludesSuffix = text.endsWith(suffix);

    if (hasPrefix && hasSuffix) {
        return {
            changes: { from: wrappedFrom, to: wrappedTo, insert: text },
            selection: EditorSelection.single(
                wrappedFrom,
                wrappedFrom + text.length,
            ),
            userEvent: "input",
        };
    }

    if (
        selectionIncludesPrefix &&
        selectionIncludesSuffix &&
        text.length >= prefix.length + suffix.length
    ) {
        const innerText = text.slice(
            prefix.length,
            text.length - suffix.length,
        );
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
        changes: {
            from: range.from,
            to: range.to,
            insert: `${prefix}${text}${suffix}`,
        },
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
        const hasOpenBracket =
            state.sliceDoc(range.from - 1, range.from) === "[";
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
        const hasSeparator =
            state.sliceDoc(range.from - 2, range.from) === "](";
        const hasCloseParen = state.sliceDoc(range.to, range.to + 1) === ")";
        if (hasSeparator && hasCloseParen) {
            const closeBracket = range.from - 2;
            const openBracket = state
                .sliceDoc(0, closeBracket)
                .lastIndexOf("[");
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

function toggleMarkdownLink(
    state: EditorState,
): SelectionTransformResult | null {
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
        const text = state.sliceDoc(
            enclosingLink.text.from,
            enclosingLink.text.to,
        );
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
        selection: EditorSelection.single(
            urlFrom,
            urlFrom + urlPlaceholder.length,
        ),
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

function getLineIndent(text: string) {
    return text.match(/^\s*/)?.[0] ?? "";
}

function resolveHeadingBlock(
    state: EditorState,
    lineNumber: number,
): HeadingBlock | null {
    const line = state.doc.line(lineNumber);
    const previousLine = lineNumber > 1 ? state.doc.line(lineNumber - 1) : null;
    const nextLine =
        lineNumber < state.doc.lines ? state.doc.line(lineNumber + 1) : null;

    const currentSetextMatch = line.text.match(SETEXT_HEADING_RE);
    if (currentSetextMatch && previousLine && previousLine.text.trim().length) {
        const indent = getLineIndent(previousLine.text);
        return {
            from: previousLine.from,
            to: line.to,
            indent,
            content: previousLine.text.slice(indent.length).trimEnd(),
            currentLevel: currentSetextMatch[1].startsWith("=") ? 1 : 2,
        };
    }

    const nextSetextMatch = nextLine?.text.match(SETEXT_HEADING_RE);
    if (nextSetextMatch && nextLine && line.text.trim().length) {
        const indent = getLineIndent(line.text);
        return {
            from: line.from,
            to: nextLine.to,
            indent,
            content: line.text.slice(indent.length).trimEnd(),
            currentLevel: nextSetextMatch[1].startsWith("=") ? 1 : 2,
        };
    }

    const atxMatch = line.text.match(ATX_HEADING_RE);
    if (atxMatch) {
        return {
            from: line.from,
            to: line.to,
            indent: atxMatch[1] ?? "",
            content: (atxMatch[3] ?? "").trim(),
            currentLevel: (atxMatch[2]?.length ?? 0) as HeadingLevel,
        };
    }

    const indent = getLineIndent(line.text);
    return {
        from: line.from,
        to: line.to,
        indent,
        content: line.text.slice(indent.length),
        currentLevel: null,
    };
}

function buildHeadingReplacement(
    block: HeadingBlock,
    targetLevel: HeadingLevel,
): string | null {
    if (targetLevel === 0) {
        if (block.currentLevel === null) return null;
        return `${block.indent}${block.content}`;
    }

    return `${block.indent}${"#".repeat(targetLevel)}${block.content.length > 0 ? ` ${block.content}` : " "}`;
}

function toggleExactLinePrefix(
    state: EditorState,
    prefix: string,
): SelectionTransformResult | null {
    if (state.readOnly) return null;

    const lines = getSelectedLines(state);
    if (!lines.length) return null;

    const allPrefixed = lines.every(
        (line) =>
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
    if (state.readOnly) return null;

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
                    state.sliceDoc(line.from, line.from + prefix.length) ===
                    prefix,
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

function parseFenceOpeningLine(text: string) {
    const match = text.match(FENCE_OPEN_RE);
    if (!match) return null;

    const marker = match[2] ?? "";
    const trailing = match[3] ?? "";
    if (marker.startsWith("`") && trailing.includes("`")) return null;

    return {
        indent: match[1] ?? "",
        marker,
        language: trailing.trim(),
    };
}

function isMatchingFenceClose(text: string, openingMarker: string) {
    const match = text.match(FENCE_CLOSE_RE);
    if (!match) return false;

    const marker = match[2] ?? "";
    return (
        marker[0] === openingMarker[0] && marker.length >= openingMarker.length
    );
}

function findFencedCodeBlockAtLine(
    state: EditorState,
    lineNumber: number,
): FencedCodeBlock | null {
    for (
        let openLineNumber = lineNumber;
        openLineNumber >= 1;
        openLineNumber--
    ) {
        const openLine = state.doc.line(openLineNumber);
        const opening = parseFenceOpeningLine(openLine.text);
        if (!opening) continue;

        for (
            let closeLineNumber = openLineNumber + 1;
            closeLineNumber <= state.doc.lines;
            closeLineNumber++
        ) {
            const closeLine = state.doc.line(closeLineNumber);
            if (!isMatchingFenceClose(closeLine.text, opening.marker)) continue;

            if (
                lineNumber >= openLine.number &&
                lineNumber <= closeLine.number
            ) {
                return {
                    openLine,
                    closeLine,
                    indent: opening.indent,
                    marker: opening.marker,
                    language: opening.language,
                };
            }

            break;
        }
    }

    return null;
}

function findFencedCodeBlockAtSelection(
    state: EditorState,
): FencedCodeBlock | null {
    const lines = getSelectedLines(state);
    if (!lines.length) return null;

    const block = findFencedCodeBlockAtLine(state, lines[0].number);
    if (!block) return null;

    const coversSelection = lines.every(
        (line) =>
            line.number >= block.openLine.number &&
            line.number <= block.closeLine.number,
    );

    return coversSelection ? block : null;
}

function getCodeFenceRemovalChanges(
    state: EditorState,
    block: FencedCodeBlock,
) {
    const openTo =
        block.openLine.to < state.doc.length
            ? block.openLine.to + 1
            : block.openLine.to;
    const closeFrom =
        block.closeLine.to === state.doc.length &&
        block.closeLine.from > 0 &&
        state.sliceDoc(block.closeLine.from - 1, block.closeLine.from) === "\n"
            ? block.closeLine.from - 1
            : block.closeLine.from;
    const closeTo =
        block.closeLine.to < state.doc.length
            ? block.closeLine.to + 1
            : block.closeLine.to;

    return ChangeSet.of(
        [
            { from: block.openLine.from, to: openTo },
            { from: closeFrom, to: closeTo },
        ],
        state.doc.length,
    );
}

export function getBlockquoteTransform(
    state: EditorState,
): SelectionTransformResult | null {
    return toggleExactLinePrefix(state, "> ");
}

export function getCodeBlockTransform(
    state: EditorState,
): SelectionTransformResult | null {
    if (state.readOnly) return null;
    if (state.selection.ranges.length !== 1) return null;

    const existingBlock = findFencedCodeBlockAtSelection(state);
    if (existingBlock) {
        const changes = getCodeFenceRemovalChanges(state, existingBlock);
        return {
            changes,
            selection: mapSelectionThroughChanges(state, changes),
            userEvent: "input",
        };
    }

    const lines = getSelectedLines(state);
    if (!lines.length) return null;

    if (lines.length === 1 && lines[0].text.length === 0) {
        const line = lines[0];
        return {
            changes: {
                from: line.from,
                to: line.to,
                insert: "```\n\n```",
            },
            selection: EditorSelection.single(line.from + 4),
            userEvent: "input",
        };
    }

    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    const changes = ChangeSet.of(
        [
            { from: firstLine.from, insert: "```\n" },
            { from: lastLine.to, insert: "\n```" },
        ],
        state.doc.length,
    );

    return {
        changes,
        selection: mapSelectionThroughChanges(state, changes),
        userEvent: "input",
    };
}

export function getCodeBlockLanguageAtSelection(
    state: EditorState,
): string | null {
    if (state.selection.ranges.length !== 1) return null;
    return findFencedCodeBlockAtSelection(state)?.language ?? null;
}

export function getSetCodeBlockLanguageTransform(
    state: EditorState,
    language: string,
): SelectionTransformResult | null {
    if (state.readOnly) return null;
    if (state.selection.ranges.length !== 1) return null;

    const block = findFencedCodeBlockAtSelection(state);
    if (!block) return null;

    const nextLanguage = language.trim();
    const replacement = `${block.indent}${block.marker}${nextLanguage}`;
    if (block.openLine.text === replacement) return null;

    return {
        changes: {
            from: block.openLine.from,
            to: block.openLine.to,
            insert: replacement,
        },
        selection: state.selection,
        userEvent: "input",
    };
}

export function getHorizontalRuleTransform(
    state: EditorState,
): SelectionTransformResult | null {
    if (state.readOnly) return null;
    if (state.selection.ranges.length !== 1) return null;

    const line = state.doc.lineAt(state.selection.main.from);

    if (line.text.trim().length === 0) {
        return {
            changes: {
                from: line.from,
                to: line.to,
                insert: "---",
            },
            selection: EditorSelection.single(line.from + 3),
            userEvent: "input",
        };
    }

    if (line.to < state.doc.length) {
        const insertAt = line.to + 1;
        return {
            changes: {
                from: insertAt,
                to: insertAt,
                insert: "---\n",
            },
            selection: EditorSelection.single(insertAt + 4),
            userEvent: "input",
        };
    }

    return {
        changes: {
            from: line.to,
            to: line.to,
            insert: "\n---",
        },
        selection: EditorSelection.single(line.to + 4),
        userEvent: "input",
    };
}

export function getHeadingTransform(
    state: EditorState,
    level: HeadingLevel,
): SelectionTransformResult | null {
    if (state.readOnly) return null;

    const selectedLines = getSelectedLines(state);
    if (!selectedLines.length) return null;

    const blocks = new Map<number, HeadingBlock>();
    for (const line of selectedLines) {
        const block = resolveHeadingBlock(state, line.number);
        if (!block) continue;
        blocks.set(block.from, block);
    }

    const changeSpecs = [...blocks.values()]
        .map((block) => {
            const insert = buildHeadingReplacement(block, level);
            if (insert === null) return null;

            const current = state.sliceDoc(block.from, block.to);
            if (current === insert) return null;

            return {
                from: block.from,
                to: block.to,
                insert,
            };
        })
        .filter(
            (change): change is { from: number; to: number; insert: string } =>
                change !== null,
        );

    if (!changeSpecs.length) return null;

    const changes = ChangeSet.of(changeSpecs, state.doc.length);
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
            return getBlockquoteTransform(state);
        case "task":
            return toggleTaskLines(state);
        default:
            return null;
    }
}
