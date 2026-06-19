import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    CHAT_FIND_ACTIVE_HIGHLIGHT,
    CHAT_FIND_HIGHLIGHT,
    applyChatFindHighlights,
    clearChatFindHighlights,
    setActiveChatFindHighlight,
} from "./chatFindHighlights";

class MockHighlight {
    ranges: Range[];

    constructor(...ranges: Range[]) {
        this.ranges = ranges;
    }
}

function installHighlightMock() {
    const store = new Map<string, MockHighlight>();
    const highlights = {
        set: vi.fn((name: string, value: MockHighlight) => {
            store.set(name, value);
        }),
        delete: vi.fn((name: string) => {
            store.delete(name);
        }),
    };

    Object.defineProperty(globalThis, "Highlight", {
        configurable: true,
        value: MockHighlight,
    });
    Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: {
            ...(globalThis.CSS ?? {}),
            highlights,
        },
    });

    return store;
}

function createRange(text: string): Range {
    const node = document.createTextNode(text);
    document.body.append(node);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, text.length);
    return range;
}

describe("chatFindHighlights", () => {
    let store: Map<string, MockHighlight>;

    beforeEach(() => {
        document.body.replaceChildren();
        store = installHighlightMock();
        clearChatFindHighlights("owner-a");
        clearChatFindHighlights("owner-b");
    });

    it("clears only the ranges owned by one finder instance", () => {
        const rangeA = createRange("alpha");
        const rangeB = createRange("beta");

        applyChatFindHighlights("owner-a", [rangeA], 0);
        applyChatFindHighlights("owner-b", [rangeB], 0);

        expect(store.get(CHAT_FIND_HIGHLIGHT)?.ranges).toEqual([
            rangeA,
            rangeB,
        ]);

        clearChatFindHighlights("owner-a");

        expect(store.get(CHAT_FIND_HIGHLIGHT)?.ranges).toEqual([rangeB]);
        expect(store.get(CHAT_FIND_ACTIVE_HIGHLIGHT)?.ranges).toEqual([
            rangeB,
        ]);
    });

    it("updates one active match without replacing another owner's active match", () => {
        const rangeA1 = createRange("alpha one");
        const rangeA2 = createRange("alpha two");
        const rangeB = createRange("beta");

        applyChatFindHighlights("owner-a", [rangeA1, rangeA2], 0);
        applyChatFindHighlights("owner-b", [rangeB], 0);
        setActiveChatFindHighlight("owner-a", rangeA2);

        expect(store.get(CHAT_FIND_ACTIVE_HIGHLIGHT)?.ranges).toEqual([
            rangeA2,
            rangeB,
        ]);
    });
});
