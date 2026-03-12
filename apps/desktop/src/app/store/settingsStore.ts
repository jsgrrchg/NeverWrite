import { create } from "zustand";
import { useVaultStore } from "./vaultStore";

export interface Settings {
    // General
    openLastVaultOnLaunch: boolean;

    // Editor
    editorFontSize: number; // 10–24
    editorFontFamily: EditorFontFamily;
    editorLineHeight: number; // 120–220 (percentage)
    editorContentWidth: number; // 600–1200
    lineWrapping: boolean;
    justifyText: boolean;
    livePreviewEnabled: boolean;
    tabSize: 2 | 4;

    // Navigation
    fileTreeScale: number; // 90–140
}

interface SettingsStore extends Settings {
    setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    reset: () => void;
}

const SETTINGS_KEY_PREFIX = "vaultai:settings:";
const SETTINGS_KEY_FALLBACK = "vaultai:settings";
const LAST_VAULT_KEY = "vaultai:lastVaultPath";

export type EditorFontFamily =
    | "system"
    | "sans"
    | "serif"
    | "mono"
    | "courier"
    | "reading"
    | "rounded"
    | "humanist"
    | "slab"
    | "typewriter"
    | "newspaper"
    | "condensed";

const VALID_EDITOR_FONT_FAMILIES: EditorFontFamily[] = [
    "system",
    "sans",
    "serif",
    "mono",
    "courier",
    "reading",
    "rounded",
    "humanist",
    "slab",
    "typewriter",
    "newspaper",
    "condensed",
];

const defaults: Settings = {
    openLastVaultOnLaunch: true,
    editorFontSize: 14,
    editorFontFamily: "system",
    editorLineHeight: 150,
    editorContentWidth: 860,
    lineWrapping: true,
    justifyText: false,
    livePreviewEnabled: true,
    tabSize: 4,
    fileTreeScale: 100,
};

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

function normalizeEditorFontFamily(
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
        const parsed = JSON.parse(raw) as { state?: Partial<Settings> };
        if (!parsed?.state) return null;

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
            tabSize: normalizeTabSize(parsed.state.tabSize),
            fileTreeScale: normalizeIntInRange(
                parsed.state.fileTreeScale,
                defaults.fileTreeScale,
                90,
                140,
            ),
        };
    } catch {
        return null;
    }
}

function pickSettings(state: SettingsStore): Settings {
    return {
        openLastVaultOnLaunch: state.openLastVaultOnLaunch,
        editorFontSize: state.editorFontSize,
        editorFontFamily: state.editorFontFamily,
        editorLineHeight: state.editorLineHeight,
        editorContentWidth: state.editorContentWidth,
        lineWrapping: state.lineWrapping,
        justifyText: state.justifyText,
        livePreviewEnabled: state.livePreviewEnabled,
        tabSize: state.tabSize,
        fileTreeScale: state.fileTreeScale,
    };
}

function getStorageKey(vaultPath: string | null): string {
    return vaultPath
        ? `${SETTINGS_KEY_PREFIX}${vaultPath}`
        : SETTINGS_KEY_FALLBACK;
}

function migrateGlobalSettings(vaultPath: string) {
    const vaultKey = getStorageKey(vaultPath);
    if (localStorage.getItem(vaultKey)) return; // already migrated
    const global = extractSettingsFromStorage(
        localStorage.getItem(SETTINGS_KEY_FALLBACK),
    );
    if (!global) return;
    localStorage.setItem(vaultKey, JSON.stringify({ state: global }));
}

function loadSettings(vaultPath: string | null): Settings {
    if (vaultPath) migrateGlobalSettings(vaultPath);
    const raw = localStorage.getItem(getStorageKey(vaultPath));
    return extractSettingsFromStorage(raw) ?? defaults;
}

function getEffectiveVaultPath(
    state: ReturnType<typeof useVaultStore.getState>,
) {
    return (
        state.vaultPath ?? (state.isLoading ? state.vaultOpenState.path : null)
    );
}

function saveSettings(vaultPath: string | null, settings: Settings) {
    localStorage.setItem(
        getStorageKey(vaultPath),
        JSON.stringify({ state: settings }),
    );
}

// Read vault path synchronously at module load to avoid a flash of defaults.
// In a settings window the vault is passed as a URL param; otherwise fall back to localStorage.
function readInitialVaultPath(): string | null {
    try {
        const urlVault = new URLSearchParams(window.location.search).get(
            "vault",
        );
        if (urlVault) return decodeURIComponent(urlVault);
        return localStorage.getItem(LAST_VAULT_KEY);
    } catch {
        return null;
    }
}

const initialVaultPath = readInitialVaultPath();

export const useSettingsStore = create<SettingsStore>()((set) => ({
    ...loadSettings(initialVaultPath),
    setSetting: (key, value) => set({ [key]: value } as Partial<Settings>),
    reset: () => set(defaults),
}));

// Track the current vault path so the save subscriber always writes to the right key
let _currentVaultPath: string | null = initialVaultPath;
let _isApplyingExternal = false;

// Persist on every settings change
useSettingsStore.subscribe((state) => {
    if (!_isApplyingExternal) {
        saveSettings(_currentVaultPath, pickSettings(state));
    }
});

// React to changes made by other windows (e.g. settings window) via localStorage
if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
        if (event.key !== getStorageKey(_currentVaultPath)) return;
        const settings = extractSettingsFromStorage(event.newValue);
        if (!settings) return;
        _isApplyingExternal = true;
        useSettingsStore.setState(settings);
        _isApplyingExternal = false;
    });
}

// Reload settings when the active vault changes
useVaultStore.subscribe((state) => {
    const newVaultPath = getEffectiveVaultPath(state);
    if (newVaultPath === _currentVaultPath) return;
    _currentVaultPath = newVaultPath;
    useSettingsStore.setState(loadSettings(newVaultPath));
});
