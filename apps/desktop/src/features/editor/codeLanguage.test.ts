import { describe, expect, it } from "vitest";
import { loadCodeLanguage, resolveCodeLanguageKey } from "./codeLanguage";

describe("codeLanguage", () => {
    it("maps supported file extensions to explicit language keys", () => {
        expect(resolveCodeLanguageKey("/vault/src/main.rs", "text/plain")).toBe(
            "rust",
        );
        expect(
            resolveCodeLanguageKey("/vault/src/App.tsx", "text/plain"),
        ).toBe("typescript-jsx");
        expect(
            resolveCodeLanguageKey("/vault/Package.swift", "text/plain"),
        ).toBe("swift");
        expect(resolveCodeLanguageKey("/vault/script.zsh", "text/plain")).toBe(
            "shell",
        );
        expect(
            resolveCodeLanguageKey("/vault/config.toml", "application/toml"),
        ).toBe("toml");
        expect(resolveCodeLanguageKey("/vault/build.mjs", "text/plain")).toBe(
            "javascript",
        );
        expect(resolveCodeLanguageKey("/vault/app.mts", "text/plain")).toBe(
            "typescript",
        );
        expect(resolveCodeLanguageKey("/vault/.zshrc", "text/plain")).toBe(
            "shell",
        );
    });

    it("falls back to mime type when the extension is missing", () => {
        expect(resolveCodeLanguageKey("/vault/Dockerfile", "application/json")).toBe(
            "json",
        );
        expect(resolveCodeLanguageKey("/vault/envfile", "text/x-shellscript")).toBe(
            "shell",
        );
    });

    it("returns null for unsupported files", () => {
        expect(resolveCodeLanguageKey("/vault/archive.bin", "application/octet-stream")).toBe(
            null,
        );
    });

    it("loads modern and legacy CodeMirror languages on demand", async () => {
        const [rustLanguage, tsxLanguage, swiftLanguage, unknownLanguage] =
            await Promise.all([
                loadCodeLanguage("/vault/src/main.rs", "text/plain"),
                loadCodeLanguage("/vault/src/App.tsx", "text/plain"),
                loadCodeLanguage("/vault/Package.swift", "text/plain"),
                loadCodeLanguage("/vault/file.unknown", "text/plain"),
            ]);

        expect(rustLanguage).not.toBeNull();
        expect(tsxLanguage).not.toBeNull();
        expect(swiftLanguage).not.toBeNull();
        expect(unknownLanguage).toBeNull();
    });
});
