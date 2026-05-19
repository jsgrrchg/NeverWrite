import { describe, expect, it } from "vitest";
import {
    installYouTubeEmbedIdentityHeaders,
    withYouTubeEmbedIdentityHeaders,
} from "./youtubeEmbedIdentity";

describe("withYouTubeEmbedIdentityHeaders", () => {
    it("adds a stable Referer when Electron does not provide one", () => {
        expect(withYouTubeEmbedIdentityHeaders({ Accept: "text/html" })).toEqual(
            {
                Accept: "text/html",
                Referer: "https://neverwrite.localhost/",
            },
        );
    });

    it("preserves an existing non-empty Referer", () => {
        const headers = {
            Referer: "http://127.0.0.1:5173/",
        };

        expect(withYouTubeEmbedIdentityHeaders(headers)).toBe(headers);
    });

    it("reuses existing header casing when the Referer is empty", () => {
        expect(withYouTubeEmbedIdentityHeaders({ referer: "" })).toEqual({
            referer: "https://neverwrite.localhost/",
        });
    });
});

describe("installYouTubeEmbedIdentityHeaders", () => {
    it("registers only YouTube embed requests for header injection", () => {
        let registeredFilter: { urls: string[] } | null = null;

        installYouTubeEmbedIdentityHeaders({
            webRequest: {
                onBeforeSendHeaders(filter) {
                    registeredFilter = filter;
                },
            },
        });

        expect(registeredFilter).toEqual({
            urls: [
                "https://www.youtube.com/embed/*",
                "https://www.youtube-nocookie.com/embed/*",
            ],
        });
    });
});
