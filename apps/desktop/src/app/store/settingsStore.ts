import { create } from "zustand";
import { readSearchParam } from "../utils/safeBrowser";
import {
    safeStorageGetItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../utils/safeStorage";
import { useVaultStore } from "./vaultStore";

export interface Settings {
    // General
    openLastVaultOnLaunch: boolean;

    // Editor
    editorFontSize: number; // 10–24
    editorFontFamily: EditorFontFamily;
    editorLineHeight: number; // 120–220 (percentage)
    editorAutosaveDelayMs: number; // 50–5000
    editorContentWidth: number; // 600–1200
    lineWrapping: boolean;
    justifyText: boolean;
    livePreviewEnabled: boolean;
    inlineReviewEnabled: boolean;
    tabSize: 2 | 4;
    editorSpellcheck: boolean;
    spellcheckPrimaryLanguage: SpellcheckLanguage;
    spellcheckSecondaryLanguage: SpellcheckSecondaryLanguage;
    grammarCheckEnabled: boolean;
    grammarCheckServerUrl: string;

    // Navigation
    fileTreeScale: number; // 90–140
    agentsSidebarScale: number; // 90–140
    fileTreeStickyFolders: boolean;
    tabOpenBehavior: TabOpenBehavior;

    // Developers
    developerModeEnabled: boolean;
    developerTerminalEnabled: boolean;
    fileTreeContentMode: "notes_only" | "all_files";
    fileTreeShowExtensions: boolean;
}

interface SettingsStore extends Settings {
    setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    reset: () => void;
}

const SETTINGS_KEY_PREFIX = "neverwrite:settings:";
const SETTINGS_KEY_FALLBACK = "neverwrite:settings";
const LAST_VAULT_KEY = "neverwrite:lastVaultPath";

export type EditorFontFamily =
    | "system"
    | "sans"
    | "geist"
    | "atkinson"
    | "serif"
    | "literata"
    | "lora"
    | "merriweather"
    | "source-serif"
    | "mono"
    | "jetbrains"
    | "geist-mono"
    | "ibm-plex-mono"
    | "courier"
    | "reading"
    | "rounded"
    | "humanist"
    | "slab"
    | "typewriter"
    | "newspaper"
    | "condensed"
    | "andale";

export type TabOpenBehavior = "history" | "new_tab";
export type SpellcheckLanguage = "system" | string;
export type SpellcheckSecondaryLanguage = string | null;

const VALID_EDITOR_FONT_FAMILIES: EditorFontFamily[] = [
    "system",
    "sans",
    "geist",
    "atkinson",
    "serif",
    "literata",
    "lora",
    "merriweather",
    "source-serif",
    "mono",
    "jetbrains",
    "geist-mono",
    "ibm-plex-mono",
    "courier",
    "reading",
    "rounded",
    "humanist",
    "slab",
    "typewriter",
    "newspaper",
    "condensed",
    "andale",
];

export const EDITOR_FONT_FAMILY_OPTIONS: {
    value: EditorFontFamily;
    label: string;
    group: "Sans" | "Serif" | "Mono";
}[] = [
    { value: "system", label: "System", group: "Sans" },
    { value: "sans", label: "Inter", group: "Sans" },
    { value: "geist", label: "Geist", group: "Sans" },
    {
        value: "atkinson",
        label: "Atkinson Hyperlegible",
        group: "Sans",
    },
    { value: "rounded", label: "Rounded (SF Pro)", group: "Sans" },
    { value: "humanist", label: "Optima", group: "Sans" },
    { value: "condensed", label: "Condensed", group: "Sans" },
    { value: "literata", label: "Literata", group: "Serif" },
    { value: "lora", label: "Lora", group: "Serif" },
    { value: "merriweather", label: "Merriweather", group: "Serif" },
    { value: "reading", label: "Charter", group: "Serif" },
    { value: "serif", label: "Palatino", group: "Serif" },
    { value: "source-serif", label: "Source Serif", group: "Serif" },
    {
        value: "newspaper",
        label: "Times New Roman",
        group: "Serif",
    },
    { value: "slab", label: "Rockwell Slab", group: "Serif" },
    { value: "mono", label: "Monospace (JetBrains)", group: "Mono" },
    { value: "jetbrains", label: "JetBrains Mono", group: "Mono" },
    { value: "geist-mono", label: "Geist Mono", group: "Mono" },
    { value: "ibm-plex-mono", label: "IBM Plex Mono", group: "Mono" },
    { value: "courier", label: "Courier New", group: "Mono" },
    { value: "andale", label: "Andale Mono", group: "Mono" },
    { value: "typewriter", label: "Typewriter", group: "Mono" },
];

const defaults: Settings = {
    openLastVaultOnLaunch: true,
    editorFontSize: 14,
    editorFontFamily: "system",
    editorLineHeight: 175,
    editorAutosaveDelayMs: 300,
    editorContentWidth: 940,
    lineWrapping: true,
    justifyText: false,
    livePreviewEnabled: true,
    inlineReviewEnabled: true,
    tabSize: 2,
    editorSpellcheck: false,
    spellcheckPrimaryLanguage: "system",
    spellcheckSecondaryLanguage: null,
    grammarCheckEnabled: false,
    grammarCheckServerUrl: "",
    fileTreeScale: 114,
    agentsSidebarScale: 100,
    fileTreeStickyFolders: true,
    tabOpenBehavior: "history",
    developerModeEnabled: false,
    developerTerminalEnabled: true,
    fileTreeContentMode: "notes_only",
    fileTreeShowExtensions: false,
};

function normalizeFileTreeContentMode(
    value: unknown,
): Settings["fileTreeContentMode"] {
    return value === "all_files" ? "all_files" : "notes_only";
}

function normalizeTabOpenBehavior(value: unknown): TabOpenBehavior {
    return value === "new_tab" ? "new_tab" : "history";
}

function normalizeIntInRange(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : NaN;

    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeTabSize(value: unknown): 2 | 4 {
    const normalized = normalizeIntInRange(value, defaults.tabSize, 2, 4);
    return normalized <= 2 ? 2 : 4;
}

function normalizeSpellcheckLanguageTag(value: string) {
    const normalized = value.trim().replace(/_/g, "-");
    if (!normalized) {
        return "";
    }

    return normalized
        .split("-")
        .filter(Boolean)
        .map((segment, index) => {
            if (index === 0) {
                return segment.toLowerCase();
            }

            if (/^[A-Za-z]{2}$/.test(segment)) {
                return segment.toUpperCase();
            }

            if (/^\d+$/.test(segment)) {
                return segment;
            }

            return segment[0]?.toUpperCase() + segment.slice(1).toLowerCase();
        })
        .join("-");
}

function normalizeSpellcheckLanguage(value: unknown): SpellcheckLanguage {
    if (typeof value !== "string") {
        return "system";
    }

    const normalized = normalizeSpellcheckLanguageTag(value);
    return normalized.length > 0 ? normalized : "system";
}

function normalizeSpellcheckSecondaryLanguage(
    value: unknown,
): SpellcheckSecondaryLanguage {
    if (value == null || value === "") {
        return null;
    }

    if (typeof value !== "string") {
        return null;
    }

    const normalized = normalizeSpellcheckLanguageTag(value);
    if (!normalized || normalized.toLowerCase() === "system") {
        return null;
    }

    return normalized;
}

function normalizeSpellcheckLanguagePair(
    primary: unknown,
    secondary: unknown,
): {
    primary: SpellcheckLanguage;
    secondary: SpellcheckSecondaryLanguage;
} {
    const normalizedPrimary = normalizeSpellcheckLanguage(primary);
    const normalizedSecondary = normalizeSpellcheckSecondaryLanguage(secondary);

    return {
        primary: normalizedPrimary,
        secondary:
            normalizedSecondary === normalizedPrimary
                ? null
                : normalizedSecondary,
    };
}

export function normalizeEditorFontFamily(
    value: unknown,
    fallback: EditorFontFamily = defaults.editorFontFamily,
): EditorFontFamily {
    if (typeof value !== "string") return fallback;
    return VALID_EDITOR_FONT_FAMILIES.includes(value as EditorFontFamily)
        ? (value as EditorFontFamily)
        : fallback;
}

function extractSettingsFromStorage(raw: string | null): Settings | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as {
            state?: Partial<Settings> & {
                spellcheckLanguage?: SpellcheckLanguage;
            };
        };
        if (!parsed?.state) return null;
        const normalizedSpellcheckLanguages = normalizeSpellcheckLanguagePair(
            parsed.state.spellcheckPrimaryLanguage ??
                parsed.state.spellcheckLanguage,
            parsed.state.spellcheckSecondaryLanguage,
        );

        return {
            openLastVaultOnLaunch:
                parsed.state.openLastVaultOnLaunch ??
                defaults.openLastVaultOnLaunch,
            editorFontSize: normalizeIntInRange(
                parsed.state.editorFontSize,
                defaults.editorFontSize,
                10,
                24,
            ),
            editorFontFamily: normalizeEditorFontFamily(
                parsed.state.editorFontFamily,
            ),
            editorLineHeight: normalizeIntInRange(
                parsed.state.editorLineHeight,
                defaults.editorLineHeight,
                120,
                220,
            ),
            editorAutosaveDelayMs: normalizeIntInRange(
                parsed.state.editorAutosaveDelayMs,
                defaults.editorAutosaveDelayMs,
                50,
                5000,
            ),
            editorContentWidth: normalizeIntInRange(
                parsed.state.editorContentWidth,
                defaults.editorContentWidth,
                600,
                1200,
            ),
            lineWrapping: parsed.state.lineWrapping ?? defaults.lineWrapping,
            justifyText: parsed.state.justifyText ?? defaults.justifyText,
            livePreviewEnabled:
                parsed.state.livePreviewEnabled ?? defaults.livePreviewEnabled,
            inlineReviewEnabled:
                parsed.state.inlineReviewEnabled ??
                defaults.inlineReviewEnabled,
            tabSize: normalizeTabSize(parsed.state.tabSize),
            editorSpellcheck:
                parsed.state.editorSpellcheck ?? defaults.editorSpellcheck,
            spellcheckPrimaryLanguage: normalizedSpellcheckLanguages.primary,
            spellcheckSecondaryLanguage:
                normalizedSpellcheckLanguages.secondary,
            grammarCheckEnabled:
                parsed.state.grammarCheckEnabled ??
                defaults.grammarCheckEnabled,
            grammarCheckServerUrl:
                typeof parsed.state.grammarCheckServerUrl === "string"
                    ? parsed.state.grammarCheckServerUrl.trim()
                    : defaults.grammarCheckServerUrl,
            fileTreeScale: normalizeIntInRange(
                parsed.state.fileTreeScale,
                defaults.fileTreeScale,
                90,
                140,
            ),
            agentsSidebarScale: normalizeIntInRange(
                parsed.state.agentsSidebarScale,
                defaults.agentsSidebarScale,
                90,
                140,
            ),
            fileTreeStickyFolders:
                parsed.state.fileTreeStickyFolders ??
                defaults.fileTreeStickyFolders,
            tabOpenBehavior: normalizeTabOpenBehavior(
                parsed.state.tabOpenBehavior,
            ),
            developerModeEnabled:
                parsed.state.developerModeEnabled ??
                defaults.developerModeEnabled,
            developerTerminalEnabled:
                parsed.state.developerTerminalEnabled ??
                defaults.developerTerminalEnabled,
            fileTreeContentMode: normalizeFileTreeContentMode(
                parsed.state.fileTreeContentMode,
            ),
            fileTreeShowExtensions:
                parsed.state.fileTreeShowExtensions ??
                defaults.fileTreeShowExtensions,
        };
    } catch {
        return null;
    }
}

