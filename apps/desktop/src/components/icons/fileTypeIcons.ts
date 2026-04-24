import {
    resolveCodeLanguageKey,
    type LanguageKey,
} from "../../features/editor/codeLanguage";
import {
    resolveAvailableCatppuccinIcon,
    resolveFirstAvailableCatppuccinIcon,
    type CatppuccinIconName,
} from "./catppuccin-icons";

export type FileTypeIconKind = "file" | "note" | "pdf";

export interface ResolvedFileTypeIcon {
    readonly iconName: CatppuccinIconName;
}

export interface ResolveFileTypeIconOptions {
    readonly kind?: FileTypeIconKind;
    readonly mimeType?: string | null;
}

type IconCandidates = CatppuccinIconName | readonly CatppuccinIconName[];

const SPECIAL_FILENAMES = new Map<string, IconCandidates>([
    ["package.json", "package-json"],
    ["package-lock.json", "npm-lock"],
    ["npm-shrinkwrap.json", "npm-lock"],
    ["pnpm-lock.yaml", "pnpm-lock"],
    ["pnpm-lock.yml", "pnpm-lock"],
    ["yarn.lock", "yarn-lock"],
    ["bun.lock", "bun-lock"],
    ["bun.lockb", "bun-lock"],
    ["cargo.lock", "cargo-lock"],
    ["cargo.toml", "cargo"],
    ["poetry.lock", "poetry-lock"],
    ["uv.lock", "uv"],
    ["pipfile.lock", "lock"],
    ["composer.lock", "lock"],
    ["deno.lock", "deno-lock"],
    ["flake.lock", "nix-lock"],
    ["gemfile", "ruby-gem"],
    ["gemfile.lock", "ruby-gem-lock"],
    ["pubspec.lock", "lock"],
    [".dockerignore", "docker-ignore"],
    ["docker-compose.yml", "docker-compose"],
    ["docker-compose.yaml", "docker-compose"],
    [".editorconfig", "editorconfig"],
    [".eslintignore", "eslint-ignore"],
    [".gitattributes", "git"],
    [".gitignore", "git"],
    [".gitmodules", "git"],
    [".npmignore", "npm-ignore"],
    [".npmrc", "npm"],
    [".prettierignore", "prettier-ignore"],
    [".yarnrc", "yarn"],
    [".yarnrc.yml", "yarn"],
    ["git-cliff.toml", "git-cliff"],
    ["jsconfig.json", "javascript-config"],
    ["pyproject.toml", "python-config"],
]);

const IMAGE_EXTENSIONS = new Set([
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp",
]);

const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mov", "mp4", "mpeg", "webm"]);

const LANGUAGE_TO_ICON: Record<LanguageKey, IconCandidates> = {
    c: "c",
    clojure: "clojure",
    cmake: "cmake",
    cpp: "cpp",
    css: "css",
    d: "d",
    diff: "diff",
    dockerfile: "docker",
    erlang: "erlang",
    go: "go",
    groovy: "groovy",
    haskell: "haskell",
    html: "html",
    java: "java",
    javascript: "javascript",
    "javascript-jsx": "javascript-react",
    json: "json",
    julia: "julia",
    lockfile: "lock",
    lua: "lua",
    makefile: "makefile",
    pascal: "file",
    perl: "perl",
    php: "php",
    powershell: "powershell",
    properties: "config",
    protobuf: "proto",
    python: "python",
    r: "r",
    ruby: "ruby",
    rust: "rust",
    sass: "sass",
    shell: "bash",
    sql: "database",
    "sql-mssql": "database",
    "sql-mysql": "database",
    "sql-postgresql": "database",
    "sql-sqlite": "database",
    stex: ["tex", "latex"],
    stylus: ["stylus", "css"],
    swift: "swift",
    tcl: ["tcl", "bash"],
    toml: "toml",
    typescript: "typescript",
    "typescript-jsx": "typescript-react",
    vb: ["visual-studio", "csharp"],
    wast: ["wasm", "web-assembly"],
    xml: "xml",
    yaml: "yaml",
};

