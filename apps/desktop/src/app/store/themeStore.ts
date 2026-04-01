import { create } from "zustand";
import { type ThemeName, applyThemeColors } from "../themes/index";
import { readSearchParam, safeMatchMedia } from "../utils/safeBrowser";
import {
    safeStorageGetItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../utils/safeStorage";
import { useVaultStore } from "./vaultStore";

export type ThemeMode = "system" | "light" | "dark";

interface ThemePreference {
    mode: ThemeMode;
    themeName: ThemeName;
}

interface ThemeStore {
    mode: ThemeMode;
    themeName: ThemeName;
    isDark: boolean;
    setMode: (mode: ThemeMode) => void;
    setThemeName: (name: ThemeName) => void;
}

const THEME_KEY_PREFIX = "vaultai:theme:";
const THEME_KEY_FALLBACK = "vaultai:theme";
const LAST_VAULT_KEY = "vaultai:lastVaultPath";
const DEFAULT_THEME: ThemePreference = { mode: "system", themeName: "default" };

const VALID_THEME_NAMES = new Set<ThemeName>([
    "default",
    "ocean",
    "forest",
    "rose",
    "amber",
    "lavender",
    "nord",
    "sunset",
    "catppuccin",
    "solarized",
    "tokyoNight",
    "gruvbox",
    "ayu",
    "nightOwl",
    "vesper",
    "rosePine",
    "kanagawa",
    "everforest",
    "synthwave84",
    "claude",
    "codex",
]);

function normalizeThemeMode(value: unknown): ThemeMode {
    return value === "light" || value === "dark" || value === "system"
        ? value
        : "system";
}

function normalizeThemeName(value: unknown): ThemeName {
    return typeof value === "string" &&
        VALID_THEME_NAMES.has(value as ThemeName)
        ? (value as ThemeName)
        : "default";
}

function getStorageKey(vaultPath: string | null): string {
    return vaultPath ? `${THEME_KEY_PREFIX}${vaultPath}` : THEME_KEY_FALLBACK;
}

function parseStoredTheme(raw: string | null): ThemePreference | null {
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as
            | {
                  mode?: unknown;
                  themeName?: unknown;
                  state?: { mode?: unknown; themeName?: unknown };
              }
            | string;

        if (typeof parsed === "string") {
            return { mode: normalizeThemeMode(parsed), themeName: "default" };
        }

        return {
            mode: normalizeThemeMode(parsed.state?.mode ?? parsed.mode),
            themeName: normalizeThemeName(
                parsed.state?.themeName ?? parsed.themeName,
            ),
        };
    } catch {
        return null;
    }
}

function getIsDark(mode: ThemeMode): boolean {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return safeMatchMedia("(prefers-color-scheme: dark)")?.matches ?? false;
}

function applyDark(isDark: boolean) {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", isDark);
}

function resolveTheme(mode: ThemeMode, themeName: ThemeName) {
    const isDark = getIsDark(mode);
    applyDark(isDark);
    applyThemeColors(themeName, isDark);
    return { mode, themeName, isDark };
}

function migrateGlobalTheme(vaultPath: string) {
    const vaultKey = getStorageKey(vaultPath);
    if (safeStorageGetItem(vaultKey)) return;

    const global = parseStoredTheme(safeStorageGetItem(THEME_KEY_FALLBACK));
    if (!global) return;

    safeStorageSetItem(vaultKey, JSON.stringify(global));
}

function readInitialVaultPath(): string | null {
    try {
        const urlVault = readSearchParam("vault");
        if (urlVault) return decodeURIComponent(urlVault);
    } catch {
        // Fall back to persisted storage below.
    }

    return safeStorageGetItem(LAST_VAULT_KEY);
}

function loadTheme(vaultPath: string | null): ThemePreference {
    if (vaultPath) {
        migrateGlobalTheme(vaultPath);
    }

    return (
        parseStoredTheme(safeStorageGetItem(getStorageKey(vaultPath))) ??
        DEFAULT_THEME
    );
}

function getEffectiveVaultPath(
    state: ReturnType<typeof useVaultStore.getState>,
) {
    return (
        state.vaultPath ?? (state.isLoading ? state.vaultOpenState.path : null)
    );
}

function saveTheme(vaultPath: string | null, preference: ThemePreference) {
    safeStorageSetItem(getStorageKey(vaultPath), JSON.stringify(preference));
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
    mode: DEFAULT_THEME.mode,
    themeName: DEFAULT_THEME.themeName,
    isDark: false,
    setMode: (mode) => set(resolveTheme(mode, get().themeName)),
    setThemeName: (themeName) => set(resolveTheme(get().mode, themeName)),
}));

let themeRuntimeInitialized = false;
let currentVaultPath: string | null = null;
let stopStorageSync: (() => void) | null = null;
let stopVaultSync: (() => void) | null = null;
let stopThemePersistence: (() => void) | null = null;
let mediaQueryList: MediaQueryList | null = null;
let removeMediaListener: (() => void) | null = null;
let isApplyingExternal = false;

export function hydrateThemeStore() {
    try {
        currentVaultPath = readInitialVaultPath();
        const preference = loadTheme(currentVaultPath);
        useThemeStore.setState(
            resolveTheme(preference.mode, preference.themeName),
        );
    } catch (error) {
        console.warn("Failed to hydrate theme store:", error);
        useThemeStore.setState(
            resolveTheme(DEFAULT_THEME.mode, DEFAULT_THEME.themeName),
        );
    }
}

export function initializeThemeStore() {
    if (themeRuntimeInitialized) return;
    themeRuntimeInitialized = true;

    hydrateThemeStore();

    stopThemePersistence = useThemeStore.subscribe((state) => {
        applyDark(state.isDark);
        applyThemeColors(state.themeName, state.isDark);
        if (!isApplyingExternal) {
            saveTheme(currentVaultPath, {
                mode: state.mode,
                themeName: state.themeName,
            });
        }
    });

    stopStorageSync = subscribeSafeStorage((event) => {
        if (event.key !== getStorageKey(currentVaultPath)) return;

        const theme = parseStoredTheme(event.newValue);
        if (!theme) return;

        isApplyingExternal = true;
        useThemeStore.setState(resolveTheme(theme.mode, theme.themeName));
        isApplyingExternal = false;
    });

    stopVaultSync = useVaultStore.subscribe((state) => {
        const newVaultPath = getEffectiveVaultPath(state);
        if (newVaultPath === currentVaultPath) return;
        currentVaultPath = newVaultPath;
        const preference = loadTheme(newVaultPath);
        useThemeStore.setState(
            resolveTheme(preference.mode, preference.themeName),
        );
    });

    mediaQueryList = safeMatchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => {
        const state = useThemeStore.getState();
        if (state.mode !== "system") return;
        useThemeStore.setState(resolveTheme("system", state.themeName));
    };

    if (mediaQueryList) {
        mediaQueryList.addEventListener("change", onMediaChange);
        removeMediaListener = () => {
            mediaQueryList?.removeEventListener("change", onMediaChange);
        };
    }
}

export function disposeThemeStoreRuntime() {
    stopThemePersistence?.();
    stopStorageSync?.();
    stopVaultSync?.();
    removeMediaListener?.();
    stopThemePersistence = null;
    stopStorageSync = null;
    stopVaultSync = null;
    removeMediaListener = null;
    mediaQueryList = null;
    themeRuntimeInitialized = false;
}