function hasStoredSpellcheckSettings(raw: string | null) {
    if (!raw) return false;

    try {
        const parsed = JSON.parse(raw) as {
            state?: Partial<Settings> & {
                spellcheckLanguage?: SpellcheckLanguage;
            };
        };

        if (!parsed?.state || typeof parsed.state !== "object") {
            return false;
        }

        return (
            Object.prototype.hasOwnProperty.call(
                parsed.state,
                "spellcheckPrimaryLanguage",
            ) ||
            Object.prototype.hasOwnProperty.call(
                parsed.state,
                "spellcheckSecondaryLanguage",
            ) ||
            Object.prototype.hasOwnProperty.call(
                parsed.state,
                "spellcheckLanguage",
            )
        );
    } catch {
        return false;
    }
}

function pickSettings(state: SettingsStore): Settings {
    return {
        openLastVaultOnLaunch: state.openLastVaultOnLaunch,
        editorFontSize: state.editorFontSize,
        editorFontFamily: state.editorFontFamily,
        editorLineHeight: state.editorLineHeight,
        editorAutosaveDelayMs: state.editorAutosaveDelayMs,
        editorContentWidth: state.editorContentWidth,
        lineWrapping: state.lineWrapping,
        justifyText: state.justifyText,
        livePreviewEnabled: state.livePreviewEnabled,
        inlineReviewEnabled: state.inlineReviewEnabled,
        tabSize: state.tabSize,
        editorSpellcheck: state.editorSpellcheck,
        spellcheckPrimaryLanguage: state.spellcheckPrimaryLanguage,
        spellcheckSecondaryLanguage: state.spellcheckSecondaryLanguage,
        grammarCheckEnabled: state.grammarCheckEnabled,
        grammarCheckServerUrl: state.grammarCheckServerUrl,
        fileTreeScale: state.fileTreeScale,
        agentsSidebarScale: state.agentsSidebarScale,
        fileTreeStickyFolders: state.fileTreeStickyFolders,
        tabOpenBehavior: state.tabOpenBehavior,
        developerModeEnabled: state.developerModeEnabled,
        developerTerminalEnabled: state.developerTerminalEnabled,
        fileTreeContentMode: state.fileTreeContentMode,
        fileTreeShowExtensions: state.fileTreeShowExtensions,
    };
}

