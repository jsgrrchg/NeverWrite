import { create } from "zustand";

type ThemeMode = "system" | "light" | "dark";

interface ThemeStore {
    mode: ThemeMode;
    isDark: boolean;
    setMode: (mode: ThemeMode) => void;
}

const getIsDark = (mode: ThemeMode): boolean => {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

const applyDark = (isDark: boolean) => {
    document.documentElement.classList.toggle("dark", isDark);
};

export const useThemeStore = create<ThemeStore>((set) => {
    const isDark = getIsDark("system");
    applyDark(isDark);

    window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
            const { mode } = useThemeStore.getState();
            if (mode === "system") {
                const isDark = getIsDark("system");
                applyDark(isDark);
                set({ isDark });
            }
        });

    return {
        mode: "system",
        isDark,
        setMode: (mode) => {
            const isDark = getIsDark(mode);
            applyDark(isDark);
            set({ mode, isDark });
        },
    };
});
