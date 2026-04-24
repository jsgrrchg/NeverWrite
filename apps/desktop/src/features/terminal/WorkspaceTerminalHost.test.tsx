import { invoke, listen } from "../../app/runtime";
import { useEditorStore } from "../../app/store/editorStore";
import { createInitialLayout } from "../../app/store/workspaceLayoutTree";
import { flushPromises, renderComponent } from "../../test/test-utils";
import {
    DEV_TERMINAL_ERROR_EVENT,
    DEV_TERMINAL_EXITED_EVENT,
    DEV_TERMINAL_OUTPUT_EVENT,
    DEV_TERMINAL_STARTED_EVENT,
} from "../devtools/terminal/terminalTypes";
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
});
