import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleWebClipperDeepLink } = vi.hoisted(() => ({
    handleWebClipperDeepLink: vi.fn(),
}));
vi.mock("./webClipper", () => ({ handleWebClipperDeepLink }));

import {
    extractDeepLinksFromArgv,
    handleDeepLink,
    installDeepLinkRuntime,
    parseOpenDeepLink,
} from "./deepLink";

describe("parseOpenDeepLink", () => {
    it("parses a plain relative path", () => {
        expect(parseOpenDeepLink("neverwrite://open?path=notes/todo.md")).toEqual(
            { path: "notes/todo.md", line: null, endLine: null },
        );
    });

    it("accepts the authority-less form (neverwrite:open)", () => {
        expect(
            parseOpenDeepLink("neverwrite:open?path=Allgemein/ABOUT.md#L5"),
        ).toEqual({ path: "Allgemein/ABOUT.md", line: 5, endLine: null });
    });

    it("decodes url-encoded paths", () => {
        expect(
            parseOpenDeepLink(
                "neverwrite://open?path=Daily%20Notes%2F2026-07-06.md",
            ),
        ).toEqual({
            path: "Daily Notes/2026-07-06.md",
            line: null,
            endLine: null,
        });
    });

    it("reads a single-line fragment", () => {
        expect(
            parseOpenDeepLink("neverwrite://open?path=a.md#L12"),
        ).toEqual({ path: "a.md", line: 12, endLine: null });
    });

    it("reads a line range fragment (L-prefixed and bare end)", () => {
        expect(parseOpenDeepLink("neverwrite://open?path=a.md#L10-L20")).toEqual({
            path: "a.md",
            line: 10,
            endLine: 20,
        });
        expect(parseOpenDeepLink("neverwrite://open?path=a.md#L10-20")).toEqual({
            path: "a.md",
            line: 10,
            endLine: 20,
        });
    });

    it("tolerates a fragment percent-encoded into the path value", () => {
        expect(
            parseOpenDeepLink("neverwrite://open?path=a.md%23L5"),
        ).toEqual({ path: "a.md", line: 5, endLine: null });
    });

    it("does not truncate a filename that merely contains #L<digit>", () => {
        expect(
            parseOpenDeepLink(
                "neverwrite://open?path=Report%23L2%20draft.md",
            ),
        ).toEqual({ path: "Report#L2 draft.md", line: null, endLine: null });
    });

    it("ignores a non-line fragment", () => {
        expect(
            parseOpenDeepLink("neverwrite://open?path=a.md#section"),
        ).toEqual({ path: "a.md", line: null, endLine: null });
    });

    it("rejects zero/negative line numbers", () => {
        expect(parseOpenDeepLink("neverwrite://open?path=a.md#L0")).toEqual({
            path: "a.md",
            line: null,
            endLine: null,
        });
    });

    it("returns null for a missing path", () => {
        expect(parseOpenDeepLink("neverwrite://open")).toBeNull();
        expect(parseOpenDeepLink("neverwrite://open?path=")).toBeNull();
    });

    it("returns null for a different action or scheme", () => {
        expect(parseOpenDeepLink("neverwrite://clip?path=a.md")).toBeNull();
        expect(parseOpenDeepLink("https://example.com/open?path=a.md")).toBeNull();
        expect(parseOpenDeepLink("not a url")).toBeNull();
    });
});

describe("extractDeepLinksFromArgv", () => {
    it("keeps only neverwrite deep links", () => {
        expect(
            extractDeepLinksFromArgv([
                "/Applications/NeverWrite.app",
                "--flag",
                "neverwrite://open?path=a.md",
                "neverwrite://clip?requestId=1",
                "https://example.com",
            ]),
        ).toEqual([
            "neverwrite://open?path=a.md",
            "neverwrite://clip?requestId=1",
        ]);
    });
});

describe("handleDeepLink", () => {
    beforeEach(() => {
        handleWebClipperDeepLink.mockClear();
    });

    it("routes clip links to the web clipper unchanged", () => {
        const url = "neverwrite://clip?requestId=1&title=t&folder=f&mode=inline";
        handleDeepLink(url);
        expect(handleWebClipperDeepLink).toHaveBeenCalledWith(url);
    });

    it("routes the authority-less open form", () => {
        const emit = vi.fn();
        installDeepLinkRuntime(emit);
        handleDeepLink("neverwrite:open?path=Allgemein/ABOUT.md");
        expect(emit).toHaveBeenCalledWith("neverwrite:deep-link/open-file", {
            path: "Allgemein/ABOUT.md",
            line: null,
            endLine: null,
        });
    });

    it("does not route unknown actions anywhere", () => {
        handleDeepLink("neverwrite://frobnicate?path=a.md");
        expect(handleWebClipperDeepLink).not.toHaveBeenCalled();
    });

    it("emits the open-file event once a runtime is installed", () => {
        const emit = vi.fn();
        installDeepLinkRuntime(emit);
        handleDeepLink("neverwrite://open?path=notes/a.md#L3-L4");
        expect(emit).toHaveBeenCalledWith("neverwrite:deep-link/open-file", {
            path: "notes/a.md",
            line: 3,
            endLine: 4,
        });
    });
});

describe("deep-link open queueing", () => {
    it("flushes links received before the runtime is ready", async () => {
        vi.resetModules();
        const { handleDeepLink: freshHandle, installDeepLinkRuntime: freshInstall } =
            await import("./deepLink");

        freshHandle("neverwrite://open?path=queued.md");
        const emit = vi.fn();
        freshInstall(emit);
        expect(emit).toHaveBeenCalledWith("neverwrite:deep-link/open-file", {
            path: "queued.md",
            line: null,
            endLine: null,
        });
    });
});
