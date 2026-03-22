import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    createDeferred,
    renderComponent,
    mockInvoke,
    flushPromises,
} from "../../test/test-utils";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    DEVELOPER_PANEL_NEW_TAB_EVENT,
    DEVELOPER_PANEL_RESTART_EVENT,
    DeveloperPanel,
} from "./DeveloperPanel";

describe("DeveloperPanel", () => {
    it("renders the first terminal tab in the header", async () => {
        useVaultStore.setState({
            vaultPath: "/home/user/projects/VaultAI",
        });
        mockInvoke().mockResolvedValue({
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/home/user/projects/VaultAI",
            cols: 40,
            rows: 8,
            exitCode: null,
            errorMessage: null,
        });

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        expect(screen.getByRole("tab", { name: /zsh/i })).toBeInTheDocument();
    });

    it("opens a new terminal tab from the command bridge", async () => {
        let createCount = 0;
        mockInvoke().mockImplementation(async (command) => {
            if (command === "devtools_create_terminal_session") {
                createCount += 1;
                return {
                    sessionId: `devterm-${createCount}`,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            if (command === "devtools_resize_terminal_session") {
                return {
                    sessionId: "devterm-1",
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            return undefined;
        });

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        act(() => {
            window.dispatchEvent(new Event(DEVELOPER_PANEL_NEW_TAB_EVENT));
        });
        await flushPromises();

        expect(screen.getByRole("tab", { name: /zsh 2/i })).toBeInTheDocument();
        expect(mockInvoke()).toHaveBeenCalledWith(
            "devtools_create_terminal_session",
            expect.anything(),
        );
    });

    it("restarts the active terminal tab from the command bridge", async () => {
        let createCount = 0;
        mockInvoke().mockImplementation(async (command, payload) => {
            if (command === "devtools_create_terminal_session") {
                createCount += 1;
                return {
                    sessionId: `devterm-${createCount}`,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            if (command === "devtools_restart_terminal_session") {
                return {
                    sessionId: (payload as { sessionId: string }).sessionId,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            if (command === "devtools_resize_terminal_session") {
                return {
                    sessionId: (payload as { input: { sessionId: string } })
                        .input.sessionId,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            return undefined;
        });

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        fireEvent.click(screen.getByLabelText("New Terminal Tab"));
        await flushPromises();

        fireEvent.click(screen.getByRole("tab", { name: /zsh 2/i }));

        act(() => {
            window.dispatchEvent(new Event(DEVELOPER_PANEL_RESTART_EVENT));
        });
        await flushPromises();

        expect(mockInvoke()).toHaveBeenCalledWith(
            "devtools_restart_terminal_session",
            {
                sessionId: "devterm-2",
            },
        );
    });

    it("persists terminal tabs and custom titles across remounts", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });

        let createCount = 0;
        mockInvoke().mockImplementation(async (command, payload) => {
            if (command === "devtools_create_terminal_session") {
                createCount += 1;
                return {
                    sessionId: `devterm-${createCount}`,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            if (command === "devtools_resize_terminal_session") {
                return {
                    sessionId: (payload as { input: { sessionId: string } })
                        .input.sessionId,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            return undefined;
        });

        const view = renderComponent(<DeveloperPanel />);
        await flushPromises();

        fireEvent.click(screen.getByLabelText("New Terminal Tab"));
        await flushPromises();

        fireEvent.doubleClick(screen.getByRole("tab", { name: /zsh 2/i }));
        const renameInput = screen.getByDisplayValue("zsh 2");
        fireEvent.change(renameInput, { target: { value: "Logs" } });
        fireEvent.keyDown(renameInput, { key: "Enter" });
        await flushPromises();

        view.unmount();

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
        expect(screen.getAllByRole("tab")).toHaveLength(2);
    });

    it("restores persisted terminal scrollback on remount", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        localStorage.setItem(
            "vaultai.devtools.terminal.tabs:/vault",
            JSON.stringify({
                version: 2,
                tabs: [
                    {
                        id: "tab-1",
                        title: null,
                        cwd: "/vault",
                        rawOutput: "previous output\nsecond line",
                    },
                ],
                activeTabId: "tab-1",
            }),
        );

        mockInvoke().mockResolvedValue({
            sessionId: "devterm-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 40,
            rows: 8,
            exitCode: null,
            errorMessage: null,
        });

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        expect(screen.getByText(/previous output/i)).toBeInTheDocument();
        expect(screen.getByText(/second line/i)).toBeInTheDocument();
    });

    it("supports context-menu actions for terminal tabs", async () => {
        let createCount = 0;
        mockInvoke().mockImplementation(async (command, payload) => {
            if (command === "devtools_create_terminal_session") {
                createCount += 1;
                return {
                    sessionId: `devterm-${createCount}`,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            if (command === "devtools_resize_terminal_session") {
                return {
                    sessionId: (payload as { input: { sessionId: string } })
                        .input.sessionId,
                    program: "/bin/zsh",
                    status: "running",
                    displayName: "zsh",
                    cwd: "/vault",
                    cols: 40,
                    rows: 8,
                    exitCode: null,
                    errorMessage: null,
                };
            }

            return undefined;
        });

        renderComponent(<DeveloperPanel />);
        await flushPromises();

        fireEvent.click(screen.getByLabelText("New Terminal Tab"));
        await flushPromises();

        fireEvent.contextMenu(screen.getByRole("tab", { name: /zsh 2/i }));
        fireEvent.click(screen.getByText("Close others"));
        await flushPromises();

        expect(screen.getAllByRole("tab")).toHaveLength(1);
        expect(screen.getByRole("tab", { name: /zsh/i })).toBeInTheDocument();
    });

    it("closes late terminal sessions created after unmount", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });

        const deferredSession = createDeferred<{
            sessionId: string;
            program: string;
            status: string;
            displayName: string;
            cwd: string;
            cols: number;
            rows: number;
            exitCode: null;
            errorMessage: null;
        }>();

        mockInvoke().mockImplementation(async (command) => {
            if (command === "devtools_create_terminal_session") {
                return deferredSession.promise;
            }

            if (command === "devtools_close_terminal_session") {
                return undefined;
            }

            return undefined;
        });

        const view = renderComponent(<DeveloperPanel />);
        view.unmount();

        deferredSession.resolve({
            sessionId: "devterm-late",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 40,
            rows: 8,
            exitCode: null,
            errorMessage: null,
        });
        await flushPromises();

        expect(mockInvoke()).toHaveBeenCalledWith(
            "devtools_close_terminal_session",
            {
                sessionId: "devterm-late",
            },
        );
    });
});
