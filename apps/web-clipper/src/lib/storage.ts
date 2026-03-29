import type {
    ClipHistoryEntry,
    ClipperSettings,
    ClipperTemplate,
    VaultConfig,
} from "./types";

const CLIPPER_SETTINGS_STORAGE_KEY = "clipperSettings";
const CLIPPER_DESKTOP_AUTH_STORAGE_KEY = "clipperDesktopAuth";
const MAX_HISTORY_ITEMS = 50;
const DEFAULT_TEMPLATE_BODY = "{{content}}";
const LEGACY_DEFAULT_TEMPLATE_BODY = "# {{title}}\n\n{{content}}";

function createTemplateId(): string {
    return crypto.randomUUID();
}

function createDefaultVault(): VaultConfig {
    return {
        id: "default",
        name: "Default vault",
        path: "",
        defaultFolder: "",
        folderHints: [],
    };
}

export function createDefaultClipperSettings(): ClipperSettings {
    return {
        vaults: [createDefaultVault()],
        activeVaultIndex: 0,
        clipSelectedOnly: false,
        useClipboard: false,
        defaultTemplate: DEFAULT_TEMPLATE_BODY,
        recentTags: [],
        recentFoldersByVault: {},
        templates: [],
        clipHistory: [],
    };
}

function normalizeList(values: unknown, limit = 12): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of values) {
        if (typeof value !== "string") {
            continue;
        }

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

function normalizeVault(
    vault: Partial<VaultConfig> | null | undefined,
): VaultConfig {
    const fallback = createDefaultVault();

    return {
        id: vault?.id?.trim() || crypto.randomUUID(),
        name: vault?.name?.trim() || fallback.name,
        path: vault?.path?.trim() || "",
        defaultFolder: vault?.defaultFolder?.trim() || "",
        folderHints: normalizeList(vault?.folderHints, 16),
    };
}

function normalizeTemplate(
    template: Partial<ClipperTemplate> | null | undefined,
): ClipperTemplate | null {
    const body = template?.body?.trim();
    if (!body) {
        return null;
    }

    return {
        id: template?.id?.trim() || createTemplateId(),
        name: template?.name?.trim() || "Untitled template",
        body,
        vaultId: template?.vaultId?.trim() || "",
        domain: template?.domain?.trim().toLowerCase() || "",
    };
}

function normalizeHistoryEntry(
    entry: Partial<ClipHistoryEntry> | null | undefined,
): ClipHistoryEntry | null {
    if (!entry?.requestId || !entry?.title || !entry?.url || !entry?.markdown) {
        return null;
    }

    return {
        id: entry.id?.trim() || crypto.randomUUID(),
        requestId: entry.requestId,
        createdAt: entry.createdAt?.trim() || new Date().toISOString(),
        title: entry.title.trim(),
        url: entry.url.trim(),
        domain: entry.domain?.trim() || "",
        folder: entry.folder?.trim() || "",
        tags: normalizeList(entry.tags, 20),
        method:
            entry.method === "desktop-api" ||
            entry.method === "deep-link-inline" ||
            entry.method === "deep-link-clipboard"
                ? entry.method
                : "deep-link-inline",
        status: entry.status === "saved" ? "saved" : "handoff",
        contentMode:
            entry.contentMode === "selection" ||
            entry.contentMode === "url-only"
                ? entry.contentMode
                : "full-page",
        markdown: entry.markdown,
        metadata: {
            title: entry.metadata?.title?.trim() || entry.title.trim(),
            url: entry.metadata?.url?.trim() || entry.url.trim(),
            domain:
                entry.metadata?.domain?.trim() || entry.domain?.trim() || "",
            description: entry.metadata?.description?.trim() || "",
            author: entry.metadata?.author?.trim() || "",
            published: entry.metadata?.published?.trim() || "",
            image: entry.metadata?.image?.trim() || "",
            favicon: entry.metadata?.favicon?.trim() || "",
            language: entry.metadata?.language?.trim() || "",
        },
        vaultId: entry.vaultId?.trim() || "",
        vaultName: entry.vaultName?.trim() || "",
        templateId: entry.templateId?.trim() || null,
    };
}

export function normalizeClipperSettings(
    value: Partial<ClipperSettings> | null | undefined,
): ClipperSettings {
    const fallback = createDefaultClipperSettings();
    const vaults = Array.isArray(value?.vaults)
        ? value.vaults.map(normalizeVault)
        : fallback.vaults;
    const safeVaults = vaults.length > 0 ? vaults : fallback.vaults;
    const activeVaultIndex = Number.isInteger(value?.activeVaultIndex)
        ? Math.min(
              Math.max(value?.activeVaultIndex ?? 0, 0),
              safeVaults.length - 1,
          )
        : 0;

    return {
        vaults: safeVaults,
        activeVaultIndex,
        clipSelectedOnly: Boolean(value?.clipSelectedOnly),
        useClipboard: Boolean(value?.useClipboard),
        defaultTemplate:
            !value?.defaultTemplate?.trim() ||
            value.defaultTemplate.trim() === LEGACY_DEFAULT_TEMPLATE_BODY
                ? DEFAULT_TEMPLATE_BODY
                : value.defaultTemplate.trim(),
        recentTags: normalizeList(value?.recentTags, 20),
        recentFoldersByVault:
            value?.recentFoldersByVault &&
            typeof value.recentFoldersByVault === "object"
                ? Object.fromEntries(
                      Object.entries(value.recentFoldersByVault).map(
                          ([vaultId, folders]) => [
                              vaultId,
                              normalizeList(folders, 16),
                          ],
                      ),
                  )
                : {},
        templates: Array.isArray(value?.templates)
            ? value.templates
                  .map(normalizeTemplate)
                  .filter(
                      (template): template is ClipperTemplate =>
                          template !== null,
                  )
            : [],
        clipHistory: Array.isArray(value?.clipHistory)
            ? value.clipHistory
                  .map(normalizeHistoryEntry)
                  .filter((entry): entry is ClipHistoryEntry => entry !== null)
                  .slice(0, MAX_HISTORY_ITEMS)
            : [],
    };
}

export async function loadClipperSettings(): Promise<ClipperSettings> {
    const stored = await browser.storage.local.get(
        CLIPPER_SETTINGS_STORAGE_KEY,
    );
    return normalizeClipperSettings(
        stored[CLIPPER_SETTINGS_STORAGE_KEY] as
            | Partial<ClipperSettings>
            | undefined,
    );
}

export async function saveClipperSettings(
    settings: ClipperSettings,
): Promise<ClipperSettings> {
    const normalized = normalizeClipperSettings(settings);
    await browser.storage.local.set({
        [CLIPPER_SETTINGS_STORAGE_KEY]: normalized,
    });
    return normalized;
}

export async function loadDesktopClipperToken(): Promise<string | null> {
    const stored = await browser.storage.local.get(
        CLIPPER_DESKTOP_AUTH_STORAGE_KEY,
    );
    const token = (
        stored[CLIPPER_DESKTOP_AUTH_STORAGE_KEY] as
            | { token?: unknown }
            | undefined
    )?.token;
    return typeof token === "string" && token.trim() ? token.trim() : null;
}

export async function saveDesktopClipperToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
        await clearDesktopClipperToken();
        return;
    }
    await browser.storage.local.set({
        [CLIPPER_DESKTOP_AUTH_STORAGE_KEY]: { token: trimmed },
    });
}

export async function clearDesktopClipperToken(): Promise<void> {
    await browser.storage.local.remove(CLIPPER_DESKTOP_AUTH_STORAGE_KEY);
}
