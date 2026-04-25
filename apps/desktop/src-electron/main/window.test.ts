import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRendererDevUrl, resolveWindowIconPath } from "./window";

describe("resolveRendererDevUrl", () => {
    it("returns the dev URL for unpackaged builds", () => {
        expect(
            resolveRendererDevUrl(
                "http://127.0.0.1:5173/",
                false,
                "?panel=updates",
            ),
        ).toBe("http://127.0.0.1:5173/?panel=updates");
    });

    it("disables the dev URL for packaged builds", () => {
        expect(
            resolveRendererDevUrl(
                "http://127.0.0.1:5173/",
                true,
                "?panel=updates",
            ),
        ).toBeNull();
    });
});

describe("resolveWindowIconPath", () => {
    it("uses the packaged resources icon on Windows", () => {
        expect(
            resolveWindowIconPath({
                platform: "win32",
                isPackaged: true,
                resourcesPath: "C:\\App\\resources",
                appPath: "C:\\Repo\\apps\\desktop",
            }),
        ).toBe(path.join("C:\\App\\resources", "icons", "icon.ico"));
    });

    it("uses the build icon during development on Windows", () => {
        expect(
            resolveWindowIconPath({
                platform: "win32",
                isPackaged: false,
                resourcesPath: "C:\\App\\resources",
                appPath: "C:\\Repo\\apps\\desktop",
            }),
        ).toBe(
            path.join(
                "C:\\Repo\\apps\\desktop",
                "build",
                "icons",
                "icon.ico",
            ),
        );
    });

    it("lets macOS use the app bundle icon", () => {
        expect(
            resolveWindowIconPath({
                platform: "darwin",
                isPackaged: true,
                resourcesPath: "/Applications/NeverWrite.app/Contents/Resources",
                appPath: "/repo/apps/desktop",
            }),
        ).toBeUndefined();
    });
});