function getStorageKey(vaultPath: string | null): string {
    return vaultPath
        ? `${SETTINGS_KEY_PREFIX}${vaultPath}`
        : SETTINGS_KEY_FALLBACK;
}

function migrateGlobalSettings(vaultPath: string) {
    try {
        const vaultKey = getStorageKey(vaultPath);
        if (safeStorageGetItem(vaultKey)) return; // already migrated
        const global = extractSettingsFromStorage(
            safeStorageGetItem(SETTINGS_KEY_FALLBACK),
        );
        if (!global) return;
        safeStorageSetItem(
            vaultKey,
            JSON.stringify({
                state: {
                    ...global,
                    editorSpellcheck: defaults.editorSpellcheck,
                },
            }),
        );
    } catch {
        // localStorage unavailable
    }
}

/**
 * Migrate spellcheck language settings from the global storage key into
 * the per-vault key. Previously these two settings were kept only in the
 * global fallback and stripped from vault storage. This one-time migration
 * copies them into the vault entry so each vault can diverge independently.
 */
function migrateGlobalSpellcheckToVault(vaultPath: string) {
    try {
        const vaultKey = getStorageKey(vaultPath);
        const vaultRaw = safeStorageGetItem(vaultKey);
        if (hasStoredSpellcheckSettings(vaultRaw)) return;

        const vaultSettings = extractSettingsFromStorage(vaultRaw);

        const globalRaw = safeStorageGetItem(SETTINGS_KEY_FALLBACK);
        if (!hasStoredSpellcheckSettings(globalRaw)) return;

        const globalSettings = extractSettingsFromStorage(globalRaw);
        if (!globalSettings) return;

        const merged = {
            ...vaultSettings,
            spellcheckPrimaryLanguage: globalSettings.spellcheckPrimaryLanguage,
            spellcheckSecondaryLanguage:
                globalSettings.spellcheckSecondaryLanguage,
        };
        safeStorageSetItem(vaultKey, JSON.stringify({ state: merged }));
    } catch {
        // localStorage unavailable
    }
}

