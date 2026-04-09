import { openPath } from "@tauri-apps/plugin-opener";

import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";

export type VaultEmbedKind = "pdf" | "image";

function normalizeEmbedTargetRelativePath(target: string) {
    return target.startsWith("/") ? target.slice(1) : target;
}

export function findVaultEmbedEntry(target: string) {
    const relativePath = normalizeEmbedTargetRelativePath(target);
    return (
        useVaultStore
            .getState()
            .entries.find((entry) => entry.relative_path === relativePath) ??
        null
    );
}

export function getVaultEmbedAbsolutePath(target: string) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return null;

    const relativePath = normalizeEmbedTargetRelativePath(target);
    const separator =
        vaultPath.endsWith("/") || vaultPath.endsWith("\\") ? "" : "/";
    return `${vaultPath}${separator}${relativePath}`;
}

export async function openVaultEmbedTarget(
    target: string,
    kind: VaultEmbedKind,
    options?: { newTab?: boolean },
) {
    const entry = findVaultEmbedEntry(target);
    const absolutePath = getVaultEmbedAbsolutePath(target);
    const editor = useEditorStore.getState();

    if (entry) {
        const title = entry.title || entry.file_name;

        if (kind === "pdf") {
            if (options?.newTab) {
                editor.insertExternalTab({
                    id: crypto.randomUUID(),
                    kind: "pdf",
                    entryId: entry.id,
                    title,
                    path: entry.path,
                    page: 1,
                    zoom: 1,
                    viewMode: "continuous",
                });
            } else {
                editor.openPdf(entry.id, title, entry.path);
            }
            return true;
        }

        if (options?.newTab) {
            editor.insertExternalTab({
                id: crypto.randomUUID(),
                kind: "file",
                relativePath: entry.relative_path,
                title,
                path: entry.path,
                content: "",
                mimeType: entry.mime_type,
                viewer: "image",
                sizeBytes: entry.size,
                contentTruncated: false,
            });
        } else {
            editor.openFile(
                entry.relative_path,
                title,
                entry.path,
                "",
                entry.mime_type,
                "image",
            );
        }
        return true;
    }

    if (!absolutePath) {
        return false;
    }

    await openPath(absolutePath);
    return true;
}
