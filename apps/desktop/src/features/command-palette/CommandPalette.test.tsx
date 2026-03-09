import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { renderComponent, setCommands } from "../../test/test-utils";
import { useCommandStore } from "./store/commandStore";

describe("CommandPalette", () => {
    it("focuses the input and executes the selected command with keyboard navigation", async () => {
        vi.useFakeTimers();
        const runOpen = vi.fn();
        const runClose = vi.fn();

        setCommands(
            [
                {
                    id: "open",
                    label: "Open note",
                    category: "File",
                    execute: runOpen,
                },
                {
                    id: "close",
                    label: "Close tab",
                    category: "File",
                    execute: runClose,
                },
            ],
            "command-palette",
        );

        renderComponent(<CommandPalette />);

        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText("Type a command...");
        expect(input).toHaveFocus();

        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter" });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(runOpen).not.toHaveBeenCalled();
        expect(runClose).toHaveBeenCalledTimes(1);
        expect(useCommandStore.getState().activeModal).toBeNull();
    });

    it("filters the command list as the user types", async () => {
        setCommands(
            [
                {
                    id: "open",
                    label: "Open note",
                    category: "File",
                    execute: vi.fn(),
                },
                {
                    id: "toggle",
                    label: "Toggle sidebar",
                    category: "View",
                    execute: vi.fn(),
                },
            ],
            "command-palette",
        );

        renderComponent(<CommandPalette />);

        fireEvent.change(screen.getByPlaceholderText("Type a command..."), {
            target: { value: "toggle" },
        });

        expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
        expect(screen.queryByText("Open note")).not.toBeInTheDocument();
    });
});
