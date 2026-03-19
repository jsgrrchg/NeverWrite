/**
 * ChangeAuthor annotation for CodeMirror — distinguishes user vs agent edits.
 *
 * Used by the ActionLog system to absorb non-conflicting user edits into
 * the diff base while preserving agent edit ranges for review.
 */

import { Annotation } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ChangeAuthor } from "../../ai/diff/actionLogTypes";
import type { TextEdit } from "../../ai/diff/actionLogTypes";

/** Annotate a transaction with its change author. */
export const changeAuthorAnnotation = Annotation.define<ChangeAuthor>();

/**
 * Compute 0-based, end-exclusive text offsets from a CodeMirror ViewUpdate.
 * Returns an array of TextEdit describing the precise old/new document ranges.
 */
export function computeChangedTextEdits(update: ViewUpdate): TextEdit[] {
    if (!update.docChanged) return [];

    const edits: TextEdit[] = [];

    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        edits.push({
            oldFrom: fromA,
            oldTo: toA,
            newFrom: fromB,
            newTo: Math.max(toB, fromB + inserted.length),
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
    onUserEdit: (fileId: string, edits: TextEdit[], fullText: string) => void,
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

        const textEdits = computeChangedTextEdits(update);
        if (textEdits.length === 0) return;

        const fullText = update.state.doc.toString();
        onUserEdit(fileId, textEdits, fullText);
    });
}
