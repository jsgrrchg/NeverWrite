import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Settings {
    // General
    autoSave: boolean;
    autoSaveDelay: number; // ms: 500 | 1000 | 2000 | 5000
    openLastVaultOnLaunch: boolean;

    // Editor
    editorFontSize: number; // 10–24
    editorFontFamily: EditorFontFamily;
    editorContentWidth: number; // 600–1200
    lineWrapping: boolean;
    justifyText: boolean;
    tabSize: 2 | 4;

    // Navigation
    fileTreeScale: number; // 90–140
}

interface SettingsStore extends Settings {
    setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    reset: () => void;
}

const SETTINGS_STORAGE_KEY = "vaultai:settings";
const SETTINGS_BROADCAST_CHANNEL = "vaultai:settings-sync";

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
    autoSave: true,
    autoSaveDelay: 1000,
    openLastVaultOnLaunch: true,
    editorFontSize: 14,
    editorFontFamily: "system",
    editorContentWidth: 860,
    lineWrapping: true,
    justifyText: false,
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
            autoSave: parsed.state.autoSave ?? defaults.autoSave,
            autoSaveDelay: parsed.state.autoSaveDelay ?? defaults.autoSaveDelay,
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
            editorContentWidth: normalizeIntInRange(
                parsed.state.editorContentWidth,
                defaults.editorContentWidth,
                600,
                1200,
            ),
            lineWrapping: parsed.state.lineWrapping ?? defaults.lineWrapping,
            justifyText: parsed.state.justifyText ?? defaults.justifyText,
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
        autoSave: state.autoSave,
        autoSaveDelay: state.autoSaveDelay,
        openLastVaultOnLaunch: state.openLastVaultOnLaunch,
        editorFontSize: state.editorFontSize,
        editorFontFamily: state.editorFontFamily,
        editorContentWidth: state.editorContentWidth,
        lineWrapping: state.lineWrapping,
        justifyText: state.justifyText,
        tabSize: state.tabSize,
        fileTreeScale: state.fileTreeScale,
    };
}

export const useSettingsStore = create<SettingsStore>()(
    persist(
        (set) => ({
            ...defaults,
            setSetting: (key, value) =>
                set({ [key]: value } as Partial<Settings>),
            reset: () => set(defaults),
        }),
        { name: SETTINGS_STORAGE_KEY },
    ),
);

let isApplyingRemoteSettings = false;

if (typeof window !== "undefined") {
    const syncId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : String(Date.now());
    const channel =
        "BroadcastChannel" in window
            ? new BroadcastChannel(SETTINGS_BROADCAST_CHANNEL)
            : null;

    const applyRemoteSettings = (settings: Settings | null) => {
        if (!settings) return;
        isApplyingRemoteSettings = true;
        useSettingsStore.setState(settings);
        isApplyingRemoteSettings = false;
    };

    channel?.addEventListener("message", (event) => {
        const payload = event.data as
            | { source?: string; settings?: Settings }
            | undefined;
        if (!payload?.settings || payload.source === syncId) return;
        applyRemoteSettings(payload.settings);
    });

    window.addEventListener("storage", (event) => {
        if (event.key !== SETTINGS_STORAGE_KEY) return;
        applyRemoteSettings(extractSettingsFromStorage(event.newValue));
    });

    useSettingsStore.subscribe((state) => {
        if (isApplyingRemoteSettings) return;
        channel?.postMessage({
            source: syncId,
            settings: pickSettings(state),
        });
    });
}
