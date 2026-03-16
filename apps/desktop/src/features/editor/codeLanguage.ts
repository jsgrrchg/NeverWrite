import type { Extension } from "@codemirror/state";

type LanguageKey =
    | "clojure"
    | "cmake"
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
    | "lua"
    | "makefile"
    | "pascal"
    | "perl"
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

export function resolveCodeLanguageKey(
    path: string,
    mimeType: string | null,
): LanguageKey | null {
    const extension = getPathExtension(path);
    const fileName = getPathFileName(path);

    switch (extension) {
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
        case "rust":
            return import("@codemirror/lang-rust").then(({ rust }) => rust());
        case "javascript":
            return import("@codemirror/lang-javascript").then(
                ({ javascript }) => javascript(),
            );
        case "javascript-jsx":
            return import("@codemirror/lang-javascript").then(
                ({ javascript }) => javascript({ jsx: true }),
            );
        case "typescript":
            return import("@codemirror/lang-javascript").then(
                ({ javascript }) => javascript({ typescript: true }),
            );
        case "typescript-jsx":
            return import("@codemirror/lang-javascript").then(
                ({ javascript }) => javascript({ typescript: true, jsx: true }),
            );
        case "json":
            return import("@codemirror/lang-json").then(({ json }) => json());
        case "python":
            return import("@codemirror/lang-python").then(({ python }) =>
                python(),
            );
        case "java":
            return import("@codemirror/lang-java").then(({ java }) => java());
        case "html":
            return import("@codemirror/lang-html").then(({ html }) => html());
        case "css":
            return import("@codemirror/lang-css").then(({ css }) => css());
        case "cmake":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/cmake"),
            ]).then(([{ StreamLanguage }, { cmake }]) =>
                StreamLanguage.define(cmake),
            );
        case "dockerfile":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/dockerfile"),
            ]).then(([{ StreamLanguage }, { dockerFile }]) =>
                StreamLanguage.define(dockerFile),
            );
        case "yaml":
            return import("@codemirror/lang-yaml").then(({ yaml }) => yaml());
        case "makefile":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/simple-mode"),
            ]).then(([{ StreamLanguage }, { simpleMode }]) =>
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
        case "powershell":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/powershell"),
            ]).then(([{ StreamLanguage }, { powerShell }]) =>
                StreamLanguage.define(powerShell),
            );
        case "properties":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/properties"),
            ]).then(([{ StreamLanguage }, { properties }]) =>
                StreamLanguage.define(properties),
            );
        case "protobuf":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/protobuf"),
            ]).then(([{ StreamLanguage }, { protobuf }]) =>
                StreamLanguage.define(protobuf),
            );
        case "swift":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/swift"),
            ]).then(([{ StreamLanguage }, { swift }]) =>
                StreamLanguage.define(swift),
            );
        case "shell":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/shell"),
            ]).then(([{ StreamLanguage }, { shell }]) =>
                StreamLanguage.define(shell),
            );
        case "toml":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/toml"),
            ]).then(([{ StreamLanguage }, { toml }]) =>
                StreamLanguage.define(toml),
            );
        case "go":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/go"),
            ]).then(([{ StreamLanguage }, { go }]) =>
                StreamLanguage.define(go),
            );
        case "ruby":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/ruby"),
            ]).then(([{ StreamLanguage }, { ruby }]) =>
                StreamLanguage.define(ruby),
            );
        case "r":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/r"),
            ]).then(([{ StreamLanguage }, { r }]) => StreamLanguage.define(r));
        case "clojure":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/clojure"),
            ]).then(([{ StreamLanguage }, { clojure }]) =>
                StreamLanguage.define(clojure),
            );
        case "haskell":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/haskell"),
            ]).then(([{ StreamLanguage }, { haskell }]) =>
                StreamLanguage.define(haskell),
            );
        case "erlang":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/erlang"),
            ]).then(([{ StreamLanguage }, { erlang }]) =>
                StreamLanguage.define(erlang),
            );
        case "perl":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/perl"),
            ]).then(([{ StreamLanguage }, { perl }]) =>
                StreamLanguage.define(perl),
            );
        case "d":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/d"),
            ]).then(([{ StreamLanguage }, { d }]) => StreamLanguage.define(d));
        case "lua":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/lua"),
            ]).then(([{ StreamLanguage }, { lua }]) =>
                StreamLanguage.define(lua),
            );
        case "julia":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/julia"),
            ]).then(([{ StreamLanguage }, { julia }]) =>
                StreamLanguage.define(julia),
            );
        case "groovy":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/groovy"),
            ]).then(([{ StreamLanguage }, { groovy }]) =>
                StreamLanguage.define(groovy),
            );
        case "sql":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/sql"),
            ]).then(([{ StreamLanguage }, m]) =>
                StreamLanguage.define(m.standardSQL),
            );
        case "diff":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/diff"),
            ]).then(([{ StreamLanguage }, { diff }]) =>
                StreamLanguage.define(diff),
            );
        case "sass":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/sass"),
            ]).then(([{ StreamLanguage }, { sass }]) =>
                StreamLanguage.define(sass),
            );
        case "stylus":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/stylus"),
            ]).then(([{ StreamLanguage }, { stylus }]) =>
                StreamLanguage.define(stylus),
            );
        case "stex":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/stex"),
            ]).then(([{ StreamLanguage }, { stex }]) =>
                StreamLanguage.define(stex),
            );
        case "tcl":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/tcl"),
            ]).then(([{ StreamLanguage }, { tcl }]) =>
                StreamLanguage.define(tcl),
            );
        case "vb":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/vb"),
            ]).then(([{ StreamLanguage }, { vb }]) =>
                StreamLanguage.define(vb),
            );
        case "wast":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/wast"),
            ]).then(([{ StreamLanguage }, { wast }]) =>
                StreamLanguage.define(wast),
            );
        case "xml":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/xml"),
            ]).then(([{ StreamLanguage }, { xml }]) =>
                StreamLanguage.define(xml),
            );
        case "pascal":
            return Promise.all([
                import("@codemirror/language"),
                import("@codemirror/legacy-modes/mode/pascal"),
            ]).then(([{ StreamLanguage }, { pascal }]) =>
                StreamLanguage.define(pascal),
            );
        default:
            return Promise.resolve(null);
    }
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
