import { invoke, listen } from "../../app/runtime";
import { useEditorStore } from "../../app/store/editorStore";
import { createInitialLayout } from "../../app/store/workspaceLayoutTree";
import { act } from "@testing-library/react";
import { flushPromises, renderComponent } from "../../test/test-utils";
import {
    DEV_TERMINAL_ERROR_EVENT,
    DEV_TERMINAL_EXITED_EVENT,
    DEV_TERMINAL_OUTPUT_EVENT,
    DEV_TERMINAL_STARTED_EVENT,
    type TerminalOutputEventPayload,
} from "./terminalTypes";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";
import { WorkspaceTerminalHost } from "./WorkspaceTerminalHost";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/runtime", () => ({
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(vi.fn()),
}));

describe("WorkspaceTerminalHost", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.mocked(invoke).mockReset();
        vi.mocked(listen).mockClear();
        vi.mocked(listen).mockResolvedValue(vi.fn());
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
            createInitialLayout("primary"),
        );
    });

    afterEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.restoreAllMocks();
    });

    it("registers one terminal event bridge and ensures workspace terminal tabs", async () => {
        vi.mocked(invoke).mockResolvedValue({
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        });

        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "terminal-tab-1",
                            kind: "terminal",
                            terminalId: "terminal-1",
                            title: "Terminal 1",
                            cwd: "/vault",
                        },
                    ],
                    activeTabId: "terminal-tab-1",
                },
            ],
            "primary",
            createInitialLayout("primary"),
        );

        renderComponent(<WorkspaceTerminalHost />);
        await flushPromises();

        expect(vi.mocked(listen).mock.calls.map(([eventName]) => eventName))
            .toEqual([
                DEV_TERMINAL_OUTPUT_EVENT,
                DEV_TERMINAL_STARTED_EVENT,
                DEV_TERMINAL_EXITED_EVENT,
                DEV_TERMINAL_ERROR_EVENT,
            ]);
        expect(vi.mocked(invoke)).toHaveBeenCalledWith(
            "devtools_create_terminal_session",
            {
                input: {
                    cwd: "/vault",
                    cols: 120,
                    rows: 24,
                    extraEnv: {},
                },
            },
        );
        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"],
        ).toMatchObject({
            tabId: "terminal-tab-1",
            sessionId: "devterm-1",
        });
    });

    it("coalesces multiple output chunks for the same session into one store update per rAF frame", async () => {
        // Spy on rAF/cAF directly so React's scheduler keeps working normally —
        // vi.useFakeTimers() breaks React 19's MessageChannel-based scheduler
        // inside RTL's act().
        let capturedRafCallback: ((time: DOMHighResTimeStamp) => void) | null =
            null;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
            capturedRafCallback = cb;
            return 1;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
            capturedRafCallback = null;
        });

        // Capture listener callbacks so we can fire output events manually.
        const capturedHandlers = new Map<
            string,
            (event: { payload: TerminalOutputEventPayload }) => void
        >();
        vi.mocked(listen).mockImplementation(async (eventName, handler) => {
            capturedHandlers.set(
                eventName,
                handler as (event: {
                    payload: TerminalOutputEventPayload;
                }) => void,
            );
            return vi.fn();
        });

        // Set up a live terminal session so output is applied to rawOutput.
        vi.mocked(invoke).mockResolvedValue({
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        });

        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "terminal-tab-1",
                            kind: "terminal",
                            terminalId: "terminal-1",
                            title: "Terminal 1",
                            cwd: "/vault",
                        },
                    ],
                    activeTabId: "terminal-tab-1",
                },
            ],
            "primary",
            createInitialLayout("primary"),
        );

        renderComponent(<WorkspaceTerminalHost />);
        await flushPromises();

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                ?.sessionId,
        ).toBe("devterm-1");

        const emitOutput = (chunk: string) =>
            capturedHandlers
                .get(DEV_TERMINAL_OUTPUT_EVENT)
                ?.({ payload: { sessionId: "devterm-1", chunk } });

        // Fire three chunks — rAF is registered but not yet fired.
        act(() => {
            emitOutput("hello");
            emitOutput(" world");
            emitOutput("!");
        });

        expect(capturedRafCallback).not.toBeNull();
        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                ?.rawOutput,
        ).toBe("");

        // Fire the rAF manually — all three chunks merge into one store update.
        await act(async () => {
            capturedRafCallback?.(performance.now());
        });

        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"]
                ?.rawOutput,
        ).toBe("hello world!");
    });

    it("caps pending output while waiting for a delayed rAF frame", async () => {
        let capturedRafCallback: ((time: DOMHighResTimeStamp) => void) | null =
            null;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
            capturedRafCallback = cb;
            return 1;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
            capturedRafCallback = null;
        });

        const capturedHandlers = new Map<
            string,
            (event: { payload: TerminalOutputEventPayload }) => void
        >();
        vi.mocked(listen).mockImplementation(async (eventName, handler) => {
            capturedHandlers.set(
                eventName,
                handler as (event: {
                    payload: TerminalOutputEventPayload;
                }) => void,
            );
            return vi.fn();
        });

        vi.mocked(invoke).mockResolvedValue({
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        });

        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "terminal-tab-1",
                            kind: "terminal",
                            terminalId: "terminal-1",
                            title: "Terminal 1",
                            cwd: "/vault",
                        },
                    ],
                    activeTabId: "terminal-tab-1",
                },
            ],
            "primary",
            createInitialLayout("primary"),
        );

        const handleOutputSpy = vi.spyOn(
            useTerminalRuntimeStore.getState(),
            "handleTerminalOutput",
        );
        const { unmount } = renderComponent(<WorkspaceTerminalHost />);
        await flushPromises();

        const emitOutput = (chunk: string) =>
            capturedHandlers
                .get(DEV_TERMINAL_OUTPUT_EVENT)
                ?.({ payload: { sessionId: "devterm-1", chunk } });

        act(() => {
            emitOutput("a".repeat(1_500_000));
            emitOutput("b".repeat(1_500_000));
        });

        expect(capturedRafCallback).not.toBeNull();
        expect(handleOutputSpy).not.toHaveBeenCalled();

        unmount();

        expect(handleOutputSpy).toHaveBeenCalledTimes(1);
        const flushedPayload = handleOutputSpy.mock.calls[0]?.[0];
        expect(flushedPayload?.chunk).toHaveLength(2_000_000);
        expect(flushedPayload?.chunk.startsWith("a".repeat(500_000))).toBe(
            true,
        );
        expect(flushedPayload?.chunk.endsWith("b".repeat(1_500_000))).toBe(
            true,
        );
    });
});
