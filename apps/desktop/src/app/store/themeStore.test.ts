import { describe, expect, it } from "vitest";
import { useThemeStore, readPersistedTheme } from "./themeStore";
import { useVaultStore } from "./vaultStore";

describe("themeStore vault persistence", () => {
    it("remembers the selected theme for each vault", () => {
        useVaultStore.setState({ vaultPath: "/vaults/atlas" });
        useThemeStore.getState().setThemeName("nord");
        useThemeStore.getState().setMode("dark");

        expect(
            readPersistedTheme("/vaults/atlas"),
        ).toMatchObject({
            themeName: "nord",
            mode: "dark",
        });

        useVaultStore.setState({ vaultPath: "/vaults/lab" });
        expect(useThemeStore.getState()).toMatchObject({
            themeName: "default",
            mode: "system",
        });

        useThemeStore.getState().setThemeName("gruvbox");
        useThemeStore.getState().setMode("light");

        expect(
            readPersistedTheme("/vaults/lab"),
        ).toMatchObject({
            themeName: "gruvbox",
            mode: "light",
        });

        useVaultStore.setState({ vaultPath: "/vaults/atlas" });
        expect(useThemeStore.getState()).toMatchObject({
            themeName: "nord",
            mode: "dark",
        });
    });

    it("uses the global theme as fallback for vaults without a custom one", () => {
        useThemeStore.getState().setThemeName("ocean");
        useThemeStore.getState().setMode("dark");

        useVaultStore.setState({ vaultPath: "/vaults/fresh" });
        expect(useThemeStore.getState()).toMatchObject({
            themeName: "ocean",
            mode: "dark",
        });
    });
});
