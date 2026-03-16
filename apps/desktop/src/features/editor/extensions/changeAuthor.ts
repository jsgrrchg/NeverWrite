/**
 * ChangeAuthor annotation for CodeMirror — distinguishes user vs agent edits.
 *
 * Used by the ActionLog system to absorb non-conflicting user edits into
 * the diff base while preserving agent edit ranges for review.
 */

import { Annotation } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ChangeAuthor } from "../../ai/diff/actionLogTypes";
import type { LineEdit } from "../../ai/diff/actionLogTypes";

/** Annotate a transaction with its change author. */
export const changeAuthorAnnotation = Annotation.define<ChangeAuthor>();

/**
 * Compute 0-based, end-exclusive line ranges from a CodeMirror ViewUpdate.
 * Returns an array of LineEdit describing which old lines were replaced
 * and which new lines were inserted.
 */
export function computeChangedLineRanges(update: ViewUpdate): LineEdit[] {
    if (!update.docChanged) return [];

    const edits: LineEdit[] = [];
    const oldDoc = update.startState.doc;
    const newDoc = update.state.doc;

    update.changes.iterChanges((fromA, toA, fromB, toB) => {
        // Old doc: which lines were removed/replaced
        const oldStartLine = oldDoc.lineAt(fromA).number - 1;
        const oldEndLine =
            fromA === toA ? oldStartLine : oldDoc.lineAt(toA - 1).number; // 1-based → 0-based exclusive

        // New doc: which lines were inserted
        const newStartLine = newDoc.lineAt(fromB).number - 1;
        const newEndLine =
            fromB === toB ? newStartLine : newDoc.lineAt(toB - 1).number;

        edits.push({
            oldStart: oldStartLine,
            oldEnd: oldEndLine,
            newStart: newStartLine,
            newEnd: newEndLine,
        });
    });

    return edits;
}

/**
 * Create a CodeMirror extension that notifies the store when the user
 * edits a file that may have pending agent changes.
 *
 * Skips:
 * - Transactions annotated with changeAuthorAnnotation("agent")
 * - Non-transaction updates (e.g. EditorView.setState)
 * - Updates that didn't change the document
 */
export function userEditNotifier(
    getFileId: () => string | null,
    onUserEdit: (fileId: string, edits: LineEdit[], fullText: string) => void,
) {
    return EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;

        // Skip non-transaction updates (setState swaps)
        if (update.transactions.length === 0) return;

        // Skip agent-annotated transactions
        const isAgent = update.transactions.some(
            (tr) => tr.annotation(changeAuthorAnnotation) === "agent",
        );
        if (isAgent) return;

        const fileId = getFileId();
        if (!fileId) return;

        const lineEdits = computeChangedLineRanges(update);
        if (lineEdits.length === 0) return;

        const fullText = update.state.doc.toString();
        onUserEdit(fileId, lineEdits, fullText);
    });
}
