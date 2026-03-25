import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore, isReviewTab } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent, setVaultEntries } from "../../../test/test-utils";
import { AIReviewView } from "./AIReviewView";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";
import { useAutoOpenReviewTab } from "../hooks/useAutoOpenReviewTab";
import type { AIRuntimeDescriptor, AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import { emptyPatch, syncDerivedLinePatch } from "../store/actionLogModel";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { selectVisibleTrackedFiles } from "../store/editedFilesBufferModel";

const WORK_CYCLE_ID = "default-cycle";

const runtimes: AIRuntimeDescriptor[] = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
];

function MultiSessionReviewHarness() {
    useAutoOpenReviewTab();
    return (
        <>
            <AIReviewView />
            <EditedFilesBufferPanel />
        </>
    );
}

function createTrackedFile(path: string, updatedAt: number): TrackedFile {
    return syncDerivedLinePatch({
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        diffBase: "old line",
        currentText: `new line ${updatedAt}`,
        unreviewedEdits: emptyPatch(),
        version: 1,
        isText: true,
        updatedAt,
    });
}

function createSession(
    sessionId: string,
    files: TrackedFile[],
    runtimeId = "codex-acp",
): AIChatSession {
    const tracked: Record<string, TrackedFile> = {};
    for (const file of files) {
        tracked[file.identityKey] = file;
    }

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: WORK_CYCLE_ID,
        visibleWorkCycleId: WORK_CYCLE_ID,
        actionLog: {
            trackedFilesByWorkCycleId: {
                [WORK_CYCLE_ID]: tracked,
            },
            lastRejectUndo: null,
        },
        runtimeId,
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        isPersistedSession: false,
        resumeContextPending: false,
    };
}

function setReviewTabActive(sessionId: string) {
    const reviewTab = useEditorStore
        .getState()
        .tabs.find((tab) => isReviewTab(tab) && tab.sessionId === sessionId);
    expect(reviewTab).toBeDefined();
    useEditorStore.getState().switchTab(reviewTab!.id);
}

function replaceSessionFile(
    session: AIChatSession,
    nextFile: TrackedFile,
): AIChatSession {
    return {
        ...session,
        actionLog: {
            trackedFilesByWorkCycleId: {
                [WORK_CYCLE_ID]: {
                    [nextFile.identityKey]: nextFile,
                },
            },
            lastRejectUndo: null,
        },
    };
}

describe("multi-session review integration", () => {
    beforeEach(() => {
        localStorage.clear();
        resetChatStore();
        vi.clearAllMocks();
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
        });
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
    });

    it("mounts review, panel and auto-open with two active sessions while switching between review tabs", async () => {
        setVaultEntries([
            {
                id: "notes/a.md",
                path: "/vault/notes/a.md",
                relative_path: "notes/a.md",
                title: "a.md",
                file_name: "a.md",
                extension: "md",
                kind: "note",
                modified_at: 0,
                created_at: 0,
                size: 10,
                mime_type: "text/markdown",
            },
            {
                id: "notes/b.md",
                path: "/vault/notes/b.md",
                relative_path: "notes/b.md",
                title: "b.md",
                file_name: "b.md",
                extension: "md",
                kind: "note",
                modified_at: 0,
                created_at: 0,
                size: 10,
                mime_type: "text/markdown",
            },
        ]);

        const sessionA = createSession("session-a", [
            createTrackedFile("/vault/notes/a.md", 10),
        ]);
        const sessionB = createSession("session-b", [
            createTrackedFile("/vault/notes/b.md", 20),
        ]);
        const consoleErrorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        renderComponent(<MultiSessionReviewHarness />);

        await act(async () => {
            useChatStore.setState((state) => ({
                ...state,
                runtimes,
                activeSessionId: sessionA.sessionId,
                sessionsById: {
                    [sessionA.sessionId]: sessionA,
                    [sessionB.sessionId]: sessionB,
                },
            }));
        });

        const reviewTabs = useEditorStore
            .getState()
            .tabs.filter((tab) => isReviewTab(tab));
        expect(reviewTabs).toHaveLength(2);

        await act(async () => {
            setReviewTabActive(sessionA.sessionId);
        });
        expect(screen.getAllByText("a.md")).toHaveLength(2);
        expect(screen.queryByText("b.md")).not.toBeInTheDocument();

        await act(async () => {
            useChatStore.setState((state) => ({
                ...state,
                activeSessionId: sessionB.sessionId,
                sessionsById: {
                    ...state.sessionsById,
                    [sessionA.sessionId]: replaceSessionFile(
                        sessionA,
                        createTrackedFile("/vault/notes/a.md", 11),
                    ),
                    [sessionB.sessionId]: replaceSessionFile(
                        sessionB,
                        createTrackedFile("/vault/notes/b.md", 21),
                    ),
                },
            }));
            setReviewTabActive(sessionB.sessionId);
        });
        expect(screen.getAllByText("b.md")).toHaveLength(2);
        expect(screen.queryByText("a.md")).not.toBeInTheDocument();

        await act(async () => {
            useChatStore.setState((state) => ({
                ...state,
                activeSessionId: sessionA.sessionId,
                sessionsById: {
                    ...state.sessionsById,
                    [sessionA.sessionId]: replaceSessionFile(
                        state.sessionsById[sessionA.sessionId]!,
                        createTrackedFile("/vault/notes/a.md", 12),
                    ),
                    [sessionB.sessionId]: replaceSessionFile(
                        state.sessionsById[sessionB.sessionId]!,
                        createTrackedFile("/vault/notes/b.md", 22),
                    ),
                },
            }));
            setReviewTabActive(sessionA.sessionId);
        });
        expect(screen.getAllByText("a.md")).toHaveLength(2);

        expect(
            consoleErrorSpy.mock.calls
                .flat()
                .find((value) =>
                    String(value).includes("Maximum update depth exceeded"),
                ),
        ).toBeUndefined();
    });

    it("returns the same session snapshot for repeated selector reads on an unchanged store state", () => {
        const sessionA = createSession("session-a", [
            createTrackedFile("/vault/notes/a.md", 10),
        ]);
        const sessionB = createSession("session-b", [
            createTrackedFile("/vault/notes/b.md", 20),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: sessionA.sessionId,
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
        }));

        const snapshot = useChatStore.getState();
        const firstA = selectVisibleTrackedFiles(snapshot, sessionA.sessionId);
        const firstB = selectVisibleTrackedFiles(snapshot, sessionB.sessionId);
        const secondA = selectVisibleTrackedFiles(snapshot, sessionA.sessionId);

        expect(firstA.map((file) => file.path)).toEqual(["/vault/notes/a.md"]);
        expect(firstB.map((file) => file.path)).toEqual(["/vault/notes/b.md"]);
        expect(secondA).toBe(firstA);
    });
});
