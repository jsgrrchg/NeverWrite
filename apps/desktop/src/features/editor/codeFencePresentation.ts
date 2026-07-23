import { extractFenceLanguageToken } from "./codeLanguage";

const codeLanguageLabels: Record<string, string> = {
    bash: "Bash",
    c: "C",
    "c++": "C++",
    cpp: "C++",
    cs: "C#",
    csharp: "C#",
    css: "CSS",
    diff: "Diff",
    docker: "Dockerfile",
    dockerfile: "Dockerfile",
    gql: "GraphQL",
    graphql: "GraphQL",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsonc: "JSONC",
    jsx: "JSX",
    make: "Makefile",
    makefile: "Makefile",
    markdown: "Markdown",
    md: "Markdown",
    mdx: "MDX",
    php: "PHP",
    powershell: "PowerShell",
    ps1: "PowerShell",
    pwsh: "PowerShell",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    rs: "Rust",
    ruby: "Ruby",
    rust: "Rust",
    scss: "SCSS",
    sh: "Shell",
    shell: "Shell",
    sql: "SQL",
    text: "Text",
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zsh: "Zsh",
};

export function formatCodeFenceLanguageLabel(info?: string) {
    const language = extractFenceLanguageToken(info ?? "");
    if (!language) return undefined;

    return (
        codeLanguageLabels[language] ??
        language
            .split(/[-_]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ")
    );
}
