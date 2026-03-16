import { describe, expect, it } from "vitest";
import { loadCodeLanguage, resolveCodeLanguageKey } from "./codeLanguage";

describe("codeLanguage", () => {
    it("maps supported file extensions to explicit language keys", () => {
        expect(resolveCodeLanguageKey("/vault/src/main.rs", "text/plain")).toBe(
            "rust",
        );
        expect(resolveCodeLanguageKey("/vault/src/App.tsx", "text/plain")).toBe(
            "typescript-jsx",
        );
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
        expect(resolveCodeLanguageKey("/vault/Dockerfile", null)).toBe(
            "dockerfile",
        );
        expect(resolveCodeLanguageKey("/vault/Makefile", null)).toBe(
            "makefile",
        );
        expect(resolveCodeLanguageKey("/vault/.env.local", null)).toBe(
            "properties",
        );
        expect(resolveCodeLanguageKey("/vault/build.cmake", null)).toBe(
            "cmake",
        );
        expect(resolveCodeLanguageKey("/vault/schema.proto", null)).toBe(
            "protobuf",
        );
        expect(resolveCodeLanguageKey("/vault/setup.ps1", null)).toBe(
            "powershell",
        );
    });

    it("maps newly added language extensions", () => {
        expect(resolveCodeLanguageKey("/vault/main.go", null)).toBe("go");
        expect(resolveCodeLanguageKey("/vault/app.rb", null)).toBe("ruby");
        expect(resolveCodeLanguageKey("/vault/analysis.r", null)).toBe("r");
        expect(resolveCodeLanguageKey("/vault/core.clj", null)).toBe("clojure");
        expect(resolveCodeLanguageKey("/vault/Main.hs", null)).toBe("haskell");
        expect(resolveCodeLanguageKey("/vault/server.erl", null)).toBe(
            "erlang",
        );
        expect(resolveCodeLanguageKey("/vault/lib.ex", null)).toBe("erlang");
        expect(resolveCodeLanguageKey("/vault/script.pl", null)).toBe("perl");
        expect(resolveCodeLanguageKey("/vault/main.lua", null)).toBe("lua");
        expect(resolveCodeLanguageKey("/vault/compute.jl", null)).toBe("julia");
        expect(resolveCodeLanguageKey("/vault/query.sql", null)).toBe("sql");
        expect(resolveCodeLanguageKey("/vault/changes.diff", null)).toBe(
            "diff",
        );
        expect(resolveCodeLanguageKey("/vault/style.sass", null)).toBe("sass");
        expect(resolveCodeLanguageKey("/vault/style.styl", null)).toBe(
            "stylus",
        );
        expect(resolveCodeLanguageKey("/vault/paper.tex", null)).toBe("stex");
        expect(resolveCodeLanguageKey("/vault/page.vue", null)).toBe(
            "javascript-jsx",
        );
        expect(resolveCodeLanguageKey("/vault/page.svelte", null)).toBe(
            "javascript-jsx",
        );
        expect(resolveCodeLanguageKey("/vault/page.astro", null)).toBe(
            "javascript-jsx",
        );
        expect(resolveCodeLanguageKey("/vault/data.xml", null)).toBe("xml");
        expect(resolveCodeLanguageKey("/vault/config.ini", null)).toBe(
            "properties",
        );
        expect(resolveCodeLanguageKey("/vault/data.jsonc", null)).toBe("json");
        expect(resolveCodeLanguageKey("/vault/style.less", null)).toBe("css");
        expect(resolveCodeLanguageKey("/vault/Build.kt", null)).toBe("java");
        expect(resolveCodeLanguageKey("/vault/Main.scala", null)).toBe("java");
        expect(resolveCodeLanguageKey("/vault/module.wast", null)).toBe("wast");
    });

    it("falls back to mime type when the extension is missing", () => {
        expect(
            resolveCodeLanguageKey("/vault/datafile", "application/json"),
        ).toBe("json");
        expect(
            resolveCodeLanguageKey("/vault/envfile", "text/x-shellscript"),
        ).toBe("shell");
    });

    it("returns null for unsupported files", () => {
        expect(
            resolveCodeLanguageKey(
                "/vault/archive.bin",
                "application/octet-stream",
            ),
        ).toBe(null);
    });

    it("loads modern and legacy CodeMirror languages on demand", async () => {
        const [
            rustLanguage,
            tsxLanguage,
            swiftLanguage,
            dockerfileLanguage,
            makefileLanguage,
            propertiesLanguage,
            unknownLanguage,
        ] = await Promise.all([
            loadCodeLanguage("/vault/src/main.rs", "text/plain"),
            loadCodeLanguage("/vault/src/App.tsx", "text/plain"),
            loadCodeLanguage("/vault/Package.swift", "text/plain"),
            loadCodeLanguage("/vault/Dockerfile", null),
            loadCodeLanguage("/vault/Makefile", null),
            loadCodeLanguage("/vault/.env.local", null),
            loadCodeLanguage("/vault/file.unknown", "text/plain"),
        ]);

        expect(rustLanguage).not.toBeNull();
        expect(tsxLanguage).not.toBeNull();
        expect(swiftLanguage).not.toBeNull();
        expect(dockerfileLanguage).not.toBeNull();
        expect(makefileLanguage).not.toBeNull();
        expect(propertiesLanguage).not.toBeNull();
        expect(unknownLanguage).toBeNull();
    });
});
