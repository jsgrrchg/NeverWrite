import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";
import { CROSS_PANE_TAB_DROP_PREVIEW_EVENT } from "./workspaceTabDropPreview";

const { mockUseTabDragReorder } = vi.hoisted(() => ({
    mockUseTabDragReorder: vi.fn(),
}));

vi.mock("./useTabDragReorder", () => ({
    useTabDragReorder: mockUseTabDragReorder,
}));

function rect({
    left,
    top,
    width,
    height,
}: {
    left: number;
    top: number;
    width: number;
    height: number;
}) {
    return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
    } as DOMRect;
}

describe("useWorkspaceTabDrag", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary"></div>
            <div data-editor-pane-id="secondary">
                <div data-pane-tab-strip="secondary">
                    <div data-pane-tab-id="tab-b"></div>
                </div>
            </div>
        `;

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement;
        const secondaryPane = document.querySelector(
            '[data-editor-pane-id="secondary"]',
        ) as HTMLElement;
        const secondaryStrip = document.querySelector(
            '[data-pane-tab-strip="secondary"]',
        ) as HTMLElement;
        const secondaryTab = document.querySelector(
            '[data-pane-tab-id="tab-b"]',
        ) as HTMLElement;

        vi.spyOn(primaryPane, "getBoundingClientRect").mockReturnValue(
            rect({ left: 0, top: 0, width: 200, height: 220 }),
        );
        vi.spyOn(secondaryPane, "getBoundingClientRect").mockReturnValue(
            rect({ left: 200, top: 0, width: 220, height: 220 }),
        );
        vi.spyOn(secondaryStrip, "getBoundingClientRect").mockReturnValue(
            rect({ left: 220, top: 8, width: 160, height: 28 }),
        );
        vi.spyOn(secondaryTab, "getBoundingClientRect").mockReturnValue(
            rect({ left: 220, top: 8, width: 120, height: 28 }),
        );

        mockUseTabDragReorder.mockImplementation((options) => ({
            dragOffsetX: 0,
            draggingTabId: null,
            detachPreviewActive: false,
            projectedDropIndex: null,
            tabStripRef: { current: null },
            visualTabs: options.tabs,
            registerTabNode: vi.fn(),
            handlePointerDown: vi.fn(),
            handlePointerMove: vi.fn(),
            handlePointerUp: vi.fn(),
            handleLostPointerCapture: vi.fn(),
            consumeSuppressedClick: vi.fn(() => false),
        }));
    });

    it("commits the last valid workspace target without republishing a stale preview", () => {
        const previewEvents: Array<unknown> = [];
        const handlePreview = (event: Event) => {
            previewEvents.push((event as CustomEvent).detail);
        };
        window.addEventListener(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            handlePreview,
        );

        const onCommitWorkspaceDrop = vi.fn();

        renderHook(() =>
            useWorkspaceTabDrag({
                tabs: [{ id: "tab-a" }],
                sourcePaneId: "primary",
                onCommitReorder: vi.fn(),
                onCommitWorkspaceDrop,
            }),
        );

        const options = mockUseTabDragReorder.mock.calls.at(-1)?.[0];
        expect(options).toBeTruthy();

        act(() => {
            options.onDragStart?.("tab-a", {
                clientX: 40,
                clientY: 20,
                screenX: 40,
                screenY: 20,
            });
            options.onDragMove?.("tab-a", {
                clientX: 210,
                clientY: 120,
                screenX: 210,
                screenY: 120,
            });
        });

        expect(previewEvents.at(-1)).toMatchObject({
            tabId: "tab-a",
            targetPaneId: "secondary",
            position: "left",
        });

        act(() => {
            options.onDragEnd?.("tab-a", {
                clientX: 430,
                clientY: 120,
                screenX: 430,
                screenY: 120,
            });
        });

        expect(onCommitWorkspaceDrop).toHaveBeenCalledWith("tab-a", {
            type: "split",
            paneId: "secondary",
            direction: "left",
        });
        expect(previewEvents.at(-1)).toBeNull();

        const shouldCommit = options.shouldCommitDrag?.("tab-a", {
            clientX: 430,
            clientY: 120,
            screenX: 430,
            screenY: 120,
        });

        expect(shouldCommit).toBe(false);
        expect(previewEvents.at(-1)).toBeNull();

        window.removeEventListener(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            handlePreview,
        );
    });
});
