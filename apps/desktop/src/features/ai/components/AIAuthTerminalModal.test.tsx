import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe("AIAuthTerminalModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        apiMocks.aiCloseAuthTerminalSession.mockResolvedValue(undefined);
        apiMocks.aiWriteAuthTerminalSession.mockResolvedValue(undefined);
        apiMocks.aiResizeAuthTerminalSession.mockResolvedValue(undefined);
        apiMocks.listenToAiAuthTerminalStarted.mockResolvedValue(vi.fn());
        apiMocks.listenToAiAuthTerminalOutput.mockResolvedValue(vi.fn());
        apiMocks.listenToAiAuthTerminalExited.mockResolvedValue(vi.fn());
        apiMocks.listenToAiAuthTerminalError.mockResolvedValue(vi.fn());
    });

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
            expect(
                screen.getByText("Waiting for Claude sign-in"),
            ).toBeInTheDocument();
        });
    });

    it("uses runtime-specific status copy for Gemini", async () => {
        const snapshot = {
            sessionId: "authterm-2",
            runtimeId: "gemini-acp",
            program: "gemini",
            displayName: "Gemini sign-in",
            cwd: "/vault",
            cols: 100,
            rows: 28,
            buffer: "Gemini CLI v0.35.3",
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
                runtimeId="gemini-acp"
                runtimeName="Gemini"
                vaultPath="/vault"
                onClose={vi.fn()}
                onRefreshSetup={vi.fn(async () => undefined)}
            />,
        );

        await waitFor(() => {
            expect(
                screen.getByText("Waiting for Gemini sign-in"),
            ).toBeInTheDocument();
        });
    });

    it("cleans up listeners that resolve after the modal unmounts", async () => {
        const startedDeferred = createDeferred<() => void>();
        const outputDeferred = createDeferred<() => void>();
        const exitedDeferred = createDeferred<() => void>();
        const errorDeferred = createDeferred<() => void>();

        const startedUnlisten = vi.fn();
        const outputUnlisten = vi.fn();
        const exitedUnlisten = vi.fn();
        const errorUnlisten = vi.fn();

        apiMocks.listenToAiAuthTerminalStarted.mockReturnValue(
            startedDeferred.promise,
        );
        apiMocks.listenToAiAuthTerminalOutput.mockReturnValue(
            outputDeferred.promise,
        );
        apiMocks.listenToAiAuthTerminalExited.mockReturnValue(
            exitedDeferred.promise,
        );
        apiMocks.listenToAiAuthTerminalError.mockReturnValue(
            errorDeferred.promise,
        );

        const view = renderComponent(
            <AIAuthTerminalModal
                open
                runtimeId="claude-acp"
                runtimeName="Claude"
                vaultPath="/vault"
                onClose={vi.fn()}
                onRefreshSetup={vi.fn(async () => undefined)}
            />,
        );

        view.unmount();

        await act(async () => {
            startedDeferred.resolve(startedUnlisten);
            outputDeferred.resolve(outputUnlisten);
            exitedDeferred.resolve(exitedUnlisten);
            errorDeferred.resolve(errorUnlisten);
            await Promise.resolve();
        });

        expect(startedUnlisten).toHaveBeenCalledOnce();
        expect(outputUnlisten).toHaveBeenCalledOnce();
        expect(exitedUnlisten).toHaveBeenCalledOnce();
        expect(errorUnlisten).toHaveBeenCalledOnce();
        expect(apiMocks.aiStartAuthTerminalSession).not.toHaveBeenCalled();
    });
});
