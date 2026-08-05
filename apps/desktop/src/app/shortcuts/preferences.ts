import { getDesktopPlatform, type DesktopPlatform } from "../utils/platform";
import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../utils/safeStorage";
import type { ShortcutBinding, ShortcutModifier } from "./registry";
import {
    isConfigurableShortcutAction,
    type ConfigurableShortcutActionId,
} from "./scope";

export const SHORTCUT_OVERRIDES_STORAGE_KEY =
    "neverwrite:shortcut-overrides";

type ShortcutOverridePlatform = "macos" | "windows";
type PlatformShortcutOverrides = Partial<
    Record<ConfigurableShortcutActionId, ShortcutBinding>
>;

export interface ShortcutOverrides {
    version: 1;
    macos: PlatformShortcutOverrides;
    windows: PlatformShortcutOverrides;
}

const SHORTCUT_MODIFIERS: readonly ShortcutModifier[] = [
    "meta",
    "ctrl",
    "alt",
    "shift",
];
const MODIFIER_KEYS = new Set([
    "alt",
    "altgraph",
    "control",
    "meta",
    "os",
    "shift",
]);

function createEmptyShortcutOverrides(): ShortcutOverrides {
    return { version: 1, macos: {}, windows: {} };
}

function resolveShortcutOverridePlatform(
    platform: DesktopPlatform,
): ShortcutOverridePlatform {
    return platform === "macos" ? "macos" : "windows";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeShortcutModifiers(
    value: unknown,
): ShortcutModifier[] | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }

    const modifiers = new Set<ShortcutModifier>();
    for (const modifier of value) {
        if (
            typeof modifier !== "string" ||
            !SHORTCUT_MODIFIERS.includes(modifier as ShortcutModifier)
        ) {
            return null;
        }
        modifiers.add(modifier as ShortcutModifier);
    }

    return SHORTCUT_MODIFIERS.filter((modifier) => modifiers.has(modifier));
}

export function normalizeShortcutBinding(
    value: unknown,
): ShortcutBinding | null {
    if (!isRecord(value) || typeof value.key !== "string") {
        return null;
    }

    const normalizedKey = value.key.toLowerCase();
    if (
        value.key.length === 0 ||
        normalizedKey === "escape" ||
        MODIFIER_KEYS.has(normalizedKey)
    ) {
        return null;
    }

    const modifiers = normalizeShortcutModifiers(value.modifiers);
    if (!modifiers) {
        return null;
    }

    return { key: value.key, modifiers };
}

function normalizePlatformShortcutOverrides(
    value: unknown,
): PlatformShortcutOverrides {
    if (!isRecord(value)) {
        return {};
    }

    const overrides: PlatformShortcutOverrides = {};
    for (const [actionId, bindingValue] of Object.entries(value)) {
        if (!isConfigurableShortcutAction(actionId)) {
            continue;
        }

        const binding = normalizeShortcutBinding(bindingValue);
        if (binding) {
            overrides[actionId] = binding;
        }
    }
    return overrides;
}

export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
    if (!isRecord(value) || value.version !== 1) {
        return createEmptyShortcutOverrides();
    }

    return {
        version: 1,
        macos: normalizePlatformShortcutOverrides(value.macos),
        windows: normalizePlatformShortcutOverrides(value.windows),
    };
}

function parseShortcutOverrides(raw: string | null): ShortcutOverrides {
    if (!raw) {
        return createEmptyShortcutOverrides();
    }

    try {
        return normalizeShortcutOverrides(JSON.parse(raw));
    } catch {
        return createEmptyShortcutOverrides();
    }
}

function hasAnyShortcutOverrides(overrides: ShortcutOverrides): boolean {
    return (
        Object.keys(overrides.macos).length > 0 ||
        Object.keys(overrides.windows).length > 0
    );
}

let cachedRawShortcutOverrides: string | null | undefined;
let cachedShortcutOverrides: ShortcutOverrides | null = null;

function readStoredShortcutOverrides(): ShortcutOverrides {
    const raw = safeStorageGetItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    if (raw === cachedRawShortcutOverrides && cachedShortcutOverrides) {
        return cachedShortcutOverrides;
    }

    cachedRawShortcutOverrides = raw;
    cachedShortcutOverrides = parseShortcutOverrides(raw);
    return cachedShortcutOverrides;
}

export function readShortcutOverrides(): ShortcutOverrides {
    return normalizeShortcutOverrides(readStoredShortcutOverrides());
}

export function writeShortcutOverrides(value: unknown): boolean {
    const overrides = normalizeShortcutOverrides(value);
    return safeStorageSetItem(
        SHORTCUT_OVERRIDES_STORAGE_KEY,
        JSON.stringify(overrides),
    );
}

export function getShortcutOverride(
    actionId: ConfigurableShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): ShortcutBinding | null {
    const overrides = readStoredShortcutOverrides();
    return (
        overrides[resolveShortcutOverridePlatform(platform)][actionId] ?? null
    );
}

export function setShortcutOverride(
    actionId: ConfigurableShortcutActionId,
    platform: DesktopPlatform,
    binding: ShortcutBinding,
): boolean {
    const normalizedBinding = normalizeShortcutBinding(binding);
    if (!normalizedBinding) {
        return false;
    }

    const overrides = readShortcutOverrides();
    overrides[resolveShortcutOverridePlatform(platform)][actionId] =
        normalizedBinding;
    return writeShortcutOverrides(overrides);
}

export function resetShortcutOverride(
    actionId: ConfigurableShortcutActionId,
    platform: DesktopPlatform = getDesktopPlatform(),
): boolean {
    const overrides = readShortcutOverrides();
    const platformOverrides =
        overrides[resolveShortcutOverridePlatform(platform)];
    if (!(actionId in platformOverrides)) {
        return true;
    }

    delete platformOverrides[actionId];
    if (!hasAnyShortcutOverrides(overrides)) {
        return safeStorageRemoveItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    }
    return writeShortcutOverrides(overrides);
}

export function resetAllShortcutOverrides(
    platform: DesktopPlatform = getDesktopPlatform(),
): boolean {
    const overrides = readShortcutOverrides();
    overrides[resolveShortcutOverridePlatform(platform)] = {};
    if (!hasAnyShortcutOverrides(overrides)) {
        return safeStorageRemoveItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    }
    return writeShortcutOverrides(overrides);
}

export function subscribeShortcutOverrides(
    listener: (overrides: ShortcutOverrides) => void,
) {
    return subscribeSafeStorage((event) => {
        if (event.key !== SHORTCUT_OVERRIDES_STORAGE_KEY) {
            return;
        }
        listener(parseShortcutOverrides(event.newValue));
    });
}
