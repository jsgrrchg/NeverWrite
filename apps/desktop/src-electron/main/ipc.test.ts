import { describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";

vi.mock("electron", () => ({
    app: { isPackaged: true, getPath: vi.fn(() => "/tmp") },
    BrowserWindow: {
        fromWebContents: vi.fn(),
        getAllWindows: vi.fn(() => []),
    },
    dialog: {},
    ipcMain: { handle: vi.fn() },
    shell: {},
}));

import { broadcastRuntimeEvent, registerPreviewProtocolHandler } from "./ipc";

function encodeBase64Url(value: string) {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

describe("managed attachment preview protocol", () => {
    it("broadcasts backend events to main and detached windows", () => {
        const mainSend = vi.fn();
        const detachedSend = vi.fn();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
            {
                isDestroyed: () => false,
                webContents: { send: mainSend },
            },
            {
                isDestroyed: () => false,
                webContents: { send: detachedSend },
            },
        ] as never);

        broadcastRuntimeEvent("ai_history_storage_changed", {
            status: "ready",
        });

        expect(mainSend).toHaveBeenCalledOnce();
        expect(detachedSend).toHaveBeenCalledOnce();
        expect(detachedSend).toHaveBeenCalledWith(
            "neverwrite:event",
            expect.objectContaining({
                eventName: "ai_history_storage_changed",
            }),
        );
    });

    it("reads managed bytes through the shared backend authority", async () => {
        const invoke = vi.fn(async () => ({
            data_base64: Buffer.from("image-bytes").toString("base64"),
            mime_type: "image/png",
        }));
        const handler = registerPreviewProtocolHandler({ invoke } as never);
        const vaultPath = "/vault with spaces";
        const attachmentId = "ma_0123456789abcdef0123456789abcdef";

        const response = await handler(
            new Request(
                `neverwrite-file://localhost/ai-attachment/${encodeBase64Url(vaultPath)}/${attachmentId}`,
            ),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
            "image-bytes",
        );
        expect(invoke).toHaveBeenCalledWith("ai_read_managed_attachment", {
            vaultPath,
            attachmentId,
        });
    });

    it("never derives a path when backend validation rejects the ID", async () => {
        const invoke = vi.fn(async () => {
            throw new Error("Invalid managed attachment ID.");
        });
        const handler = registerPreviewProtocolHandler({ invoke } as never);

        const response = await handler(
            new Request(
                `neverwrite-file://localhost/ai-attachment/${encodeBase64Url("/vault")}/..%2Fsecret`,
            ),
        );

        expect(response.status).toBe(404);
        expect(invoke).toHaveBeenCalledOnce();
    });

    it("blocks the managed namespace through generic preview routes", async () => {
        const handler = registerPreviewProtocolHandler({
            invoke: vi.fn(),
        } as never);
        const privatePath =
            "assets/chat/.neverwrite-managed/v1/blobs/id/blob";

        const response = await handler(
            new Request(
                `neverwrite-file://localhost/vault/${encodeBase64Url("/vault")}/${encodeBase64Url(privatePath)}`,
            ),
        );

        expect(response.status).toBe(404);

        const alternateCaseResponse = await handler(
            new Request(
                `neverwrite-file://localhost/vault/${encodeBase64Url("/vault")}/${encodeBase64Url(privatePath.replace(".neverwrite-managed", ".NEVERWRITE-MANAGED"))}`,
            ),
        );
        expect(alternateCaseResponse.status).toBe(404);
    });
});
