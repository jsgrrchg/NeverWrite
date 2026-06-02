import { invoke } from "../../app/runtime";
import {
    selectEditorWorkspaceTabs,
    type TerminalTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { isTerminalTab } from "../../app/store/editorTabs";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { resetClaudeTerminalAgentSessionsForTests } from "../ai/claudeTerminalAgentSession";
import type { FileTreeNoteDragDetail } from "../ai/dragEvents";
import { resetChatStore } from "../ai/store/chatStore";
import type { TerminalSessionSnapshot } from "./terminalTypes";
import { openClaudeCodeTerminalWithContext } from "./claudeCodeTerminal";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/runtime", () => ({
    invoke: vi.fn(async () => undefined),
}));

function makeRunningSnapshot(
    overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
    return {
        sessionId: "devterm-1",
        program: "/bin/zsh",
        status: "running",
        displayName: "zsh",
        cwd: "/vault root",
        cols: 120,
        rows: 24,
        exitCode: null,
        errorMessage: null,
        ...overrides,
    };
}

async function attachOpenedTerminalRuntime() {
    await Promise.resolve();
    const editorState = useEditorStore.getState();
    const tab = selectEditorWorkspaceTabs(editorState).find(
        (candidate): candidate is TerminalTab =>
            isTerminalTab(candidate) && candidate.id === editorState.activeTabId,
    );
    expect(tab).toBeDefined();
    useTerminalRuntimeStore.setState({
        runtimesById: {
            [tab!.terminalId]: {
                terminalId: tab!.terminalId,
                tabId: tab!.id,
                sessionId: "devterm-1",
                snapshot: makeRunningSnapshot(),
                hasOutput: false,
                busy: false,
                launchError: null,
            },
        },
    });
    await Promise.resolve();
    return tab!;
}

function getWrittenInputs() {
    return vi
        .mocked(invoke)
        .mock.calls.filter(
            ([command]) => command === "devtools_write_terminal_session",
        )
        .map(([, payload]) => {
            return (
                payload as {
                    input: {
                        data: string;
                    };
                }
            ).input.data;
        });
}

const FIXED_SESSION_UUID = "2198181b-9c2d-4c4b-b646-0c219657a6ff";

describe("openClaudeCodeTerminalWithContext", () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.mocked(invoke).mockClear();
        // Deterministic --session-id so command assertions are stable.
        vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_SESSION_UUID);
        resetClaudeTerminalAgentSessionsForTests();
        resetChatStore();
        useSettingsStore.getState().reset();
        useVaultStore.setState({ vaultPath: "/vault root" });
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );
        resetTerminalRuntimeStoreForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        resetClaudeTerminalAgentSessionsForTests();
        resetChatStore();
        resetTerminalRuntimeStoreForTests();
    });

    it("opens a workspace terminal and launches Claude Code with configured flags", async () => {
        useSettingsStore.setState({
            claudeCodeSkipPermissions: true,
            claudeCodeModel: " claude-sonnet-4-6 ",
            claudeCodeContinueSession: true,
            claudeCodeMaxTurns: 7,
        } as Partial<ReturnType<typeof useSettingsStore.getState>>);

        const opening = openClaudeCodeTerminalWithContext();
        await attachOpenedTerminalRuntime();
        await opening;

        const terminalTab = selectEditorWorkspaceTabs(
            useEditorStore.getState(),
        ).find(isTerminalTab);
        expect(terminalTab).toMatchObject({
            title: "Claude Code 1",
            cwd: "/vault root",
        });
        expect(getWrittenInputs()).toEqual([
            "cd '/vault root'\n",
            "claude --dangerously-skip-permissions --model claude-sonnet-4-6 --continue\n",
        ]);
        expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
            "devtools_read_claude_transcript",
            expect.anything(),
        );
    });

    it("ignores unsupported persisted Claude Code models before writing to the shell", async () => {
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        useSettingsStore.setState({
            claudeCodeModel: "claude-sonnet-4-6\nsay injected",
            claudeCodeContinueSession: true,
        });

        const opening = openClaudeCodeTerminalWithContext();
        await attachOpenedTerminalRuntime();
        await opening;

        expect(getWrittenInputs()).toEqual([
            "cd '/vault root'\n",
            "claude --continue\n",
        ]);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                "Ignoring unsupported Claude Code model setting",
            ),
        );
        warnSpy.mockRestore();
    });

    it("prefills vault-relative @mentions after Claude Code settles", async () => {
        vi.useFakeTimers();
        const detail: FileTreeNoteDragDetail = {
            phase: "attach",
            x: 0,
            y: 0,
            notes: [
                {
                    id: "note-1",
                    title: "One note",
                    path: "/vault root/Project Notes/One note.md",
                },
            ],
            files: [
                {
                    fileName: "chart (v1).png",
                    filePath: "/vault root/assets/chart (v1).png",
                    mimeType: "image/png",
                },
                {
                    fileName: 'he said "yes".md',
                    filePath: '/vault root/assets/he said "yes".md',
                    mimeType: "text/markdown",
                },
            ],
            folder: {
                name: "Draft Folder",
                path: "Draft Folder",
            },
            folders: [
                {
                    name: "Draft Folder",
                    path: "Draft Folder",
                },
            ],
        };

        const opening = openClaudeCodeTerminalWithContext(detail);
        await attachOpenedTerminalRuntime();
        await vi.advanceTimersByTimeAsync(3_500);
        await opening;

        expect(getWrittenInputs()).toEqual([
            "cd '/vault root/Draft Folder'\n",
            `claude --session-id ${FIXED_SESSION_UUID}\n`,
            [
                '@"Project Notes/One note.md"',
                '@"assets/chart (v1).png"',
                '@"assets/he said \\"yes\\".md"',
            ].join(" "),
        ]);
    });

    it("numbers Claude Code terminals independently from regular terminals", async () => {
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
                            cwd: "/vault root",
                        },
                        {
                            id: "claude-code-tab-1",
                            kind: "terminal",
                            terminalId: "claude-code-1",
                            title: "Claude Code 1",
                            cwd: "/vault root",
                        },
                    ],
                    activeTabId: "claude-code-tab-1",
                },
            ],
            "primary",
        );

        const opening = openClaudeCodeTerminalWithContext();
        await attachOpenedTerminalRuntime();
        await opening;

        const terminalTitles = selectEditorWorkspaceTabs(
            useEditorStore.getState(),
        )
            .filter(isTerminalTab)
            .map((tab) => tab.title);

        expect(terminalTitles).toEqual([
            "Terminal 1",
            "Claude Code 1",
            "Claude Code 2",
        ]);
    });
});
