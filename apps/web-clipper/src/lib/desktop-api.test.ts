import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DesktopApiError,
    fetchDesktopContext,
    saveClipToDesktop,
} from "./desktop-api";

function installBrowserMock(initialToken: string | null = null) {
    const storage = new Map<string, unknown>();
    if (initialToken) {
        storage.set("clipperDesktopAuth", { token: initialToken });
    }

    vi.stubGlobal("browser", {
        runtime: {
            id: "pogmjgibofkooljfgaandhoinmenfhao",
        },
        storage: {
            local: {
                get: vi.fn(async (key: string) => ({
                    [key]: storage.get(key),
                })),
                set: vi.fn(async (values: Record<string, unknown>) => {
                    for (const [key, value] of Object.entries(values)) {
                        storage.set(key, value);
                    }
                }),
                remove: vi.fn(async (key: string) => {
                    storage.delete(key);
                }),
            },
        },
    });

    return storage;
}

describe("desktop api client", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("pairs automatically and retries desktop requests", async () => {
        const storage = installBrowserMock();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: "Pairing required." }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ ok: true, token: "token-1" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        ok: true,
                        status: "saved",
                        message: "Saved clip to Inbox/Clip.md.",
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        vi.stubGlobal("fetch", fetchMock);

        const result = await saveClipToDesktop({
            requestId: "clip-1",
            title: "Clip",
            content: "Body",
            folder: "",
        });

        expect(result.status).toBe("saved");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0]?.[0]).toContain("/clips");
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
            "content-type": "application/json",
            "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
        });
        expect(fetchMock.mock.calls[1]?.[0]).toContain("/pair");
        expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
            "content-type": "application/json",
            "x-vaultai-clipper-token": "token-1",
            "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
        });
        expect(storage.get("clipperDesktopAuth")).toEqual({ token: "token-1" });
    });

    it("surfaces authorization failures when pairing is rejected", async () => {
        installBrowserMock();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: "Pairing required." }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ message: "Extension not allowed." }),
                    {
                        status: 403,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            saveClipToDesktop({
                requestId: "clip-2",
                title: "Clip",
                content: "Body",
                folder: "",
            }),
        ).rejects.toMatchObject({
            message: "Extension not allowed.",
            isUnauthorized: true,
            isUnavailable: false,
            statusCode: 403,
        });
    });

    it("clears an invalid persisted token, pairs again, and retries the request", async () => {
        const storage = installBrowserMock("stale-token");
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        message: "Web clipper token is invalid.",
                    }),
                    {
                        status: 403,
                        headers: { "content-type": "application/json" },
                    },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        message: "Web clipper pairing is required.",
                    }),
                    {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ ok: true, token: "token-2" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        ok: true,
                        status: "saved",
                        message: "Saved clip to Inbox/Clip.md.",
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        vi.stubGlobal("fetch", fetchMock);

        const result = await saveClipToDesktop({
            requestId: "clip-4",
            title: "Clip",
            content: "Body",
            folder: "",
        });

        expect(result.status).toBe("saved");
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
            "content-type": "application/json",
            "x-vaultai-clipper-token": "stale-token",
            "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
        });
        expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
            "content-type": "application/json",
            "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
        });
        expect(fetchMock.mock.calls[2]?.[0]).toContain("/pair");
        expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual({
            "content-type": "application/json",
            "x-vaultai-clipper-token": "token-2",
            "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
        });
        expect(storage.get("clipperDesktopAuth")).toEqual({ token: "token-2" });
    });

    it("treats transport failures as desktop unavailability", async () => {
        installBrowserMock();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new TypeError("boom")),
        );

        await expect(
            saveClipToDesktop({
                requestId: "clip-3",
                title: "Clip",
                content: "Body",
                folder: "",
            }),
        ).rejects.toMatchObject({
            message: "NeverWrite desktop API is unavailable.",
            isUnauthorized: false,
            isUnavailable: true,
        });
    });

    it("sends the persisted token and extension identity on context requests", async () => {
        installBrowserMock("persisted-token");
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        ok: true,
                        message: "NeverWrite desktop API is ready.",
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ folders: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ tags: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ themes: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        vi.stubGlobal("fetch", fetchMock);

        await fetchDesktopContext({
            vaultPathHint: "/vault",
            vaultNameHint: "Vault",
        });

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const [, init] of fetchMock.mock.calls) {
            expect(init?.headers).toEqual({
                "content-type": "application/json",
                "x-vaultai-clipper-token": "persisted-token",
                "x-vaultai-extension-id": "pogmjgibofkooljfgaandhoinmenfhao",
            });
        }
    });
});
