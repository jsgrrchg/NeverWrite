import { create } from "zustand";
import { type ThemeName, applyThemeColors } from "../themes/index";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeStore {
    mode: ThemeMode;
    themeName: ThemeName;
    isDark: boolean;
    setMode: (mode: ThemeMode) => void;
    setThemeName: (name: ThemeName) => void;
}

const THEME_STORAGE_KEY = "vaultai:theme";
const THEME_BROADCAST_CHANNEL = "vaultai:theme-sync";

const VALID_THEME_NAMES = new Set<ThemeName>([
    "default",
    "ocean",
    "forest",
    "rose",
    "amber",
    "lavender",
    "nord",
    "sunset",
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

function readStored(): { mode: ThemeMode; themeName: ThemeName } {
    if (typeof window === "undefined")
        return { mode: "system", themeName: "default" };

    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { mode: "system", themeName: "default" };

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
        return { mode: "system", themeName: "default" };
    }
}

function writeStored(mode: ThemeMode, themeName: ThemeName) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
        THEME_STORAGE_KEY,
        JSON.stringify({ mode, themeName }),
    );
}

const initial = readStored();
const initialTheme = resolveTheme(initial.mode, initial.themeName);

export const useThemeStore = create<ThemeStore>((set, get) => ({
    ...initialTheme,
    setMode: (mode) => set(resolveTheme(mode, get().themeName)),
    setThemeName: (themeName) => set(resolveTheme(get().mode, themeName)),
}));

let isApplyingRemoteTheme = false;

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

    const applyRemote = (mode: ThemeMode | null, themeName?: ThemeName) => {
        if (!mode) return;
        isApplyingRemoteTheme = true;
        const name = themeName ?? useThemeStore.getState().themeName;
        useThemeStore.setState(resolveTheme(mode, name));
        isApplyingRemoteTheme = false;
    };

    const handleSystemThemeChange = () => {
        const s = useThemeStore.getState();
        if (s.mode !== "system") return;
        useThemeStore.setState(resolveTheme("system", s.themeName));
    };

    if ("addEventListener" in media) {
        media.addEventListener("change", handleSystemThemeChange);
    } else {
        media.addListener(handleSystemThemeChange);
    }

    channel?.addEventListener("message", (event) => {
        const payload = event.data as
            | { source?: string; mode?: ThemeMode; themeName?: ThemeName }
            | undefined;
        if (!payload?.mode || payload.source === syncId) return;
        applyRemote(payload.mode, payload.themeName);
    });

    window.addEventListener("storage", (event) => {
        if (event.key !== THEME_STORAGE_KEY) return;
        const stored = readStored();
        applyRemote(stored.mode, stored.themeName);
    });

    useThemeStore.subscribe((state) => {
        applyDark(state.isDark);
        applyThemeColors(state.themeName, state.isDark);
        if (isApplyingRemoteTheme) return;
        writeStored(state.mode, state.themeName);
        channel?.postMessage({
            source: syncId,
            mode: state.mode,
            themeName: state.themeName,
        });
    });
}
