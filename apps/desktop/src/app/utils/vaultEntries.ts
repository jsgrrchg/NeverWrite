import { openPath } from "@neverwrite/runtime";
import {
    useEditorStore,
    isFileTab,
    isMapTab,
    isPdfTab,
    type TabInput,
} from "../store/editorStore";
import { inferFileViewer } from "../store/editorTabs";
import type { WorkspaceSplitDirection } from "../store/workspaceLayoutTree";
import { useVaultStore, type VaultEntryDto } from "../store/vaultStore";
import { toVaultRelativePath } from "./vaultPaths";
import { vaultInvoke } from "./vaultInvoke";

const TEXT_EXTENSIONS = new Set([
    "astro",
    "bat",
    "bash",
    "c",
    "cc",
    "cfg",
    "cjs",
    "clj",
    "cljs",
    "cmake",
    "conf",
    "cpp",
    "cs",
    "cts",
    "css",
    "csv",
    "d",
    "dart",
    "diff",
    "elm",
    "env",
    "erl",
    "ex",
    "exs",
    "fish",
    "gitignore",
    "go",
    "gradle",
    "graphql",
    "groovy",
    "h",
    "hpp",
    "hs",
    "html",
    "ini",
    "java",
    "jl",
    "js",
    "json",
    "jsonc",
    "jsx",
    "kt",
    "kts",
    "less",
    "lock",
    "log",
    "lua",
    "m",
    "md",
    "mdx",
    "mjs",
    "mts",
    "mk",
    "nim",
    "nix",
    "patch",
    "php",
    "pl",
    "plist",
    "prisma",
    "properties",
    "proto",
    "ps1",
    "py",
    "r",
    "rb",
    "rc",
    "rs",
    "sass",
    "scala",
    "scss",
    "sh",
    "sql",
    "styl",
    "svelte",
    "swift",
    "tcl",
    "tex",
    "tf",
    "tfvars",
    "toml",
    "ts",
    "tsx",
    "txt",
    "v",
    "vb",
    "vue",
    "wast",
    "xml",
    "yaml",
    "yml",
    "zig",
    "zsh",
]);

const TEXT_FILE_NAMES = new Set([
    ".babelrc",
    ".dockerignore",
    ".editorconfig",
    ".eslintignore",
    ".eslintrc",
    ".gitattributes",
    ".gitignore",
    ".gitmodules",
    ".gitconfig",
    ".ignore",
    ".node-version",
    ".npmignore",
    ".npmrc",
    ".python-version",
    ".prettierignore",
    ".prettierrc",
    ".ruby-version",
    ".stylelintrc",
    ".stylelintignore",
    ".tool-versions",
    ".terraform-version",
    ".yarnrc",
    ".bash_profile",
    ".bashrc",
    ".profile",
    ".zprofile",
    ".zshrc",
    "brewfile",
    "cmakelists.txt",
    "containerfile",
    "dockerfile",
    "gemfile",
    "gnumakefile",
    "justfile",
    "makefile",
    "podfile",
    "procfile",
    "rakefile",
]);

const IMAGE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "jpe",
    "jfif",
    "gif",
    "webp",
    "svg",
    "avif",
    "bmp",
    "ico",
]);

export function isTextLikeMimeType(mimeType: string | null | undefined) {
    if (!mimeType) return false;
    return (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml" ||
        mimeType === "application/yaml" ||
        mimeType === "application/toml"
    );
}

function getNormalizedExtension(pathOrExtension: string) {
    const normalized = pathOrExtension.toLowerCase().split("/").pop() ?? "";
    if (!normalized.includes(".")) {
        return normalized;
    }
    return normalized.split(".").slice(1).pop() ?? "";
}

function getNormalizedFileName(pathOrFileName: string) {
    return pathOrFileName.toLowerCase().split("/").pop() ?? "";
}

export function isTextLikeVaultPath(path: string) {
    const extension = getNormalizedExtension(path);
    if (TEXT_EXTENSIONS.has(extension)) return true;
    const fileName = getNormalizedFileName(path);
    if (TEXT_FILE_NAMES.has(fileName)) return true;
    if (fileName === ".env" || fileName.startsWith(".env.")) return true;
    if (
        fileName.startsWith(".") &&
        (fileName.endsWith("rc") || fileName.endsWith("ignore"))
    ) {
        return true;
    }
    return false;
}

