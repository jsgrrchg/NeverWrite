import { describe, expect, it } from "vitest";

async function readDesktopCsp() {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");

    const raw = await readFile(
        resolve(import.meta.dirname, "../../../config/desktop-security.json"),
        "utf8",
    );
    const parsed = JSON.parse(raw) as { csp?: string };

    return parsed.csp ?? "";
}

describe("desktop CSP allowlist", () => {
    it("keeps the runtime and resource allowlist needed by the desktop product", async () => {
        const csp = await readDesktopCsp();

        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self' 'unsafe-eval'");
        expect(csp).toContain(
            "connect-src 'self' ipc: http://ipc.localhost asset: neverwrite-file:",
        );
        expect(csp).toContain("https://www.youtube.com");
        expect(csp).toContain(
            "img-src 'self' asset: data: neverwrite-file:",
        );
        expect(csp).toContain("https: http:");
        expect(csp).toContain("worker-src 'self' blob:");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain(
            "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
        );
    });
});
