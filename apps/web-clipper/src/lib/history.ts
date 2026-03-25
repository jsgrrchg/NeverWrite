import type { ClipData } from "./clipper-contract";
import type { ClipHistoryEntry, ClipperSettings } from "./types";

const MAX_HISTORY_ITEMS = 50;

export interface RecordClipHistoryInput {
    requestId: string;
    clipData: ClipData;
    markdown: string;
    title: string;
    tags: string[];
    folder: string;
    method: ClipHistoryEntry["method"];
    status: ClipHistoryEntry["status"];
    contentMode: ClipHistoryEntry["contentMode"];
    vaultId: string;
    vaultName: string;
    templateId: string | null;
}

export function recordClipHistory(
    settings: ClipperSettings,
    input: RecordClipHistoryInput,
): ClipperSettings {
    const entry: ClipHistoryEntry = {
        id: crypto.randomUUID(),
        requestId: input.requestId,
        createdAt: new Date().toISOString(),
        title: input.title.trim() || input.clipData.metadata.title,
        url: input.clipData.metadata.url,
        domain: input.clipData.metadata.domain,
        folder: input.folder.trim(),
        tags: input.tags,
        method: input.method,
        status: input.status,
        contentMode: input.contentMode,
        markdown: input.markdown,
        metadata: input.clipData.metadata,
        vaultId: input.vaultId,
        vaultName: input.vaultName,
        templateId: input.templateId,
    };

    const clipHistory = [
        entry,
        ...settings.clipHistory.filter(
            (historyEntry) => historyEntry.requestId !== input.requestId,
        ),
    ].slice(0, MAX_HISTORY_ITEMS);

    return {
        ...settings,
        clipHistory,
    };
}
