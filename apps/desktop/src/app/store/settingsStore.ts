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
    editorActiveLineHighlight: boolean;
    justifyText: boolean;
    livePreviewEnabled: boolean;
    aiReviewEnabled: boolean;
    inlineReviewEnabled: boolean;
    hoverPreviewEnabled: boolean;
    hoverPreviewDelayMs: number; // 0–2000
    pdfFilter: PdfFilterMode;
    pdfDefaultZoom: PdfDefaultZoom;
    tabSize: 2 | 4;
    editorSpellcheck: boolean;
    spellcheckPrimaryLanguage: SpellcheckLanguage;
    spellcheckSecondaryLanguage: SpellcheckSecondaryLanguage;
    grammarCheckEnabled: boolean;
    grammarCheckServerUrl: string;
    vimModeEnabled: boolean;
    vimRelativeLineNumbers: boolean;

    // Navigation
    fileTreeScale: number; // 90–140
    agentsSidebarScale: number; // 90–140
    fileTreeStickyFolders: boolean;
    tabOpenBehavior: TabOpenBehavior;

    // Terminal
    terminalFontFamily: string;
    terminalFontSize: number; // 8–24
    claudeCodeOptimized: boolean;
    claudeCodeSkipPermissions: boolean;
    claudeCodeModel: string; // "" = Claude Code default
    claudeCodeContinueSession: boolean;

    // Developers
    fileTreeContentMode: "notes_only" | "all_files";
    fileTreeShowExtensions: boolean;
    fileTreeShowDocumentStatus: boolean;
    fileTreeExtensionFilter: string[];
}

interface SettingsStore extends Settings {
    setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    reset: () => void;
}

const SETTINGS_KEY_PREFIX = "neverwrite:settings:";
const SETTINGS_KEY_FALLBACK = "neverwrite:settings";
const LAST_VAULT_KEY = "neverwrite:lastVaultPath";
const GLOBAL_SETTING_KEYS = [
    "vimModeEnabled",
    "vimRelativeLineNumbers",
    "hoverPreviewEnabled",
    "hoverPreviewDelayMs",
] as const;

type GlobalSettingKey = (typeof GLOBAL_SETTING_KEYS)[number];

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
    | "fliege-mono"
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
export type PdfFilterMode = "none" | "dark" | "sepia" | "grayscale";

/**
 * Initial zoom applied when a PDF is opened. "fit-width" scales the page so
 * its width fills the viewport; a number is a fixed zoom factor (1 = 100%).
 */
export type PdfDefaultZoom = "fit-width" | number;

// Fixed zoom factors offered as a default, mirroring the PDF viewer's steps.
export const PDF_DEFAULT_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

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
    "fliege-mono",
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

const VALID_PDF_FILTER_MODES: PdfFilterMode[] = [
    "none",
    "dark",
    "sepia",
    "grayscale",
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
    { value: "fliege-mono", label: "Fliege Mono", group: "Mono" },
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
    editorActiveLineHighlight: true,
    justifyText: false,
    livePreviewEnabled: true,
    aiReviewEnabled: true,
    inlineReviewEnabled: true,
    hoverPreviewEnabled: true,
    hoverPreviewDelayMs: 300,
    pdfFilter: "none",
    pdfDefaultZoom: "fit-width",
    tabSize: 2,
    editorSpellcheck: false,
    spellcheckPrimaryLanguage: "system",
    spellcheckSecondaryLanguage: null,
    grammarCheckEnabled: false,
    grammarCheckServerUrl: "",
    vimModeEnabled: false,
    vimRelativeLineNumbers: false,
    fileTreeScale: 114,
    agentsSidebarScale: 100,
    fileTreeStickyFolders: true,
    tabOpenBehavior: "history",
    terminalFontFamily: "",
    terminalFontSize: 13,
    claudeCodeOptimized: false,
    claudeCodeSkipPermissions: false,
    claudeCodeModel: "",
    claudeCodeContinueSession: false,
    fileTreeContentMode: "notes_only",
    fileTreeShowExtensions: false,
    fileTreeShowDocumentStatus: true,
    fileTreeExtensionFilter: [],
};

function normalizeFileTreeContentMode(
    value: unknown,
): Settings["fileTreeContentMode"] {
    return value === "all_files" ? "all_files" : "notes_only";
}

function normalizeFileTreeExtensionFilter(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") continue;
        const extension = item.trim().replace(/^\.+/, "").toLowerCase();
        if (!extension || seen.has(extension)) continue;
        seen.add(extension);
        normalized.push(extension);
    }

    return normalized;
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

function normalizePdfFilterMode(value: unknown): PdfFilterMode {
    return VALID_PDF_FILTER_MODES.includes(value as PdfFilterMode)
        ? (value as PdfFilterMode)
        : defaults.pdfFilter;
}

