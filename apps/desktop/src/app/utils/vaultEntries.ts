import { openPath } from "@tauri-apps/plugin-opener";
import { useEditorStore, isFileTab, isPdfTab } from "../store/editorStore";
import type { VaultEntryDto } from "../store/vaultStore";
import { vaultInvoke } from "./vaultInvoke";

const TEXT_EXTENSIONS = new Set([
    "bat",
    "bash",
    "c",
    "cc",
    "cjs",
    "conf",
    "cpp",
    "cts",
    "css",
    "csv",
    "env",
    "gitignore",
    "go",
    "gradle",
    "graphql",
    "h",
    "hpp",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsx",
    "kt",
    "kts",
    "lock",
    "log",
    "lua",
    "m",
    "md",
    "mjs",
    "mts",
    "php",
    "properties",
    "proto",
    "ps1",
    "py",
    "rb",
    "rs",
    "scss",
    "sh",
    "sql",
    "swift",
    "tf",
    "tfvars",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zsh",
]);

const TEXT_FILE_NAMES = new Set([
    ".dockerignore",
    ".editorconfig",
    ".eslintignore",
    ".gitattributes",
    ".gitmodules",
    ".ignore",
    ".npmrc",
    ".prettierignore",
    ".prettierrc",
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

export function isTextLikeVaultEntry(
    entry: Pick<VaultEntryDto, "extension" | "mime_type" | "file_name">,
) {
    const extension = entry.extension.toLowerCase();
    if (TEXT_EXTENSIONS.has(extension)) return true;
    const fileName = entry.file_name.toLowerCase();
    if (TEXT_FILE_NAMES.has(fileName)) return true;
    if (fileName === ".env" || fileName.startsWith(".env.")) return true;
    if (!entry.mime_type) return false;
    return (
        entry.mime_type.startsWith("text/") ||
        entry.mime_type === "application/json" ||
        entry.mime_type === "application/xml" ||
        entry.mime_type === "application/yaml" ||
        entry.mime_type === "application/toml"
    );
}

export function isImageLikeVaultEntry(
    entry: Pick<VaultEntryDto, "extension" | "mime_type">,
) {
    const extension = entry.extension.toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return true;
    return entry.mime_type?.startsWith("image/") ?? false;
}

export function canOpenVaultFileEntryInApp(
    entry: Pick<VaultEntryDto, "extension" | "mime_type" | "file_name">,
) {
    return isImageLikeVaultEntry(entry) || isTextLikeVaultEntry(entry);
}

export function getVaultEntryDisplayName(
    entry: Pick<VaultEntryDto, "kind" | "title" | "file_name">,
    showExtensions: boolean,
) {
    if (showExtensions) {
        return entry.file_name;
    }
    return entry.kind === "note" ? entry.title : entry.title;
}

type VaultFileReadDetail = {
    path: string;
    relative_path: string;
    file_name: string;
    mime_type: string | null;
    content: string;
};

export async function openVaultFileEntry(
    entry: VaultEntryDto,
    options?: { newTab?: boolean },
) {
    if (isImageLikeVaultEntry(entry)) {
        const nextTab = {
            id: crypto.randomUUID(),
            kind: "file" as const,
            relativePath: entry.relative_path,
            title: entry.file_name,
            path: entry.path,
            mimeType: entry.mime_type,
            viewer: "image" as const,
            content: "",
        };

        if (options?.newTab) {
            useEditorStore.getState().insertExternalTab(nextTab);
            return;
        }

        useEditorStore
            .getState()
            .openFile(
                nextTab.relativePath,
                nextTab.title,
                nextTab.path,
                nextTab.content,
                nextTab.mimeType,
                nextTab.viewer,
            );
        return;
    }

    if (!canOpenVaultFileEntryInApp(entry)) {
        await openPath(entry.path);
        return;
    }

    const detail = await vaultInvoke<VaultFileReadDetail>("read_vault_file", {
        relativePath: entry.relative_path,
    });

    if (options?.newTab) {
        useEditorStore.getState().insertExternalTab({
            id: crypto.randomUUID(),
            kind: "file",
            relativePath: detail.relative_path,
            title: detail.file_name,
            path: detail.path,
            mimeType: detail.mime_type,
            viewer: "text",
            content: detail.content,
        });
        return;
    }

    useEditorStore
        .getState()
        .openFile(
            detail.relative_path,
            detail.file_name,
            detail.path,
            detail.content,
            detail.mime_type,
            "text",
        );
}

export async function moveVaultEntryToTrash(relativePath: string) {
    await vaultInvoke("move_vault_entry_to_trash", {
        relativePath,
    });
}

export function closeOpenTabsForVaultPath(path: string) {
    const { tabs, closeTab } = useEditorStore.getState();
    const matchingTabs = tabs.filter(
        (tab) => (isPdfTab(tab) || isFileTab(tab)) && tab.path === path,
    );

    for (const tab of matchingTabs) {
        closeTab(tab.id);
    }
}
