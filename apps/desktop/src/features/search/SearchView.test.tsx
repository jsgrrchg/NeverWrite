import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockInvoke, renderComponent } from "../../test/test-utils";
import { useVaultStore } from "../../app/store/vaultStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { SearchView } from "./SearchView";

describe("SearchView", () => {
    afterEach(() => {
        useSettingsStore.setState({ fileTreeContentMode: "notes_only" });
        mockInvoke().mockReset();
    });

    it("restores the previous query and results when the search tab remounts", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        mockInvoke().mockImplementation(async (command) => {
            if (command === "advanced_search") {
                return [
                    {
                        id: "notes/alpha",
                        path: "/vault/notes/alpha.md",
                        title: "Alpha Note",
                        score: 1,
                        tags: [],
                        modified_at: 0,
                        matches: [
                            {
                                line_number: 3,
                                line_content: "alpha body",
                                match_start: 0,
                                match_end: 5,
                            },
                        ],
                    },
                ];
            }
            return null;
        });

        const { unmount } = renderComponent(<SearchView tabId="search-tab-a" />);
        const input = screen.getByPlaceholderText(
            "Search files and notes... (e.g. tag:project content:react)",
        );

        fireEvent.change(input, { target: { value: "alpha" } });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });

        expect(await screen.findByText("Alpha Note")).toBeInTheDocument();
        expect(mockInvoke()).toHaveBeenCalledTimes(1);

        unmount();
        renderComponent(<SearchView tabId="search-tab-a" />);

        expect(
            screen.getByPlaceholderText(
                "Search files and notes... (e.g. tag:project content:react)",
            ),
        ).toHaveValue("alpha");
        expect(screen.getByText("Alpha Note")).toBeInTheDocument();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        expect(mockInvoke()).toHaveBeenCalledTimes(1);
    });

    it("passes file-oriented search preference when all-files mode is active", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        useSettingsStore.setState({ fileTreeContentMode: "all_files" });
        const invokeMock = mockInvoke().mockResolvedValue([]);

        renderComponent(<SearchView tabId="search-tab-file-oriented" />);
        const input = screen.getByPlaceholderText(
            "Search files and notes... (e.g. tag:project content:react)",
        );

        fireEvent.change(input, { target: { value: "diagnostico" } });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });

        expect(invokeMock).toHaveBeenCalledWith(
            "advanced_search",
            expect.objectContaining({
                params: expect.objectContaining({
                    prefer_file_name: true,
                }),
            }),
        );
    });
});
