import { beforeEach, describe, expect, it } from "vitest";
import {
    resolvePaneDropPosition,
    resolveWorkspaceTabDropTarget,
    toCrossPaneTabDropPreview,
} from "./workspaceTabDropPreview";

function mockRect({
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
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe("workspaceTabDropPreview", () => {
    const paneRect = {
        left: 100,
        right: 500,
        top: 40,
        bottom: 340,
    };

    it("classifies the center region as add-as-tab", () => {
        expect(resolvePaneDropPosition(300, 180, paneRect)).toBe("center");
    });

    it("classifies each edge as a split target", () => {
        expect(resolvePaneDropPosition(112, 180, paneRect)).toBe("left");
        expect(resolvePaneDropPosition(488, 180, paneRect)).toBe("right");
        expect(resolvePaneDropPosition(300, 52, paneRect)).toBe("up");
        expect(resolvePaneDropPosition(300, 328, paneRect)).toBe("down");
    });

    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("resolves another pane tab strip as a strip drop target", () => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary">
              <div data-pane-tab-strip="primary"></div>
            </div>
            <div data-editor-pane-id="secondary">
              <div data-pane-tab-strip="secondary">
                <div data-pane-tab-id="tab-b"></div>
                <div data-pane-tab-id="tab-c"></div>
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
        const secondaryTabs = Array.from(
            document.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
        );

        primaryPane.getBoundingClientRect = () =>
            mockRect({ left: 0, top: 0, width: 180, height: 140 });
        secondaryPane.getBoundingClientRect = () =>
            mockRect({ left: 200, top: 0, width: 220, height: 140 });
        secondaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 210, top: 6, width: 190, height: 32 });
        secondaryTabs[0]!.getBoundingClientRect = () =>
            mockRect({ left: 220, top: 8, width: 72, height: 28 });
        secondaryTabs[1]!.getBoundingClientRect = () =>
            mockRect({ left: 296, top: 8, width: 72, height: 28 });

        const target = resolveWorkspaceTabDropTarget({
            sourcePaneId: "primary",
            tabId: "tab-a",
            clientX: 250,
            clientY: 18,
        });

        expect(target).toEqual({
            type: "strip",
            paneId: "secondary",
            index: 0,
        });
        expect(toCrossPaneTabDropPreview("primary", "tab-a", target)).toEqual({
            sourcePaneId: "primary",
            targetPaneId: "secondary",
            position: "center",
            insertIndex: 0,
            tabId: "tab-a",
            overlayRect: null,
            lineRect: {
                left: 219,
                right: 221,
                top: 10,
                bottom: 34,
                width: 2,
                height: 24,
            },
        });
    });

    it("resolves same-pane center as a no-preview workspace target and edges as splits", () => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary">
              <div data-pane-tab-strip="primary"></div>
            </div>
        `;

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement;
        const primaryStrip = document.querySelector(
            '[data-pane-tab-strip="primary"]',
        ) as HTMLElement;

        primaryPane.getBoundingClientRect = () =>
            mockRect({ left: 0, top: 0, width: 220, height: 180 });
        primaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 8, top: 8, width: 204, height: 30 });

        const centerTarget = resolveWorkspaceTabDropTarget({
            sourcePaneId: "primary",
            tabId: "tab-a",
            clientX: 110,
            clientY: 120,
        });
        const edgeTarget = resolveWorkspaceTabDropTarget({
            sourcePaneId: "primary",
            tabId: "tab-a",
            clientX: 12,
            clientY: 120,
        });

        expect(centerTarget).toEqual({
            type: "pane-center",
            paneId: "primary",
        });
        expect(
            toCrossPaneTabDropPreview("primary", "tab-a", centerTarget),
        ).toBeNull();
        expect(edgeTarget).toEqual({
            type: "split",
            paneId: "primary",
            direction: "left",
        });

        expect(
            toCrossPaneTabDropPreview("primary", "tab-a", edgeTarget),
        ).toEqual({
            sourcePaneId: "primary",
            targetPaneId: "primary",
            position: "left",
            insertIndex: null,
            tabId: "tab-a",
            overlayRect: {
                left: 0,
                top: 0,
                right: 92.4,
                bottom: 180,
                width: 92.4,
                height: 180,
            },
            lineRect: null,
        });
    });

    it("keeps a split target through the narrow divider gap between panes", () => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary">
              <div data-pane-tab-strip="primary"></div>
            </div>
            <div data-editor-pane-id="secondary">
              <div data-pane-tab-strip="secondary"></div>
            </div>
        `;

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement;
        const primaryStrip = document.querySelector(
            '[data-pane-tab-strip="primary"]',
        ) as HTMLElement;
        const secondaryPane = document.querySelector(
            '[data-editor-pane-id="secondary"]',
        ) as HTMLElement;
        const secondaryStrip = document.querySelector(
            '[data-pane-tab-strip="secondary"]',
        ) as HTMLElement;

        primaryPane.getBoundingClientRect = () =>
            mockRect({ left: 0, top: 0, width: 180, height: 160 });
        primaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 8, top: 8, width: 164, height: 30 });
        secondaryPane.getBoundingClientRect = () =>
            mockRect({ left: 190, top: 0, width: 220, height: 160 });
        secondaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 198, top: 8, width: 204, height: 30 });

        expect(
            resolveWorkspaceTabDropTarget({
                sourcePaneId: "primary",
                tabId: "tab-a",
                clientX: 184,
                clientY: 90,
            }),
        ).toEqual({
            type: "split",
            paneId: "primary",
            direction: "right",
        });

        expect(
            resolveWorkspaceTabDropTarget({
                sourcePaneId: "primary",
                tabId: "tab-a",
                clientX: 186,
                clientY: 90,
            }),
        ).toEqual({
            type: "split",
            paneId: "secondary",
            direction: "left",
        });
    });

    it("still clears the workspace target when the pointer is outside pane slop", () => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary">
              <div data-pane-tab-strip="primary"></div>
            </div>
        `;

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement;
        primaryPane.getBoundingClientRect = () =>
            mockRect({ left: 0, top: 0, width: 180, height: 160 });

        expect(
            resolveWorkspaceTabDropTarget({
                sourcePaneId: "primary",
                tabId: "tab-a",
                clientX: 240,
                clientY: 90,
            }),
        ).toEqual({ type: "none" });
    });

    it("builds an inset center overlay for foreign pane drops", () => {
        document.body.innerHTML = `
            <div data-editor-pane-id="primary">
              <div data-pane-tab-strip="primary"></div>
            </div>
            <div data-editor-pane-id="secondary">
              <div data-pane-tab-strip="secondary"></div>
            </div>
        `;

        const primaryPane = document.querySelector(
            '[data-editor-pane-id="primary"]',
        ) as HTMLElement;
        const primaryStrip = document.querySelector(
            '[data-pane-tab-strip="primary"]',
        ) as HTMLElement;
        const secondaryPane = document.querySelector(
            '[data-editor-pane-id="secondary"]',
        ) as HTMLElement;
        const secondaryStrip = document.querySelector(
            '[data-pane-tab-strip="secondary"]',
        ) as HTMLElement;

        primaryPane.getBoundingClientRect = () =>
            mockRect({ left: 0, top: 0, width: 180, height: 140 });
        primaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 8, top: 8, width: 164, height: 30 });
        secondaryPane.getBoundingClientRect = () =>
            mockRect({ left: 200, top: 0, width: 240, height: 180 });
        secondaryStrip.getBoundingClientRect = () =>
            mockRect({ left: 208, top: 8, width: 224, height: 30 });

        const target = resolveWorkspaceTabDropTarget({
            sourcePaneId: "primary",
            tabId: "tab-a",
            clientX: 320,
            clientY: 120,
        });

        expect(target).toEqual({
            type: "pane-center",
            paneId: "secondary",
        });
        expect(toCrossPaneTabDropPreview("primary", "tab-a", target)).toEqual({
            sourcePaneId: "primary",
            targetPaneId: "secondary",
            position: "center",
            insertIndex: null,
            tabId: "tab-a",
            overlayRect: {
                left: 206,
                top: 6,
                right: 434,
                bottom: 174,
                width: 228,
                height: 168,
            },
            lineRect: null,
        });
    });
});
