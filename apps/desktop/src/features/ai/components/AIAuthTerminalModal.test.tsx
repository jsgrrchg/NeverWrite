import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AIAuthTerminalModal } from "./AIAuthTerminalModal";

const apiMocks = vi.hoisted(() => ({
    aiStartAuthTerminalSession: vi.fn(),
    aiCloseAuthTerminalSession: vi.fn(async () => undefined),
    aiWriteAuthTerminalSession: vi.fn(async () => undefined),
    aiResizeAuthTerminalSession: vi.fn(async () => undefined),
    listenToAiAuthTerminalStarted: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalOutput: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalExited: vi.fn(async () => vi.fn()),
    listenToAiAuthTerminalError: vi.fn(async () => vi.fn()),
}));

vi.mock("../api", () => apiMocks);

describe("AIAuthTerminalModal", () => {
    it("renders buffered terminal output returned with the initial snapshot", async () => {
        const snapshot = {
            sessionId: "authterm-1",
            runtimeId: "claude-acp",
            program: "claude-agent-acp",
            displayName: "Claude sign-in",
            cwd: "/vault",
            cols: 100,
            rows: 28,
            buffer: "Welcome to Claude sign-in\nPaste the code here",
            status: "running",
            exitCode: null,
            errorMessage: null,
        };
        apiMocks.aiStartAuthTerminalSession.mockResolvedValue(snapshot);
        apiMocks.aiResizeAuthTerminalSession.mockResolvedValue(
            snapshot as never,
        );

        renderComponent(
            <AIAuthTerminalModal
                open
                runtimeId="claude-acp"
                runtimeName="Claude"
                vaultPath="/vault"
                onClose={vi.fn()}
                onRefreshSetup={vi.fn(async () => undefined)}
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText(/Welcome to Claude sign-in/i),
            ).toBeInTheDocument();
            expect(
                screen.getByText(/Paste the code here/i),
            ).toBeInTheDocument();
        });
    });
});
