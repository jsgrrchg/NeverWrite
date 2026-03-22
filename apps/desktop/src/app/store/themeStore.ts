import { create } from "zustand";
import { type ThemeName, applyThemeColors } from "../themes/index";
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

function getIsDark(mode: ThemeMode): boolean {
    if (typeof window === "undefined") return false;
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
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

function getStorageKey(vaultPath: string | null): string {
    return vaultPath ? `${THEME_KEY_PREFIX}${vaultPath}` : THEME_KEY_FALLBACK;
}

function safeGetItem(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function migrateGlobalTheme(vaultPath: string) {
    const vaultKey = getStorageKey(vaultPath);
    if (safeGetItem(vaultKey)) return; // already migrated
    const global = parseStoredTheme(safeGetItem(THEME_KEY_FALLBACK));
    if (!global) return;
    try {
        localStorage.setItem(vaultKey, JSON.stringify(global));
    } catch {
        // localStorage unavailable
    }
}

function readInitialVaultPath(): string | null {
    try {
        const urlVault = new URLSearchParams(window.location.search).get(
            "vault",
        );
        if (urlVault) return decodeURIComponent(urlVault);
        return safeGetItem(LAST_VAULT_KEY);
    } catch {
        return null;
    }
}

function loadTheme(vaultPath: string | null): ThemePreference {
    if (vaultPath) migrateGlobalTheme(vaultPath);
    return (
        parseStoredTheme(safeGetItem(getStorageKey(vaultPath))) ?? DEFAULT_THEME
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
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
        getStorageKey(vaultPath),
        JSON.stringify(preference),
    );
}

const initialVaultPath = readInitialVaultPath();
const initialPreference = loadTheme(initialVaultPath);
const initialTheme = resolveTheme(
    initialPreference.mode,
    initialPreference.themeName,
);

export const useThemeStore = create<ThemeStore>((set, get) => ({
    ...initialTheme,
    setMode: (mode) => set(resolveTheme(mode, get().themeName)),
    setThemeName: (themeName) => set(resolveTheme(get().mode, themeName)),
}));

let _currentVaultPath: string | null = initialVaultPath;

if (typeof window !== "undefined") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    media.addEventListener("change", () => {
        const s = useThemeStore.getState();
        if (s.mode !== "system") return;
        useThemeStore.setState(resolveTheme("system", s.themeName));
    });

    let isApplyingExternal = false;

    // Persist on every theme change
    useThemeStore.subscribe((state) => {
        applyDark(state.isDark);
        applyThemeColors(state.themeName, state.isDark);
        if (!isApplyingExternal) {
            saveTheme(_currentVaultPath, {
                mode: state.mode,
                themeName: state.themeName,
            });
        }
    });

    // React to changes made by other windows (e.g. settings window) via localStorage
    window.addEventListener("storage", (event) => {
        if (event.key !== getStorageKey(_currentVaultPath)) return;
        const theme = parseStoredTheme(event.newValue);
        if (!theme) return;
        isApplyingExternal = true;
        useThemeStore.setState(resolveTheme(theme.mode, theme.themeName));
        isApplyingExternal = false;
    });

    // Reload theme when the active vault changes
    useVaultStore.subscribe((state) => {
        const newVaultPath = getEffectiveVaultPath(state);
        if (newVaultPath === _currentVaultPath) return;
        _currentVaultPath = newVaultPath;
        const pref = loadTheme(newVaultPath);
        useThemeStore.setState(resolveTheme(pref.mode, pref.themeName));
    });
}