function loadSettings(vaultPath: string | null): Settings {
    try {
        if (vaultPath) {
            migrateGlobalSettings(vaultPath);
            migrateGlobalSpellcheckToVault(vaultPath);
        }
        const raw = safeStorageGetItem(getStorageKey(vaultPath));
        return extractSettingsFromStorage(raw) ?? defaults;
    } catch {
        return defaults;
    }
}

export function readSettingsForVault(vaultPath: string | null): Settings {
    if (!settingsRuntimeInitialized || _currentVaultPath === vaultPath) {
        return pickSettings(useSettingsStore.getState());
    }
    return loadSettings(vaultPath);
}

function getEffectiveVaultPath(
    state: ReturnType<typeof useVaultStore.getState>,
) {
    return (
        state.vaultPath ?? (state.isLoading ? state.vaultOpenState.path : null)
    );
}

function saveSettings(vaultPath: string | null, settings: Settings) {
    try {
        safeStorageSetItem(
            getStorageKey(vaultPath),
            JSON.stringify({ state: settings }),
        );
    } catch {
        // localStorage unavailable (e.g. during test module init)
    }
}

// Read vault path synchronously at module load to avoid a flash of defaults.
// In a settings window the vault is passed as a URL param; otherwise fall back to localStorage.
function readInitialVaultPath(): string | null {
    try {
        const urlVault = readSearchParam("vault");
        if (urlVault) return decodeURIComponent(urlVault);
        return safeStorageGetItem(LAST_VAULT_KEY);
    } catch {
        return null;
    }
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
    ...defaults,
    setSetting: (key, value) =>
        set((state) => {
            if (
                key === "spellcheckPrimaryLanguage" ||
                key === "spellcheckSecondaryLanguage"
            ) {
                const nextPair = normalizeSpellcheckLanguagePair(
                    key === "spellcheckPrimaryLanguage"
                        ? value
                        : state.spellcheckPrimaryLanguage,
                    key === "spellcheckSecondaryLanguage"
                        ? value
                        : state.spellcheckSecondaryLanguage,
                );

                return {
                    spellcheckPrimaryLanguage: nextPair.primary,
                    spellcheckSecondaryLanguage: nextPair.secondary,
                } as Partial<Settings>;
            }

            return { [key]: value } as Partial<Settings>;
        }),
    reset: () => set(defaults),
}));

