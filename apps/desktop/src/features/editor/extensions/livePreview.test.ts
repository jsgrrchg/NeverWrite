import { describe, expect, it, vi } from "vitest";

import {
    getBlockWidgetSelectionAnchor,
    isPointerInsideTaskToggleZone,
} from "./livePreview";

describe("isPointerInsideTaskToggleZone", () => {
    it("only treats the rendered checkbox box as interactive", () => {
        const taskLine = document.createElement("div");
        taskLine.className = "cm-lp-task-line";
        taskLine.style.paddingLeft = "28px";
        taskLine.style.paddingTop = "0px";
        taskLine.style.fontSize = "16px";
        taskLine.style.lineHeight = "24px";
        taskLine.dataset.lpTaskFrom = "0";

        vi.spyOn(taskLine, "getBoundingClientRect").mockReturnValue({
            x: 100,
            y: 20,
            width: 300,
            height: 24,
            top: 20,
            right: 400,
            bottom: 44,
            left: 100,
            toJSON: () => ({}),
        });

        expect(isPointerInsideTaskToggleZone(taskLine, 112, 28)).toBe(true);
        expect(isPointerInsideTaskToggleZone(taskLine, 130, 28)).toBe(false);
    });

    it("ignores clicks in the vertical gap below the checkbox", () => {
        const taskLine = document.createElement("div");
        taskLine.className = "cm-lp-task-line";
        taskLine.style.paddingLeft = "28px";
        taskLine.style.paddingTop = "0px";
        taskLine.style.fontSize = "16px";
        taskLine.style.lineHeight = "24px";
        taskLine.dataset.lpTaskFrom = "0";

        vi.spyOn(taskLine, "getBoundingClientRect").mockReturnValue({
            x: 100,
            y: 20,
            width: 300,
            height: 24,
            top: 20,
            right: 400,
            bottom: 44,
            left: 100,
            toJSON: () => ({}),
        });

        expect(isPointerInsideTaskToggleZone(taskLine, 112, 41)).toBe(false);
        expect(isPointerInsideTaskToggleZone(taskLine, 99, 28)).toBe(false);
    });
});

describe("getBlockWidgetSelectionAnchor", () => {
    it("places the caret before the widget when clicking in its top half", () => {
        const widget = document.createElement("div");
        widget.dataset.sourceFrom = "10";
        widget.dataset.sourceTo = "24";

        vi.spyOn(widget, "getBoundingClientRect").mockReturnValue({
            x: 100,
            y: 20,
            width: 200,
            height: 80,
            top: 20,
            right: 300,
            bottom: 100,
            left: 100,
            toJSON: () => ({}),
        });

        expect(getBlockWidgetSelectionAnchor(widget, 35)).toBe(10);
    });

    it("places the caret after the widget when clicking in its bottom half", () => {
        const widget = document.createElement("div");
        widget.dataset.sourceFrom = "10";
        widget.dataset.sourceTo = "24";

        vi.spyOn(widget, "getBoundingClientRect").mockReturnValue({
            x: 100,
            y: 20,
            width: 200,
            height: 80,
            top: 20,
            right: 300,
            bottom: 100,
            left: 100,
            toJSON: () => ({}),
        });

        expect(getBlockWidgetSelectionAnchor(widget, 85)).toBe(24);
    });
});
