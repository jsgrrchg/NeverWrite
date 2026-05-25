import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { getVimExtension, getLineNumberExtension } from "./editorExtensions";

describe("getVimExtension", () => {
    it("returns no extension when disabled", () => {
        expect(getVimExtension(false)).toEqual([]);
    });

    it("returns a non-empty extension when enabled", () => {
        const ext = getVimExtension(true);
        expect(Array.isArray(ext)).toBe(true);
        expect((ext as unknown[]).length).toBeGreaterThan(0);
        // Should build into a valid editor state without throwing.
        expect(() =>
            EditorState.create({ doc: "hello", extensions: ext }),
        ).not.toThrow();
    });
});

describe("getLineNumberExtension", () => {
    it("renders no gutter in live-preview mode", () => {
        expect(getLineNumberExtension(true, false)).toEqual([]);
        expect(getLineNumberExtension(true, true)).toEqual([]);
    });

    it("builds an absolute gutter in code mode", () => {
        expect(() =>
            EditorState.create({
                doc: "one\ntwo",
                extensions: getLineNumberExtension(false, false),
            }),
        ).not.toThrow();
    });

    it("builds a relative gutter in code mode without throwing", () => {
        expect(() =>
            EditorState.create({
                doc: "one\ntwo\nthree",
                selection: { anchor: 4 },
                extensions: getLineNumberExtension(false, true),
            }),
        ).not.toThrow();
    });
});