function normalizePdfDefaultZoom(value: unknown): PdfDefaultZoom {
    if (value === "fit-width") {
        return "fit-width";
    }

    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : NaN;

    if (!Number.isFinite(parsed)) {
        return defaults.pdfDefaultZoom;
    }

    const match = PDF_DEFAULT_ZOOM_STEPS.find(
        (step) => Math.abs(step - parsed) < 0.001,
    );
    return match ?? defaults.pdfDefaultZoom;
}

/**
 * Resolves the configured default PDF zoom into the concrete state a new PDF
 * tab should start with. Read at tab-creation time so the setting applies to
 * newly opened PDFs without disturbing already-open tabs.
 */
export function resolvePdfInitialZoom(): { zoom: number; fitWidth: boolean } {
    const value = useSettingsStore.getState().pdfDefaultZoom;
    if (value === "fit-width") {
        return { zoom: 1, fitWidth: true };
    }
    return { zoom: value, fitWidth: false };
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

function extractPersistedState(raw: string | null): Partial<Settings> | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as { state?: unknown };
        if (!parsed?.state || typeof parsed.state !== "object") return null;
        return parsed.state as Partial<Settings>;
    } catch {
        return null;
    }
}

function hasVaultScopedSettings(raw: string | null) {
    const state = extractPersistedState(raw);
    if (!state) return false;

    return Object.keys(state).some(
        (key) => !GLOBAL_SETTING_KEYS.includes(key as GlobalSettingKey),
    );
}

function hasStoredGlobalSettings(raw: string | null) {
    const state = extractPersistedState(raw);
    if (!state) return false;

    return GLOBAL_SETTING_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(state, key),
    );
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
            editorActiveLineHighlight:
                parsed.state.editorActiveLineHighlight ??
                defaults.editorActiveLineHighlight,
            justifyText: parsed.state.justifyText ?? defaults.justifyText,
            livePreviewEnabled:
                parsed.state.livePreviewEnabled ?? defaults.livePreviewEnabled,
            aiReviewEnabled:
                parsed.state.aiReviewEnabled ?? defaults.aiReviewEnabled,
            inlineReviewEnabled:
                parsed.state.inlineReviewEnabled ??
                defaults.inlineReviewEnabled,
            hoverPreviewEnabled:
                parsed.state.hoverPreviewEnabled ??
                defaults.hoverPreviewEnabled,
            hoverPreviewDelayMs: normalizeIntInRange(
                parsed.state.hoverPreviewDelayMs,
                defaults.hoverPreviewDelayMs,
                0,
                2000,
            ),
            pdfFilter: normalizePdfFilterMode(parsed.state.pdfFilter),
            pdfDefaultZoom: normalizePdfDefaultZoom(
                parsed.state.pdfDefaultZoom,
            ),
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
            vimModeEnabled:
                parsed.state.vimModeEnabled ?? defaults.vimModeEnabled,
            vimRelativeLineNumbers:
                parsed.state.vimRelativeLineNumbers ??
                defaults.vimRelativeLineNumbers,
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
            terminalFontFamily:
                typeof parsed.state.terminalFontFamily === "string"
                    ? parsed.state.terminalFontFamily
                    : defaults.terminalFontFamily,
            terminalFontSize: normalizeIntInRange(
                parsed.state.terminalFontSize,
                defaults.terminalFontSize,
                8,
                24,
            ),
            claudeCodeOptimized:
                parsed.state.claudeCodeOptimized ??
                defaults.claudeCodeOptimized,
            claudeCodeSkipPermissions:
                parsed.state.claudeCodeSkipPermissions ??
                defaults.claudeCodeSkipPermissions,
            claudeCodeModel:
                typeof parsed.state.claudeCodeModel === "string"
                    ? parsed.state.claudeCodeModel
                    : defaults.claudeCodeModel,
            claudeCodeContinueSession:
                parsed.state.claudeCodeContinueSession ??
                defaults.claudeCodeContinueSession,
            fileTreeContentMode: normalizeFileTreeContentMode(
                parsed.state.fileTreeContentMode,
            ),
            fileTreeShowExtensions:
                parsed.state.fileTreeShowExtensions ??
                defaults.fileTreeShowExtensions,
            fileTreeShowDocumentStatus:
                parsed.state.fileTreeShowDocumentStatus ??
                defaults.fileTreeShowDocumentStatus,
            fileTreeExtensionFilter: normalizeFileTreeExtensionFilter(
                parsed.state.fileTreeExtensionFilter,
            ),
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
        editorActiveLineHighlight: state.editorActiveLineHighlight,
        justifyText: state.justifyText,
        livePreviewEnabled: state.livePreviewEnabled,
        aiReviewEnabled: state.aiReviewEnabled,
        inlineReviewEnabled: state.inlineReviewEnabled,
        hoverPreviewEnabled: state.hoverPreviewEnabled,
        hoverPreviewDelayMs: state.hoverPreviewDelayMs,
        pdfFilter: state.pdfFilter,
        pdfDefaultZoom: state.pdfDefaultZoom,
        tabSize: state.tabSize,
        editorSpellcheck: state.editorSpellcheck,
        spellcheckPrimaryLanguage: state.spellcheckPrimaryLanguage,
        spellcheckSecondaryLanguage: state.spellcheckSecondaryLanguage,
        grammarCheckEnabled: state.grammarCheckEnabled,
        grammarCheckServerUrl: state.grammarCheckServerUrl,
        vimModeEnabled: state.vimModeEnabled,
        vimRelativeLineNumbers: state.vimRelativeLineNumbers,
        fileTreeScale: state.fileTreeScale,
        agentsSidebarScale: state.agentsSidebarScale,
        fileTreeStickyFolders: state.fileTreeStickyFolders,
        tabOpenBehavior: state.tabOpenBehavior,
        terminalFontFamily: state.terminalFontFamily,
        terminalFontSize: state.terminalFontSize,
        claudeCodeOptimized: state.claudeCodeOptimized,
        claudeCodeSkipPermissions: state.claudeCodeSkipPermissions,
        claudeCodeModel: state.claudeCodeModel,
        claudeCodeContinueSession: state.claudeCodeContinueSession,
        fileTreeContentMode: state.fileTreeContentMode,
        fileTreeShowExtensions: state.fileTreeShowExtensions,
        fileTreeShowDocumentStatus: state.fileTreeShowDocumentStatus,
        fileTreeExtensionFilter: state.fileTreeExtensionFilter,
    };
}

