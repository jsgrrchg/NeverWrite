import { describe, expect, it, vi } from "vitest";

import {
    getBlockWidgetSelectionAnchor,
    isPointerInsideTaskToggleZone,
    syncTaskToggleHoverState,
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

        expect(isPointerInsideTaskToggleZone(taskLine, 112, 42)).toBe(false);
        expect(isPointerInsideTaskToggleZone(taskLine, 99, 28)).toBe(false);
    });

    it("respects configured hit slop so the checkbox stays easy to toggle", () => {
        const taskLine = document.createElement("div");
        taskLine.className = "cm-lp-task-line";
        taskLine.style.paddingLeft = "28px";
        taskLine.style.paddingTop = "0px";
        taskLine.style.fontSize = "16px";
        taskLine.style.lineHeight = "24px";
        taskLine.style.setProperty("--cm-lp-task-hit-slop", "4px");
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

        expect(isPointerInsideTaskToggleZone(taskLine, 119, 28)).toBe(true);
        expect(isPointerInsideTaskToggleZone(taskLine, 122, 28)).toBe(false);
    });
});

describe("syncTaskToggleHoverState", () => {
    function createTaskLine() {
        const root = document.createElement("div");
        const taskLine = document.createElement("div");
        taskLine.className = "cm-lp-task-line";
        taskLine.style.paddingLeft = "28px";
        taskLine.style.paddingTop = "0px";
        taskLine.style.fontSize = "16px";
        taskLine.style.lineHeight = "24px";
        taskLine.dataset.lpTaskFrom = "0";
        root.append(taskLine);

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

        return { root, taskLine };
    }

    it("adds hover state only when the pointer is inside the rendered checkbox", () => {
        const { root, taskLine } = createTaskLine();

        syncTaskToggleHoverState(root, taskLine, 112, 28);
        expect(taskLine.classList.contains("cm-lp-task-toggle-hover")).toBe(
            true,
        );

        syncTaskToggleHoverState(root, taskLine, 130, 28);
        expect(taskLine.classList.contains("cm-lp-task-toggle-hover")).toBe(
            false,
        );
    });

    it("moves hover state between task lines", () => {
        const { root, taskLine: firstTaskLine } = createTaskLine();
        const secondTaskLine = firstTaskLine.cloneNode() as HTMLElement;
        secondTaskLine.dataset.lpTaskFrom = "12";
        root.append(secondTaskLine);

        vi.spyOn(secondTaskLine, "getBoundingClientRect").mockReturnValue({
            x: 100,
            y: 60,
            width: 300,
            height: 24,
            top: 60,
            right: 400,
            bottom: 84,
            left: 100,
            toJSON: () => ({}),
        });

        syncTaskToggleHoverState(root, firstTaskLine, 112, 28);
        syncTaskToggleHoverState(root, secondTaskLine, 112, 68);

        expect(
            firstTaskLine.classList.contains("cm-lp-task-toggle-hover"),
        ).toBe(false);
        expect(
            secondTaskLine.classList.contains("cm-lp-task-toggle-hover"),
        ).toBe(true);
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
