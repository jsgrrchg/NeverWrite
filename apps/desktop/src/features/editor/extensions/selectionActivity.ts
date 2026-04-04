import type { EditorState } from "@codemirror/state";

export function selectionTouchesRange(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    for (const range of state.selection.ranges) {
        if (range.empty) {
            if (range.from >= from && range.from < to) {
                return true;
            }
            continue;
        }

        if (range.to > from && range.from < to) {
            return true;
        }
    }
    return false;
}

export function selectionTouchesLine(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;

    for (const range of state.selection.ranges) {
        const selectionLineFrom = state.doc.lineAt(range.from).number;
        const selectionLineTo = state.doc.lineAt(range.to).number;
        if (selectionLineTo >= lineFrom && selectionLineFrom <= lineTo) {
            return true;
        }
    }

    return false;
}

export function selectionHasMultilineRangeTouchingLine(
    state: EditorState,
    from: number,
    to: number,
): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;

    for (const range of state.selection.ranges) {
        if (range.empty) continue;

        const selectionLineFrom = state.doc.lineAt(range.from).number;
        const selectionLineTo = state.doc.lineAt(range.to).number;
        if (selectionLineFrom === selectionLineTo) continue;

        if (selectionLineTo >= lineFrom && selectionLineFrom <= lineTo) {
            return true;
        }
    }

    return false;
}