function pickVaultSettings(settings: Settings): Partial<Settings> {
    const vaultSettings: Partial<Settings> = { ...settings };
    for (const key of GLOBAL_SETTING_KEYS) {
        delete vaultSettings[key];
    }
    return vaultSettings;
}

function pickGlobalSettings(
    settings: Settings,
): Pick<Settings, GlobalSettingKey> {
    return {
        vimModeEnabled: settings.vimModeEnabled,
        vimRelativeLineNumbers: settings.vimRelativeLineNumbers,
        hoverPreviewEnabled: settings.hoverPreviewEnabled,
        hoverPreviewDelayMs: settings.hoverPreviewDelayMs,
    };
}

function mergeGlobalSettings(settings: Settings): Settings {
    const global = extractSettingsFromStorage(
        safeStorageGetItem(SETTINGS_KEY_FALLBACK),
    );
    if (!global) return settings;

    return {
        ...settings,
        ...pickGlobalSettings(global),
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
        const globalRaw = safeStorageGetItem(SETTINGS_KEY_FALLBACK);
        if (!hasVaultScopedSettings(globalRaw)) return;
        const global = extractSettingsFromStorage(globalRaw);
        if (!global) return;
        safeStorageSetItem(
            vaultKey,
            JSON.stringify({
                state: {
                    ...pickVaultSettings(global),
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

function migrateVaultGlobalSettingsToGlobal(vaultRaw: string | null) {
    try {
        if (
            hasStoredGlobalSettings(safeStorageGetItem(SETTINGS_KEY_FALLBACK))
        ) {
            return;
        }
        if (!hasStoredGlobalSettings(vaultRaw)) return;

        const vaultSettings = extractSettingsFromStorage(vaultRaw);
        if (!vaultSettings) return;
        saveGlobalSettings(vaultSettings);
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
        if (vaultPath) {
            migrateVaultGlobalSettingsToGlobal(raw);
        }
        const settings = extractSettingsFromStorage(raw) ?? defaults;
        return vaultPath ? mergeGlobalSettings(settings) : settings;
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
        if (vaultPath) {
            safeStorageSetItem(
                getStorageKey(vaultPath),
                JSON.stringify({ state: pickVaultSettings(settings) }),
            );
            saveGlobalSettings(settings);
            return;
        }

        safeStorageSetItem(
            SETTINGS_KEY_FALLBACK,
            JSON.stringify({ state: settings }),
        );
    } catch {
        // localStorage unavailable (e.g. during test module init)
    }
}

function saveGlobalSettings(settings: Settings) {
    const existing = extractPersistedState(
        safeStorageGetItem(SETTINGS_KEY_FALLBACK),
    );

    safeStorageSetItem(
        SETTINGS_KEY_FALLBACK,
        JSON.stringify({
            state: {
                ...(existing ?? {}),
                ...pickGlobalSettings(settings),
            },
        }),
    );
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

            if (key === "fileTreeExtensionFilter") {
                return {
                    fileTreeExtensionFilter:
                        normalizeFileTreeExtensionFilter(value),
                };
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
