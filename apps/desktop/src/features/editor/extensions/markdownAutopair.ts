import { Annotation, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const activateWikilinkSuggesterAnnotation =
    Annotation.define<boolean>();

function dispatchAutopair(
    view: EditorView,
    from: number,
    to: number,
    insert: string,
    selectionFrom: number,
    selectionTo = selectionFrom,
    activateWikilinkSuggester = false,
) {
    view.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.single(selectionFrom, selectionTo),
        annotations: activateWikilinkSuggester
            ? activateWikilinkSuggesterAnnotation.of(true)
            : undefined,
        userEvent: "input",
    });
}

function wrapSelection(
    view: EditorView,
    from: number,
    to: number,
    prefix: string,
    suffix: string,
) {
    const text = view.state.sliceDoc(from, to);
    dispatchAutopair(
        view,
        from,
        to,
        `${prefix}${text}${suffix}`,
        from + prefix.length,
        from + prefix.length + text.length,
    );
    return true;
}

function pairAtCursor(view: EditorView, from: number, to: number, pair: string) {
    dispatchAutopair(view, from, to, pair, from + pair.length / 2);
    return true;
}

function getCharBefore(view: EditorView, pos: number) {
    if (pos <= 0) return "";
    return view.state.sliceDoc(pos - 1, pos);
}

function getCharAfter(view: EditorView, pos: number) {
    if (pos >= view.state.doc.length) return "";
    return view.state.sliceDoc(pos, pos + 1);
}

function skipOverClosing(view: EditorView, from: number, text: string) {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;

    const nextChar = getCharAfter(view, from);
    if (nextChar !== text) return false;

    view.dispatch({
        selection: EditorSelection.cursor(from + 1),
        userEvent: "input",
    });
    return true;
}

function upgradeBracketPairToWikilink(
    view: EditorView,
    from: number,
    to: number,
) {
    const selection = view.state.selection.main;
    const nextChar = getCharAfter(view, from);

    if (
        selection.empty &&
        getCharBefore(view, from) === "[" &&
        nextChar === "]"
    ) {
        dispatchAutopair(view, from, to + 1, "[]]", from + 1, from + 1, true);
        return true;
    }

    if (
        !selection.empty &&
        getCharBefore(view, from) === "[" &&
        getCharAfter(view, to) === "]"
    ) {
        const text = view.state.sliceDoc(from, to);
        dispatchAutopair(
            view,
            from - 1,
            to + 1,
            `[[${text}]]`,
            from + 1,
            from + 1 + text.length,
            true,
        );
        return true;
    }

    return false;
}

function handleAsteriskPair(view: EditorView, from: number, to: number) {
    const selection = view.state.selection.main;
    if (!selection.empty) {
        return wrapSelection(view, from, to, "**", "**");
    }

    if (getCharBefore(view, from) !== "*") return false;
    dispatchAutopair(view, from - 1, from, "****", from + 1);
    return true;
}

function handleEqualsPair(view: EditorView, from: number, to: number) {
    const selection = view.state.selection.main;
    if (!selection.empty) {
        return wrapSelection(view, from, to, "==", "==");
    }

    if (getCharBefore(view, from) !== "=") return false;
    dispatchAutopair(view, from - 1, from, "====", from + 1);
    return true;
}

export const markdownAutopairExtension = EditorView.inputHandler.of(
    (view, from, to, text) => {
        if (view.state.readOnly) return false;
        if (view.state.selection.ranges.length !== 1) return false;
        if (text.length !== 1) return false;

        if (text === "]" || text === ")" || text === "`") {
            if (skipOverClosing(view, from, text)) return true;
        }

        if (text === "[") {
            if (upgradeBracketPairToWikilink(view, from, to)) return true;

            if (!view.state.selection.main.empty) {
                return wrapSelection(view, from, to, "[", "]");
            }

            return pairAtCursor(view, from, to, "[]");
        }

        if (text === "(") {
            if (!view.state.selection.main.empty) {
                return wrapSelection(view, from, to, "(", ")");
            }

            return pairAtCursor(view, from, to, "()");
        }

        if (text === "`") {
            if (!view.state.selection.main.empty) {
                return wrapSelection(view, from, to, "`", "`");
            }

            return pairAtCursor(view, from, to, "``");
        }

        if (text === "*") {
            return handleAsteriskPair(view, from, to);
        }

        if (text === "=") {
            return handleEqualsPair(view, from, to);
        }

        return false;
    },
);