export function isImageLikeVaultPath(path: string) {
    return IMAGE_EXTENSIONS.has(getNormalizedExtension(path));
}

export function isExcalidrawVaultPath(path: string) {
    return getNormalizedExtension(path) === "excalidraw";
}

export function isTextLikeVaultEntry(
    entry: Pick<
        VaultEntryDto,
        "extension" | "mime_type" | "file_name" | "is_text_like"
    >,
) {
    if ("is_text_like" in entry && entry.is_text_like != null) {
        return entry.is_text_like;
    }
    if (isTextLikeVaultPath(entry.file_name)) {
        return true;
    }
    return isTextLikeMimeType(entry.mime_type);
}

export function isImageLikeVaultEntry(
    entry: Pick<VaultEntryDto, "extension" | "mime_type" | "is_image_like">,
) {
    if ("is_image_like" in entry && entry.is_image_like != null) {
        return entry.is_image_like;
    }
    if (isImageLikeVaultPath(entry.extension)) return true;
    return entry.mime_type?.startsWith("image/") ?? false;
}

export function canOpenVaultFileEntryInApp(
    entry: Pick<
        VaultEntryDto,
        | "extension"
        | "mime_type"
        | "file_name"
        | "open_in_app"
        | "is_image_like"
        | "is_text_like"
    >,
) {
    if ("open_in_app" in entry && entry.open_in_app != null) {
        return entry.open_in_app;
    }
    return isImageLikeVaultEntry(entry) || isTextLikeVaultEntry(entry);
}

function getVaultEntryViewerKind(
    entry: Pick<
        VaultEntryDto,
        | "kind"
        | "extension"
        | "mime_type"
        | "file_name"
        | "viewer_kind"
        | "is_image_like"
        | "is_text_like"
    >,
) {
    if (entry.viewer_kind) {
        return entry.viewer_kind;
    }
    if (entry.kind === "note") return "markdown";
    if (entry.kind === "pdf") return "pdf";
    if (isExcalidrawVaultEntry(entry)) return "map";
    if (isImageLikeVaultEntry(entry)) return "image";
    if (isTextLikeVaultEntry(entry)) return "text";
    return "external";
}

export function getVaultEntryDisplayName(
    entry: Pick<VaultEntryDto, "kind" | "title" | "file_name">,
    showExtensions: boolean,
) {
    if (showExtensions) {
        return entry.file_name;
    }
    return entry.title || entry.file_name;
}

type VaultFileReadDetail = {
    path: string;
    relative_path: string;
    file_name: string;
    mime_type: string | null;
    content: string;
    size_bytes?: number | null;
    content_truncated?: boolean;
};

async function buildVaultEntryTab(
    entry: VaultEntryDto,
): Promise<TabInput | null> {
    if (entry.kind === "folder") {
        return null;
    }

    if (entry.kind === "note") {
        const detail = await vaultInvoke<{ content: string }>("read_note", {
            noteId: entry.id,
        });

        return {
            id: crypto.randomUUID(),
            kind: "note",
            noteId: entry.id,
            title: entry.title || entry.file_name,
            content: detail.content,
        };
    }

    if (entry.kind === "pdf") {
        return {
            id: crypto.randomUUID(),
            kind: "pdf",
            entryId: entry.id,
            title: entry.title || entry.file_name,
            path: entry.path,
            page: 1,
            zoom: 1,
            viewMode: "continuous",
        };
    }

    if (getVaultEntryViewerKind(entry) === "image") {
        return {
            id: crypto.randomUUID(),
            kind: "file",
            relativePath: entry.relative_path,
            title: entry.file_name,
            path: entry.path,
            mimeType: entry.mime_type,
            viewer: "image",
            content: "",
            sizeBytes: entry.size,
            contentTruncated: false,
        };
    }

    if (!canOpenVaultFileEntryInApp(entry)) {
        return null;
    }

    const detail = await vaultInvoke<VaultFileReadDetail>("read_vault_file", {
        relativePath: entry.relative_path,
    });

    return {
        id: crypto.randomUUID(),
        kind: "file",
        relativePath: detail.relative_path,
        title: detail.file_name,
        path: detail.path,
        mimeType: detail.mime_type,
        viewer: inferFileViewer(detail.path, detail.mime_type),
        content: detail.content,
        sizeBytes: detail.size_bytes ?? null,
        contentTruncated: Boolean(detail.content_truncated),
    };
}

