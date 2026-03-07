import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeStore {
    mode: ThemeMode;
    isDark: boolean;
    setMode: (mode: ThemeMode) => void;
}

const THEME_STORAGE_KEY = "vaultai:theme";
const THEME_BROADCAST_CHANNEL = "vaultai:theme-sync";

function normalizeThemeMode(value: unknown): ThemeMode {
    return value === "light" || value === "dark" || value === "system"
        ? value
        : "system";
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

function resolveTheme(mode: ThemeMode) {
    const isDark = getIsDark(mode);
    applyDark(isDark);
    return { mode, isDark };
}

function readStoredThemeMode(): ThemeMode {
    if (typeof window === "undefined") return "system";

    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return "system";

    try {
        const parsed = JSON.parse(raw) as
            | { mode?: unknown; state?: { mode?: unknown } }
            | string;

        if (typeof parsed === "string") {
            return normalizeThemeMode(parsed);
        }

        return normalizeThemeMode(parsed.state?.mode ?? parsed.mode);
    } catch {
        return "system";
    }
}

function writeStoredThemeMode(mode: ThemeMode) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode }));
}

const initialTheme = resolveTheme(readStoredThemeMode());

export const useThemeStore = create<ThemeStore>((set) => ({
    ...initialTheme,
    setMode: (mode) => set(resolveTheme(mode)),
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

    const applyRemoteMode = (mode: ThemeMode | null) => {
        if (!mode) return;
        isApplyingRemoteTheme = true;
        useThemeStore.setState(resolveTheme(mode));
        isApplyingRemoteTheme = false;
    };

    const handleSystemThemeChange = () => {
        if (useThemeStore.getState().mode !== "system") return;
        useThemeStore.setState(resolveTheme("system"));
    };

    if ("addEventListener" in media) {
        media.addEventListener("change", handleSystemThemeChange);
    } else {
        media.addListener(handleSystemThemeChange);
    }

    channel?.addEventListener("message", (event) => {
        const payload = event.data as
            | { source?: string; mode?: ThemeMode }
            | undefined;
        if (!payload?.mode || payload.source === syncId) return;
        applyRemoteMode(payload.mode);
    });

    window.addEventListener("storage", (event) => {
        if (event.key !== THEME_STORAGE_KEY) return;
        applyRemoteMode(readStoredThemeMode());
    });

    useThemeStore.subscribe((state) => {
        applyDark(state.isDark);
        if (isApplyingRemoteTheme) return;
        writeStoredThemeMode(state.mode);
        channel?.postMessage({
            source: syncId,
            mode: state.mode,
        });
    });
}
