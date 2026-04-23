import { invoke } from "../../app/runtime";
import type { TerminalTab } from "../../app/store/editorStore";
import type { TerminalSessionSnapshot } from "../devtools/terminal/terminalTypes";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/runtime", () => ({
    invoke: vi.fn(),
    listen: vi.fn().mockResolvedValue(vi.fn()),
}));

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
    return {
        id: "tab-1",
        kind: "terminal",
        terminalId: "terminal-1",
        title: "Terminal 1",
        cwd: "/vault",
        ...overrides,
    };
}

function makeSnapshot(
    overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
    return {
        sessionId: "devterm-1",
        program: "/bin/zsh",
        status: "running",
        displayName: "zsh",
        cwd: "/vault",
        cols: 120,
        rows: 24,
        exitCode: null,
        errorMessage: null,
        ...overrides,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

function getRuntime(terminalId = "terminal-1") {
    return useTerminalRuntimeStore.getState().runtimesById[terminalId] ?? null;
}

describe("terminalRuntimeStore", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.mocked(invoke).mockReset();
    });

    afterEach(() => {
        resetTerminalRuntimeStoreForTests();
        vi.restoreAllMocks();
    });

    it("buffers output that arrives before a terminal session attaches", async () => {
        const createSession = createDeferred<TerminalSessionSnapshot>();
        vi.mocked(invoke).mockReturnValue(createSession.promise);

        useTerminalRuntimeStore
            .getState()
            .ensureTerminal(makeTerminalTab({ cwd: "/vault" }));

        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "early output\n",
        });
        createSession.resolve(makeSnapshot({ sessionId: "devterm-1" }));
        await flushPromises();

        expect(getRuntime()).toMatchObject({
            sessionId: "devterm-1",
            rawOutput: "early output\n",
            busy: false,
        });
    });

    it("ignores output from retired sessions after closing a terminal tab", async () => {
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();
        await useTerminalRuntimeStore.getState().closeTerminal("terminal-1");

        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "late output\n",
        });

        expect(getRuntime()).toBeNull();
        expect(vi.mocked(invoke)).toHaveBeenCalledWith(
            "devtools_close_terminal_session",
            { sessionId: "devterm-1" },
        );
    });

    it("creates a new PTY session when a closed terminal tab is reopened", async () => {
        vi.mocked(invoke)
            .mockResolvedValueOnce(makeSnapshot({ sessionId: "devterm-1" }))
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(makeSnapshot({ sessionId: "devterm-2" }));

        const tab = makeTerminalTab();
        useTerminalRuntimeStore.getState().ensureTerminal(tab);
        await flushPromises();
        await useTerminalRuntimeStore.getState().closeTerminal(tab.terminalId);

        useTerminalRuntimeStore.getState().ensureTerminal(tab);
        await flushPromises();

        const createCalls = vi
            .mocked(invoke)
            .mock.calls.filter(
                ([command]) => command === "devtools_create_terminal_session",
            );
        expect(createCalls).toHaveLength(2);
        expect(getRuntime()).toMatchObject({
            sessionId: "devterm-2",
            terminalId: "terminal-1",
        });
    });

    it("does not mix old output into the viewport while restarting", async () => {
        const restartSession = createDeferred<TerminalSessionSnapshot>();
        vi.mocked(invoke)
            .mockResolvedValueOnce(makeSnapshot({ sessionId: "devterm-1" }))
            .mockReturnValueOnce(restartSession.promise);

        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "before restart\n",
        });

        const restartPromise = useTerminalRuntimeStore
            .getState()
            .restart("terminal-1");
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "old process output\n",
        });
        restartSession.resolve(makeSnapshot({ sessionId: "devterm-1" }));
        await restartPromise;

        expect(getRuntime()?.rawOutput).toBe("");

        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "new process output\n",
        });
        expect(getRuntime()?.rawOutput).toBe("new process output\n");
    });

    it("does not spam resize commands for an unchanged or already pending size", async () => {
        const resizeSession = createDeferred<TerminalSessionSnapshot>();
        vi.mocked(invoke)
            .mockResolvedValueOnce(makeSnapshot({ sessionId: "devterm-1" }))
            .mockReturnValueOnce(resizeSession.promise);

        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        const firstResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 100, 30);
        const duplicateResize = useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 100, 30);

        resizeSession.resolve(
            makeSnapshot({ sessionId: "devterm-1", cols: 100, rows: 30 }),
        );
        await Promise.all([firstResize, duplicateResize]);

        await useTerminalRuntimeStore
            .getState()
            .resize("terminal-1", 100, 30);

        const resizeCalls = vi
            .mocked(invoke)
            .mock.calls.filter(
                ([command]) => command === "devtools_resize_terminal_session",
            );
        expect(resizeCalls).toHaveLength(1);
    });
});
