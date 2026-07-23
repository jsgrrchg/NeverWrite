import { describe, expect, it, vi } from "vitest";
import { installProfileIntegrations } from "./profileIntegrations";

describe("installProfileIntegrations", () => {
    it("installs production deep links and the Web Clipper for release", () => {
        const installers = {
            installProductionDeepLinks: vi.fn(),
            installWebClipperServer: vi.fn(),
        };

        installProfileIntegrations(
            {
                enableProductionDeepLinks: true,
                enableWebClipperServer: true,
            },
            installers,
        );

        expect(installers.installProductionDeepLinks).toHaveBeenCalledOnce();
        expect(installers.installWebClipperServer).toHaveBeenCalledOnce();
    });

    it("does not let development register deep links or occupy the clipper port", () => {
        const installers = {
            installProductionDeepLinks: vi.fn(),
            installWebClipperServer: vi.fn(),
        };

        installProfileIntegrations(
            {
                enableProductionDeepLinks: false,
                enableWebClipperServer: false,
            },
            installers,
        );

        expect(installers.installProductionDeepLinks).not.toHaveBeenCalled();
        expect(installers.installWebClipperServer).not.toHaveBeenCalled();
    });
});