export async function insertVaultEntryTab(
    entry: VaultEntryDto,
    index?: number,
    options?: {
        paneId?: string;
        newPane?: boolean;
        splitDirection?: WorkspaceSplitDirection;
    },
) {
    const nextTab = await buildVaultEntryTab(entry);
    if (!nextTab) {
        return false;
    }

    const store = useEditorStore.getState();
    if (options?.splitDirection) {
        return (
            store.insertExternalTabInNewSplit(
                nextTab,
                options.splitDirection,
                options.paneId,
            ) !== null
        );
    }
    if (options?.newPane) {
        return store.insertExternalTabInNewSplit(nextTab, "row") !== null;
    }
    if (options?.paneId) {
        store.insertExternalTabInPane(nextTab, options.paneId, index);
        return true;
    }
    store.insertExternalTab(nextTab, index);
    return true;
}

export function isExcalidrawVaultEntry(
    entry: Pick<VaultEntryDto, "extension">,
) {
    return isExcalidrawVaultPath(entry.extension);
}

export async function openVaultFileEntry(
    entry: VaultEntryDto,
    options?: {
        newTab?: boolean;
        paneId?: string;
        newPane?: boolean;
        splitDirection?: WorkspaceSplitDirection;
    },
) {
    const store = useEditorStore.getState();

    if (isExcalidrawVaultEntry(entry)) {
        if (options?.splitDirection) {
            store.insertExternalTabInNewSplit(
                {
                    id: crypto.randomUUID(),
                    kind: "map",
                    relativePath: entry.relative_path,
                    title: entry.title || entry.file_name,
                },
                options.splitDirection,
                options.paneId,
            );
            return;
        }
        if (options?.newPane) {
            store.insertExternalTabInNewSplit(
                {
                    id: crypto.randomUUID(),
                    kind: "map",
                    relativePath: entry.relative_path,
                    title: entry.title || entry.file_name,
                },
                "row",
            );
            return;
        }
        if (options?.paneId) {
            store.focusPane(options.paneId);
        }
        store.openMap(entry.relative_path, entry.title || entry.file_name);
        return;
    }

    if (
        options?.newTab ||
        options?.newPane ||
        options?.paneId ||
        options?.splitDirection
    ) {
        const inserted = await insertVaultEntryTab(entry, undefined, {
            paneId: options?.paneId,
            newPane: options?.newPane,
            splitDirection: options?.splitDirection,
        });
        if (!inserted) {
            try {
                await openPath(entry.path);
            } catch (error) {
                console.error("Error opening vault file externally:", error);
            }
        }
        return;
    }

    if (getVaultEntryViewerKind(entry) === "image") {
        if (options?.paneId) {
            store.focusPane(options.paneId);
        }
        store.openFile(
            entry.relative_path,
            entry.file_name,
            entry.path,
            "",
            entry.mime_type,
            "image",
            {
                sizeBytes: entry.size,
                contentTruncated: false,
            },
        );
        return;
    }

    if (!canOpenVaultFileEntryInApp(entry)) {
        try {
            await openPath(entry.path);
        } catch (error) {
            console.error("Error opening vault file externally:", error);
        }
        return;
    }

    const detail = await vaultInvoke<VaultFileReadDetail>("read_vault_file", {
        relativePath: entry.relative_path,
    });

    useEditorStore
        .getState()
        .openFile(
            detail.relative_path,
            detail.file_name,
            detail.path,
            detail.content,
            detail.mime_type,
            inferFileViewer(detail.path, detail.mime_type),
            {
                sizeBytes: detail.size_bytes ?? null,
                contentTruncated: Boolean(detail.content_truncated),
            },
        );
}

export async function moveVaultEntryToTrash(relativePath: string) {
    await vaultInvoke("move_vault_entry_to_trash", {
        relativePath,
    });
}

export function closeOpenTabsForVaultPath(path: string) {
    const { tabs, closeTab } = useEditorStore.getState();
    const relativePath = toVaultRelativePath(
        path,
        useVaultStore.getState().vaultPath,
    );
    const matchingTabs = tabs.filter(
        (tab) =>
            ((isPdfTab(tab) || isFileTab(tab)) && tab.path === path) ||
            (isMapTab(tab) &&
                relativePath !== null &&
                tab.relativePath === relativePath),
    );

    for (const tab of matchingTabs) {
        closeTab(tab.id, { reason: "cleanup" });
    }
}
