import { EditorSelection, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import {
    backspaceMarkdownListMarker,
    continueMarkdownListItem,
    insertConfiguredTab,
    removeConfiguredTab,
} from "./markdownLists";

function applyListCommand(
    doc: string,
    selection: EditorSelection | { anchor: number; head?: number },
    command: typeof continueMarkdownListItem,
) {
    let state = EditorState.create({
        doc,
        selection,
        extensions: [indentUnit.of("  ")],
    });

    const handled = command({
        state,
        dispatch: (transaction) => {
            state = transaction.state;
        },
    });

    return {
        handled,
        state,
    };
}

describe("markdownLists", () => {
    it("continues the current markdown list item on Enter", () => {
        const { handled, state } = applyListCommand(
            "- Item",
            EditorSelection.cursor(6),
            continueMarkdownListItem,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- Item\n- ");
    });

    it("continues below the current item when Enter is pressed in the hidden list prefix", () => {
        const { handled, state } = applyListCommand(
            "- One\n- Two",
            EditorSelection.cursor(6),
            continueMarkdownListItem,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- One\n- Two\n- ");
    });

    it("continues ordered sublists with numbering local to the nested level", () => {
        const { handled, state } = applyListCommand(
            "1. Parent\n   1. Child\n2. Next parent",
            EditorSelection.cursor(21),
            continueMarkdownListItem,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe(
            "1. Parent\n   1. Child\n   2. \n2. Next parent",
        );
    });

    it("keeps splitting the item when Enter is pressed in the content", () => {
        const { handled, state } = applyListCommand(
            "- OneTwo",
            EditorSelection.cursor(5),
            continueMarkdownListItem,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- One\n- Two");
    });

    it("removes an empty list item marker on Backspace", () => {
        const { handled, state } = applyListCommand(
            "- ",
            EditorSelection.cursor(2),
            backspaceMarkdownListMarker,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("");
    });

    it("indents selected markdown list items on Tab", () => {
        const { handled, state } = applyListCommand(
            "- One\n- Two",
            EditorSelection.range(0, 11),
            insertConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("  - One\n  - Two");
    });

    it("indents ordered list items enough to create a nested level in one Tab", () => {
        const { handled, state } = applyListCommand(
            "1. One\n1. Two",
            EditorSelection.range(7, 13),
            insertConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("1. One\n   1. Two");
    });

    it("renumbers parent and child ordered items when creating a nested sublist", () => {
        const { handled, state } = applyListCommand(
            "1. Parent\n2. Child\n3. Child\n4. Next parent",
            EditorSelection.range(10, 28),
            insertConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe(
            "1. Parent\n   1. Child\n   2. Child\n2. Next parent",
        );
    });

    it("outdents selected markdown list items on Shift+Tab", () => {
        const { handled, state } = applyListCommand(
            "  - One\n  - Two",
            EditorSelection.range(0, 15),
            removeConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("- One\n- Two");
    });

    it("outdents ordered list items using the same nesting step", () => {
        const { handled, state } = applyListCommand(
            "1. One\n   1. Two",
            EditorSelection.range(7, 16),
            removeConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe("1. One\n2. Two");
    });

    it("renumbers ordered items correctly when flattening a nested sublist", () => {
        const { handled, state } = applyListCommand(
            "1. Parent\n   1. Child\n   2. Child\n2. Next parent",
            EditorSelection.range(10, 34),
            removeConfiguredTab,
        );

        expect(handled).toBe(true);
        expect(state.doc.toString()).toBe(
            "1. Parent\n2. Child\n3. Child\n4. Next parent",
        );
    });
});
