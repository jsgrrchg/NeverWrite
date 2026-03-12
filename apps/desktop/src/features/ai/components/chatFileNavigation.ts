import { useVaultStore, type VaultEntryDto } from "../../../app/store/vaultStore";
import {
    isImageLikeVaultEntry,
    isTextLikeVaultEntry,
    openVaultFileEntry,
} from "../../../app/utils/vaultEntries";
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
