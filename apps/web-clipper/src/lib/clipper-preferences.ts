import type { ClipperSettings } from "./types";

function dedupeCaseInsensitive(values: string[], limit: number): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) {
            continue;
        }

        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        normalized.push(trimmed);

        if (normalized.length >= limit) {
            break;
        }
    }

    return normalized;
}

export function normalizeFolderHint(value: string): string {
    const compact = value
        .trim()
        .replaceAll("\\", "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

    return compact;
}

export function parseTagInput(value: string): string[] {
    return dedupeCaseInsensitive(
        value
            .split(/[,\n]/)
            .map((part) => part.trim())
            .filter(Boolean),
        20,
    );
}

export function mergeRecentValues(
    existing: string[],
    incoming: string[],
    limit: number,
): string[] {
    return dedupeCaseInsensitive([...incoming, ...existing], limit);
}

export function parseFolderHintsInput(value: string): string[] {
    return dedupeCaseInsensitive(
        value
            .split("\n")
            .map((line) => normalizeFolderHint(line))
            .filter(Boolean),
        16,
    );
}

export function serializeFolderHintsInput(values: string[]): string {
    return values.join("\n");
}

export function recordClipperUsage(
    settings: ClipperSettings,
    payload: {
        vaultId: string;
        folder: string;
        tags: string[];
    },
): ClipperSettings {
    const normalizedFolder = normalizeFolderHint(payload.folder);
    const nextRecentFolders = {
        ...settings.recentFoldersByVault,
        [payload.vaultId]: mergeRecentValues(
            settings.recentFoldersByVault[payload.vaultId] ?? [],
            normalizedFolder ? [normalizedFolder] : [],
            16,
        ),
    };

    const nextVaults = settings.vaults.map((vault) =>
        vault.id === payload.vaultId
            ? {
                  ...vault,
                  defaultFolder: normalizedFolder,
                  folderHints: mergeRecentValues(
                      vault.folderHints,
                      normalizedFolder ? [normalizedFolder] : [],
                      16,
                  ),
              }
            : vault,
    );

    return {
        ...settings,
        vaults: nextVaults,
        recentTags: mergeRecentValues(settings.recentTags, payload.tags, 20),
        recentFoldersByVault: nextRecentFolders,
    };
}
