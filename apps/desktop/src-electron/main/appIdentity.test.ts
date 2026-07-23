import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    DEVELOPMENT_APP_ID,
    DEVELOPMENT_APP_NAME,
    DEVELOPMENT_SECRET_SERVICE,
    RELEASE_APP_ID,
    RELEASE_APP_NAME,
    RELEASE_SECRET_SERVICE,
    applyAppIdentity,
    registerProductionProtocolClient,
    resolveAppIdentity,
} from "./appIdentity";

function createAppMock() {
    return {
        getPath: vi.fn((name: string) => {
            if (name === "appData") return "/Users/test/Library/Application Support";
            if (name === "userData") {
                return "/Users/test/Library/Application Support/NeverWrite";
            }
            throw new Error(`Unexpected path: ${name}`);
        }),
        getVersion: vi.fn(() => "0.5.0"),
        setAboutPanelOptions: vi.fn(),
        setAppUserModelId: vi.fn(),
        setName: vi.fn(),
        setPath: vi.fn(),
    };
}

describe("resolveAppIdentity", () => {
    it("preserves the canonical release identity and production integrations", () => {
        expect(resolveAppIdentity({ isPackaged: true })).toEqual({
            variant: "release",
            displayName: RELEASE_APP_NAME,
            appUserModelId: RELEASE_APP_ID,
            userDataDirectoryName: RELEASE_APP_NAME,
            ownsProductionDeepLinks: true,
            enablesWebClipperServer: true,
            secretServiceName: RELEASE_SECRET_SERVICE,
        });
    });

    it("gives unpackaged development a fully separate identity", () => {
        expect(resolveAppIdentity({ isPackaged: false })).toEqual({
            variant: "development",
            displayName: DEVELOPMENT_APP_NAME,
            appUserModelId: DEVELOPMENT_APP_ID,
            userDataDirectoryName: DEVELOPMENT_APP_NAME,
            ownsProductionDeepLinks: false,
            enablesWebClipperServer: false,
            secretServiceName: DEVELOPMENT_SECRET_SERVICE,
        });
    });

    it("keeps the packaging override release-only", () => {
        expect(
            resolveAppIdentity({
                isPackaged: true,
                releaseAppUserModelId: " com.example.release-smoke ",
            }).appUserModelId,
        ).toBe("com.example.release-smoke");
        expect(
            resolveAppIdentity({
                isPackaged: false,
                releaseAppUserModelId: "com.example.release-smoke",
            }).appUserModelId,
        ).toBe(DEVELOPMENT_APP_ID);
    });
});

describe("applyAppIdentity", () => {
    it("does not override the release userData path", () => {
        const app = createAppMock();
        const identity = resolveAppIdentity({ isPackaged: true });

        applyAppIdentity(app, identity, "darwin");

        expect(app.setName).toHaveBeenCalledWith(RELEASE_APP_NAME);
        expect(app.setPath).not.toHaveBeenCalled();
        expect(app.getPath).not.toHaveBeenCalled();
        expect(app.setAboutPanelOptions).toHaveBeenCalledWith({
            applicationName: RELEASE_APP_NAME,
            applicationVersion: "0.5.0",
        });
    });

    it("sets the development profile before later userData consumers run", () => {
        const app = createAppMock();
        const identity = resolveAppIdentity({ isPackaged: false });

        applyAppIdentity(app, identity, "darwin");

        expect(app.setName).toHaveBeenCalledWith(DEVELOPMENT_APP_NAME);
        expect(app.setPath).toHaveBeenCalledWith(
            "userData",
            path.join(
                "/Users/test/Library/Application Support",
                DEVELOPMENT_APP_NAME,
            ),
        );
        expect(app.setName.mock.invocationCallOrder[0]).toBeLessThan(
            app.setPath.mock.invocationCallOrder[0]!,
        );
    });

    it("uses the variant-specific Windows App User Model ID", () => {
        const app = createAppMock();
        const identity = resolveAppIdentity({ isPackaged: false });

        applyAppIdentity(app, identity, "win32");

        expect(app.setAppUserModelId).toHaveBeenCalledWith(DEVELOPMENT_APP_ID);
        expect(app.setAboutPanelOptions).not.toHaveBeenCalled();
    });
});

describe("registerProductionProtocolClient", () => {
    it("leaves the production protocol owned by release", () => {
        const setAsDefaultProtocolClient = vi.fn(() => true);

        expect(
            registerProductionProtocolClient(
                { setAsDefaultProtocolClient },
                resolveAppIdentity({ isPackaged: true }),
            ),
        ).toBe(true);
        expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("neverwrite");
    });

    it("does not register any protocol for development", () => {
        const setAsDefaultProtocolClient = vi.fn(() => true);

        expect(
            registerProductionProtocolClient(
                { setAsDefaultProtocolClient },
                resolveAppIdentity({ isPackaged: false }),
            ),
        ).toBe(false);
        expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
    });
});
