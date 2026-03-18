import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore, type VaultEntryDto } from "../../app/store/vaultStore";
import {
    isImageLikeVaultEntry,
    isTextLikeVaultEntry,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { openChatNoteByAbsolutePath } from "./chatNoteNavigation";

function getVaultEntryByAbsolutePath(absPath: string) {
    return (
        useVaultStore
            .getState()
            .entries.find((entry) => entry.path === absPath) ?? null
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
    return canOpenAiEditedFileEntry(getVaultEntryByAbsolutePath(absPath));
}

export async function openAiEditedFileByAbsolutePath(
    absPath: string,
    options?: { newTab?: boolean },
) {
    const entry = getVaultEntryByAbsolutePath(absPath);
    if (!entry || !canOpenAiEditedFileEntry(entry)) {
        return false;
    }

    if (entry.kind === "note") {
        return openChatNoteByAbsolutePath(absPath, options);
    }

    await openVaultFileEntry(entry, options);
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