// Track the current vault path so the save subscriber always writes to the right key
let _currentVaultPath: string | null = null;
let _isApplyingExternal = false;
let settingsRuntimeInitialized = false;
let stopStorageSync: (() => void) | null = null;
let stopVaultSync: (() => void) | null = null;
let stopSettingsPersistence: (() => void) | null = null;

export function hydrateSettingsStore() {
    _currentVaultPath = readInitialVaultPath();
    useSettingsStore.setState(loadSettings(_currentVaultPath));
}

export function initializeSettingsStore() {
    if (settingsRuntimeInitialized) return;
    settingsRuntimeInitialized = true;

    hydrateSettingsStore();

    stopSettingsPersistence = useSettingsStore.subscribe((state) => {
        if (!_isApplyingExternal) {
            saveSettings(_currentVaultPath, pickSettings(state));
        }
    });

    stopStorageSync = subscribeSafeStorage((event) => {
        if (
            event.key !== getStorageKey(_currentVaultPath) &&
            event.key !== SETTINGS_KEY_FALLBACK
        ) {
            return;
        }
        const settings = extractSettingsFromStorage(event.newValue);
        if (!settings) {
            const reloaded = loadSettings(_currentVaultPath);
            _isApplyingExternal = true;
            useSettingsStore.setState(reloaded);
            _isApplyingExternal = false;
            return;
        }
        _isApplyingExternal = true;
        useSettingsStore.setState(loadSettings(_currentVaultPath));
        _isApplyingExternal = false;
    });

    stopVaultSync = useVaultStore.subscribe((state) => {
        const newVaultPath = getEffectiveVaultPath(state);
        if (newVaultPath === _currentVaultPath) return;
        _currentVaultPath = newVaultPath;
        useSettingsStore.setState(loadSettings(newVaultPath));
    });
}

export function disposeSettingsStoreRuntime() {
    stopSettingsPersistence?.();
    stopStorageSync?.();
    stopVaultSync?.();
    stopSettingsPersistence = null;
    stopStorageSync = null;
    stopVaultSync = null;
    settingsRuntimeInitialized = false;
}
