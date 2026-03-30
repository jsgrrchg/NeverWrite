import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore, type VaultEntryDto } from "../../app/store/vaultStore";
import {
    normalizeVaultPath as normalizeVaultPathMatch,
    toVaultRelativePath,
} from "../../app/utils/vaultPaths";
import {
    canOpenVaultFileEntryInApp,
    isExcalidrawVaultPath,
    isImageLikeVaultPath,
    isTextLikeVaultPath,
    openVaultFileEntry,
} from "../../app/utils/vaultEntries";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    openChatNoteByAbsolutePath,
    openChatResolvedNote,
} from "./chatNoteNavigation";

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

function getFallbackNoteTitle(absPath: string) {
    return getFileNameFromAbsolutePath(absPath).replace(/\.md$/i, "");
}

function canOpenFallbackAbsolutePath(absPath: string) {
    return (
        /\.md$/i.test(absPath) ||
        /\.pdf$/i.test(absPath) ||
        isExcalidrawVaultPath(absPath) ||
        isTextLikeVaultPath(absPath) ||
        isImageLikeVaultPath(absPath)
    );
}

async function openResolvedNoteEntry(
    entry: Pick<VaultEntryDto, "id" | "title" | "path">,
    options?: { newTab?: boolean },
) {
    const title = entry.title || getFallbackNoteTitle(entry.path);
    return openChatResolvedNote(entry.id, title, options);
}

async function readVaultEntryByAbsolutePath(absPath: string) {
    const relativePath = toVaultRelativePath(
        absPath,
        useVaultStore.getState().vaultPath,
    );
    if (!relativePath) {
        return null;
    }

    try {
        return await vaultInvoke<VaultEntryDto>("read_vault_entry", {
            relativePath,
        });
    } catch {
        return null;
    }
}

export function canOpenAiEditedFileEntry(entry: VaultEntryDto | null) {
    if (!entry) {
        return false;
    }

    if (entry.kind === "note") {
        return true;
    }

    if (entry.kind === "pdf") {
        return true;
    }

    if (entry.viewer_kind === "map" || entry.extension === "excalidraw") {
        return true;
    }

    return entry.open_in_app ?? canOpenVaultFileEntryInApp(entry);
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

    return canOpenFallbackAbsolutePath(absPath);
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
            return openResolvedNoteEntry(entry, options);
        }

        await openVaultFileEntry(entry, options);
        return true;
    }

    const resolvedEntry = await readVaultEntryByAbsolutePath(absPath);
    if (!resolvedEntry || !canOpenAiEditedFileEntry(resolvedEntry)) {
        return false;
    }

    if (resolvedEntry.kind === "note") {
        return openResolvedNoteEntry(resolvedEntry, options);
    }
    const title = getFileNameFromAbsolutePath(absPath);
    resolvedEntry.title ||= title.replace(/\.[^/.]+$/, "");
    resolvedEntry.file_name ||= title;
    await openVaultFileEntry(resolvedEntry, options);
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
