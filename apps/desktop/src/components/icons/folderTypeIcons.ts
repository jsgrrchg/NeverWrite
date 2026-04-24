import {
    resolveAvailableCatppuccinIcon,
    type CatppuccinIconName,
} from "./catppuccin-icons";

export interface ResolvedFolderTypeIcon {
    readonly iconName: CatppuccinIconName;
}

const FOLDER_NAME_TO_ICON: Record<string, CatppuccinIconName> = {
    "__tests__": "folder-tests",
    ".cursor": "folder-cursor",
    ".devcontainer": "folder-devcontainer",
    ".git": "folder-git",
    ".github": "folder-github",
    ".gitlab": "folder-gitlab",
    ".husky": "folder-husky",
    ".personal": "folder-private",
    ".vscode": "folder-vscode",
    app: "folder-app",
    apps: "folder-app",
    assets: "folder-assets",
    audio: "folder-audio",
    benchmark: "folder-benchmark",
    benchmarks: "folder-benchmark",
    client: "folder-client",
    components: "folder-components",
    config: "folder-config",
    configs: "folder-config",
    content: "folder-content",
    controllers: "folder-controllers",
    core: "folder-core",
    coverage: "folder-coverage",
    crates: "folder-packages",
    cypress: "folder-cypress",
    database: "folder-database",
    db: "folder-database",
    dist: "folder-dist",
    docker: "folder-docker",
    docs: "folder-docs",
    excalidraw: "folder-images",
    examples: "folder-examples",
    fonts: "folder-fonts",
    functions: "folder-functions",
    graphql: "folder-graphql",
    hooks: "folder-hooks",
    images: "folder-images",
    include: "folder-include",
    layouts: "folder-layouts",
    lib: "folder-lib",
    locales: "folder-locales",
    messages: "folder-messages",
    middleware: "folder-middleware",
    mocks: "folder-mocks",
    notes: "folder-docs",
    packages: "folder-packages",
    plugins: "folder-plugins",
    prisma: "folder-prisma",
    private: "folder-private",
    public: "folder-public",
    routes: "folder-routes",
    scripts: "folder-scripts",
    security: "folder-security",
    server: "folder-server",
    shared: "folder-shared",
    src: "folder-src",
    styles: "folder-styles",
    svg: "folder-svg",
    temp: "folder-temp",
    templates: "folder-templates",
    test: "folder-tests",
    tests: "folder-tests",
    themes: "folder-themes",
    types: "folder-types",
    typings: "folder-types",
    upload: "folder-upload",
    uploads: "folder-upload",
    utils: "folder-utils",
    vault: "folder-private",
    vendor: "folder-packages",
    video: "folder-video",
    views: "folder-views",
    workflows: "folder-workflows",
};

function normalizeFolderName(folderName: string): string {
    const normalizedPath = folderName.replaceAll("\\", "/");
    return (normalizedPath.split("/").at(-1) ?? folderName).toLowerCase();
}

export function resolveCatppuccinFolderIcon(
    folderName: string,
    open: boolean,
): ResolvedFolderTypeIcon {
    const normalizedFolderName = normalizeFolderName(folderName);
    const baseIconName =
        FOLDER_NAME_TO_ICON[normalizedFolderName] ?? "folder";
    const iconName = open ? `${baseIconName}-open` : baseIconName;

    return {
        iconName: resolveAvailableCatppuccinIcon(
            iconName,
            open ? "folder-open" : "folder",
        ),
    };
}
