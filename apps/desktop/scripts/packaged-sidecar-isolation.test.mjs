import { describe, expect, it, vi } from "vitest";

import {
    isolateExecutableForSmoke,
    removeSmokeTempDirectory,
} from "./packaged-sidecar-isolation.mjs";

function fileSystemDouble() {
    return {
        link: vi.fn().mockResolvedValue(undefined),
        copyFile: vi.fn().mockResolvedValue(undefined),
        chmod: vi.fn().mockResolvedValue(undefined),
    };
}

describe("packaged sidecar smoke isolation", () => {
    it("does not chmod an isolated hard link", async () => {
        const fileSystem = fileSystemDouble();

        await expect(
            isolateExecutableForSmoke("packaged-acp", "isolated-acp", {
                fileSystem,
                platform: "darwin",
            }),
        ).resolves.toBe("hard-link");

        expect(fileSystem.link).toHaveBeenCalledWith(
            "packaged-acp",
            "isolated-acp",
        );
        expect(fileSystem.copyFile).not.toHaveBeenCalled();
        expect(fileSystem.chmod).not.toHaveBeenCalled();
    });

    it("makes a copied executable runnable on Unix", async () => {
        const fileSystem = fileSystemDouble();
        fileSystem.link.mockRejectedValue(
            Object.assign(new Error("cross-device link"), { code: "EXDEV" }),
        );

        await expect(
            isolateExecutableForSmoke("packaged-acp", "isolated-acp", {
                fileSystem,
                platform: "linux",
            }),
        ).resolves.toBe("copy");

        expect(fileSystem.copyFile).toHaveBeenCalledWith(
            "packaged-acp",
            "isolated-acp",
        );
        expect(fileSystem.chmod).toHaveBeenCalledWith("isolated-acp", 0o755);
    });

    it("does not chmod a copied Windows executable", async () => {
        const fileSystem = fileSystemDouble();
        fileSystem.link.mockRejectedValue(new Error("link unavailable"));

        await expect(
            isolateExecutableForSmoke("packaged-acp.exe", "isolated-acp.exe", {
                fileSystem,
                platform: "win32",
            }),
        ).resolves.toBe("copy");

        expect(fileSystem.copyFile).toHaveBeenCalled();
        expect(fileSystem.chmod).not.toHaveBeenCalled();
    });

    it("retries temporary directory cleanup for locked Windows files", async () => {
        const fileSystem = {
            rm: vi.fn().mockResolvedValue(undefined),
        };

        await removeSmokeTempDirectory("smoke-temp", { fileSystem });

        expect(fileSystem.rm).toHaveBeenCalledWith("smoke-temp", {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 500,
        });
    });
});
