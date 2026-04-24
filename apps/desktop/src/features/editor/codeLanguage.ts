import type { Extension } from "@codemirror/state";
import {
    Language,
    LanguageDescription,
    LanguageSupport,
    StreamLanguage,
} from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";

export type LanguageKey =
    | "c"
    | "clojure"
    | "cmake"
    | "cpp"
    | "css"
    | "d"
    | "diff"
    | "dockerfile"
    | "erlang"
    | "go"
    | "groovy"
    | "haskell"
    | "html"
    | "java"
    | "javascript"
    | "javascript-jsx"
    | "json"
    | "julia"
    | "lockfile"
    | "lua"
    | "makefile"
    | "pascal"
    | "perl"
    | "php"
    | "powershell"
    | "properties"
    | "protobuf"
    | "python"
    | "r"
    | "ruby"
    | "rust"
    | "sass"
    | "shell"
    | "sql"
    | "sql-mssql"
    | "sql-mysql"
    | "sql-postgresql"
    | "sql-sqlite"
    | "stex"
    | "stylus"
    | "swift"
    | "tcl"
    | "toml"
    | "typescript"
    | "typescript-jsx"
    | "vb"
    | "wast"
    | "xml"
    | "yaml";

const languageCache = new Map<LanguageKey, Promise<Extension | null>>();

const markdownFenceAliases: Record<LanguageKey, readonly string[]> = {
    c: ["c"],
    clojure: ["clojure", "clj", "cljs"],
    cmake: ["cmake"],
    cpp: ["cpp", "c++", "cc", "cxx", "h", "hpp"],
    css: ["css", "scss", "less"],
    d: ["d"],
    diff: ["diff", "patch"],
    dockerfile: ["dockerfile", "docker"],
    erlang: ["erlang", "erl", "elixir", "ex", "exs"],
    go: ["go", "golang"],
    groovy: ["groovy"],
    haskell: ["haskell", "hs"],
    html: ["html"],
    java: ["java", "kotlin", "kt", "kts", "scala"],
    javascript: ["javascript", "js", "node", "nodejs", "mjs", "cjs"],
    "javascript-jsx": ["jsx"],
    json: ["json", "jsonc"],
    julia: ["julia", "jl"],
    lockfile: ["lock", "lockfile"],
    lua: ["lua"],
    makefile: ["make", "makefile", "mk"],
    pascal: ["pascal", "delphi"],
    perl: ["perl", "pl"],
    php: ["php", "php3", "php4", "php5", "phtml"],
    powershell: ["powershell", "ps1", "ps", "pwsh"],
    properties: ["properties", "ini", "cfg", "conf", "dotenv", "env"],
    protobuf: ["protobuf", "proto"],
    python: ["python", "py"],
    r: ["r"],
    ruby: ["ruby", "rb"],
    rust: ["rust", "rs"],
    sass: ["sass"],
    shell: ["shell", "sh", "bash", "zsh", "fish", "shellscript"],
    sql: ["sql"],
    "sql-mssql": ["mssql", "tsql"],
    "sql-mysql": ["mysql", "mariadb"],
    "sql-postgresql": ["postgres", "postgresql", "psql"],
    "sql-sqlite": ["sqlite", "sqlite3"],
    stex: ["tex", "latex"],
    stylus: ["stylus", "styl"],
    swift: ["swift"],
    tcl: ["tcl"],
    toml: ["toml"],
    typescript: ["typescript", "ts"],
    "typescript-jsx": ["tsx"],
    vb: ["vb", "vbnet", "csharp", "c#", "cs"],
    wast: ["wast", "wat", "wasm"],
    xml: ["xml", "svg", "xhtml"],
    yaml: ["yaml", "yml"],
};

const markdownFenceAliasToKey = new Map<string, LanguageKey>();
const markdownLanguageDescriptions = new Map<
    LanguageKey,
    LanguageDescription
>();

for (const key of Object.keys(markdownFenceAliases) as LanguageKey[]) {
    for (const alias of markdownFenceAliases[key]) {
        markdownFenceAliasToKey.set(alias.toLowerCase(), key);
    }
}