const EXTENSION_TO_ICON: Record<string, IconCandidates> = {
    "7z": "zip",
    astro: "astro",
    csv: "csv",
    dockerignore: "docker-ignore",
    doc: "file",
    docx: "file",
    ex: "elixir",
    exs: "elixir",
    env: "env",
    excalidraw: ["excalidraw", "drawio", "image"],
    kt: "kotlin",
    kts: "kotlin",
    less: "less",
    lock: "lock",
    md: "markdown",
    mdx: "markdown-mdx",
    pdf: "pdf",
    prisma: "prisma",
    ppt: "file",
    pptx: "file",
    rar: "zip",
    sass: "sass",
    scala: "scala",
    scss: "sass",
    svelte: "svelte",
    vue: "vue",
    xls: "ms-excel",
    xlsx: "ms-excel",
    zig: "zig",
    zip: "zip",
};

function resolveCandidates(candidates: IconCandidates): CatppuccinIconName {
    if (typeof candidates === "string") {
        return resolveAvailableCatppuccinIcon(candidates);
    }

    return resolveFirstAvailableCatppuccinIcon(candidates);
}

function getBaseFileName(fileName: string): string {
    const normalizedPath = fileName.replaceAll("\\", "/");
    return normalizedPath.split("/").at(-1) ?? fileName;
}

function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0 || dot === fileName.length - 1) return "";
    return fileName.slice(dot + 1).toLowerCase();
}

function getPatternIcon(fileName: string): IconCandidates | null {
    if (fileName === ".envrc") {
        return ["envrc", "env"];
    }

    if (fileName === ".env" || fileName.startsWith(".env.")) {
        return "env";
    }

    if (fileName.startsWith("tsconfig") && fileName.endsWith(".json")) {
        return "typescript-config";
    }

    if (fileName.startsWith("astro.config.")) {
        return "astro-config";
    }

    if (fileName.startsWith("vite.config.")) {
        return "vite";
    }

    if (fileName.startsWith("vitest.config.")) {
        return "vitest";
    }

    if (fileName.startsWith("eslint.config.")) {
        return "eslint";
    }

    if (
        fileName.startsWith("prettier.config.") ||
        fileName.startsWith(".prettierrc")
    ) {
        return "prettier";
    }

    if (fileName.startsWith("tailwind.config.")) {
        return "tailwind";
    }

    if (fileName.startsWith("postcss.config.")) {
        return "postcss";
    }

    if (fileName.startsWith("webpack.config.")) {
        return "webpack";
    }

    if (fileName.startsWith("rollup.config.")) {
        return "rollup";
    }

    if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) {
        return "docker";
    }

    return null;
}

function getMimeTypeIcon(
    mimeType: string | null | undefined,
): IconCandidates | null {
    if (!mimeType) return null;

    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType === "application/pdf") return "pdf";

    return null;
}

export function resolveCatppuccinFileIcon(
    fileName: string,
    options: ResolveFileTypeIconOptions = {},
): ResolvedFileTypeIcon {
    if (options.kind === "note") {
        return { iconName: "markdown" };
    }

    if (options.kind === "pdf") {
        return { iconName: "pdf" };
    }

    const baseFileName = getBaseFileName(fileName).toLowerCase();
    const specialIcon = SPECIAL_FILENAMES.get(baseFileName);

    if (specialIcon) {
        return { iconName: resolveCandidates(specialIcon) };
    }

    const patternIcon = getPatternIcon(baseFileName);
    if (patternIcon) {
        return { iconName: resolveCandidates(patternIcon) };
    }

    const extension = getExtension(baseFileName);
    if (IMAGE_EXTENSIONS.has(extension)) {
        return { iconName: "image" };
    }
    if (AUDIO_EXTENSIONS.has(extension)) {
        return { iconName: "audio" };
    }
    if (VIDEO_EXTENSIONS.has(extension)) {
        return { iconName: "video" };
    }

    const extensionIcon = EXTENSION_TO_ICON[extension];
    if (extensionIcon) {
        return { iconName: resolveCandidates(extensionIcon) };
    }

    const mimeTypeIcon = getMimeTypeIcon(options.mimeType);
    if (mimeTypeIcon) {
        return { iconName: resolveCandidates(mimeTypeIcon) };
    }

    const languageKey = resolveCodeLanguageKey(
        fileName,
        options.mimeType ?? null,
    );
    const languageIcon = languageKey ? LANGUAGE_TO_ICON[languageKey] : null;

    if (languageIcon) {
        return { iconName: resolveCandidates(languageIcon) };
    }

    return { iconName: "file" };
}

export const resolveFileTypeIcon = resolveCatppuccinFileIcon;
