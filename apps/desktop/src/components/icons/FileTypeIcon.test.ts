import { describe, expect, it } from "vitest";

import { hasSymbolsIcon } from "./symbols-icons";
import { resolveSymbolsFileIcon } from "./fileTypeIcons";

describe("resolveSymbolsFileIcon", () => {
    it.each([
        ["package.json", "files/node.svg"],
        ["package-lock.json", "files/node.svg"],
        ["pnpm-lock.yaml", "files/pnpm.svg"],
        ["yarn.lock", "files/yarn.svg"],
        ["bun.lockb", "files/bun.svg"],
        ["uv.lock", "files/uv.svg"],
        [".gitignore", "files/git.svg"],
        [".gitattributes", "files/git.svg"],
        [".editorconfig", "files/editorconfig.svg"],
        [".npmignore", "files/npm.svg"],
        [".prettierignore", "files/prettier.svg"],
        ["docker-compose.yml", "files/docker-pink.svg"],
        [".env.local", "files/gear.svg"],
        ["tsconfig.app.json", "files/tsconfig.svg"],
        ["astro.config.mjs", "files/astro.svg"],
        ["vite.config.ts", "files/vite.svg"],
        ["vitest.config.ts", "files/vitest.svg"],
        ["eslint.config.mjs", "files/eslint.svg"],
        [".prettierrc.json", "files/prettier.svg"],
        ["tailwind.config.ts", "files/tailwind.svg"],
        ["postcss.config.cjs", "files/postcss.svg"],
        ["webpack.config.js", "files/webpack.svg"],
        ["Dockerfile.dev", "files/docker.svg"],
    ])("maps exact file %s to %s", (fileName, iconPath) => {
        const resolved = resolveSymbolsFileIcon(fileName);

        expect(resolved.iconPath).toBe(iconPath);
        expect(hasSymbolsIcon(resolved.iconPath)).toBe(true);
    });

    it.each([
        ["notes/draft.md", "files/markdown.svg"],
        ["docs/intro.mdx", "files/mdx.svg"],
        ["src/App.tsx", "files/react-ts.svg"],
        ["src/App.jsx", "files/react.svg"],
        ["src/index.ts", "files/ts.svg"],
        ["src/index.js", "files/js.svg"],
        ["styles/app.css", "files/brackets-purple.svg"],
        ["styles/app.scss", "files/sass.svg"],
        ["scripts/build.sh", "files/shell.svg"],
        ["src/main.py", "files/python.svg"],
        ["src/main.rs", "files/rust.svg"],
        ["src/main.go", "files/go.svg"],
        ["data/query.sql", "files/database.svg"],
        ["schema.proto", "files/proto.svg"],
        ["formula.tex", "files/tex.svg"],
        ["image.png", "files/image.svg"],
        ["diagram.svg", "files/svg.svg"],
        ["document.pdf", "files/pdf.svg"],
        ["table.csv", "files/csv.svg"],
        ["budget.xlsx", "files/csv.svg"],
        ["song.mp3", "files/audio.svg"],
        ["clip.mp4", "files/video.svg"],
    ])("maps extension %s to %s", (fileName, iconPath) => {
        const resolved = resolveSymbolsFileIcon(fileName);

        expect(resolved.iconPath).toBe(iconPath);
        expect(hasSymbolsIcon(resolved.iconPath)).toBe(true);
    });

    it("prefers the longest matching compound extension", () => {
        expect(
            resolveSymbolsFileIcon("component.test.tsx").iconPath,
        ).toBe("files/react-test.svg");
        expect(resolveSymbolsFileIcon("model.schema.json").iconPath).toBe(
            "files/brackets-yellow.svg",
        );
    });

    it("matches exact basenames case-insensitively", () => {
        expect(resolveSymbolsFileIcon("C:\\project\\PACKAGE.JSON").iconPath).toBe(
            "files/node.svg",
        );
    });

    it("forces internal notes and PDFs to their semantic icons", () => {
        expect(
            resolveSymbolsFileIcon("daily-note", { kind: "note" }).iconPath,
        ).toBe("files/markdown.svg");
        expect(
            resolveSymbolsFileIcon("document", { kind: "pdf" }).iconPath,
        ).toBe("files/pdf.svg");
    });

    it("uses MIME types when the filename has no useful extension", () => {
        expect(
            resolveSymbolsFileIcon("cover", {
                mimeType: "image/png; charset=binary",
            }).iconPath,
        ).toBe("files/image.svg");
        expect(
            resolveSymbolsFileIcon("archive", {
                mimeType: "application/zip",
            }).iconPath,
        ).toBe("files/compressed.svg");
    });

    it("falls back to the generic document icon", () => {
        expect(resolveSymbolsFileIcon("unknown.customthing").iconPath).toBe(
            "files/document.svg",
        );
    });
});
