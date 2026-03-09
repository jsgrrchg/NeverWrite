import { create } from "zustand";
import { useVaultStore } from "./vaultStore";
import { type ThemeName, applyThemeColors } from "../themes/index";

export type ThemeMode = "system" | "light" | "dark";

interface ThemePreference {
    mode: ThemeMode;
    themeName: ThemeName;
}

interface ThemeStore {
    mode: ThemeMode;
    themeName: ThemeName;
    isDark: boolean;
    activeVaultPath: string | null;
    setMode: (mode: ThemeMode) => void;
    setThemeName: (name: ThemeName) => void;
}

const THEME_STORAGE_KEY = "vaultai:theme";
const THEME_STORAGE_KEY_PREFIX = "vaultai:theme:";
const THEME_BROADCAST_CHANNEL = "vaultai:theme-sync";
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

function getVaultThemeKey(vaultPath: string) {
    return `${THEME_STORAGE_KEY_PREFIX}${vaultPath}`;
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

function readGlobalTheme(): ThemePreference {
    if (typeof window === "undefined") return DEFAULT_THEME;
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY)) ??
        DEFAULT_THEME;
}

function readVaultTheme(vaultPath: string | null): ThemePreference | null {
    if (typeof window === "undefined" || !vaultPath) return null;
    return parseStoredTheme(
        window.localStorage.getItem(getVaultThemeKey(vaultPath)),
    );
}

export function readPersistedTheme(vaultPath: string | null): ThemePreference {
    return readVaultTheme(vaultPath) ?? readGlobalTheme();
}

function writeStoredTheme(
    vaultPath: string | null,
    preference: ThemePreference,
) {
    if (typeof window === "undefined") return;
    const key = vaultPath ? getVaultThemeKey(vaultPath) : THEME_STORAGE_KEY;
    window.localStorage.setItem(key, JSON.stringify(preference));
}

function resolveStoreTheme(
    vaultPath: string | null,
    preference: ThemePreference,
) {
    return {
        activeVaultPath: vaultPath,
        ...resolveTheme(preference.mode, preference.themeName),
    };
}

const initialVaultPath =
    typeof window === "undefined" ? null : useVaultStore.getState().vaultPath;
const initialTheme = resolveStoreTheme(
    initialVaultPath,
    readPersistedTheme(initialVaultPath),
);

export const useThemeStore = create<ThemeStore>((set, get) => ({
    ...initialTheme,
    setMode: (mode) => set(resolveTheme(mode, get().themeName)),
    setThemeName: (themeName) => set(resolveTheme(get().mode, themeName)),
}));

let isApplyingRemoteTheme = false;
let isLoadingStoredTheme = false;

if (typeof window !== "undefined") {
    const syncId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : String(Date.now());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const channel =
        "BroadcastChannel" in window
            ? new BroadcastChannel(THEME_BROADCAST_CHANNEL)
            : null;

    const applyStoredTheme = (vaultPath: string | null) => {
        isLoadingStoredTheme = true;
        useThemeStore.setState(
            resolveStoreTheme(vaultPath, readPersistedTheme(vaultPath)),
        );
        isLoadingStoredTheme = false;
    };

    const applyRemote = (
        vaultPath: string | null,
        mode: ThemeMode | null,
        themeName?: ThemeName,
    ) => {
        if (!mode) return;
        isApplyingRemoteTheme = true;
        useThemeStore.setState(
            resolveStoreTheme(vaultPath, {
                mode,
                themeName: themeName ?? useThemeStore.getState().themeName,
            }),
        );
        isApplyingRemoteTheme = false;
    };

    const handleSystemThemeChange = () => {
        const s = useThemeStore.getState();
        if (s.mode !== "system") return;
        useThemeStore.setState(resolveTheme("system", s.themeName));
    };

    media.addEventListener("change", handleSystemThemeChange);

    channel?.addEventListener("message", (event) => {
        const payload = event.data as
            | {
                  source?: string;
                  vaultPath?: string | null;
                  mode?: ThemeMode;
                  themeName?: ThemeName;
              }
            | undefined;
        if (!payload?.mode || payload.source === syncId) return;

        const currentVaultPath = useThemeStore.getState().activeVaultPath;
        if (payload.vaultPath === currentVaultPath) {
            applyRemote(payload.vaultPath ?? null, payload.mode, payload.themeName);
            return;
        }

        if (payload.vaultPath === null) {
            applyStoredTheme(currentVaultPath);
        }
    });

    window.addEventListener("storage", (event) => {
        const currentVaultPath = useThemeStore.getState().activeVaultPath;
        if (event.key === THEME_STORAGE_KEY) {
            applyStoredTheme(currentVaultPath);
            return;
        }

        if (
            currentVaultPath &&
            event.key === getVaultThemeKey(currentVaultPath)
        ) {
            applyStoredTheme(currentVaultPath);
        }
    });

    let lastVaultPath = useVaultStore.getState().vaultPath;
    useVaultStore.subscribe((state) => {
        if (state.vaultPath === lastVaultPath) return;
        lastVaultPath = state.vaultPath;
        applyStoredTheme(state.vaultPath);
    });

    useThemeStore.subscribe((state) => {
        applyDark(state.isDark);
        applyThemeColors(state.themeName, state.isDark);
        if (isApplyingRemoteTheme || isLoadingStoredTheme) return;
        writeStoredTheme(state.activeVaultPath, {
            mode: state.mode,
            themeName: state.themeName,
        });
        channel?.postMessage({
            source: syncId,
            vaultPath: state.activeVaultPath,
            mode: state.mode,
            themeName: state.themeName,
        });
    });
}
