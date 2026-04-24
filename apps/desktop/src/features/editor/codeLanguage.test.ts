import { describe, expect, it } from "vitest";
import {
    loadCodeLanguage,
    resolveCodeLanguageKey,
    resolveMarkdownCodeLanguage,
    resolveMarkdownCodeLanguageKey,
} from "./codeLanguage";

describe("codeLanguage", () => {
    it("maps supported file extensions to explicit language keys", () => {
        expect(resolveCodeLanguageKey("/vault/main.c", "text/plain")).toBe("c");
        expect(resolveCodeLanguageKey("/vault/main.cpp", "text/plain")).toBe(
            "cpp",
        );
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
        expect(resolveCodeLanguageKey("/vault/index.php", null)).toBe("php");
        expect(resolveCodeLanguageKey("/vault/view.phtml", null)).toBe("php");
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

    it("maps lockfiles to the closest available language", () => {
        expect(resolveCodeLanguageKey("/vault/Cargo.lock", null)).toBe("toml");
        expect(resolveCodeLanguageKey("/vault/poetry.lock", null)).toBe("toml");
        expect(resolveCodeLanguageKey("/vault/uv.lock", null)).toBe("toml");
        expect(resolveCodeLanguageKey("/vault/Pipfile.lock", null)).toBe(
            "json",
        );
        expect(resolveCodeLanguageKey("/vault/composer.lock", null)).toBe(
            "json",
        );
        expect(resolveCodeLanguageKey("/vault/deno.lock", null)).toBe("json");
        expect(resolveCodeLanguageKey("/vault/flake.lock", null)).toBe("json");
        expect(resolveCodeLanguageKey("/vault/pubspec.lock", null)).toBe(
            "yaml",
        );
        expect(resolveCodeLanguageKey("/vault/Gemfile.lock", null)).toBe(
            "lockfile",
        );
        expect(resolveCodeLanguageKey("/vault/yarn.lock", null)).toBe(
            "lockfile",
        );
        expect(resolveCodeLanguageKey("/vault/custom.lock", null)).toBe(
            "lockfile",
        );
        expect(resolveCodeLanguageKey("/vault/package-lock.json", null)).toBe(
            "json",
        );
        expect(resolveCodeLanguageKey("/vault/pnpm-lock.yaml", null)).toBe(
            "yaml",
        );
    });

    it("falls back to mime type when the extension is missing", () => {
        expect(
            resolveCodeLanguageKey("/vault/datafile", "application/json"),
        ).toBe("json");
        expect(
            resolveCodeLanguageKey("/vault/envfile", "text/x-shellscript"),
        ).toBe("shell");
        expect(resolveCodeLanguageKey("/vault/noext", "text/x-csrc")).toBe("c");
        expect(resolveCodeLanguageKey("/vault/noext", "text/x-c++src")).toBe(
            "cpp",
        );
        expect(resolveCodeLanguageKey("/vault/noext", "text/x-php")).toBe(
            "php",
        );
        expect(resolveCodeLanguageKey("/vault/noext", "text/x-sql")).toBe(
            "sql",
        );
    });

    it("returns null for unsupported files", () => {
        expect(
            resolveCodeLanguageKey(
                "/vault/archive.bin",
                "application/octet-stream",
            ),
        ).toBe(null);
    });

    it("maps fenced code info strings to supported language keys", () => {
        expect(resolveMarkdownCodeLanguageKey("rust")).toBe("rust");
        expect(resolveMarkdownCodeLanguageKey("rs")).toBe("rust");
        expect(resolveMarkdownCodeLanguageKey("c")).toBe("c");
        expect(resolveMarkdownCodeLanguageKey("c++")).toBe("cpp");
        expect(resolveMarkdownCodeLanguageKey("hpp")).toBe("cpp");
        expect(resolveMarkdownCodeLanguageKey("typescript")).toBe("typescript");
        expect(resolveMarkdownCodeLanguageKey("tsx")).toBe("typescript-jsx");
        expect(resolveMarkdownCodeLanguageKey("bash")).toBe("shell");
        expect(resolveMarkdownCodeLanguageKey("php5")).toBe("php");
        expect(resolveMarkdownCodeLanguageKey("yml")).toBe("yaml");
        expect(resolveMarkdownCodeLanguageKey("postgresql")).toBe(
            "sql-postgresql",
        );
        expect(resolveMarkdownCodeLanguageKey("mysql")).toBe("sql-mysql");
        expect(resolveMarkdownCodeLanguageKey("sqlite")).toBe("sql-sqlite");
        expect(resolveMarkdownCodeLanguageKey("{.python}")).toBe("python");
        expect(resolveMarkdownCodeLanguageKey("language-json")).toBe("json");
        expect(resolveMarkdownCodeLanguageKey("rust linenums")).toBe("rust");
        expect(resolveMarkdownCodeLanguageKey("unknown")).toBe(null);
    });

    it("builds lazy Markdown language descriptions for fenced code", async () => {
        const rust = resolveMarkdownCodeLanguage("rust");
        const bash = resolveMarkdownCodeLanguage("bash");
        const cpp = resolveMarkdownCodeLanguage("c++");
        const php = resolveMarkdownCodeLanguage("php");
        const postgres = resolveMarkdownCodeLanguage("postgresql");
        const unknown = resolveMarkdownCodeLanguage("plaintext");

        expect(rust).not.toBeNull();
        expect(bash).not.toBeNull();
        expect(cpp).not.toBeNull();
        expect(php).not.toBeNull();
        expect(postgres).not.toBeNull();
        expect(unknown).toBeNull();

        await expect(rust?.load()).resolves.toBeDefined();
        await expect(bash?.load()).resolves.toBeDefined();
        await expect(cpp?.load()).resolves.toBeDefined();
        await expect(php?.load()).resolves.toBeDefined();
        await expect(postgres?.load()).resolves.toBeDefined();
    });

    it("loads modern and legacy CodeMirror languages on demand", async () => {
        const [
            cLanguage,
            cppLanguage,
            rustLanguage,
            tsxLanguage,
            phpLanguage,
            sqlLanguage,
            swiftLanguage,
            dockerfileLanguage,
            makefileLanguage,
            propertiesLanguage,
            lockfileLanguage,
            unknownLanguage,
        ] = await Promise.all([
            loadCodeLanguage("/vault/main.c", "text/plain"),
            loadCodeLanguage("/vault/main.hpp", "text/plain"),
            loadCodeLanguage("/vault/src/main.rs", "text/plain"),
            loadCodeLanguage("/vault/src/App.tsx", "text/plain"),
            loadCodeLanguage("/vault/index.php", "text/plain"),
            loadCodeLanguage("/vault/query.sql", "text/plain"),
            loadCodeLanguage("/vault/Package.swift", "text/plain"),
            loadCodeLanguage("/vault/Dockerfile", null),
            loadCodeLanguage("/vault/Makefile", null),
            loadCodeLanguage("/vault/.env.local", null),
            loadCodeLanguage("/vault/yarn.lock", null),
            loadCodeLanguage("/vault/file.unknown", "text/plain"),
        ]);

        expect(cLanguage).not.toBeNull();
        expect(cppLanguage).not.toBeNull();
        expect(rustLanguage).not.toBeNull();
        expect(tsxLanguage).not.toBeNull();
        expect(phpLanguage).not.toBeNull();
        expect(sqlLanguage).not.toBeNull();
        expect(swiftLanguage).not.toBeNull();
        expect(dockerfileLanguage).not.toBeNull();
        expect(makefileLanguage).not.toBeNull();
        expect(propertiesLanguage).not.toBeNull();
        expect(lockfileLanguage).not.toBeNull();
        expect(unknownLanguage).toBeNull();
    });
});
