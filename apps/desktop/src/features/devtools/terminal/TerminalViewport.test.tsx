import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    flushPromises,
    getXtermMockInstances,
    renderComponent,
} from "../../../test/test-utils";
import { TerminalViewport } from "./TerminalViewport";
import type { TerminalSessionView } from "./terminalTypes";

function createSessionView(
    overrides: Partial<TerminalSessionView> = {},
): TerminalSessionView {
    return {
        snapshot: {
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        },
        rawOutput: "hello from terminal\nready",
        busy: false,
        writeInput: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        restart: vi.fn(async () => undefined),
        clearViewport: vi.fn(),
        ...overrides,
    };
}

describe("TerminalViewport", () => {
    it("renders raw output and forwards xterm input and resize events", async () => {
        const writeInput = vi.fn(async () => undefined);
        const resize = vi.fn(async () => undefined);

        renderComponent(
            <TerminalViewport
                session={createSessionView({
                    writeInput,
                    resize,
                })}
            />,
        );
        await flushPromises();

        expect(screen.getByText(/hello from terminal/i)).toBeInTheDocument();
        expect(screen.getByText(/ready/i)).toBeInTheDocument();
        expect(resize).toHaveBeenCalledWith(80, 24);

        act(() => {
            getXtermMockInstances()[0]?.emitData("pwd\r");
        });

        expect(writeInput).toHaveBeenCalledWith("pwd\r");
    });
});
