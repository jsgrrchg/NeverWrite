import symbolsManifestJson from "../../assets/file-icons/file-icons.json";
import {
    resolveCodeLanguageKey,
    type LanguageKey,
} from "../../features/editor/codeLanguage";
import {
    hasSymbolsIcon,
    type SymbolsIconPath,
} from "./symbols-icons";

export type FileTypeIconKind = "file" | "note" | "pdf";

export interface ResolvedFileTypeIcon {
    readonly iconPath: SymbolsIconPath;
}

export interface ResolveFileTypeIconOptions {
    readonly kind?: FileTypeIconKind;
    readonly mimeType?: string | null;
}

interface SymbolsManifest {
    readonly file?: string;
    readonly fileExtensions?: Readonly<Record<string, string>>;
    readonly fileNames?: Readonly<Record<string, string>>;
    readonly iconDefinitions: Readonly<
        Record<string, { readonly iconPath: string }>
    >;
    readonly languageIds?: Readonly<Record<string, string>>;
}

const manifest = symbolsManifestJson as SymbolsManifest;

function lowercaseKeys(
    values: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
    return new Map(
        Object.entries(values ?? {}).map(([key, value]) => [
            key.toLowerCase(),
            value,
        ]),
    );
}

const fileNames = lowercaseKeys(manifest.fileNames);
const fileExtensions = lowercaseKeys(manifest.fileExtensions);
const languageIds = lowercaseKeys(manifest.languageIds);

function definitionIconPath(definitionName: string): SymbolsIconPath | null {
    // The upstream manifest references these aliases without defining them.
    const resolvedDefinitionName =
        definitionName === "less"
            ? "brackets-sky"
            : definitionName === "yml"
              ? "yaml"
              : definitionName;
    const manifestPath = manifest.iconDefinitions[
        resolvedDefinitionName
    ]?.iconPath.replace(/^\.\/icons\//, "");

    return manifestPath && hasSymbolsIcon(manifestPath) ? manifestPath : null;
}

function genericFileIconPath(): SymbolsIconPath {
    return definitionIconPath(manifest.file ?? "document") ?? "files/document.svg";
}

function basename(fileName: string): string {
    const normalizedPath = fileName.replaceAll("\\", "/");
    return normalizedPath.split("/").at(-1) ?? fileName;
}

function compoundExtensions(fileName: string): string[] {
    const extensions: string[] = [];
    for (let index = fileName.indexOf("."); index !== -1; ) {
        const extension = fileName.slice(index + 1);
        if (extension) extensions.push(extension);
        index = fileName.indexOf(".", index + 1);
    }
    return extensions;
}

const LANGUAGE_TO_VSCODE_ID: Readonly<Partial<Record<LanguageKey, string>>> = {
    c: "c",
    clojure: "clojure",
    cmake: "cmake",
    cpp: "cpp",
    css: "css",
    dockerfile: "dockerfile",
    erlang: "erlang",
    go: "go",
    haskell: "haskell",
    html: "html",
    java: "java",
    javascript: "javascript",
    "javascript-jsx": "javascriptreact",
    json: "json",
    julia: "julia",
    lua: "lua",
    makefile: "makefile",
    perl: "perl",
    php: "php",
    powershell: "powershell",
    properties: "properties",
    protobuf: "protobuf",
    python: "python",
    r: "r",
    ruby: "ruby",
    rust: "rust",
    sass: "sass",
    shell: "shellscript",
    sql: "sql",
    "sql-mssql": "sql",
    "sql-mysql": "sql",
    "sql-postgresql": "sql",
    "sql-sqlite": "sql",
    stex: "latex",
    stylus: "styl",
    swift: "swift",
    toml: "properties",
    typescript: "typescript",
    "typescript-jsx": "typescriptreact",
    vb: "vb",
    xml: "xml",
    yaml: "yaml",
};

function languageIconPath(
    fileName: string,
    mimeType: string | null | undefined,
): SymbolsIconPath | null {
    const languageKey = resolveCodeLanguageKey(fileName, mimeType ?? null);
    const languageId = languageKey
        ? LANGUAGE_TO_VSCODE_ID[languageKey]
        : undefined;
    const definitionName = languageId ? languageIds.get(languageId) : undefined;
    return definitionName ? definitionIconPath(definitionName) : null;
}

function mimeIconPath(
    mimeType: string | null | undefined,
): SymbolsIconPath | null {
    const normalizedMimeType = mimeType
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
    if (!normalizedMimeType) return null;

    let definitionName: string | null = null;
    if (normalizedMimeType.startsWith("image/")) definitionName = "image";
    else if (normalizedMimeType.startsWith("audio/")) definitionName = "audio";
    else if (normalizedMimeType.startsWith("video/")) definitionName = "video";
    else if (
        normalizedMimeType === "application/json" ||
        normalizedMimeType === "application/ld+json"
    )
        definitionName = "brackets-yellow";
    else if (normalizedMimeType === "application/pdf") definitionName = "pdf";
    else if (
        normalizedMimeType === "application/zip" ||
        normalizedMimeType === "application/gzip" ||
        normalizedMimeType === "application/x-tar"
    )
        definitionName = "compressed";
    else if (normalizedMimeType === "text/markdown") definitionName = "markdown";
    else if (normalizedMimeType === "text/css") definitionName = "brackets-sky";
    else if (normalizedMimeType === "text/html") definitionName = "brackets-orange";

    return definitionName ? definitionIconPath(definitionName) : null;
}

export function resolveSymbolsFileIcon(
    fileName: string,
    options: ResolveFileTypeIconOptions = {},
): ResolvedFileTypeIcon {
    if (options.kind === "note") {
        return {
            iconPath:
                definitionIconPath("markdown") ?? "files/markdown.svg",
        };
    }
    if (options.kind === "pdf") {
        return { iconPath: definitionIconPath("pdf") ?? "files/pdf.svg" };
    }

    const baseFileName = basename(fileName).toLowerCase();
    const exactDefinition = fileNames.get(baseFileName);
    const exactIconPath = exactDefinition
        ? definitionIconPath(exactDefinition)
        : null;
    if (exactIconPath) return { iconPath: exactIconPath };

    for (const extension of compoundExtensions(baseFileName)) {
        const extensionDefinition = fileExtensions.get(extension);
        const extensionIconPath = extensionDefinition
            ? definitionIconPath(extensionDefinition)
            : null;
        if (extensionIconPath) return { iconPath: extensionIconPath };
    }

    return {
        iconPath:
            languageIconPath(fileName, options.mimeType) ??
            mimeIconPath(options.mimeType) ??
            genericFileIconPath(),
    };
}

export const resolveFileTypeIcon = resolveSymbolsFileIcon;
