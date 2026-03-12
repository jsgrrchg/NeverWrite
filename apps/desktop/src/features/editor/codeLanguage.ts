import type { Extension } from "@codemirror/state";

type LanguageKey =
    | "css"
    | "html"
    | "java"
    | "javascript"
    | "javascript-jsx"
    | "json"
    | "python"
    | "rust"
    | "shell"
    | "swift"
    | "toml"
    | "typescript"
    | "typescript-jsx"
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
            return "javascript-jsx";
        case "ts":
        case "cts":
        case "mts":
            return "typescript";
        case "tsx":
            return "typescript-jsx";
        case "json":
            return "json";
        case "py":
            return "python";
        case "java":
            return "java";
        case "html":
            return "html";
        case "css":
            return "css";
        case "yaml":
        case "yml":
            return "yaml";
        case "swift":
            return "swift";
        case "sh":
        case "bash":
        case "zsh":
            return "shell";
        case "toml":
            return "toml";
        default:
            break;
    }

    switch (fileName) {
        case ".bash_profile":
        case ".bashrc":
        case ".profile":
        case ".zprofile":
        case ".zshrc":
            return "shell";
        default:
            break;
    }

    switch (mimeType) {
        case "application/json":
        case "text/json":
            return "json";
        case "application/toml":
            return "toml";
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
                ({ javascript }) =>
                    javascript({ typescript: true, jsx: true }),
            );
        case "json":
            return import("@codemirror/lang-json").then(({ json }) => json());
        case "python":
            return import("@codemirror/lang-python").then(
                ({ python }) => python(),
            );
        case "java":
            return import("@codemirror/lang-java").then(({ java }) => java());
        case "html":
            return import("@codemirror/lang-html").then(({ html }) => html());
        case "css":
            return import("@codemirror/lang-css").then(({ css }) => css());
        case "yaml":
            return import("@codemirror/lang-yaml").then(({ yaml }) => yaml());
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
