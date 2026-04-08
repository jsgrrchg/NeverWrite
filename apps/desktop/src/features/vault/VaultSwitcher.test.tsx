import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { VaultSwitcher } from "./VaultSwitcher";

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

vi.mock("../../app/detachedWindows", () => ({
    openVaultWindow: vi.fn(),
}));

describe("VaultSwitcher", () => {
    beforeEach(() => {
        localStorage.clear();
        useVaultStore.setState({
            vaultPath: "/vaults/Vault 1",
        });
    });

    afterEach(() => {
        localStorage.clear();
    });

    it("filters recent vaults inside a scrollable menu", () => {
        const recents = Array.from({ length: 12 }, (_, index) => ({
            path: `/vaults/Vault ${index + 1}`,
            name: `Vault ${index + 1}`,
        }));

        localStorage.setItem("neverwrite:recentVaults", JSON.stringify(recents));

        renderComponent(<VaultSwitcher />);

        fireEvent.click(screen.getByRole("button", { name: /Vault 1/i }));

        const search = screen.getByRole("textbox", { name: "Search vaults" });
        const list = screen.getByRole("list", {
            name: "Vault switcher recent vaults",
        });

        expect(list).toHaveStyle({
            maxHeight: "240px",
            overflowY: "auto",
        });
        expect(screen.getByText("12/12")).toBeInTheDocument();
        expect(screen.getByText("Vault 12")).toBeInTheDocument();

        fireEvent.change(search, { target: { value: "12" } });

        expect(screen.getByText("1/12")).toBeInTheDocument();
        expect(screen.getByText("Vault 12")).toBeInTheDocument();
        expect(screen.queryByText("Vault 2")).not.toBeInTheDocument();

        fireEvent.change(search, { target: { value: "missing" } });

        expect(screen.getByText("0/12")).toBeInTheDocument();
        expect(
            screen.getByText("No vaults match your search."),
        ).toBeInTheDocument();
    });
});
