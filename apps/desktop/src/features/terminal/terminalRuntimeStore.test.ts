import { invoke } from "../../app/runtime";
import type { TerminalTab } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { safeStorageGetItem } from "../../app/utils/safeStorage";
import type {
    TerminalOutputCommand,
    TerminalSessionSnapshot,
} from "./terminalTypes";
import {
    createTerminalSessionView,
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

// Subscribe to a terminal's output channel and collect emitted commands.
function collectOutput(terminalId = "terminal-1") {
    const runtime = getRuntime(terminalId);
    if (!runtime) throw new Error(`No runtime for ${terminalId}`);
    const commands: TerminalOutputCommand[] = [];
    const unsubscribe = createTerminalSessionView(runtime).subscribeOutput(
        (command) => commands.push(command),
    );
    const writes = () =>
        commands
            .filter((c): c is { type: "write"; data: string } => c.type === "write")
            .map((c) => c.data)
            .join("");
    return { commands, writes, unsubscribe };
}

describe("terminalRuntimeStore", () => {
    beforeEach(() => {
        resetTerminalRuntimeStoreForTests();
        useSettingsStore.getState().reset();
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
            hasOutput: true,
            busy: false,
        });

        // The buffered output is replayed through the output channel, flushed
        // to the first subscriber.
        const { writes } = collectOutput();
        expect(writes()).toBe("early output\n");
    });

    it("adds Claude Code fullscreen rendering env to newly created sessions when enabled", async () => {
        useSettingsStore.setState({ claudeCodeOptimized: true });
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );

        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        expect(vi.mocked(invoke)).toHaveBeenCalledWith(
            "devtools_create_terminal_session",
            {
                input: {
                    cwd: "/vault",
                    cols: 120,
                    rows: 24,
                    extraEnv: {
                        CLAUDE_CODE_NO_FLICKER: "1",
                    },
                },
            },
        );
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

        // Watch the output channel live across the restart.
        const { commands, writes } = collectOutput();

        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "before restart\n",
        });

        const restartPromise = useTerminalRuntimeStore
            .getState()
            .restart("terminal-1");
        // Output from the dying process is suppressed and never reaches xterm.
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "old process output\n",
        });
        restartSession.resolve(makeSnapshot({ sessionId: "devterm-1" }));
        await restartPromise;

        // Restart wipes the screen via a clear command and resets the flag.
        expect(commands.some((c) => c.type === "clear")).toBe(true);
        expect(getRuntime()?.hasOutput).toBe(false);

        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "new process output\n",
        });
        expect(getRuntime()?.hasOutput).toBe(true);
        // Old process output dropped; only pre-restart and post-restart remain.
        expect(writes()).toBe("before restart\nnew process output\n");
    });

    it("delivers live output to a subscriber in arrival order", async () => {
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );
        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        const { writes } = collectOutput();
        const emit = (chunk: string) =>
            useTerminalRuntimeStore
                .getState()
                .handleTerminalOutput({ sessionId: "devterm-1", chunk });

        emit("one ");
        emit("two ");
        emit("three");

        expect(writes()).toBe("one two three");
        expect(getRuntime()?.hasOutput).toBe(true);
    });

    it("clears the viewport: emits a clear command, resets hasOutput, and drops the snapshot", async () => {
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );
        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        const { commands } = collectOutput();
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "output\n",
        });
        expect(getRuntime()?.hasOutput).toBe(true);

        const view = createTerminalSessionView(getRuntime()!);
        view.saveReplaySnapshot("snapshot");
        expect(view.getReplaySnapshot()).toBe("snapshot");

        useTerminalRuntimeStore.getState().clear("terminal-1");

        expect(commands.some((command) => command.type === "clear")).toBe(true);
        expect(getRuntime()?.hasOutput).toBe(false);
        expect(
            createTerminalSessionView(getRuntime()!).getReplaySnapshot(),
        ).toBeNull();
    });

    it("round-trips the replay snapshot and persists it for reload", async () => {
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );
        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        const view = createTerminalSessionView(getRuntime()!);
        expect(view.getReplaySnapshot()).toBeNull();

        view.saveReplaySnapshot("serialized buffer");

        expect(view.getReplaySnapshot()).toBe("serialized buffer");
        // Persisted to storage too, so it survives a full reload (the in-memory
        // copy is gone once the renderer restarts).
        expect(
            safeStorageGetItem("neverwrite.terminal.replay:terminal-1"),
        ).toBe("serialized buffer");
    });

    it("tears down the output channel and snapshot when a terminal closes", async () => {
        vi.mocked(invoke).mockResolvedValue(
            makeSnapshot({ sessionId: "devterm-1" }),
        );
        useTerminalRuntimeStore.getState().ensureTerminal(makeTerminalTab());
        await flushPromises();

        const view = createTerminalSessionView(getRuntime()!);
        view.saveReplaySnapshot("snapshot");
        // Output buffered with no subscriber attached.
        useTerminalRuntimeStore.getState().handleTerminalOutput({
            sessionId: "devterm-1",
            chunk: "buffered\n",
        });

        await useTerminalRuntimeStore.getState().closeTerminal("terminal-1");

        expect(getRuntime()).toBeNull();
        expect(
            safeStorageGetItem("neverwrite.terminal.replay:terminal-1"),
        ).toBeNull();

        // Subscribing to the same id after close yields a fresh channel with no
        // leftover buffered output.
        const received: TerminalOutputCommand[] = [];
        view.subscribeOutput((command) => received.push(command));
        expect(received).toHaveLength(0);
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