function getPathExtension(path: string) {
    const fileName = path.split("/").pop() ?? path;
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex < 0 || dotIndex === fileName.length - 1) {
        return "";
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

function getPathFileName(path: string) {
    return (path.split("/").pop() ?? path).toLowerCase();
}

function resolveLockfileLanguageKey(
    fileName: string,
    extension: string,
): LanguageKey | null {
    switch (fileName) {
        case "cargo.lock":
        case "poetry.lock":
        case "uv.lock":
            return "toml";
        case "pipfile.lock":
        case "composer.lock":
        case "deno.lock":
        case "flake.lock":
            return "json";
        case "pubspec.lock":
            return "yaml";
        case "gemfile.lock":
        case "yarn.lock":
            return "lockfile";
        default:
            return extension === "lock" ? "lockfile" : null;
    }
}

export function resolveCodeLanguageKey(
    path: string,
    mimeType: string | null,
): LanguageKey | null {
    const extension = getPathExtension(path);
    const fileName = getPathFileName(path);
    const lockfileLanguageKey = resolveLockfileLanguageKey(
        fileName,
        extension,
    );

    if (lockfileLanguageKey) {
        return lockfileLanguageKey;
    }

    switch (extension) {
        case "c":
            return "c";
        case "cc":
        case "cpp":
        case "cxx":
        case "h":
        case "hpp":
            return "cpp";
        case "rs":
            return "rust";
        case "js":
        case "cjs":
        case "mjs":
            return "javascript";
        case "jsx":
        case "astro":
        case "svelte":
        case "vue":
        case "mdx":
            return "javascript-jsx";
        case "ts":
        case "cts":
        case "mts":
            return "typescript";
        case "tsx":
            return "typescript-jsx";
        case "proto":
            return "protobuf";
        case "json":
        case "jsonc":
            return "json";
        case "py":
            return "python";
        case "ps1":
            return "powershell";
        case "java":
        case "kt":
        case "kts":
        case "scala":
        case "groovy":
            return "java";
        case "html":
            return "html";
        case "css":
        case "scss":
        case "less":
            return "css";
        case "cmake":
            return "cmake";
        case "yaml":
        case "yml":
        case "prisma":
            return "yaml";
        case "swift":
            return "swift";
        case "sh":
        case "bash":
        case "zsh":
        case "fish":
            return "shell";
        case "toml":
            return "toml";
        case "properties":
        case "ini":
        case "cfg":
        case "rc":
        case "conf":
        case "plist":
            return "properties";
        case "mk":
            return "makefile";
        case "go":
            return "go";
        case "rb":
            return "ruby";
        case "r":
            return "r";
        case "clj":
        case "cljs":
            return "clojure";
        case "hs":
            return "haskell";
        case "erl":
        case "ex":
        case "exs":
            return "erlang";
        case "pl":
            return "perl";
        case "php":
        case "php3":
        case "php4":
        case "php5":
        case "phtml":
            return "php";
        case "d":
            return "d";
        case "lua":
            return "lua";
        case "jl":
            return "julia";
        case "elm":
            return "haskell";
        case "nim":
        case "zig":
        case "v":
        case "dart":
            return "go";
        case "sql":
            return "sql";
        case "diff":
        case "patch":
            return "diff";
        case "sass":
            return "sass";
        case "styl":
            return "stylus";
        case "tex":
            return "stex";
        case "tcl":
            return "tcl";
        case "vb":
        case "cs":
            return "vb";
        case "wast":
            return "wast";
        case "xml":
        case "nix":
            return "xml";
        default:
            break;
    }

    switch (fileName) {
        case "containerfile":
        case "dockerfile":
            return "dockerfile";
        case "cmakelists.txt":
            return "cmake";
        case "gnumakefile":
        case "makefile":
            return "makefile";
        case ".editorconfig":
        case ".gitconfig":
        case ".gitmodules":
        case ".npmrc":
        case ".prettierrc":
        case ".yarnrc":
            return "properties";
        case ".bash_profile":
        case ".bashrc":
        case ".profile":
        case ".zprofile":
        case ".zshrc":
            return "shell";
        default:
            if (fileName === ".env" || fileName.startsWith(".env.")) {
                return "properties";
            }
            break;
    }

    switch (mimeType) {
        case "application/json":
        case "text/json":
            return "json";
        case "application/toml":
            return "toml";
        case "text/x-properties":
            return "properties";
        case "application/yaml":
        case "text/yaml":
            return "yaml";
        case "application/sql":
        case "text/x-sql":
            return "sql";
        case "application/x-httpd-php":
        case "text/x-php":
            return "php";
        case "text/x-c":
        case "text/x-csrc":
            return "c";
        case "text/x-c++":
        case "text/x-c++src":
        case "text/x-c++hdr":
            return "cpp";
        case "text/x-python":
            return "python";
        case "text/x-java":
            return "java";
        case "text/html":
            return "html";
        case "text/css":
            return "css";
        case "application/x-sh":
        case "text/x-shellscript":
            return "shell";
        default:
            return null;
    }
}

function loadLanguageByKey(key: LanguageKey): Promise<Extension | null> {
    switch (key) {
        case "c":
        case "cpp":
            return import("@codemirror/lang-cpp").then(({ cpp }) => cpp());
        case "rust":
            return import("@codemirror/lang-rust").then(({ rust }) => rust());
        case "javascript":
            return Promise.resolve(javascript());
        case "javascript-jsx":
            return Promise.resolve(javascript({ jsx: true }));
        case "typescript":
            return Promise.resolve(javascript({ typescript: true }));
        case "typescript-jsx":
            return Promise.resolve(javascript({ typescript: true, jsx: true }));
        case "json":
            return import("@codemirror/lang-json").then(({ json }) => json());
        case "python":
            return import("@codemirror/lang-python").then(({ python }) =>
                python(),
            );
        case "java":
            return import("@codemirror/lang-java").then(({ java }) => java());
        case "html":
            return Promise.resolve(html());
        case "css":
            return Promise.resolve(css());
        case "cmake":
            return import("@codemirror/legacy-modes/mode/cmake").then(
                ({ cmake }) => StreamLanguage.define(cmake),
            );
        case "dockerfile":
            return import("@codemirror/legacy-modes/mode/dockerfile").then(
                ({ dockerFile }) => StreamLanguage.define(dockerFile),
            );
        case "yaml":
            return import("@codemirror/lang-yaml").then(({ yaml }) => yaml());
        case "makefile":
            return import("@codemirror/legacy-modes/mode/simple-mode").then(
                ({ simpleMode }) =>
                    StreamLanguage.define(
                        simpleMode({
                            start: [
                                { regex: /#.*/, token: "comment" },
                                { regex: /^\t.*/, token: "meta" },
                                {
                                    regex: /^\s*(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|export|unexport|override|private|define|endef|undefine|vpath)\b/,
                                    token: "keyword",
                                },
                                {
                                    regex: /^\s*[A-Za-z0-9_.-]+\s*(?::=|\?=|\+=|!=|=)/,
                                    token: "def",
                                },
                                {
                                    regex: /^\s*[^\s:#=]+(?=\s*:)/,
                                    token: "definition",
                                },
                                {
                                    regex: /\$\((?:[^()\\]|\\.)+\)|\$\{(?:[^{}\\]|\\.)+\}/,
                                    token: "variableName",
                                },
                                {
                                    regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
                                    token: "string",
                                },
                                { regex: /[:=]/, token: "operator" },
                            ],
                        }),
                    ),
            );
        case "lockfile":
            return import("@codemirror/legacy-modes/mode/simple-mode").then(
                ({ simpleMode }) =>
                    StreamLanguage.define(
                        simpleMode({
                            start: [
                                { regex: /#.*/, token: "comment" },
                                {
                                    regex: /^\s{2,}[A-Za-z0-9_.@/+~-]+(?=:)/,
                                    token: "propertyName",
                                },
                                {
                                    regex: /^[A-Za-z0-9_.@/+~-]+(?=\s|:|$)/,
                                    token: "definition",
                                },
                                {
                                    regex: /\b(?:version|resolved|integrity|checksum|dependencies|specs|platforms|bundled|remote|revision|branch|ref)\b(?=:)/,
                                    token: "keyword",
                                },
                                {
                                    regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
                                    token: "string",
                                },
                                {
                                    regex: /\b(?:[0-9]+(?:\.[0-9A-Za-z-]+)+|[a-f0-9]{32,})\b/,
                                    token: "number",
                                },
                                {
                                    regex: /[:=,()[\]{}]/,
                                    token: "operator",
                                },
                            ],
                        }),
                    ),
            );
        case "powershell":
            return import("@codemirror/legacy-modes/mode/powershell").then(
                ({ powerShell }) => StreamLanguage.define(powerShell),
            );
        case "properties":
            return import("@codemirror/legacy-modes/mode/properties").then(
                ({ properties }) => StreamLanguage.define(properties),
            );
        case "protobuf":
            return import("@codemirror/legacy-modes/mode/protobuf").then(
                ({ protobuf }) => StreamLanguage.define(protobuf),
            );
        case "swift":
            return import("@codemirror/legacy-modes/mode/swift").then(
                ({ swift }) => StreamLanguage.define(swift),
            );
        case "shell":
            return import("@codemirror/legacy-modes/mode/shell").then(
                ({ shell }) => StreamLanguage.define(shell),
            );
        case "toml":
            return import("@codemirror/legacy-modes/mode/toml").then(
                ({ toml }) => StreamLanguage.define(toml),
            );
        case "go":
            return import("@codemirror/legacy-modes/mode/go").then(({ go }) =>
                StreamLanguage.define(go),
            );
        case "ruby":
            return import("@codemirror/legacy-modes/mode/ruby").then(
                ({ ruby }) => StreamLanguage.define(ruby),
            );
        case "r":
            return import("@codemirror/legacy-modes/mode/r").then(({ r }) =>
                StreamLanguage.define(r),
            );
        case "clojure":
            return import("@codemirror/legacy-modes/mode/clojure").then(
                ({ clojure }) => StreamLanguage.define(clojure),
            );
        case "haskell":
            return import("@codemirror/legacy-modes/mode/haskell").then(
                ({ haskell }) => StreamLanguage.define(haskell),
            );
        case "erlang":
            return import("@codemirror/legacy-modes/mode/erlang").then(
                ({ erlang }) => StreamLanguage.define(erlang),
            );
        case "perl":
            return import("@codemirror/legacy-modes/mode/perl").then(
                ({ perl }) => StreamLanguage.define(perl),
            );
        case "php":
            return import("@codemirror/lang-php").then(({ php }) => php());
        case "d":
            return import("@codemirror/legacy-modes/mode/d").then(({ d }) =>
                StreamLanguage.define(d),
            );
        case "lua":
            return import("@codemirror/legacy-modes/mode/lua").then(({ lua }) =>
                StreamLanguage.define(lua),
            );
        case "julia":
            return import("@codemirror/legacy-modes/mode/julia").then(
                ({ julia }) => StreamLanguage.define(julia),
            );
        case "groovy":
            return import("@codemirror/legacy-modes/mode/groovy").then(
                ({ groovy }) => StreamLanguage.define(groovy),
            );
        case "sql":
            return import("@codemirror/lang-sql").then(({ sql }) => sql());
        case "sql-mssql":
            return import("@codemirror/lang-sql").then(({ MSSQL, sql }) =>
                sql({ dialect: MSSQL }),
            );
        case "sql-mysql":
            return import("@codemirror/lang-sql").then(({ MySQL, sql }) =>
                sql({ dialect: MySQL }),
            );
        case "sql-postgresql":
            return import("@codemirror/lang-sql").then(({ PostgreSQL, sql }) =>
                sql({ dialect: PostgreSQL }),
            );
        case "sql-sqlite":
            return import("@codemirror/lang-sql").then(({ SQLite, sql }) =>
                sql({ dialect: SQLite }),
            );
        case "diff":
            return import("@codemirror/legacy-modes/mode/diff").then(
                ({ diff }) => StreamLanguage.define(diff),
            );
        case "sass":
            return import("@codemirror/legacy-modes/mode/sass").then(
                ({ sass }) => StreamLanguage.define(sass),
            );
        case "stylus":
            return import("@codemirror/legacy-modes/mode/stylus").then(
                ({ stylus }) => StreamLanguage.define(stylus),
            );
        case "stex":
            return import("@codemirror/legacy-modes/mode/stex").then(
                ({ stex }) => StreamLanguage.define(stex),
            );
        case "tcl":
            return import("@codemirror/legacy-modes/mode/tcl").then(({ tcl }) =>
                StreamLanguage.define(tcl),
            );
        case "vb":
            return import("@codemirror/legacy-modes/mode/vb").then(({ vb }) =>
                StreamLanguage.define(vb),
            );
        case "wast":
            return import("@codemirror/legacy-modes/mode/wast").then(
                ({ wast }) => StreamLanguage.define(wast),
            );
        case "xml":
            return import("@codemirror/legacy-modes/mode/xml").then(({ xml }) =>
                StreamLanguage.define(xml),
            );
        case "pascal":
            return import("@codemirror/legacy-modes/mode/pascal").then(
                ({ pascal }) => StreamLanguage.define(pascal),
            );
        default:
            return Promise.resolve(null);
    }
}

export async function loadLanguageSupportByKey(
    key: LanguageKey,
): Promise<LanguageSupport | null> {
    const extension = await loadLanguageByKey(key);
    if (extension instanceof LanguageSupport) {
        return extension;
    }
    if (extension instanceof Language) {
        return new LanguageSupport(extension);
    }
    return null;
}

export function extractFenceLanguageToken(info: string): string | null {
    const trimmed = info.trim().toLowerCase();
    if (!trimmed) return null;

    const braceLanguageMatch = trimmed.match(
        /(?:^|[\s{])(?:language-|\.)?([a-z0-9+#_-]+)(?=[\s},]|$)/,
    );
    const rawToken = braceLanguageMatch?.[1] ?? trimmed.split(/\s+/, 1)[0];
    if (!rawToken) return null;

    const normalized = rawToken
        .replace(/^[{[(<.'"]+/, "")
        .replace(/[>\])}',";:]+$/, "")
        .replace(/^language-/, "")
        .replace(/^\./, "");

    return normalized || null;
}

export function resolveMarkdownCodeLanguageKey(
    info: string,
): LanguageKey | null {
    const token = extractFenceLanguageToken(info);
    if (!token) return null;
    return markdownFenceAliasToKey.get(token) ?? null;
}

export async function loadMarkdownCodeLanguageSupport(
    info: string,
): Promise<LanguageSupport | null> {
    const key = resolveMarkdownCodeLanguageKey(info);
    if (!key) {
        return null;
    }
    return loadLanguageSupportByKey(key);
}

export function resolveMarkdownCodeLanguage(
    info: string,
): LanguageDescription | null {
    const key = resolveMarkdownCodeLanguageKey(info);
    if (!key) return null;

    const cached = markdownLanguageDescriptions.get(key);
    if (cached) {
        return cached;
    }

    const description = LanguageDescription.of({
        name: key,
        alias: markdownFenceAliases[key],
        load: async () => {
            const support = await loadLanguageSupportByKey(key);
            if (!support) {
                throw new Error(
                    `Language support '${key}' is unavailable for Markdown fenced code`,
                );
            }
            return support;
        },
    });
    markdownLanguageDescriptions.set(key, description);
    return description;
}

export function loadCodeLanguage(
    path: string,
    mimeType: string | null,
): Promise<Extension | null> {
    const key = resolveCodeLanguageKey(path, mimeType);
    if (!key) {
        return Promise.resolve(null);
    }

    const cached = languageCache.get(key);
    if (cached) {
        return cached;
    }

    const loader = loadLanguageByKey(key).catch((error) => {
        languageCache.delete(key);
        console.error(`Error loading CodeMirror language '${key}':`, error);
        return null;
    });
    languageCache.set(key, loader);
    return loader;
}

export async function loadCodeLanguageSupport(
    path: string,
    mimeType: string | null,
): Promise<LanguageSupport | null> {
    const key = resolveCodeLanguageKey(path, mimeType);
    if (!key) {
        return null;
    }
    return loadLanguageSupportByKey(key);
}
