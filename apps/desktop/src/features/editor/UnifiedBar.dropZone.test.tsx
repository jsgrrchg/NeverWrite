import { describe, expect, it, vi } from "vitest";
import {
    flushPromises,
    getMockCurrentWindow,
    renderComponent,
} from "../../test/test-utils";
import { useVaultStore } from "../../app/store/vaultStore";
import { publishWindowTabDropZone } from "../../app/detachedWindows";

const innerPositionMock = vi.fn();
const scaleFactorMock = vi.fn();

vi.mock("../../app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "neverwrite:attach-external-tab",
    createDetachedWindowPayload: vi.fn(),
    createGhostWindow: vi.fn(),
    destroyGhostWindow: vi.fn(),
    findWindowTabDropTarget: vi.fn(),
    getCurrentWindowLabel: vi.fn(() => "main"),
    getDetachedWindowPosition: vi.fn(),
    isPointerOutsideCurrentWindow: vi.fn(() => false),
    moveGhostWindow: vi.fn(),
    openDetachedNoteWindow: vi.fn(),
    publishWindowTabDropZone: vi.fn(),
}));

describe("UnifiedBar drop zone publishing", () => {
    it("publishes a drop zone even when the window has no open tabs", async () => {
        const mockWindow = getMockCurrentWindow() as unknown as {
            innerPosition: typeof innerPositionMock;
            scaleFactor: typeof scaleFactorMock;
        };
        mockWindow.innerPosition = innerPositionMock;
        mockWindow.scaleFactor = scaleFactorMock;
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: "/vaults/main",
        }));

        Object.defineProperty(window, "screenX", {
            value: 900,
            configurable: true,
        });
        Object.defineProperty(window, "screenY", {
            value: 700,
            configurable: true,
        });

        scaleFactorMock.mockResolvedValue(2);
        innerPositionMock.mockResolvedValue({
            x: 240,
            y: 80,
            toLogical: () => ({
                x: 120,
                y: 40,
            }),
        });

        const rectSpy = vi
            .spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(
                () =>
                    ({
                        x: 20,
                        y: 12,
                        left: 20,
                        top: 12,
                        right: 420,
                        bottom: 42,
                        width: 400,
                        height: 30,
                        toJSON: () => ({}),
                    }) as DOMRect,
            );

        const { UnifiedBar } = await import("./UnifiedBar");
        renderComponent(<UnifiedBar windowMode="main" />);
        await flushPromises();
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        expect(vi.mocked(publishWindowTabDropZone)).toHaveBeenCalledWith(
            "main",
            expect.objectContaining({
                left: 140,
                top: 52,
                right: 540,
                bottom: 82,
                vaultPath: "/vaults/main",
            }),
        );

        rectSpy.mockRestore();
    });
});
