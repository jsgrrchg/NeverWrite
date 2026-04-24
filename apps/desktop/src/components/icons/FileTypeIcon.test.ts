import { describe, expect, it } from "vitest";

import { hasCatppuccinIcon } from "./catppuccin-icons";
import { resolveCatppuccinFileIcon } from "./fileTypeIcons";

describe("resolveCatppuccinFileIcon", () => {
    it.each([
        ["package.json", "package-json"],
        ["package-lock.json", "npm-lock"],
        ["pnpm-lock.yaml", "pnpm-lock"],
        ["yarn.lock", "yarn-lock"],
        ["bun.lockb", "bun-lock"],
        ["Cargo.lock", "cargo-lock"],
        ["Cargo.toml", "cargo"],
        ["poetry.lock", "poetry-lock"],
        ["uv.lock", "uv"],
        ["flake.lock", "nix-lock"],
        ["Gemfile.lock", "ruby-gem-lock"],
        [".gitignore", "git"],
        [".gitattributes", "git"],
        [".editorconfig", "editorconfig"],
        [".npmignore", "npm-ignore"],
        [".prettierignore", "prettier-ignore"],
        ["docker-compose.yml", "docker-compose"],
    ])("maps special file %s to %s", (fileName, iconName) => {
        const resolved = resolveCatppuccinFileIcon(fileName);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it.each([
        [".env.local", "env"],
        [".envrc", "envrc"],
        ["tsconfig.app.json", "typescript-config"],
        ["jsconfig.json", "javascript-config"],
        ["astro.config.mjs", "astro-config"],
        ["vite.config.ts", "vite"],
        ["vitest.config.ts", "vitest"],
        ["eslint.config.mjs", "eslint"],
        [".prettierrc.json", "prettier"],
        ["prettier.config.cjs", "prettier"],
        ["tailwind.config.ts", "tailwind"],
        ["postcss.config.cjs", "postcss"],
        ["webpack.config.js", "webpack"],
        ["rollup.config.mjs", "rollup"],
        ["Dockerfile.dev", "docker"],
    ])("maps patterned file %s to %s", (fileName, iconName) => {
        const resolved = resolveCatppuccinFileIcon(fileName);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it.each([
        ["notes/draft.md", "markdown"],
        ["docs/intro.mdx", "markdown-mdx"],
        ["src/App.tsx", "typescript-react"],
        ["src/App.jsx", "javascript-react"],
        ["src/index.ts", "typescript"],
        ["src/index.js", "javascript"],
        ["styles/app.css", "css"],
        ["styles/app.scss", "sass"],
        ["scripts/build.sh", "bash"],
        ["src/main.py", "python"],
        ["src/main.rs", "rust"],
        ["src/main.go", "go"],
        ["data/query.sql", "database"],
        ["schema.proto", "proto"],
        ["config/settings.ini", "config"],
        ["formula.tex", "latex"],
        ["module.wast", "web-assembly"],
        ["image.png", "image"],
        ["diagram.svg", "image"],
        ["board.excalidraw", "drawio"],
        ["document.pdf", "pdf"],
        ["table.csv", "csv"],
        ["budget.xlsx", "ms-excel"],
        ["song.mp3", "audio"],
        ["clip.mp4", "video"],
    ])("maps file %s to %s", (fileName, iconName) => {
        const resolved = resolveCatppuccinFileIcon(fileName);

        expect(resolved.iconName).toBe(iconName);
        expect(hasCatppuccinIcon(resolved.iconName)).toBe(true);
    });

    it("forces internal notes to markdown", () => {
        expect(
            resolveCatppuccinFileIcon("daily-note", { kind: "note" }).iconName,
        ).toBe("markdown");
    });

    it("uses mime types when the filename has no useful extension", () => {
        expect(
            resolveCatppuccinFileIcon("cover", {
                mimeType: "image/png",
            }).iconName,
        ).toBe("image");
        expect(
            resolveCatppuccinFileIcon("movie", {
                mimeType: "video/mp4",
            }).iconName,
        ).toBe("video");
    });

    it("falls back to the generic file icon for unknown files", () => {
        expect(resolveCatppuccinFileIcon("unknown.customthing").iconName).toBe(
            "file",
        );
    });
});
