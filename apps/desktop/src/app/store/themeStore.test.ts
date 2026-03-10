import { describe, expect, it } from "vitest";
import { useThemeStore } from "./themeStore";

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
});
