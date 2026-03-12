import { describe, expect, it } from "vitest";
import { useThemeStore } from "./themeStore";
import { useVaultStore } from "./vaultStore";

describe("themeStore global persistence", () => {
    it("persists theme globally across all vaults", () => {
        useThemeStore.getState().setThemeName("nord");
        useThemeStore.getState().setMode("dark");

        expect(useThemeStore.getState()).toMatchObject({
            themeName: "nord",
            mode: "dark",
            isDark: true,
        });
    });

    it("changing theme updates isDark correctly", () => {
        useThemeStore.getState().setMode("light");
        expect(useThemeStore.getState().isDark).toBe(false);

        useThemeStore.getState().setMode("dark");
        expect(useThemeStore.getState().isDark).toBe(true);
    });

    it("keeps the opening vault theme during transient loading state", () => {
        localStorage.setItem(
            "vaultai:theme",
            JSON.stringify({ mode: "light", themeName: "rose" }),
        );
        localStorage.setItem(
            "vaultai:theme:/vaults/work",
            JSON.stringify({ mode: "dark", themeName: "nord" }),
        );

        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: null,
            isLoading: true,
            vaultOpenState: {
                ...state.vaultOpenState,
                path: "/vaults/work",
                stage: "scanning",
            },
        }));

        expect(useThemeStore.getState()).toMatchObject({
            themeName: "nord",
            mode: "dark",
            isDark: true,
        });
    });
});
