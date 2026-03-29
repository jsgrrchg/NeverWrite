import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore, type VaultEntryDto } from "../../app/store/vaultStore";
import {
    normalizeVaultPath as normalizeVaultPathMatch,
    toVaultRelativePath,
} from "../../app/utils/vaultPaths";
import {
    isExcalidrawVaultPath,
    isImageLikeVaultEntry,
    isImageLikeVaultPath,
    isTextLikeVaultEntry,
    isTextLikeVaultPath,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { openChatNoteByAbsolutePath } from "./chatNoteNavigation";

function getVaultEntryByAbsolutePath(absPath: string) {
    return (
        useVaultStore
            .getState()
            .entries.find((entry) => entry.path === absPath) ?? null
    );
}

function getFileNameFromAbsolutePath(absPath: string) {
    return normalizeVaultPathMatch(absPath).split("/").pop() ?? absPath;
}

function canOpenAiEditedFileByPathFallback(absPath: string) {
    if (!toVaultRelativePath(absPath, useVaultStore.getState().vaultPath)) {
        return false;
    }

    const normalizedPath = normalizeVaultPathMatch(absPath).toLowerCase();
    return (
        normalizedPath.endsWith(".pdf") ||
        isExcalidrawVaultPath(absPath) ||
        isImageLikeVaultPath(absPath) ||
        isTextLikeVaultPath(absPath)
    );
}

export function canOpenAiEditedFileEntry(entry: VaultEntryDto | null) {
    if (!entry) {
        return false;
    }

    if (entry.kind === "note") {
        return true;
    }

    if (entry.kind !== "file") {
        return false;
    }

    return isTextLikeVaultEntry(entry) || isImageLikeVaultEntry(entry);
}

export function canOpenAiEditedFileByAbsolutePath(absPath: string) {
    const note = useVaultStore
        .getState()
        .notes.find((entry) => entry.path === absPath);
    if (note) {
        return true;
    }

    const entry = getVaultEntryByAbsolutePath(absPath);
    if (canOpenAiEditedFileEntry(entry)) {
        return true;
    }

    return canOpenAiEditedFileByPathFallback(absPath);
}

export async function openAiEditedFileByAbsolutePath(
    absPath: string,
    options?: { newTab?: boolean },
) {
    const note = useVaultStore
        .getState()
        .notes.find((entry) => entry.path === absPath);
    if (note) {
        return openChatNoteByAbsolutePath(absPath, options);
    }

    const entry = getVaultEntryByAbsolutePath(absPath);
    if (entry && canOpenAiEditedFileEntry(entry)) {
        if (entry.kind === "note") {
            return openChatNoteByAbsolutePath(absPath, options);
        }

        await openVaultFileEntry(entry, options);
        return true;
    }

    const relativePath = toVaultRelativePath(
        absPath,
        useVaultStore.getState().vaultPath,
    );
    if (!relativePath) {
        return false;
    }

    const title = getFileNameFromAbsolutePath(absPath);
    const normalizedPath = normalizeVaultPathMatch(absPath).toLowerCase();

    if (normalizedPath.endsWith(".pdf")) {
        if (options?.newTab) {
            useEditorStore.getState().insertExternalTab({
                id: crypto.randomUUID(),
                kind: "pdf",
                entryId: relativePath,
                title,
                path: absPath,
                page: 1,
                zoom: 1,
                viewMode: "continuous",
            });
        } else {
            useEditorStore.getState().openPdf(relativePath, title, absPath);
        }
        return true;
    }

    if (isExcalidrawVaultPath(absPath)) {
        useEditorStore.getState().openMap(relativePath, title);
        return true;
    }

    if (isImageLikeVaultPath(absPath)) {
        if (options?.newTab) {
            useEditorStore.getState().insertExternalTab({
                id: crypto.randomUUID(),
                kind: "file",
                relativePath,
                title,
                path: absPath,
                mimeType: null,
                viewer: "image",
                content: "",
            });
        } else {
            useEditorStore
                .getState()
                .openFile(relativePath, title, absPath, "", null, "image");
        }
        return true;
    }

    if (!isTextLikeVaultPath(absPath)) {
        return false;
    }

    const detail = await vaultInvoke<{
        path: string;
        relative_path: string;
        file_name: string;
        mime_type: string | null;
        content: string;
    }>("read_vault_file", {
        relativePath,
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
    } else {
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

    return true;
}

function findPdfEntry(reference: string) {
    const trimmed = reference.trim();
    if (!trimmed) return null;

    const normalized = trimmed.toLowerCase().replace(/\.pdf$/i, "");
    const { entries } = useVaultStore.getState();
    const pdfs = entries.filter((e) => e.kind === "pdf");

    return (
        pdfs.find((e) => e.path === trimmed || e.relative_path === trimmed) ??
        pdfs.find(
            (e) =>
                e.title.toLowerCase() === normalized ||
                e.file_name.toLowerCase().replace(/\.pdf$/i, "") === normalized,
        ) ??
        pdfs.find(
            (e) =>
                e.path.toLowerCase().endsWith(trimmed.toLowerCase()) ||
                e.relative_path.toLowerCase().endsWith(trimmed.toLowerCase()) ||
                e.title.toLowerCase().includes(normalized),
        ) ??
        null
    );
}

export function openChatPdfByReference(
    reference: string,
    options?: { newTab?: boolean },
) {
    const entry = findPdfEntry(reference);
    if (!entry) return false;

    if (options?.newTab) {
        useEditorStore.getState().insertExternalTab({
            id: crypto.randomUUID(),
            kind: "pdf",
            entryId: entry.id,
            title: entry.title || entry.file_name,
            path: entry.path,
            page: 1,
            zoom: 1,
            viewMode: "continuous",
        });
    } else {
        useEditorStore
            .getState()
            .openPdf(entry.id, entry.title || entry.file_name, entry.path);
    }

    return true;
}
