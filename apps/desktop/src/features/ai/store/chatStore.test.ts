import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isChatTab,
    isFileTab,
    isNoteTab,
    isReviewTab,
    useEditorStore,
} from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { serializeComposerParts } from "../composerParts";
import type {
    AIChatAttachment,
    AIChatSession,
    AIComposerPart,
    QueuedChatMessage,
} from "../types";
import { deriveReviewItems } from "../diff/editedFilesPresentationModel";
import * as reviewProjectionIndexModule from "../diff/reviewProjectionIndex";
import * as reviewProjectionModule from "../diff/reviewProjection";
import { buildReviewProjection } from "../diff/reviewProjection";
import { selectVisibleTrackedFiles } from "./editedFilesBufferModel";
import type { TrackedFile } from "../diff/actionLogTypes";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    emptyPatch,
    hashTextContent,
    setTrackedFilesForWorkCycle,
} from "./actionLogModel";
import { resetChatTabsStore, useChatTabsStore } from "./chatTabsStore";
import {
    disposeChatStoreRuntime,
    flushDeltasSync,
    initializeChatStoreRuntime,
    resetChatStore,
    useChatStore,
} from "./chatStore";
import { resolveEditorTargetForOpenTab } from "../../editor/editorTargetResolver";
import { subscribeEditorReviewSync } from "../../editor/editorReviewSync";
import {
    rememberExternalReloadBaseline,
    resetExternalReloadBaselinesForTests,
} from "../../editor/externalReloadBaselineCache";
import { useChatRowUiStore } from "./chatRowUiStore";

const invokeMock = vi.mocked(invoke);
const AI_PREFS_KEY = "neverwrite.ai.preferences";
const AI_AUTO_CONTEXT_KEY_PREFIX = "neverwrite.ai.auto-context:";

function getAutoContextKey(vaultPath: string | null) {
    return `${AI_AUTO_CONTEXT_KEY_PREFIX}${vaultPath ?? "__global__"}`;
}

function getVisibleBuffer(sessionId: string): TrackedFile[] {
    return selectVisibleTrackedFiles(useChatStore.getState(), sessionId);
}

function createSessionWithTrackedFiles(
    sessionId: string,
    files: TrackedFile[],
    workCycleId = "wc-test",
): AIChatSession {
    let actionLog = emptyActionLogState();
    if (files.length > 0) {
        actionLog = setTrackedFilesForWorkCycle(
            actionLog,
            workCycleId,
            Object.fromEntries(files.map((file) => [file.identityKey, file])),
        );
    }

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        actionLog,
        runtimeId: "test-runtime",
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

function createTrackedFile(
    path: string,
    diffBase: string,
    currentText: string,
    overrides?: Partial<TrackedFile>,
): TrackedFile {
    return {
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        diffBase,
        currentText,
        unreviewedEdits:
            diffBase === currentText
                ? emptyPatch()
                : buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
        ...overrides,
    };
}

const runtimePayload = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime embedded as an ACP sidecar.",
            capabilities: [
                "attachments",
                "permissions",
                "reasoning",
                "create_session",
                "user_input",
            ],
        },
        // Models, modes and config come from the ACP session, not the descriptor.
        models: [],
        modes: [],
        config_options: [],
    },
];

// Session payload simulates what the ACP returns at session creation time.
const acpModels = [
    {
        id: "test-model",
        runtime_id: "codex-acp",
        name: "Test Model",
        description: "A test model for unit tests.",
    },
];

const acpModes = [
    {
        id: "default",
        runtime_id: "codex-acp",
        name: "Default",
        description: "Prompt for actions that need explicit approval.",
        disabled: false,
    },
];

const acpConfigOptions = [
    {
        id: "model",
        runtime_id: "codex-acp",
        category: "model",
        label: "Model",
        type: "select",
        value: "test-model",
        options: [
            { value: "test-model", label: "Test Model" },
            { value: "wide-model", label: "Wide Model" },
        ],
    },
    {
        id: "reasoning_effort",
        runtime_id: "codex-acp",
        category: "reasoning",
        label: "Reasoning Effort",
        type: "select",
        value: "medium",
        options: [
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
        ],
    },
];

const sessionPayload = {
    session_id: "codex-session-1",
    runtime_id: "codex-acp",
    model_id: "test-model",
    mode_id: "default",
    status: "idle" as const,
    efforts_by_model: {
        "test-model": ["medium", "high"],
        "wide-model": ["low", "medium", "high", "xhigh"],
    },
    models: acpModels,
    modes: acpModes,
    config_options: acpConfigOptions,
};

const readySetupStatus = {
    runtime_id: "codex-acp",
    binary_ready: true,
    binary_path: "/Applications/NeverWrite/codex-acp",
    binary_source: "bundled" as const,
    auth_ready: true,
    auth_method: "openai-api-key",
    auth_methods: [
        {
            id: "chatgpt",
            name: "ChatGPT account",
            description:
                "Sign in with your paid ChatGPT account to connect Codex.",
        },
        {
            id: "openai-api-key",
            name: "API key",
            description: "Use an OpenAI API key stored locally in NeverWrite.",
        },
    ],
    onboarding_required: false,
    message: null,
};

const readySetupStatusState = {
    runtimeId: readySetupStatus.runtime_id,
    binaryReady: readySetupStatus.binary_ready,
    binaryPath: readySetupStatus.binary_path,
    binarySource: readySetupStatus.binary_source,
    authReady: readySetupStatus.auth_ready,
    authMethod: readySetupStatus.auth_method,
    authMethods: readySetupStatus.auth_methods,
    onboardingRequired: readySetupStatus.onboarding_required,
    message: readySetupStatus.message ?? undefined,
};

function getActiveSessionId(): string {
    const id = useChatStore.getState().activeSessionId;
    expect(id, "activeSessionId should not be null").not.toBeNull();
    return id!;
}

function createTextParts(text: string): AIComposerPart[] {
    return [
        {
            id: `part:${text}`,
            type: "text",
            text,
        },
    ];
}

function createQueuedMessage(
    id: string,
    text: string,
    overrides: Partial<QueuedChatMessage> = {},
): QueuedChatMessage {
    return {
        id,
        content: overrides.content ?? text,
        prompt: overrides.prompt ?? text,
        composerParts: overrides.composerParts ?? createTextParts(text),
        attachments: overrides.attachments ?? [],
        createdAt: overrides.createdAt ?? 1,
        status: overrides.status ?? "queued",
        modelId: overrides.modelId ?? "test-model",
        modeId: overrides.modeId ?? "default",
        optionsSnapshot: overrides.optionsSnapshot ?? {
            model: "test-model",
            reasoning_effort: "medium",
        },
        optimisticMessageId: overrides.optimisticMessageId,
    };
}

function cloneSessionForTest(
    source: AIChatSession,
    sessionId: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        ...source,
        sessionId,
        historySessionId: sessionId,
        models: source.models.map((model) => ({ ...model })),
        modes: source.modes.map((mode) => ({ ...mode })),
        configOptions: source.configOptions.map((option) => ({
            ...option,
            options: option.options.map((item) => ({ ...item })),
        })),
        messages: [],
        attachments: [],
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

type MockTrackedFilePatch = {
    linePatch: ReturnType<typeof buildPatchFromTexts>;
    textRangePatch: ReturnType<typeof buildTextRangePatchFromTexts>;
};

type MockTrackedFilePatchInput = {
    oldText: string;
    newText: string;
};

function createMockTrackedFilePatch(
    oldText: string,
    newText: string,
): MockTrackedFilePatch {
    const linePatch = buildPatchFromTexts(oldText, newText);
    return {
        linePatch,
        textRangePatch: buildTextRangePatchFromTexts(
            oldText,
            newText,
            linePatch,
        ),
    };
}

function getMockTrackedFilePatchInputs(
    args: unknown,
): MockTrackedFilePatchInput[] {
    if (
        typeof args !== "object" ||
        args === null ||
        !("inputs" in args) ||
        !Array.isArray((args as { inputs?: unknown }).inputs)
    ) {
        throw new Error("Expected tracked file patch inputs.");
    }

    return (args as { inputs: MockTrackedFilePatchInput[] }).inputs;
}

async function defaultInvokeImplementation(command: string, args?: unknown) {
    if (command === "ai_list_runtimes") {
        return runtimePayload;
    }

    if (command === "ai_create_session") {
        return sessionPayload;
    }

    if (command === "ai_list_sessions") {
        return [];
    }

    if (command === "ai_get_setup_status") {
        return readySetupStatus;
    }

    if (command === "ai_update_setup") {
        return readySetupStatus;
    }

    if (command === "ai_start_auth") {
        return readySetupStatus;
    }

    if (command === "ai_load_session") {
        return sessionPayload;
    }

    if (command === "ai_set_model") {
        return {
            ...sessionPayload,
            model_id: "test-model",
        };
    }

    if (command === "ai_set_config_option") {
        const input =
            typeof args === "object" && args !== null && "input" in args
                ? (args.input as {
                      option_id: string;
                      value: string;
                  })
                : null;

        if (input?.option_id === "model") {
            return {
                ...sessionPayload,
                model_id: input.value,
                config_options: [
                    {
                        ...acpConfigOptions[0],
                        value: input.value,
                    },
                    {
                        ...acpConfigOptions[1],
                        value: "low",
                        options: [
                            { value: "low", label: "Low" },
                            { value: "medium", label: "Medium" },
                            { value: "high", label: "High" },
                            { value: "xhigh", label: "Extra High" },
                        ],
                    },
                ],
            };
        }

        return {
            ...sessionPayload,
            config_options: acpConfigOptions.map((option) =>
                option.id === input?.option_id
                    ? { ...option, value: input.value }
                    : option,
            ),
        };
    }

    if (command === "ai_send_message") {
        throw new Error("Codex ACP is unavailable.");
    }

    if (command === "ai_cancel_turn") {
        return {
            ...sessionPayload,
            status: "idle",
        };
    }

    if (command === "ai_respond_user_input") {
        return {
            ...sessionPayload,
            status: "streaming",
        };
    }

    if (command === "ai_load_session_histories") {
        return [];
    }

    if (command === "ai_load_session_history_page") {
        return {
            session_id: "history-1",
            total_messages: 0,
            start_index: 0,
            end_index: 0,
            messages: [],
        };
    }

    return sessionPayload;
}

function mockRustTrackedFilePatches(
    resolver: (
        inputs: MockTrackedFilePatchInput[],
        callIndex: number,
    ) => MockTrackedFilePatch[] | Promise<MockTrackedFilePatch[]>,
    options: {
        allowSendMessage?: boolean;
    } = {},
) {
    let callIndex = 0;
    invokeMock.mockImplementation(async (command, args) => {
        if (command === "compute_tracked_file_patches") {
            return await resolver(
                getMockTrackedFilePatchInputs(args),
                callIndex++,
            );
        }

        if (options.allowSendMessage && command === "ai_send_message") {
            return { ...sessionPayload, status: "streaming" };
        }

        if (
            command === "ai_save_session_history" ||
            command === "ai_prune_session_histories"
        ) {
            return undefined;
        }

        return defaultInvokeImplementation(command, args);
    });
}

async function drainRustTrackedFileWork(iterations = 8) {
    for (let attempt = 0; attempt < iterations; attempt += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function expectTrackedFileToMatchAccumulatedDiff(
    file: TrackedFile,
    diffBase: string,
    currentText: string,
) {
    const linePatch = buildPatchFromTexts(diffBase, currentText);
    expect(file).toMatchObject({
        diffBase,
        currentText,
    });
    expect(file.unreviewedEdits).toEqual(linePatch);
    expect(file.unreviewedRanges).toEqual(
        buildTextRangePatchFromTexts(diffBase, currentText, linePatch),
    );
}

describe("chatStore", () => {
    beforeEach(() => {
        disposeChatStoreRuntime();
        initializeChatStoreRuntime();
        resetChatStore();
        resetChatTabsStore();
        resetExternalReloadBaselinesForTests();
        vi.clearAllMocks();
        delete (globalThis as Record<string, unknown>)
            .__NEVERWRITE_FORCE_RUST_LINE_DIFFS__;
        useVaultStore.setState({ vaultPath: null, notes: [] });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
            currentSelection: null,
        });
        invokeMock.mockImplementation(defaultInvokeImplementation);
    });

    afterEach(() => {
        disposeChatStoreRuntime();
    });

    it("loads the default edit diff zoom when no preference is stored", () => {
        expect(useChatStore.getState().editDiffZoom).toBe(0.72);
    });

    it("restores persisted edit diff zoom from AI preferences", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                editDiffZoom: 0.88,
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().editDiffZoom).toBe(0.88);
    });

    it("persists edit diff zoom updates rounded to two decimals", () => {
        useChatStore.getState().setEditDiffZoom(0.823);

        expect(useChatStore.getState().editDiffZoom).toBe(0.82);
        expect(
            JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}"),
        ).toMatchObject({
            editDiffZoom: 0.82,
        });
    });

    it("persists auto context per vault path", () => {
        useVaultStore.setState({ vaultPath: "/vaults/one" });
        resetChatStore();

        expect(useChatStore.getState().autoContextEnabled).toBe(false);

        useChatStore.getState().toggleAutoContext();

        expect(useChatStore.getState().autoContextEnabled).toBe(true);
        expect(localStorage.getItem(getAutoContextKey("/vaults/one"))).toBe(
            "true",
        );
        expect(localStorage.getItem(AI_PREFS_KEY)).toBeNull();
    });

    it("reloads auto context when switching vaults", () => {
        localStorage.setItem(getAutoContextKey("/vaults/one"), "false");
        localStorage.setItem(getAutoContextKey("/vaults/two"), "true");

        useVaultStore.setState({ vaultPath: "/vaults/one" });
        resetChatStore();
        expect(useChatStore.getState().autoContextEnabled).toBe(false);

        useVaultStore.setState({ vaultPath: "/vaults/two" });
        expect(useChatStore.getState().autoContextEnabled).toBe(true);

        useVaultStore.setState({ vaultPath: "/vaults/one" });
        expect(useChatStore.getState().autoContextEnabled).toBe(false);
    });

    it("restores persisted AI font families from preferences", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                composerFontFamily: "serif",
                chatFontFamily: "typewriter",
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().composerFontFamily).toBe("serif");
        expect(useChatStore.getState().chatFontFamily).toBe("typewriter");
    });

    it("normalizes invalid persisted AI font families back to system", () => {
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                composerFontFamily: "not-a-font",
                chatFontFamily: "also-bad",
            }),
        );

        resetChatStore();

        expect(useChatStore.getState().composerFontFamily).toBe("system");
        expect(useChatStore.getState().chatFontFamily).toBe("system");
    });

    it("persists AI font family updates", () => {
        useChatStore.getState().setComposerFontFamily("reading");
        useChatStore.getState().setChatFontFamily("rounded");

        expect(useChatStore.getState().composerFontFamily).toBe("reading");
        expect(useChatStore.getState().chatFontFamily).toBe("rounded");
        expect(
            JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}"),
        ).toMatchObject({
            composerFontFamily: "reading",
            chatFontFamily: "rounded",
        });
    });

    it("coalesces rapid AI preference storage events and applies only the latest values", () => {
        vi.useFakeTimers();

        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                editDiffZoom: 0.8,
            }),
        );
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: AI_PREFS_KEY,
                newValue: localStorage.getItem(AI_PREFS_KEY),
            }),
        );

        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                editDiffZoom: 0.9,
            }),
        );
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: AI_PREFS_KEY,
                newValue: localStorage.getItem(AI_PREFS_KEY),
            }),
        );

        expect(useChatStore.getState().editDiffZoom).toBe(0.72);

        vi.advanceTimersByTime(80);

        expect(useChatStore.getState().editDiffZoom).toBe(0.9);
        vi.useRealTimers();
    });

    it("ignores global AI preference storage events for auto context and syncs only the active vault key", () => {
        vi.useFakeTimers();

        useVaultStore.setState({ vaultPath: "/vaults/one" });
        resetChatStore();
        expect(useChatStore.getState().autoContextEnabled).toBe(false);

        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({
                autoContextEnabled: false,
                editDiffZoom: 0.8,
            }),
        );
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: AI_PREFS_KEY,
                newValue: localStorage.getItem(AI_PREFS_KEY),
            }),
        );

        vi.advanceTimersByTime(80);

        expect(useChatStore.getState().editDiffZoom).toBe(0.8);
        expect(useChatStore.getState().autoContextEnabled).toBe(false);

        localStorage.setItem(getAutoContextKey("/vaults/two"), "false");
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: getAutoContextKey("/vaults/two"),
                newValue: "false",
            }),
        );

        vi.advanceTimersByTime(80);
        expect(useChatStore.getState().autoContextEnabled).toBe(false);

        localStorage.setItem(getAutoContextKey("/vaults/one"), "false");
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: getAutoContextKey("/vaults/one"),
                newValue: "false",
            }),
        );

        vi.advanceTimersByTime(80);
        expect(useChatStore.getState().autoContextEnabled).toBe(false);
        vi.useRealTimers();
    });

    it("loads runtimes and creates an initial session", async () => {
        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.runtimeConnectionByRuntimeId["codex-acp"]?.status).toBe(
            "ready",
        );
        expect(state.runtimes).toHaveLength(1);
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["codex-session-1"]?.runtimeId).toBe(
            "codex-acp",
        );
    });

    it("starts a new local work cycle when sending a message", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        const activeSessionId = getActiveSessionId();
        useChatStore.getState().setComposerParts(createTextParts("Ship it"));

        await useChatStore.getState().sendMessage();

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const userMessage = session.messages.at(-1);

        expect(session.activeWorkCycleId).toBeTruthy();
        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        expect(userMessage?.workCycleId).toBe(session.activeWorkCycleId);
    });

    it("sends plain full paths to the agent for path-based composer parts", async () => {
        await useChatStore.getState().initialize();
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        useChatStore.getState().setComposerParts([
            { id: "text-1", type: "text", text: "Review " },
            {
                id: "mention-1",
                type: "mention",
                noteId: "notes/spec.md",
                label: "Spec",
                path: "notes/spec.md",
            },
            { id: "text-2", type: "text", text: " and " },
            {
                id: "folder-1",
                type: "folder_mention",
                label: "docs",
                folderPath: "docs",
            },
            { id: "text-3", type: "text", text: " with " },
            {
                id: "selection-1",
                type: "selection_mention",
                noteId: "notes/spec.md",
                label: "Lines 3-4",
                path: "notes/spec.md",
                selectedText: "selected",
                startLine: 3,
                endLine: 4,
            },
            { id: "text-4", type: "text", text: " plus " },
            {
                id: "file-1",
                type: "file_attachment",
                filePath: "/vault/docs/guide.md",
                mimeType: "text/markdown",
                label: "guide.md",
            },
        ]);

        await useChatStore.getState().sendMessage();

        const sendCall = invokeMock.mock.calls.find(
            ([command]) => command === "ai_send_message",
        );

        expect(sendCall).toBeTruthy();
        expect(sendCall?.[1]).toMatchObject({
            content:
                "Review /vault/notes/spec.md and /vault/docs with /vault/notes/spec.md:3-4 plus /vault/docs/guide.md",
        });
    });

    it("does not synthesize legacy auto-context attachments when sending a plain composer message", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "note-tab",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "- [ ] Win bug",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "note-tab",
            activationHistory: ["note-tab"],
            tabNavigationHistory: ["note-tab"],
            tabNavigationIndex: 0,
            currentSelection: {
                noteId: "notes/current",
                path: "/vault/notes/current.md",
                text: "- [ ] Win bug",
                from: 0,
                to: 13,
                startLine: 11,
                endLine: 11,
            },
        });
        await useChatStore.getState().initialize();
        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            autoContextEnabled: true,
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: [],
                },
            },
        }));
        useChatStore.getState().setComposerParts(createTextParts("Check this"));

        await useChatStore.getState().sendMessage();

        const queuedMessage =
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0];

        expect(queuedMessage?.attachments).toEqual([]);
    });

    it("keeps the previous visible work cycle while its permission buffer is unresolved", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    activeWorkCycleId: "cycle-old",
                    visibleWorkCycleId: "cycle-old",
                    messages: [
                        {
                            id: "permission:req-1",
                            role: "assistant",
                            kind: "permission",
                            content: "Edit watcher",
                            title: "Permission request",
                            timestamp: Date.now() - 1_000,
                            workCycleId: "cycle-old",
                            permissionRequestId: "req-1",
                            permissionOptions: [
                                {
                                    option_id: "allow_once",
                                    name: "Allow once",
                                    kind: "allow_once",
                                },
                            ],
                            diffs: [
                                {
                                    path: "/vault/src/watcher.rs",
                                    kind: "update",
                                    old_text: "old line",
                                    new_text: "new line",
                                },
                            ],
                            meta: {
                                status: "pending",
                                target: "/vault/src/watcher.rs",
                            },
                        },
                    ],
                },
            },
        });

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second turn"));
        await useChatStore.getState().sendMessage();

        const updatedSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const userMessages = updatedSession.messages.filter(
            (message) => message.role === "user",
        );

        expect(updatedSession.activeWorkCycleId).toBeTruthy();
        expect(updatedSession.activeWorkCycleId).not.toBe("cycle-old");
        expect(updatedSession.visibleWorkCycleId).toBe("cycle-old");
        expect(userMessages.at(-1)?.workCycleId).toBe(
            updatedSession.activeWorkCycleId,
        );
    });

    it("keeps accumulated tracked edits visible when a new prompt starts before the previous review is resolved", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const firstTracked = createTrackedFile(
            "/vault/src/watcher.rs",
            "original",
            "first edit",
        );

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    activeWorkCycleId: "cycle-old",
                    visibleWorkCycleId: "cycle-old",
                    actionLog: setTrackedFilesForWorkCycle(
                        emptyActionLogState(),
                        "cycle-old",
                        {
                            [firstTracked.identityKey]: firstTracked,
                        },
                    ),
                    messages: [
                        {
                            id: "permission:req-1",
                            role: "assistant",
                            kind: "permission",
                            content: "Edit watcher",
                            title: "Permission request",
                            timestamp: Date.now() - 1_000,
                            workCycleId: "cycle-old",
                            permissionRequestId: "req-1",
                            permissionOptions: [
                                {
                                    option_id: "allow_once",
                                    name: "Allow once",
                                    kind: "allow_once",
                                },
                            ],
                            diffs: [
                                {
                                    path: "/vault/src/watcher.rs",
                                    kind: "update",
                                    old_text: "original",
                                    new_text: "first edit",
                                },
                            ],
                            meta: {
                                status: "pending",
                                target: "/vault/src/watcher.rs",
                            },
                        },
                    ],
                },
            },
        });

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second turn"));
        await useChatStore.getState().sendMessage();

        let updatedSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        expect(updatedSession.visibleWorkCycleId).toBe("cycle-old");
        expect(updatedSession.activeWorkCycleId).not.toBe("cycle-old");
        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                diffBase: "original",
                currentText: "first edit",
            },
        ]);

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-b-same-file",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs again",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "first edit",
                    new_text: "second edit",
                },
            ],
        });

        updatedSession = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                diffBase: "original",
                currentText: "second edit",
            },
        ]);
        const oldCycleTracked =
            updatedSession.actionLog?.trackedFilesByWorkCycleId?.["cycle-old"];
        expect(
            oldCycleTracked == null ||
                Object.keys(oldCycleTracked).length === 0,
        ).toBe(true);
    });

    it("reloads an open markdown note when agent diffs are consolidated", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "old line",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();
        const stopSync = subscribeEditorReviewSync(() =>
            resolveEditorTargetForOpenTab(
                (() => {
                    const activeTab =
                        useEditorStore
                            .getState()
                            .tabs.find(
                                (tab) =>
                                    tab.id ===
                                    useEditorStore.getState().activeTabId,
                            ) ?? null;
                    return activeTab && isNoteTab(activeTab) ? activeTab : null;
                })(),
            ),
        );

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-open-note-sync",
            title: "Edit current note",
            kind: "edit",
            status: "completed",
            target: "/vault/notes/current.md",
            summary: "Updated current.md",
            diffs: [
                {
                    path: "/vault/notes/current.md",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        const editorState = useEditorStore.getState();
        const tab = editorState.tabs[0];
        expect(tab).toMatchObject({
            noteId: "notes/current",
            content: "new line",
        });
        expect(editorState._pendingForceReloads.has("notes/current")).toBe(
            true,
        );
        expect(editorState._noteReloadMetadata["notes/current"]).toMatchObject({
            origin: "agent",
            revision: 0,
            contentHash: null,
        });
        stopSync();
    });

    it("reloads an open text file tab when agent diffs are consolidated", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "file",
                    relativePath: "src/watcher.rs",
                    path: "/vault/src/watcher.rs",
                    title: "watcher.rs",
                    content: "old line",
                    mimeType: "text/rust",
                    viewer: "text",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();
        const stopSync = subscribeEditorReviewSync(() =>
            resolveEditorTargetForOpenTab(
                (() => {
                    const activeTab =
                        useEditorStore
                            .getState()
                            .tabs.find(
                                (tab) =>
                                    tab.id ===
                                    useEditorStore.getState().activeTabId,
                            ) ?? null;
                    return activeTab && isFileTab(activeTab) ? activeTab : null;
                })(),
            ),
        );

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-open-file-sync",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        const editorState = useEditorStore.getState();
        const tab = editorState.tabs[0];
        expect(tab).toMatchObject({
            kind: "file",
            relativePath: "src/watcher.rs",
            content: "new line",
        });
        expect(editorState._pendingForceFileReloads.has("src/watcher.rs")).toBe(
            true,
        );
        stopSync();
    });

    it("clears the auth error banner when setup status becomes ready again", async () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            runtimeConnectionByRuntimeId: {
                "codex-acp": {
                    status: "error",
                    message:
                        "You were signed out. Reconnect in AI setup to continue chatting.",
                },
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    authReady: false,
                    onboardingRequired: true,
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        await useChatStore.getState().refreshSetupStatus();

        expect(
            useChatStore.getState().runtimeConnectionByRuntimeId["codex-acp"],
        ).toEqual({
            status: "ready",
            message: null,
        });
    });

    it("clears the auth error banner after startAuth succeeds", async () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            runtimeConnectionByRuntimeId: {
                "codex-acp": {
                    status: "error",
                    message:
                        "You were signed out. Reconnect in AI setup to continue chatting.",
                },
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    authReady: false,
                    onboardingRequired: true,
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        await useChatStore.getState().startAuth({
            methodId: "openai-api-key",
            codexApiKey: { action: "unchanged" },
            openaiApiKey: { action: "unchanged" },
            geminiApiKey: { action: "unchanged" },
            googleApiKey: { action: "unchanged" },
            gatewayHeaders: { action: "unchanged" },
            anthropicCustomHeaders: { action: "unchanged" },
            anthropicAuthToken: { action: "unchanged" },
        });

        expect(
            useChatStore.getState().runtimeConnectionByRuntimeId["codex-acp"],
        ).toEqual({
            status: "ready",
            message: null,
        });
    });

    it("opens the selected runtime after onboarding completes while another runtime is active", async () => {
        const claudeReadySetupStatus = {
            ...readySetupStatus,
            runtime_id: "claude-acp",
            auth_method: "claude-login",
        };
        const codexSession = {
            sessionId: "codex-session-1",
            historySessionId: "codex-session-1",
            runtimeId: "codex-acp",
            modelId: "test-model",
            modeId: "default",
            status: "idle" as const,
            models: [],
            modes: [],
            configOptions: [],
            messages: [],
            attachments: [],
            runtimeState: "live" as const,
        };

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [
                {
                    runtime: runtimePayload[0].runtime,
                    models: [],
                    modes: [],
                    configOptions: [],
                },
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description:
                            "Claude runtime embedded as an ACP sidecar.",
                        capabilities: [
                            "attachments",
                            "permissions",
                            "plans",
                            "create_session",
                        ],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                [codexSession.sessionId]: codexSession,
            },
            sessionOrder: [codexSession.sessionId],
            activeSessionId: codexSession.sessionId,
            selectedRuntimeId: "claude-acp",
            setupStatusByRuntimeId: {
                "claude-acp": {
                    runtimeId: "claude-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: false,
                    authMethods: [
                        {
                            id: "claude-login",
                            name: "Claude login",
                            description:
                                "Open a terminal-based Claude login flow.",
                        },
                    ],
                    onboardingRequired: true,
                },
            },
        }));

        invokeMock.mockImplementation(async (command, payload) => {
            if (
                command === "ai_get_setup_status" &&
                (payload as { runtimeId?: string } | undefined)?.runtimeId ===
                    "claude-acp"
            ) {
                return claudeReadySetupStatus;
            }
            if (command === "ai_create_session") {
                return {
                    ...sessionPayload,
                    session_id: "claude-session-1",
                    runtime_id: "claude-acp",
                };
            }
            if (command === "ai_save_session_history") {
                return null;
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        });

        await useChatStore.getState().refreshSetupStatus("claude-acp");

        expect(useChatStore.getState().activeSessionId).toBe(
            "claude-session-1",
        );
    });

    it("updates setup copy with the active runtime when authentication expires", () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: { ...runtimePayload[0].runtime },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            setupStatusByRuntimeId: {
                "codex-acp": {
                    ...readySetupStatusState,
                    runtimeId: "codex-acp",
                },
            },
            sessionsById: {
                "codex-session-1": {
                    sessionId: "codex-session-1",
                    historySessionId: "codex-session-1",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    status: "streaming",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Working",
                            timestamp: 10,
                            inProgress: true,
                        },
                    ],
                    attachments: [],
                    runtimeState: "live",
                },
            },
            selectedRuntimeId: "codex-acp",
        });

        useChatStore.getState().applySessionError({
            session_id: "codex-session-1",
            message: "authentication required",
        });

        expect(
            useChatStore.getState().setupStatusByRuntimeId["codex-acp"],
        ).toMatchObject({
            authReady: false,
            onboardingRequired: true,
            message: "You were signed out. Reconnect Codex to continue.",
        });
        expect(
            useChatStore.getState().sessionsById["codex-session-1"]?.messages[0]
                ?.inProgress,
        ).toBe(false);
    });

    it("treats the normalized signed-out message as an authentication error", () => {
        useChatStore.setState({
            runtimes: [
                {
                    runtime: {
                        ...runtimePayload[0].runtime,
                        id: "claude-acp",
                        name: "Claude ACP",
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            setupStatusByRuntimeId: {
                "claude-acp": {
                    ...readySetupStatusState,
                    runtimeId: "claude-acp",
                },
            },
            sessionsById: {
                "claude-session-1": {
                    sessionId: "claude-session-1",
                    historySessionId: "claude-session-1",
                    runtimeId: "claude-acp",
                    modelId: "test-model",
                    modeId: "default",
                    status: "error",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    runtimeState: "live",
                },
            },
            selectedRuntimeId: "claude-acp",
        });

        useChatStore.getState().applySessionError({
            session_id: "claude-session-1",
            message:
                "You were signed out. Reconnect in AI setup to continue chatting.",
        });

        expect(
            useChatStore.getState().setupStatusByRuntimeId["claude-acp"],
        ).toMatchObject({
            authReady: false,
            onboardingRequired: true,
            message: "You were signed out. Reconnect Claude to continue.",
        });
    });

    it("hydrates existing backend sessions before creating a new one", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                    },
                ];
            }

            if (command === "ai_create_session") {
                throw new Error("Should not create a new session");
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("codex-session-existing");
        expect(state.sessionOrder).toEqual(["codex-session-existing"]);
    });

    it("hydrates normalized transcript metadata when a live session adopts persisted history on initialize", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                        models: [],
                        modes: [],
                        config_options: [],
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "codex-session-existing",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "status:init-turn",
                                role: "system",
                                kind: "status",
                                content: "New turn",
                                title: "New turn",
                                timestamp: 10,
                                meta: {
                                    status_event: "turn_started",
                                    status: "completed",
                                    emphasis: "neutral",
                                },
                            },
                            {
                                id: "assistant:init",
                                role: "assistant",
                                kind: "text",
                                content: "Recovered text",
                                timestamp: 11,
                            },
                            {
                                id: "plan:init",
                                role: "assistant",
                                kind: "plan",
                                content: "Recovered plan",
                                title: "Plan",
                                timestamp: 12,
                                plan_entries: [
                                    {
                                        content: "Recovered plan",
                                        priority: "medium",
                                        status: "in_progress",
                                    },
                                ],
                            },
                        ],
                    },
                ];
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_create_session") {
                throw new Error("Should not create a new session");
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const session =
            useChatStore.getState().sessionsById["codex-session-existing"]!;

        expect(session.messages.map((message) => message.id)).toEqual([
            "status:init-turn",
            "assistant:init",
            "plan:init",
        ]);
        expect(session.messageOrder).toEqual([
            "status:init-turn",
            "assistant:init",
            "plan:init",
        ]);
        expect(session.messagesById?.["assistant:init"]?.content).toBe(
            "Recovered text",
        );
        expect(session.lastTurnStartedMessageId).toBe("status:init-turn");
        expect(session.lastAssistantMessageId).toBe("assistant:init");
        expect(session.activePlanMessageId).toBe("plan:init");
        expect(session.models).toEqual([
            {
                id: "test-model",
                runtimeId: "codex-acp",
                name: "Test Model",
                description: "A test model for unit tests.",
            },
        ]);
        expect(session.modes).toEqual([
            {
                id: "default",
                runtimeId: "codex-acp",
                name: "Default",
                description: "Prompt for actions that need explicit approval.",
                disabled: false,
            },
        ]);
        expect(
            session.configOptions.find((option) => option.id === "model"),
        ).toMatchObject({
            id: "model",
            runtimeId: "codex-acp",
            category: "model",
            value: "test-model",
        });
    });

    it("refreshes the active live session catalog on initialize when ACP lists it empty", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                        models: [],
                        modes: [],
                        config_options: [],
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            if (command === "ai_load_session") {
                expect(
                    (args as { sessionId?: string } | undefined)?.sessionId,
                ).toBe("codex-session-existing");
                return {
                    ...sessionPayload,
                    session_id: "codex-session-existing",
                };
            }

            if (command === "ai_create_session") {
                throw new Error("Should not create a new session");
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const session =
            useChatStore.getState().sessionsById["codex-session-existing"]!;

        expect(session.models).toHaveLength(1);
        expect(session.modes).toHaveLength(1);
        expect(session.configOptions).not.toHaveLength(0);
        expect(invokeMock).toHaveBeenCalledWith("ai_load_session", {
            sessionId: "codex-session-existing",
        });
    });

    it("rehydrates a restored live session from the workspace history id when startup ACP data is empty", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                        models: [],
                        modes: [],
                        config_options: [],
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "m1",
                                role: "user",
                                kind: "text",
                                content: "Recovered from disk",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }

            if (command === "ai_load_session") {
                expect(
                    (args as { sessionId?: string } | undefined)?.sessionId,
                ).toBe("codex-session-existing");
                return {
                    ...sessionPayload,
                    session_id: "codex-session-existing",
                    models: [],
                    modes: [],
                    config_options: [],
                };
            }

            if (command === "ai_load_session_history_page") {
                expect(args).toMatchObject({
                    vaultPath: "/vault",
                    sessionId: "history-1",
                    startIndex: 0,
                    limit: 1,
                });
                return {
                    session_id: "history-1",
                    total_messages: 1,
                    start_index: 0,
                    end_index: 1,
                    messages: [
                        {
                            id: "m1",
                            role: "user",
                            kind: "text",
                            content: "Recovered from disk",
                            timestamp: 20,
                        },
                    ],
                };
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        await useChatStore.getState().reconcileRestoredWorkspaceTabs(
            [
                {
                    id: "tab-restored",
                    sessionId: "codex-session-existing",
                    historySessionId: "history-1",
                    runtimeId: "codex-acp",
                },
            ],
            "tab-restored",
        );

        const session =
            useChatStore.getState().sessionsById["codex-session-existing"]!;
        expect(session.historySessionId).toBe("history-1");
        expect(session.models).toHaveLength(1);
        expect(session.modes).toHaveLength(1);
        expect(session.configOptions).not.toHaveLength(0);
    });

    it("loads the active restored workspace session after history metadata is reconciled", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                        models: [],
                        modes: [],
                        config_options: [],
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 200,
                        message_count: 2,
                        title: "Restored title",
                        preview: "Recovered latest",
                        messages: [],
                    },
                ];
            }

            if (command === "ai_load_session_history_page") {
                expect(args).toMatchObject({
                    vaultPath: "/vault",
                    sessionId: "history-1",
                    startIndex: 0,
                    limit: 2,
                });
                return {
                    session_id: "history-1",
                    total_messages: 2,
                    start_index: 0,
                    end_index: 2,
                    messages: [
                        {
                            id: "m1",
                            role: "user",
                            kind: "text",
                            content: "Recovered from disk",
                            timestamp: 10,
                        },
                        {
                            id: "m2",
                            role: "assistant",
                            kind: "text",
                            content: "Recovered reply",
                            timestamp: 20,
                        },
                    ],
                };
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const sessionBefore =
            useChatStore.getState().sessionsById["codex-session-existing"]!;
        expect(sessionBefore.messages).toHaveLength(0);
        expect(sessionBefore.persistedMessageCount ?? 0).toBe(0);

        await useChatStore.getState().reconcileRestoredWorkspaceTabs(
            [
                {
                    id: "tab-restored",
                    sessionId: "codex-session-existing",
                    historySessionId: "history-1",
                    runtimeId: "codex-acp",
                },
            ],
            "tab-restored",
        );

        const sessionAfter =
            useChatStore.getState().sessionsById["codex-session-existing"]!;
        expect(sessionAfter.historySessionId).toBe("history-1");
        expect(sessionAfter.persistedMessageCount).toBe(2);
        expect(sessionAfter.messages.map((message) => message.id)).toEqual([
            "m1",
            "m2",
        ]);
    });

    it("loads only the latest persisted transcript page for the active live session on initialize", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        const latestPageMessages = Array.from({ length: 60 }, (_, index) => ({
            id: `assistant:${index + 20}`,
            role: "assistant",
            kind: "text",
            content: `Recovered message ${index + 20}`,
            timestamp: 1_000 + index,
        }));

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "codex-session-existing",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 2_000,
                        message_count: 80,
                        title: "Seed prompt",
                        preview: "Recovered message 79",
                        messages: [],
                    },
                ];
            }

            if (command === "ai_load_session_history_page") {
                return {
                    session_id: "codex-session-existing",
                    total_messages: 80,
                    start_index: 20,
                    end_index: 80,
                    messages: latestPageMessages,
                };
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const session =
            useChatStore.getState().sessionsById["codex-session-existing"]!;

        expect(session.persistedMessageCount).toBe(80);
        expect(session.loadedPersistedMessageStart).toBe(20);
        expect(session.persistedTitle).toBe("Seed prompt");
        expect(session.persistedPreview).toBe("Recovered message 79");
        expect(session.messages).toHaveLength(60);
        expect(session.messages[0]?.id).toBe("assistant:20");
        expect(session.messages.at(-1)?.id).toBe("assistant:79");
        expect(invokeMock).toHaveBeenCalledWith(
            "ai_load_session_history_page",
            {
                vaultPath: "/vault",
                sessionId: "codex-session-existing",
                startIndex: 20,
                limit: 60,
            },
        );
    });

    it("does not replace an already-normalized empty persisted transcript session", async () => {
        const sessionId = "persisted:empty-history";

        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: {
                    sessionId,
                    historySessionId: "empty-history",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    runtimeState: "persisted_only",
                    isPersistedSession: true,
                    persistedMessageCount: 0,
                    loadedPersistedMessageStart: 0,
                    isLoadingPersistedMessages: false,
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
        }));

        const before = useChatStore.getState().sessionsById[sessionId]!;

        await useChatStore
            .getState()
            .ensureSessionTranscriptLoaded(sessionId, "full");

        const after = useChatStore.getState().sessionsById[sessionId]!;

        expect(after).toBe(before);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_load_session_history_page",
            expect.anything(),
        );
    });

    it("rejects lazy transcript pages that belong to a different session", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        const consoleWarnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => {});

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "codex-session-existing",
                    },
                ];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "codex-session-existing",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 2_000,
                        message_count: 80,
                        title: "Seed prompt",
                        preview: "Recovered message 79",
                        messages: [],
                    },
                ];
            }

            if (command === "ai_load_session_history_page") {
                return {
                    session_id: "wrong-session",
                    total_messages: 80,
                    start_index: 20,
                    end_index: 80,
                    messages: [],
                };
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const session =
            useChatStore.getState().sessionsById["codex-session-existing"]!;
        expect(session.messages).toHaveLength(0);
        expect(session.isLoadingPersistedMessages).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            "[chat-store] Failed to load persisted session transcript page",
            expect.any(Error),
        );

        consoleWarnSpy.mockRestore();
    });

    it("stops before creating a session when onboarding is still required", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return {
                    ...readySetupStatus,
                    binary_ready: false,
                    auth_methods: readySetupStatus.auth_methods,
                    onboarding_required: true,
                };
            }

            if (command === "ai_create_session") {
                throw new Error(
                    "Should not create a session while onboarding is required",
                );
            }

            if (command === "ai_load_session_histories") {
                return [];
            }

            return [];
        });

        await useChatStore.getState().initialize();

        expect(useChatStore.getState().activeSessionId).toBeNull();
        expect(
            useChatStore.getState().setupStatusByRuntimeId["codex-acp"]
                ?.onboardingRequired,
        ).toBe(true);
    });

    it("prevents duplicate note attachments of the same type", async () => {
        await useChatStore.getState().initialize();

        const note = {
            id: "notes/runtime",
            title: "Runtime",
            path: "/vault/notes/runtime.md",
        };

        useChatStore.getState().attachNote(note);
        useChatStore.getState().attachNote(note);

        const activeSessionId = getActiveSessionId();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toHaveLength(1);
    });

    it("prevents duplicate vault file attachments for the same path", async () => {
        await useChatStore.getState().initialize();

        const file = {
            id: "src/main.ts",
            title: "main",
            path: "/vault/src/main.ts",
            relativePath: "src/main.ts",
            fileName: "main.ts",
            mimeType: "text/typescript",
        };

        useChatStore.getState().attachVaultFile(file);
        useChatStore.getState().attachVaultFile(file);

        const activeSessionId = getActiveSessionId();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([
            expect.objectContaining({
                type: "file",
                path: "/vault/src/main.ts",
            }),
        ]);
    });

    it("serializes mention parts into the current session draft", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Use ",
            },
            {
                id: "mention-1",
                type: "mention",
                noteId: "README.md",
                label: "README.md",
                path: "/vault/README.md",
            },
        ]);

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(serializeComposerParts(parts)).toBe("Use [@README.md]");
    });

    it("prunes composer-backed vault file attachments when the file mention is removed", async () => {
        await useChatStore.getState().initialize();

        const file = {
            id: "src/watcher.rs",
            title: "watcher",
            path: "/vault/src/watcher.rs",
            relativePath: "src/watcher.rs",
            fileName: "watcher.rs",
            mimeType: "text/rust",
        };

        useChatStore.getState().attachVaultFile(file);
        useChatStore.getState().setComposerParts([
            {
                id: "file-mention-1",
                type: "file_mention",
                label: "watcher.rs",
                path: "/vault/src/watcher.rs",
                relativePath: "src/watcher.rs",
                mimeType: "text/rust",
            },
        ]);

        const activeSessionId = getActiveSessionId();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toHaveLength(1);

        useChatStore.getState().setComposerParts(createTextParts("Check this"));

        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toHaveLength(0);
    });

    it("moves the updated session to the top of the history order", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        useChatStore.getState().applyMessageStarted({
            session_id: "codex-session-1",
            message_id: "assistant-1",
        });

        expect(useChatStore.getState().sessionOrder).toEqual([
            "codex-session-1",
            "codex-session-2",
        ]);
    });

    it("switches the active session without losing the per-session draft", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );
        useChatStore.getState().setActiveSession("codex-session-1");

        useChatStore.getState().setComposerParts([
            {
                id: "draft-1",
                type: "text",
                text: "first draft",
            },
        ]);

        useChatStore.getState().setActiveSession("codex-session-2");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-2",
                type: "text",
                text: "second draft",
            },
        ]);
        useChatStore.getState().setActiveSession("codex-session-1");

        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    "codex-session-1"
                ] ?? [],
            ),
        ).toBe("first draft");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    "codex-session-2"
                ] ?? [],
            ),
        ).toBe("second draft");
    });

    it("keeps drafts, attachments and agent events isolated between sessions", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        useChatStore.getState().setActiveSession("codex-session-1");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-1",
                type: "text",
                text: "draft session 1",
            },
        ]);
        useChatStore.getState().attachNote({
            id: "notes/one",
            title: "Note One",
            path: "/vault/Note One.md",
        });

        useChatStore.getState().setActiveSession("codex-session-2");
        useChatStore.getState().setComposerParts([
            {
                id: "draft-2",
                type: "text",
                text: "draft session 2",
            },
        ]);
        useChatStore.getState().attachNote({
            id: "notes/two",
            title: "Note Two",
            path: "/vault/Note Two.md",
        });

        useChatStore.getState().applyMessageDelta({
            session_id: "codex-session-1",
            message_id: "assistant-1",
            delta: "response for session 1",
        });
        flushDeltasSync();

        const state = useChatStore.getState();

        expect(
            serializeComposerParts(
                state.composerPartsBySessionId["codex-session-1"] ?? [],
            ),
        ).toBe("draft session 1");
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId["codex-session-2"] ?? [],
            ),
        ).toBe("draft session 2");

        expect(
            state.sessionsById["codex-session-1"]?.attachments.map(
                (attachment) => attachment.label,
            ),
        ).toEqual(["Note One"]);
        expect(
            state.sessionsById["codex-session-2"]?.attachments.map(
                (attachment) => attachment.label,
            ),
        ).toEqual(["Note Two"]);

        expect(
            state.sessionsById["codex-session-1"]?.messages.at(-1)?.content,
        ).toBe("response for session 1");
        expect(state.sessionsById["codex-session-2"]?.messages).toHaveLength(0);
        expect(state.activeSessionId).toBe("codex-session-2");
    });

    it("does not reorder session history when flushing streamed deltas", async () => {
        await useChatStore.getState().initialize();

        const activeSession =
            useChatStore.getState().sessionsById[getActiveSessionId()]!;
        const secondSession = cloneSessionForTest(
            activeSession,
            "codex-session-2",
        );

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [secondSession.sessionId]: secondSession,
            },
            sessionOrder: [secondSession.sessionId, activeSession.sessionId],
            activeSessionId: secondSession.sessionId,
        }));

        useChatStore.getState().applyMessageDelta({
            session_id: activeSession.sessionId,
            message_id: "assistant-stream-1",
            delta: "background delta",
        });
        flushDeltasSync();

        expect(useChatStore.getState().sessionOrder).toEqual([
            secondSession.sessionId,
            activeSession.sessionId,
        ]);
    });

    it("loads a session from backend and promotes it to the top of the history", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
                messages: [],
                attachments: [],
            },
            true,
        );

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session") {
                return {
                    ...sessionPayload,
                    session_id: (args as { sessionId: string }).sessionId,
                };
            }
            return sessionPayload;
        });

        await useChatStore.getState().loadSession("codex-session-2");

        expect(useChatStore.getState().activeSessionId).toBe("codex-session-2");
        expect(useChatStore.getState().sessionOrder[0]).toBe("codex-session-2");
    });

    it("prepends older persisted transcript pages on demand", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const sessionId = getActiveSessionId();
        const latestMessages = Array.from({ length: 20 }, (_, index) => ({
            id: `assistant:${index + 60}`,
            role: "assistant" as const,
            kind: "text" as const,
            content: `Loaded message ${index + 60}`,
            timestamp: index + 60,
        }));

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: {
                    ...state.sessionsById[sessionId]!,
                    messages: latestMessages,
                    persistedCreatedAt: 1,
                    persistedUpdatedAt: 120,
                    persistedTitle: "Persisted title",
                    persistedPreview: "Loaded message 79",
                    persistedMessageCount: 80,
                    loadedPersistedMessageStart: 60,
                    isLoadingPersistedMessages: false,
                },
            },
        }));

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_load_session_history_page") {
                expect(args).toMatchObject({
                    vaultPath: "/vault",
                    sessionId,
                    startIndex: 0,
                    limit: 60,
                });
                return {
                    session_id: sessionId,
                    total_messages: 80,
                    start_index: 0,
                    end_index: 60,
                    messages: Array.from({ length: 60 }, (_, index) => ({
                        id: `assistant:${index}`,
                        role: "assistant",
                        kind: "text",
                        content: `Loaded message ${index}`,
                        timestamp: index,
                    })),
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().loadOlderMessages(sessionId);

        const session = useChatStore.getState().sessionsById[sessionId]!;
        expect(session.loadedPersistedMessageStart).toBe(0);
        expect(session.messages).toHaveLength(80);
        expect(session.messages[0]?.id).toBe("assistant:0");
        expect(session.messages[59]?.id).toBe("assistant:59");
        expect(session.messages[60]?.id).toBe("assistant:60");
        expect(session.messages.at(-1)?.id).toBe("assistant:79");
    });

    it("migrates virtualized row UI state when a detached session is resumed", async () => {
        await useChatStore.getState().initialize();

        const detachedSessionId = "persisted:history-42";
        const resumedSessionId = "codex-session-resumed";
        const messageId = "plan:resume";
        const queuedMessage = createQueuedMessage(
            "queued-resume",
            "Queued after resume",
        );
        const editedQueuedMessage = createQueuedMessage(
            "queued-edit",
            "Edit after resume",
        );
        const draftParts = createTextParts("Resume draft");
        const previousDraftParts = createTextParts("Previous draft");
        const activeSession =
            useChatStore.getState().sessionsById[getActiveSessionId()]!;

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, detachedSessionId, {
                historySessionId: "history-42",
                runtimeId: "codex-acp",
                runtimeState: "detached",
                isPersistedSession: true,
                status: "idle",
                messages: [
                    {
                        id: messageId,
                        role: "assistant",
                        kind: "plan",
                        title: "Plan",
                        content: "Resume work",
                        timestamp: 10,
                        planEntries: [
                            {
                                content: "Resume work",
                                priority: "medium",
                                status: "in_progress",
                            },
                        ],
                    },
                ],
                attachments: [],
            }),
            true,
        );

        useChatRowUiStore.getState().patchRow(detachedSessionId, messageId, {
            expanded: false,
        });
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-detached",
                    sessionId: detachedSessionId,
                },
            ],
            activeTabId: "tab-detached",
        });
        useEditorStore.getState().openChat(detachedSessionId, {
            title: "Detached chat",
        });
        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [detachedSessionId]: draftParts,
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [detachedSessionId]: [queuedMessage, editedQueuedMessage],
            },
            queuedMessageEditBySessionId: {
                ...state.queuedMessageEditBySessionId,
                [detachedSessionId]: {
                    item: editedQueuedMessage,
                    originalIndex: 1,
                    previousItemId: queuedMessage.id,
                    nextItemId: null,
                    previousComposerParts: previousDraftParts,
                    previousAttachments: [],
                },
            },
            activeQueuedMessageBySessionId: {
                ...state.activeQueuedMessageBySessionId,
                [detachedSessionId]: {
                    item: queuedMessage,
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: editedQueuedMessage.id,
                },
            },
            pausedQueueBySessionId: {
                ...state.pausedQueueBySessionId,
                [detachedSessionId]: {
                    reinstateAfterNextManualSend: [
                        {
                            item: editedQueuedMessage,
                            originalIndex: 1,
                            previousItemId: queuedMessage.id,
                            nextItemId: null,
                        },
                    ],
                },
            },
        }));

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_create_session") {
                return {
                    ...sessionPayload,
                    session_id: resumedSessionId,
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        const nextSessionId = await useChatStore
            .getState()
            .resumeSession(detachedSessionId);

        expect(nextSessionId).toBe(resumedSessionId);
        expect(
            useChatRowUiStore.getState().rowsBySessionId[detachedSessionId],
        ).toBeUndefined();
        expect(
            useChatRowUiStore.getState().rowsBySessionId[resumedSessionId]?.[
                messageId
            ],
        ).toMatchObject({
            expanded: false,
        });
        expect(
            useChatStore.getState().sessionsById[resumedSessionId]
                ?.messageOrder,
        ).toEqual([messageId]);
        expect(
            useChatStore.getState().sessionsById[resumedSessionId]
                ?.messagesById?.[messageId]?.content,
        ).toBe("Resume work");
        expect(
            useChatStore.getState().sessionsById[resumedSessionId]
                ?.activePlanMessageId,
        ).toBe(messageId);
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    resumedSessionId
                ] ?? [],
            ),
        ).toBe("Resume draft");
        expect(
            useChatStore.getState().queuedMessagesBySessionId[resumedSessionId],
        ).toEqual([queuedMessage, editedQueuedMessage]);
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                resumedSessionId
            ],
        ).toMatchObject({
            item: editedQueuedMessage,
            previousComposerParts: previousDraftParts,
        });
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                resumedSessionId
            ],
        ).toMatchObject({
            item: queuedMessage,
            nextItemId: editedQueuedMessage.id,
        });
        expect(
            useChatStore.getState().pausedQueueBySessionId[resumedSessionId],
        ).toMatchObject({
            reinstateAfterNextManualSend: [
                expect.objectContaining({
                    item: editedQueuedMessage,
                }),
            ],
        });
        expect(
            useChatStore.getState().composerPartsBySessionId[detachedSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().queuedMessagesBySessionId[
                detachedSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                detachedSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                detachedSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore.getState().pausedQueueBySessionId[detachedSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().sessionsById[resumedSessionId],
        ).toMatchObject({
            isResumingSession: false,
            runtimeState: "live",
        });
        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-detached",
                sessionId: resumedSessionId,
                historySessionId: "history-42",
                runtimeId: "codex-acp",
            },
        ]);
        expect(
            useEditorStore
                .getState()
                .tabs.some(
                    (tab) =>
                        isChatTab(tab) && tab.sessionId === resumedSessionId,
                ),
        ).toBe(true);
        expect(
            useEditorStore
                .getState()
                .tabs.some(
                    (tab) =>
                        isChatTab(tab) && tab.sessionId === detachedSessionId,
                ),
        ).toBe(false);
    });

    it("adds the user message and turns the session into error when the runtime fails", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Please rewrite this note",
            },
        ]);

        await useChatStore.getState().sendMessage();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.status).toBe("error");
        expect(session.messages[0]?.role).toBe("user");
        expect(session.messages.at(-1)?.kind).toBe("error");
    });

    it("normalizes oversized context errors into a start-new-chat message", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                throw new Error(
                    'Internal error: {"codex_error_info":"other","message":"{\n  \\"type\\": \\"error\\",\n  \\"error\\": {\n    \\"type\\": \\"invalid_request_error\\",\n    \\"message\\": \\"[LargeStringParam] [input[2].content[0].text] [string_above_max_length] Invalid \'input[2].content[0].text\': string too long. Expected a string with maximum length 10485760, but got a string with length 14274669 instead.\\"\n  },\n  \\"status\\": 400\n}"}',
                );
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        useChatStore.getState().setComposerParts(createTextParts("hola"));
        await useChatStore.getState().sendMessage();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.messages.at(-1)?.kind).toBe("error");
        expect(session.messages.at(-1)?.content).toBe(
            "This chat context grew too large to continue. Start a new chat and resend your last message.",
        );
    });

    it("queues a new turn while the session is waiting for permission", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: [
                        {
                            id: "file-1",
                            type: "file",
                            noteId: null,
                            label: "Scope.md",
                            path: null,
                            filePath: "/tmp/Scope.md",
                            mimeType: "text/markdown",
                            status: "ready",
                        },
                    ],
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Queue this next",
            },
        ]);

        await useChatStore.getState().sendMessage();

        const state = useChatStore.getState();
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_send_message",
            ),
        ).toHaveLength(0);
        expect(state.queuedMessagesBySessionId[activeSessionId]).toEqual([
            expect.objectContaining({
                content: "Queue this next",
                status: "queued",
                modelId: "test-model",
                modeId: "default",
                attachments: [
                    expect.objectContaining({
                        id: "file-1",
                        label: "Scope.md",
                    }),
                ],
            }),
        ]);
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId[activeSessionId] ?? [],
            ),
        ).toBe("");
        expect(state.sessionsById[activeSessionId]?.attachments).toEqual([]);
    });

    it("clears the composer after sending immediately", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Send right away"));

        await useChatStore.getState().sendMessage();

        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("");
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.role === "user" && message.content === "Send right away"),
        ).toBe(true);
    });

    it("drains the next queued message when the session returns to idle", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Send after this turn",
            },
        ]);

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toHaveLength(1);

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.some(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Send after this turn",
            ),
        ).toBe(true);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            content: "Send after this turn",
            status: "sending",
        });
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.role === "user" && message.content === "Send after this turn"),
        ).toBe(true);
    });

    it("pauses the queue on cancel and resumes it only after the next manual send", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                const content =
                    typeof args === "object" &&
                    args !== null &&
                    "content" in args &&
                    typeof args.content === "string"
                        ? args.content
                        : "";
                return {
                    ...sessionPayload,
                    status: "streaming",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                    model_id:
                        content === "Manual redirect"
                            ? sessionPayload.model_id
                            : sessionPayload.model_id,
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "Queued after cancel"),
                ],
            },
        }));

        await useChatStore.getState().stopStreaming(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId]
                ?.reinstateAfterNextManualSend,
        ).toEqual([]);

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-cancelled",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Queued after cancel",
            ),
        ).toHaveLength(0);

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Manual redirect"));
        await useChatStore.getState().sendMessage(activeSessionId);

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Manual redirect",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-after-manual",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Queued after cancel",
            ),
        ).toHaveLength(1);
    });

    it("requeues the in-flight queued message after cancel and preserves order after the next manual send", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "First queued"),
                    createQueuedMessage("queued-2", "Second queued"),
                ],
            },
        }));

        await useChatStore.getState().tryDrainQueue(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2"]);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item.id,
        ).toBe("queued-1");

        await useChatStore.getState().stopStreaming(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1", "queued-2"]);
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId]
                ?.reinstateAfterNextManualSend,
        ).toEqual([]);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Manual redirect"));
        await useChatStore.getState().sendMessage(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2"]);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            id: "queued-1",
            status: "sending",
        });
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId],
        ).toBeUndefined();

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-after-manual",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "First queued",
            ),
        ).toHaveLength(2);
    });

    it("waits for an in-flight stop before sending the next manual message", async () => {
        const cancelTurn = createDeferred<typeof sessionPayload>();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming" as const,
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_cancel_turn") {
                return await cancelTurn.promise;
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "Queued after cancel"),
                ],
            },
        }));

        const stopPromise = useChatStore
            .getState()
            .stopStreaming(activeSessionId);
        await Promise.resolve();

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Manual redirect"));
        const sendPromise = useChatStore
            .getState()
            .sendMessage(activeSessionId);

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_send_message",
            ),
        ).toHaveLength(0);

        cancelTurn.resolve({
            ...sessionPayload,
            session_id: activeSessionId,
            status: "idle",
        });

        await stopPromise;
        await sendPromise;

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Manual redirect",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            id: "queued-1",
            status: "sending",
        });
    });

    it("dispatches the first manual send after stop without requiring a second submit", async () => {
        const cancelTurn = createDeferred<typeof sessionPayload>();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming" as const,
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_cancel_turn") {
                return await cancelTurn.promise;
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        }));

        const stopPromise = useChatStore
            .getState()
            .stopStreaming(activeSessionId);
        await Promise.resolve();

        useChatStore
            .getState()
            .setComposerParts(createTextParts("First send should stick"));
        await useChatStore.getState().sendMessage(activeSessionId);

        expect(
            useChatStore.getState().interruptedTurnStateBySessionId[
                activeSessionId
            ]?.pendingManualSend?.item.content,
        ).toBe("First send should stick");
        expect(
            useChatStore.getState().composerPartsBySessionId[activeSessionId],
        ).toMatchObject([{ type: "text", text: "" }]);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_send_message",
            ),
        ).toHaveLength(0);

        cancelTurn.resolve({
            ...sessionPayload,
            session_id: activeSessionId,
            status: "idle",
        });

        await stopPromise;
        await Promise.resolve();

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "First send should stick",
            ),
        ).toHaveLength(1);
    });

    it("drops buffered assistant deltas from a stopped turn before the next turn starts", async () => {
        vi.useFakeTimers();
        try {
            invokeMock.mockImplementation(async (command) => {
                if (command === "ai_list_runtimes") return runtimePayload;
                if (command === "ai_create_session") return sessionPayload;
                if (command === "ai_list_sessions") return [];
                if (command === "ai_get_setup_status") return readySetupStatus;
                if (command === "ai_update_setup") return readySetupStatus;
                if (command === "ai_start_auth") return readySetupStatus;
                if (command === "ai_load_session") return sessionPayload;
                if (command === "ai_set_model") return sessionPayload;
                if (command === "ai_set_mode") return sessionPayload;
                if (command === "ai_set_config_option") return sessionPayload;
                if (command === "ai_cancel_turn") {
                    return {
                        ...sessionPayload,
                        status: "idle",
                    };
                }
                if (command === "ai_load_session_histories") return [];
                return sessionPayload;
            });

            await useChatStore.getState().initialize();

            const activeSessionId = getActiveSessionId();
            useChatStore.setState((state) => ({
                sessionsById: {
                    ...state.sessionsById,
                    [activeSessionId]: {
                        ...state.sessionsById[activeSessionId]!,
                        status: "streaming",
                    },
                },
            }));

            useChatStore.getState().applyMessageDelta({
                session_id: activeSessionId,
                message_id: "assistant-stale",
                delta: "Old cancelled response",
            });

            await useChatStore.getState().stopStreaming(activeSessionId);

            useChatStore.getState().applyThinkingStarted({
                session_id: activeSessionId,
                message_id: "thinking-next",
            });

            expect(
                useChatStore
                    .getState()
                    .sessionsById[
                        activeSessionId
                    ]?.messages.some((message) => message.role === "assistant" && message.content.includes("Old cancelled response")),
            ).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores late assistant activity after stop until a fresh turn starts", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        }));

        await useChatStore.getState().stopStreaming(activeSessionId);

        useChatStore.getState().applyMessageDelta({
            session_id: activeSessionId,
            message_id: "assistant-late",
            delta: "Too late",
        });
        flushDeltasSync();

        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("idle");
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.content.includes("Too late")),
        ).toBe(false);
    });

    it("retries a failed queued message without duplicating the user turn", async () => {
        let sendAttempts = 0;
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                sendAttempts += 1;
                if (sendAttempts === 1) {
                    throw new Error("Temporary send failure.");
                }
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                };
            }
            if (command === "ai_respond_user_input") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });
        useChatStore.getState().setComposerParts([
            {
                id: "text-1",
                type: "text",
                text: "Retry me once",
            },
        ]);

        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const failedItem =
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0];
        expect(failedItem?.status).toBe("failed");

        await useChatStore
            .getState()
            .retryQueuedMessage(activeSessionId, failedItem!.id);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(
            session.messages.filter(
                (message) =>
                    message.role === "user" &&
                    message.content === "Retry me once",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            content: "Retry me once",
            status: "sending",
        });
        expect(sendAttempts).toBe(2);
    });

    it("interrupts the current turn and sends the queued message immediately when sending it now", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...useChatStore.getState().sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        });

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        await useChatStore
            .getState()
            .sendQueuedMessageNow(activeSessionId, "queued-2");

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_cancel_turn",
            ),
        ).toHaveLength(1);
        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Second",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("requeues the interrupted queued turn and still sends the selected queued message immediately", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_cancel_turn") {
                return {
                    ...sessionPayload,
                    status: "idle",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
            activeQueuedMessageBySessionId: {
                ...state.activeQueuedMessageBySessionId,
                [activeSessionId]: {
                    item: createQueuedMessage("queued-1", "First", {
                        status: "sending",
                    }),
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: "queued-2",
                },
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-2", "Second"),
                    createQueuedMessage("queued-3", "Third"),
                ],
            },
        }));

        await useChatStore
            .getState()
            .sendQueuedMessageNow(activeSessionId, "queued-3");

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_cancel_turn",
            ),
        ).toHaveLength(1);
        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Third",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1", "queued-2"]);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("dispatches the prioritized queued message immediately when sending it now from idle", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "First"),
                    createQueuedMessage("queued-2", "Second"),
                ],
            },
        }));

        await useChatStore
            .getState()
            .sendQueuedMessageNow(activeSessionId, "queued-2");

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Second",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-priority",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "First",
            ),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            id: "queued-1",
            status: "sending",
        });
        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
    });

    it("removes a queued message from the visible list once it has been sent", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                    session_id:
                        typeof args === "object" &&
                        args !== null &&
                        "sessionId" in args &&
                        typeof args.sessionId === "string"
                            ? args.sessionId
                            : sessionPayload.session_id,
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "Only queued"),
                ],
            },
        }));

        await useChatStore.getState().tryDrainQueue(activeSessionId);

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ]?.item,
        ).toMatchObject({
            id: "queued-1",
            status: "sending",
        });

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-final",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("heals stale sending queue entries when the session is already idle", async () => {
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_update_setup") return readySetupStatus;
            if (command === "ai_start_auth") return readySetupStatus;
            if (command === "ai_load_session") return sessionPayload;
            if (command === "ai_set_model") return sessionPayload;
            if (command === "ai_set_mode") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }
            if (command === "ai_load_session_histories") return [];
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "idle",
                },
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-stale", "Already sent", {
                        status: "sending",
                    }),
                    createQueuedMessage("queued-next", "Send this now"),
                ],
            },
            activeQueuedMessageBySessionId: {
                ...state.activeQueuedMessageBySessionId,
                [activeSessionId]: {
                    item: createQueuedMessage("queued-stale", "Already sent", {
                        status: "sending",
                    }),
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: "queued-next",
                },
            },
        }));

        await useChatStore
            .getState()
            .sendQueuedMessageNow(activeSessionId, "queued-next");

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => `${item.id}:${item.status}`),
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
        expect(
            invokeMock.mock.calls.filter(
                ([command, payload]) =>
                    command === "ai_send_message" &&
                    typeof payload === "object" &&
                    payload !== null &&
                    "content" in payload &&
                    payload.content === "Send this now",
            ),
        ).toHaveLength(1);
    });

    it("moves a queued message into the composer and restores the previous draft on cancel", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const currentDraft = createTextParts("Current draft");
        const currentAttachment: AIChatAttachment = {
            id: "current-file",
            type: "file",
            noteId: null,
            label: "Current.txt",
            path: null,
            filePath: "/tmp/current.txt",
            mimeType: "text/plain",
            status: "ready",
        };
        const queuedAttachment: AIChatAttachment = {
            id: "queued-file",
            type: "file",
            noteId: null,
            label: "Queued.txt",
            path: null,
            filePath: "/tmp/queued.txt",
            mimeType: "text/plain",
            status: "ready",
        };

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: currentDraft,
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    attachments: [currentAttachment],
                },
            },
        }));
        useChatStore.getState().enqueueMessage(
            activeSessionId,
            createQueuedMessage("queued-1", "Queued draft", {
                attachments: [queuedAttachment],
            }),
        );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-1");

        expect(
            useChatStore.getState().queuedMessagesBySessionId[activeSessionId],
        ).toBeUndefined();
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Queued draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([queuedAttachment]);

        useChatStore.getState().cancelQueuedMessageEdit(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1"]);
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Current draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([currentAttachment]);
    });

    it("clears queue editing and deferred state even when no visible queue entry remains", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const editingItem = createQueuedMessage("queued-edit", "Editing");

        useChatStore.setState((state) => ({
            queuedMessageEditBySessionId: {
                ...state.queuedMessageEditBySessionId,
                [activeSessionId]: {
                    item: editingItem,
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: null,
                    previousComposerParts: createTextParts("Draft"),
                    previousAttachments: [],
                },
            },
            activeQueuedMessageBySessionId: {
                ...state.activeQueuedMessageBySessionId,
                [activeSessionId]: {
                    item: editingItem,
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: null,
                },
            },
            pausedQueueBySessionId: {
                ...state.pausedQueueBySessionId,
                [activeSessionId]: {
                    reinstateAfterNextManualSend: [
                        {
                            item: editingItem,
                            originalIndex: 0,
                            previousItemId: null,
                            nextItemId: null,
                        },
                    ],
                },
            },
        }));

        useChatStore.getState().clearSessionQueue(activeSessionId);

        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore.getState().activeQueuedMessageBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore.getState().pausedQueueBySessionId[activeSessionId],
        ).toBeUndefined();
    });

    it("keeps an edited message ahead of later items when canceling after the queue changes", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-3", "Third"),
            );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-2");
        useChatStore
            .getState()
            .removeQueuedMessage(activeSessionId, "queued-1");
        useChatStore.getState().cancelQueuedMessageEdit(activeSessionId);

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2", "queued-3"]);
    });

    it("requeues an edited message ahead of later items when saving from the composer while the session is busy", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const previousDraft = createTextParts("Side draft");
        const previousAttachment: AIChatAttachment = {
            id: "side-file",
            type: "file",
            noteId: null,
            label: "Side.txt",
            path: null,
            filePath: "/tmp/side.txt",
            mimeType: "text/plain",
            status: "ready",
        };

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: previousDraft,
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: [previousAttachment],
                },
            },
        }));

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-3", "Third"),
            );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-2");
        useChatStore
            .getState()
            .removeQueuedMessage(activeSessionId, "queued-1");
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second updated"));

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-2", "queued-3"]);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0]?.content,
        ).toBe("Second updated");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Side draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([previousAttachment]);
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("requeues an edited message only once when stale queue state already contains the same item", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const previousDraft = createTextParts("Side draft");
        const previousAttachment: AIChatAttachment = {
            id: "side-file",
            type: "file",
            noteId: null,
            label: "Side.txt",
            path: null,
            filePath: "/tmp/side.txt",
            mimeType: "text/plain",
            status: "ready",
        };
        const staleEditedItem = createQueuedMessage("queued-2", "Second stale");

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: createTextParts("Second updated"),
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "waiting_permission",
                    attachments: staleEditedItem.attachments.map(
                        (attachment) => ({
                            ...attachment,
                        }),
                    ),
                },
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "First"),
                    staleEditedItem,
                    createQueuedMessage("queued-3", "Third"),
                ],
            },
            queuedMessageEditBySessionId: {
                ...state.queuedMessageEditBySessionId,
                [activeSessionId]: {
                    item: staleEditedItem,
                    originalIndex: 1,
                    previousItemId: "queued-1",
                    nextItemId: "queued-3",
                    previousComposerParts: previousDraft,
                    previousAttachments: [previousAttachment],
                },
            },
        }));

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1", "queued-2", "queued-3"]);
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.filter((item) => item.id === "queued-2"),
        ).toHaveLength(1);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[1]?.content,
        ).toBe("Second updated");
    });

    it("sends an edited queued message immediately without keeping it in the queue when the session is idle", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                expect(
                    typeof args === "object" &&
                        args !== null &&
                        "content" in args &&
                        args.content,
                ).toBe("Second updated");
                return {
                    ...sessionPayload,
                    status: "streaming" as const,
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const previousDraft = createTextParts("Side draft");
        const previousAttachment: AIChatAttachment = {
            id: "side-file",
            type: "file",
            noteId: null,
            label: "Side.txt",
            path: null,
            filePath: "/tmp/side.txt",
            mimeType: "text/plain",
            status: "ready",
        };

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: previousDraft,
            },
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    attachments: [previousAttachment],
                },
            },
        }));

        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-1", "First"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-2", "Second"),
            );
        useChatStore
            .getState()
            .enqueueMessage(
                activeSessionId,
                createQueuedMessage("queued-3", "Third"),
            );

        useChatStore.getState().editQueuedMessage(activeSessionId, "queued-2");
        useChatStore
            .getState()
            .removeQueuedMessage(activeSessionId, "queued-1");
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second updated"));

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-3"]);
        expect(
            useChatStore.getState().queuedMessagesBySessionId[
                activeSessionId
            ]?.[0]?.content,
        ).toBe("Third");
        expect(
            serializeComposerParts(
                useChatStore.getState().composerPartsBySessionId[
                    activeSessionId
                ] ?? [],
            ),
        ).toBe("Side draft");
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([previousAttachment]);
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.messages.some((message) => message.role === "user" && message.content === "Second updated"),
        ).toBe(true);
    });

    it("drops stale queued copies of an edited message when sending it immediately", async () => {
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                expect(
                    typeof args === "object" &&
                        args !== null &&
                        "content" in args &&
                        args.content,
                ).toBe("Second updated");
                return {
                    ...sessionPayload,
                    status: "streaming" as const,
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const staleEditedItem = createQueuedMessage("queued-2", "Second stale");

        useChatStore.setState((state) => ({
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: createTextParts("Second updated"),
            },
            queuedMessagesBySessionId: {
                ...state.queuedMessagesBySessionId,
                [activeSessionId]: [
                    createQueuedMessage("queued-1", "First"),
                    staleEditedItem,
                    createQueuedMessage("queued-3", "Third"),
                ],
            },
            queuedMessageEditBySessionId: {
                ...state.queuedMessageEditBySessionId,
                [activeSessionId]: {
                    item: staleEditedItem,
                    originalIndex: 1,
                    previousItemId: "queued-1",
                    nextItemId: "queued-3",
                    previousComposerParts: createTextParts("Side draft"),
                    previousAttachments: [],
                },
            },
        }));

        await useChatStore.getState().sendMessage();

        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.map((item) => item.id),
        ).toEqual(["queued-1", "queued-3"]);
        expect(
            useChatStore
                .getState()
                .queuedMessagesBySessionId[
                    activeSessionId
                ]?.find((item) => item.id === "queued-2"),
        ).toBeUndefined();
        expect(
            useChatStore.getState().queuedMessageEditBySessionId[
                activeSessionId
            ],
        ).toBeUndefined();
    });

    it("does not force the session back to idle after a quiet tool event", async () => {
        vi.useFakeTimers();
        try {
            await useChatStore.getState().initialize();

            const activeSessionId = getActiveSessionId();
            const session =
                useChatStore.getState().sessionsById[activeSessionId]!;

            useChatStore.setState({
                sessionsById: {
                    ...useChatStore.getState().sessionsById,
                    [activeSessionId]: {
                        ...session,
                        status: "streaming",
                        messages: [
                            {
                                id: "user-1",
                                role: "user",
                                kind: "text",
                                content: "Open the file and fix it",
                                timestamp: Date.now() - 10,
                            },
                        ],
                    },
                },
            });

            useChatStore.getState().applyToolActivity({
                session_id: activeSessionId,
                tool_call_id: "tool-1",
                title: "Read file",
                kind: "read",
                status: "completed",
                summary: "README.md",
            });
            vi.runAllTimers();

            expect(
                useChatStore.getState().sessionsById[activeSessionId]?.status,
            ).toBe("streaming");
        } finally {
            vi.useRealTimers();
        }
    });

    it("flushes assistant deltas without waiting for a later lifecycle event", async () => {
        vi.useFakeTimers();
        try {
            await useChatStore.getState().initialize();

            const activeSessionId = getActiveSessionId();
            useChatStore.setState((state) => ({
                sessionsById: {
                    ...state.sessionsById,
                    [activeSessionId]: {
                        ...state.sessionsById[activeSessionId]!,
                        status: "idle",
                    },
                },
            }));

            useChatStore.getState().applyMessageDelta({
                session_id: activeSessionId,
                message_id: "assistant-live",
                delta: "Streaming now",
            });

            expect(
                useChatStore
                    .getState()
                    .sessionsById[
                        activeSessionId
                    ]?.messages.some((message) => message.id === "assistant-live" && message.content.includes("Streaming now")),
            ).toBe(false);

            vi.runAllTimers();

            expect(
                useChatStore.getState().sessionsById[activeSessionId]?.status,
            ).toBe("streaming");
            expect(
                useChatStore
                    .getState()
                    .sessionsById[
                        activeSessionId
                    ]?.messages.some((message) => message.id === "assistant-live" && message.content.includes("Streaming now")),
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("restores streaming when late activity arrives on a live idle session", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "idle",
                },
            },
        }));

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-restore-1",
            title: "Write file",
            kind: "edit",
            status: "in_progress",
            summary: "notes/today.md",
        });
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("streaming");

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "idle",
                },
            },
        }));

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "status-restore-1",
            kind: "turn_started",
            status: "in_progress",
            title: "Turn started",
            detail: "Agent resumed work",
            emphasis: "normal",
        });
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("streaming");

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "idle",
                },
            },
        }));

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "plan-restore-1",
            title: "Continue execution",
            detail: "Still running",
            entries: [
                {
                    content: "Finish the write",
                    priority: "medium",
                    status: "in_progress",
                },
            ],
        });
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("streaming");

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "idle",
                },
            },
        }));

        useChatStore.getState().applyMessageDelta({
            session_id: activeSessionId,
            message_id: "assistant-restore-1",
            delta: "Still working",
        });
        flushDeltasSync();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.status,
        ).toBe("streaming");
    });

    it("upserts tool diffs into a single tool message and preserves its timestamp", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "in_progress",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const firstMessage =
            useChatStore.getState().sessionsById[activeSessionId]?.messages[0];

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const toolMessages = session.messages.filter(
            (message) => message.kind === "tool",
        );

        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0]).toMatchObject({
            id: "tool:tool-1",
            kind: "tool",
            content: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });
        expect(toolMessages[0].workCycleId).toBeTruthy();
        expect(session.activeWorkCycleId).toBe(toolMessages[0].workCycleId);
        expect(toolMessages[0].timestamp).toBe(firstMessage?.timestamp);
    });

    it("consolidates edited files only for completed tool diffs", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-progress",
            title: "Edit watcher",
            kind: "edit",
            status: "in_progress",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-complete",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                originPath: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                status: { kind: "modified" },
                diffBase: "old line",
                currentText: "new line",
                isText: true,
            },
        ]);
    });

    it("ignores failed tool diffs when consolidating the edited files buffer", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-failed",
            title: "Edit watcher",
            kind: "edit",
            status: "failed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
    });

    it("consolidates repeated edits for the same file into a single buffer entry", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "mid line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-2",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs again",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "mid line",
                    new_text: "final line",
                },
            ],
        });

        const buffer = getVisibleBuffer(activeSessionId);

        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/vault/src/watcher.rs",
            originPath: "/vault/src/watcher.rs",
            path: "/vault/src/watcher.rs",
            diffBase: "old line",
            currentText: "final line",
            status: { kind: "modified" },
        });
    });

    it("removes the buffer entry when a later diff restores the base snapshot", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-2",
            title: "Restore watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Restored watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "new line",
                    new_text: "old line",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
    });

    it("keeps the edited files buffer after message completion transitions the session to idle", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-buffer-survives-complete",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-1",
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("idle");
        expect(session.visibleWorkCycleId).toBe(workCycleId);
        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                diffBase: "old line",
                currentText: "new line",
            },
        ]);
    });

    it("consolidates the edited files buffer when a permission request carries diffs", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        // First, trigger a tool activity so a work cycle is created
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-before-perm",
            title: "Read file",
            kind: "read",
            status: "completed",
            summary: "file.rs",
        });

        // Now send a permission request with diffs
        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "perm-1",
            tool_call_id: "tool-patch",
            title: "Edit watcher.rs",
            target: "/vault/src/watcher.rs",
            options: [],
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old content",
                    new_text: "new content",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                status: { kind: "modified" },
                diffBase: "old content",
                currentText: "new content",
            },
        ]);
    });

    it("reconstructs a fragmentary permission diff from the open editor content", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "before\nold line\nafter",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-before-fragment-perm",
            title: "Read file",
            kind: "read",
            status: "completed",
            summary: "current.md",
        });

        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "perm-fragment",
            tool_call_id: "tool-fragment",
            title: "Edit current.md",
            target: "/vault/notes/current.md",
            options: [],
            diffs: [
                {
                    path: "/vault/notes/current.md",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                    reversible: true,
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/notes/current.md",
                path: "/vault/notes/current.md",
                diffBase: "before\nold line\nafter",
                currentText: "before\nnew line\nafter",
            },
        ]);
    });

    it("reconstructs a fragmentary tool diff from the pre-reload external baseline", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "file",
                    relativePath: "src/watcher.rs",
                    path: "/vault/src/watcher.rs",
                    title: "watcher.rs",
                    content: "before\nnew line\nafter",
                    mimeType: "text/rust",
                    viewer: "text",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        rememberExternalReloadBaseline(
            "src/watcher.rs",
            "before\nold line\nafter",
            "before\nnew line\nafter",
        );
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-fragment-reload-baseline",
            title: "Edit watcher.rs",
            kind: "edit",
            status: "completed",
            summary: "watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                    reversible: true,
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                path: "/vault/src/watcher.rs",
                diffBase: "before\nold line\nafter",
                currentText: "before\nnew line\nafter",
            },
        ]);
    });

    it("treats fragmentary delete diffs as inline updates when the file still has content", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "before\nremove me\nafter",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-before-fragment-delete",
            title: "Read file",
            kind: "read",
            status: "completed",
            summary: "current.md",
        });

        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "perm-fragment-delete",
            tool_call_id: "tool-fragment-delete",
            title: "Edit current.md",
            target: "/vault/notes/current.md",
            options: [],
            diffs: [
                {
                    path: "/vault/notes/current.md",
                    kind: "delete",
                    old_text: "remove me\n",
                    reversible: true,
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/notes/current.md",
                path: "/vault/notes/current.md",
                status: { kind: "modified" },
                diffBase: "before\nremove me\nafter",
                currentText: "before\nafter",
            },
        ]);
    });

    it("reconstructs fragmentary diffs against an empty tracked baseline", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    actionLog: setTrackedFilesForWorkCycle(
                        emptyActionLogState(),
                        "wc-empty-file",
                        {
                            "/vault/src/new.cpp": {
                                identityKey: "/vault/src/new.cpp",
                                originPath: "/vault/src/new.cpp",
                                path: "/vault/src/new.cpp",
                                previousPath: null,
                                status: { kind: "modified" },
                                reviewState: "finalized",
                                diffBase: "",
                                currentText: "",
                                unreviewedRanges: { spans: [] },
                                unreviewedEdits: { edits: [] },
                                version: 1,
                                isText: true,
                                updatedAt: 1,
                                conflictHash: null,
                            },
                        },
                    ),
                    activeWorkCycleId: "wc-empty-file",
                    visibleWorkCycleId: "wc-empty-file",
                },
            },
        }));

        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "perm-empty-file",
            tool_call_id: "tool-empty-file",
            title: "Edit new.cpp",
            target: "/vault/src/new.cpp",
            options: [],
            diffs: [
                {
                    path: "/vault/src/new.cpp",
                    kind: "update",
                    old_text: "",
                    new_text: "int main() {}\n",
                    reversible: true,
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/new.cpp",
                path: "/vault/src/new.cpp",
                diffBase: "",
                currentText: "int main() {}\n",
            },
        ]);
    });

    it("replaces a resolved visible work cycle when a new turn starts", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return {
                    ...sessionPayload,
                    status: "streaming",
                };
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    visibleWorkCycleId: "cycle-old",
                    activeWorkCycleId: "cycle-old",
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            "cycle-old": {
                                "/vault/src/old.rs": createTrackedFile(
                                    "/vault/src/old.rs",
                                    "old base",
                                    "old applied",
                                ),
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
            },
        }));

        useChatStore
            .getState()
            .setComposerParts(createTextParts("Second turn"));
        await useChatStore.getState().sendMessage();

        let session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.activeWorkCycleId).toBeTruthy();
        expect(session.activeWorkCycleId).not.toBe("cycle-old");
        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        // Old cycle key is gone, but entries are carried forward to the new cycle
        const oldCycleTracked =
            session.actionLog?.trackedFilesByWorkCycleId?.["cycle-old"];
        expect(
            oldCycleTracked == null ||
                Object.keys(oldCycleTracked).length === 0,
        ).toBe(true);
        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            expect.objectContaining({
                identityKey: "/vault/src/old.rs",
                diffBase: "old base",
                currentText: "old applied",
            }),
        ]);

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-new-cycle",
            title: "Edit new file",
            kind: "edit",
            status: "completed",
            target: "/vault/src/new.rs",
            summary: "Updated new.rs",
            diffs: [
                {
                    path: "/vault/src/new.rs",
                    kind: "update",
                    old_text: "new old",
                    new_text: "new applied",
                },
            ],
        });

        session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        // Buffer now has both the carried-forward entry and the new one
        const visibleBuf = getVisibleBuffer(activeSessionId);
        expect(visibleBuf).toHaveLength(2);
        expect(visibleBuf).toMatchObject(
            expect.arrayContaining([
                expect.objectContaining({
                    identityKey: "/vault/src/old.rs",
                    diffBase: "old base",
                    currentText: "old applied",
                }),
                expect.objectContaining({
                    identityKey: "/vault/src/new.rs",
                    diffBase: "new old",
                    currentText: "new applied",
                }),
            ]),
        );
        const oldCycleTracked2 =
            session.actionLog?.trackedFilesByWorkCycleId?.["cycle-old"];
        expect(
            oldCycleTracked2 == null ||
                Object.keys(oldCycleTracked2).length === 0,
        ).toBe(true);
    });

    it("starts a new work cycle without waiting for deprecated tracked-file precomputation", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();

        invokeMock.mockImplementation(async (command) => {
            if (command === "compute_tracked_file_patches") {
                throw new Error(
                    "compute_tracked_file_patches should not be called from the ActionLog write path.",
                );
            }

            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-cycle-a",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const firstWorkCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId;

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_send_message",
            ),
        ).toBe(true);
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "compute_tracked_file_patches",
            ),
        ).toBe(false);
        expect(session.activeWorkCycleId).toBeTruthy();
        expect(session.activeWorkCycleId).not.toBe(firstWorkCycleId);
        expect(session.visibleWorkCycleId).toBe(session.activeWorkCycleId);
        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/src/watcher.rs",
                diffBase: "old line",
                currentText: "new line",
            },
        ]);

        const oldCycleTracked =
            firstWorkCycleId == null
                ? null
                : session.actionLog?.trackedFilesByWorkCycleId?.[
                      firstWorkCycleId
                  ];
        expect(
            oldCycleTracked == null ||
                Object.keys(oldCycleTracked).length === 0,
        ).toBe(true);
    });

    it("keeps accumulated hunks when Rust refinement reprocesses the same file in one cycle", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();
        mockRustTrackedFilePatches((inputs) =>
            inputs.map((input) =>
                createMockTrackedFilePatch(input.oldText, input.newText),
            ),
        );

        const activeSessionId = getActiveSessionId();
        const baseText = "aaa\nbbb\nccc\nddd";
        const midText = "aaa\nBBB\nccc\nddd";
        const finalText = "aaa\nBBB\nccc\nDDD";

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-same-cycle-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: baseText,
                    new_text: midText,
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-same-cycle-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: midText,
                    new_text: finalText,
                },
            ],
        });

        await drainRustTrackedFileWork();

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0].unreviewedEdits.edits).toHaveLength(2);
        expectTrackedFileToMatchAccumulatedDiff(buffer[0], baseText, finalText);
    });

    it("keeps accumulated hunks across cycles when Rust refinement revisits the same file", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();
        mockRustTrackedFilePatches(
            (inputs) =>
                inputs.map((input) =>
                    createMockTrackedFilePatch(input.oldText, input.newText),
                ),
            { allowSendMessage: true },
        );

        const activeSessionId = getActiveSessionId();
        const baseText = "aaa\nbbb\nccc\nddd";
        const midText = "aaa\nBBB\nccc\nddd";
        const finalText = "aaa\nBBB\nccc\nDDD";

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-cycle-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: baseText,
                    new_text: midText,
                },
            ],
        });
        await drainRustTrackedFileWork();

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-cycle-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: midText,
                    new_text: finalText,
                },
            ],
        });

        await drainRustTrackedFileWork();

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0].unreviewedEdits.edits).toHaveLength(2);
        expectTrackedFileToMatchAccumulatedDiff(buffer[0], baseText, finalText);
    });

    it("keeps earlier hunks after a user edit and a later Rust-refined agent edit", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();
        mockRustTrackedFilePatches(
            (inputs) =>
                inputs.map((input) =>
                    createMockTrackedFilePatch(input.oldText, input.newText),
                ),
            { allowSendMessage: true },
        );

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-user-edit-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc\nddd",
                    new_text: "aaa\nBBB\nccc\nddd",
                },
            ],
        });
        await drainRustTrackedFileWork();

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-user-edit-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaXa\nBBB\nccc\nddd",
                    new_text: "aaXa\nBBB\nccc\nDDD",
                },
            ],
        });

        await drainRustTrackedFileWork();

        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-cycle-b",
        });

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0].reviewState).toBe("finalized");
        expect(buffer[0].unreviewedEdits.edits).toHaveLength(2);
        expectTrackedFileToMatchAccumulatedDiff(
            buffer[0],
            "aaXa\nbbb\nccc\nddd",
            "aaXa\nBBB\nccc\nDDD",
        );

        const reviewItems = deriveReviewItems(
            buffer,
            new Set(["/notes/file.md"]),
        );
        expect(reviewItems).toHaveLength(1);
        expect(reviewItems[0]).toMatchObject({
            canReject: true,
            canResolveHunks: true,
        });
    });

    it("keeps accumulated hunks when a Rust-refined permission diff updates an already tracked file", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();
        mockRustTrackedFilePatches((inputs) =>
            inputs.map((input) =>
                createMockTrackedFilePatch(input.oldText, input.newText),
            ),
        );

        const activeSessionId = getActiveSessionId();
        const baseText = "aaa\nbbb\nccc\nddd";
        const midText = "aaa\nBBB\nccc\nddd";
        const finalText = "aaa\nBBB\nccc\nDDD";

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-permission-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: baseText,
                    new_text: midText,
                },
            ],
        });
        await drainRustTrackedFileWork();

        useChatStore.getState().applyPermissionRequest({
            session_id: activeSessionId,
            request_id: "permission-rust-accumulated",
            tool_call_id: "tool-rust-permission-b",
            title: "Edit file again",
            target: "/notes/file.md",
            options: [],
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: midText,
                    new_text: finalText,
                },
            ],
        });

        await drainRustTrackedFileWork();

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0].unreviewedEdits.edits).toHaveLength(2);
        expectTrackedFileToMatchAccumulatedDiff(buffer[0], baseText, finalText);
    });

    it("does not let a late Rust refinement collapse earlier hunks on an accumulated file", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();

        const firstRefinement = createDeferred<MockTrackedFilePatch[]>();
        mockRustTrackedFilePatches((inputs, callIndex) => {
            if (callIndex === 0) {
                return firstRefinement.promise;
            }

            return inputs.map((input) =>
                createMockTrackedFilePatch(input.oldText, input.newText),
            );
        });

        const activeSessionId = getActiveSessionId();
        const baseText = "aaa\nbbb\nccc\nddd";
        const midText = "aaa\nBBB\nccc\nddd";
        const finalText = "aaa\nBBB\nccc\nDDD";

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-late-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: baseText,
                    new_text: midText,
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-late-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: midText,
                    new_text: finalText,
                },
            ],
        });

        const optimisticBuffer = getVisibleBuffer(activeSessionId);
        expect(optimisticBuffer).toHaveLength(1);
        expectTrackedFileToMatchAccumulatedDiff(
            optimisticBuffer[0],
            baseText,
            finalText,
        );

        firstRefinement.resolve([
            createMockTrackedFilePatch(baseText, midText),
        ]);
        await drainRustTrackedFileWork();

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0].unreviewedEdits.edits).toHaveLength(2);
        expectTrackedFileToMatchAccumulatedDiff(buffer[0], baseText, finalText);
    });

    it("merges accumulated entries when the same file is edited across cycles", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();

        // Cycle A: edit file.md
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "original",
                    new_text: "first edit",
                },
            ],
        });

        // Start cycle B
        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();

        // Cycle B: edit same file again
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-b",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "first edit",
                    new_text: "second edit",
                },
            ],
        });

        // Should have one merged entry: diffBase from cycle A, currentText from cycle B
        const mergedBuf = getVisibleBuffer(activeSessionId);
        expect(mergedBuf).toHaveLength(1);
        expect(mergedBuf).toMatchObject([
            {
                identityKey: "/notes/file.md",
                diffBase: "original",
                currentText: "second edit",
            },
        ]);
    });

    it("keeps earlier agent hunks rejectable when the user edits the file and the agent edits it again later", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();

        // Cycle A: agent edits line 1.
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-a-user-interleaved",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc\nddd",
                    new_text: "aaa\nBBB\nccc\nddd",
                },
            ],
        });

        // User edits a different line before resolving the pending agent hunk.
        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        // Cycle B: same file gets another agent edit on a different line.
        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-cycle-b-user-interleaved",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaXa\nBBB\nccc\nddd",
                    new_text: "aaXa\nBBB\nccc\nDDD",
                },
            ],
        });

        // Finishing the second turn should restore review controls, not
        // silently accept the older hunk.
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-cycle-b",
        });

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/notes/file.md",
            diffBase: "aaXa\nbbb\nccc\nddd",
            currentText: "aaXa\nBBB\nccc\nDDD",
            reviewState: "finalized",
        });
        expect(buffer[0].unreviewedEdits.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
            {
                oldStart: 3,
                oldEnd: 4,
                newStart: 3,
                newEnd: 4,
            },
        ]);

        const reviewItems = deriveReviewItems(
            buffer,
            new Set(["/notes/file.md"]),
        );
        expect(reviewItems).toHaveLength(1);
        expect(reviewItems[0]).toMatchObject({
            canReject: true,
            canResolveHunks: true,
        });
    });

    it("auto-removes a carried entry when a later cycle reverts the file", async () => {
        await useChatStore.getState().initialize();
        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();

        // Cycle A: edit file.md
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-revert-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "original",
                    new_text: "changed",
                },
            ],
        });

        // Start cycle B
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Revert turn"));
        await useChatStore.getState().sendMessage();

        // Cycle B: revert file back to original
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-revert-b",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "changed",
                    new_text: "original",
                },
            ],
        });

        // Entry should be auto-removed since diffBase === currentText
        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
    });

    it("applies user edits immediately without deferred Rust replay", async () => {
        (
            globalThis as Record<string, unknown>
        ).__NEVERWRITE_FORCE_RUST_LINE_DIFFS__ = true;
        await useChatStore.getState().initialize();

        invokeMock.mockImplementation(async (command) => {
            if (command === "compute_tracked_file_patches") {
                throw new Error(
                    "compute_tracked_file_patches should not be called from the ActionLog write path.",
                );
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            return sessionPayload;
        });

        const activeSessionId = getActiveSessionId();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-rust-user-edit",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc",
                    new_text: "aaa\nBBB\nccc",
                },
            ],
        });

        // JS consolidation creates the buffer entry immediately
        expect(getVisibleBuffer(activeSessionId)).toHaveLength(1);

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc",
        );

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "compute_tracked_file_patches",
            ),
        ).toBe(false);
        expect(buffer[0]).toMatchObject({
            identityKey: "/notes/file.md",
            diffBase: "aaXa\nbbb\nccc",
            currentText: "aaXa\nBBB\nccc",
        });
        expect(buffer[0].unreviewedEdits.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
        ]);
    });

    it("applies user text edits from the editor while preserving untouched agent spans", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const workCycleId = "cycle-user-edit";

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    activeWorkCycleId: workCycleId,
                    visibleWorkCycleId: workCycleId,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [workCycleId]: {
                                "/notes/file.md": createTrackedFile(
                                    "/notes/file.md",
                                    "aaa\nbbb\nccc",
                                    "aaa\nBBB\nccc",
                                ),
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
            },
        }));

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc",
        );

        const buffer = getVisibleBuffer(activeSessionId);
        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/notes/file.md",
            diffBase: "aaXa\nbbb\nccc",
            currentText: "aaXa\nBBB\nccc",
        });
        expect(buffer[0].unreviewedEdits.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
        ]);

        // Verify spans (source of truth) are also correctly preserved
        expect(buffer[0].unreviewedRanges).toBeDefined();
        expect(buffer[0].unreviewedRanges!.spans.length).toBeGreaterThan(0);
        // The agent span for "bbb"→"BBB" should be within line 1 of the new text
        const agentSpan = buffer[0].unreviewedRanges!.spans[0];
        const line1Start = "aaXa\n".length; // 5
        expect(agentSpan.currentFrom).toBeGreaterThanOrEqual(line1Start);
        expect(agentSpan.currentTo).toBeLessThanOrEqual(
            line1Start + "BBB".length,
        );
    });

    it("propagates user text edits to every session tracking the same file", async () => {
        await useChatStore.getState().initialize();

        const firstSessionId = getActiveSessionId();
        const firstSession =
            useChatStore.getState().sessionsById[firstSessionId]!;
        const secondSessionId = "codex-session-2";
        const firstWorkCycleId = "cycle-user-edit-1";
        const secondWorkCycleId = "cycle-user-edit-2";

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [firstSessionId]: {
                    ...state.sessionsById[firstSessionId]!,
                    activeWorkCycleId: firstWorkCycleId,
                    visibleWorkCycleId: firstWorkCycleId,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [firstWorkCycleId]: {
                                "/notes/file.md": createTrackedFile(
                                    "/notes/file.md",
                                    "aaa\nbbb\nccc",
                                    "aaa\nBBB\nccc",
                                ),
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
                [secondSessionId]: {
                    ...firstSession,
                    sessionId: secondSessionId,
                    historySessionId: secondSessionId,
                    activeWorkCycleId: secondWorkCycleId,
                    visibleWorkCycleId: secondWorkCycleId,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [secondWorkCycleId]: {
                                "/notes/file.md": createTrackedFile(
                                    "/notes/file.md",
                                    "aaa\nbbb\nccc",
                                    "aaa\nBBB\nccc",
                                ),
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
            } as Record<string, AIChatSession>,
            sessionOrder: [...state.sessionOrder, secondSessionId],
        }));

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc",
        );

        const firstBuffer = getVisibleBuffer(firstSessionId);
        const secondBuffer = getVisibleBuffer(secondSessionId);

        expect(firstBuffer).toHaveLength(1);
        expect(secondBuffer).toHaveLength(1);
        expect(firstBuffer[0]).toMatchObject({
            identityKey: "/notes/file.md",
            diffBase: "aaXa\nbbb\nccc",
            currentText: "aaXa\nBBB\nccc",
        });
        expect(secondBuffer[0]).toMatchObject({
            identityKey: "/notes/file.md",
            diffBase: "aaXa\nbbb\nccc",
            currentText: "aaXa\nBBB\nccc",
        });
        expect(firstBuffer[0].unreviewedEdits.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
        ]);
        expect(secondBuffer[0].unreviewedEdits.edits).toEqual([
            {
                oldStart: 1,
                oldEnd: 2,
                newStart: 1,
                newEnd: 2,
            },
        ]);
    });

    it("normalizes move entries to the destination path so later edits merge into one row", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-move",
            title: "Move watcher",
            kind: "move",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Moved watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    previous_path: "/vault/src/watcher.rs",
                    kind: "move",
                    old_text: "old line",
                    new_text: "old line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-update-after-move",
            title: "Edit moved watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Updated watcher-final.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const buffer = getVisibleBuffer(activeSessionId);

        expect(buffer).toHaveLength(1);
        expect(buffer[0]).toMatchObject({
            identityKey: "/vault/src/watcher-final.rs",
            originPath: "/vault/src/watcher.rs",
            path: "/vault/src/watcher-final.rs",
            previousPath: "/vault/src/watcher.rs",
            status: { kind: "modified" },
            diffBase: "old line",
            currentText: "new line",
        });
    });

    it("keeps only the visible buffer in memory when Keep All is used", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-keep-all",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().keepAllEditedFiles(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        // keepAllEditedFiles clears tracked files but keeps work cycle IDs
        expect(session.visibleWorkCycleId).toBeDefined();
        expect(session.activeWorkCycleId).toBeDefined();
        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
    });

    it("keepEditedFile removes only the targeted entry and keeps other work-cycle entries intact", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const visibleWorkCycleId = "wc-visible";
        const hiddenWorkCycleId = "wc-hidden";
        const visibleEntry = createTrackedFile(
            "/vault/visible.md",
            "before visible",
            "after visible",
        );
        const hiddenEntry = createTrackedFile(
            "/vault/hidden.md",
            "before hidden",
            "after hidden",
        );

        useChatStore.setState((state) => {
            const session = state.sessionsById[activeSessionId]!;
            let actionLog = emptyActionLogState();
            actionLog = setTrackedFilesForWorkCycle(
                actionLog,
                visibleWorkCycleId,
                {
                    [visibleEntry.identityKey]: visibleEntry,
                },
            );
            actionLog = setTrackedFilesForWorkCycle(
                actionLog,
                hiddenWorkCycleId,
                {
                    [hiddenEntry.identityKey]: hiddenEntry,
                },
            );

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [activeSessionId]: {
                        ...session,
                        visibleWorkCycleId,
                        activeWorkCycleId: hiddenWorkCycleId,
                        actionLog,
                    },
                },
            };
        });

        useChatStore
            .getState()
            .keepEditedFile(activeSessionId, visibleEntry.identityKey);

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            expect.objectContaining({
                identityKey: hiddenEntry.identityKey,
                path: hiddenEntry.path,
            }),
        ]);
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.actionLog
                ?.trackedFilesByWorkCycleId?.[visibleWorkCycleId],
        ).toBeUndefined();
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.actionLog
                ?.trackedFilesByWorkCycleId?.[hiddenWorkCycleId],
        ).toMatchObject({
            [hiddenEntry.identityKey]: expect.objectContaining({
                path: hiddenEntry.path,
            }),
        });
    });

    function getEditedBufferEntry(sessionId: string, workCycleId: string) {
        const session = useChatStore.getState().sessionsById[sessionId]!;
        expect(session.visibleWorkCycleId).toBe(workCycleId);
        const entries = getVisibleBuffer(sessionId);
        expect(entries).toHaveLength(1);
        return entries[0];
    }

    it("rejects a single edited file when the on-disk hash still matches the applied snapshot", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reject-one",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (command === "ai_restore_text_file") {
                return {
                    vault_path: "/vault",
                    kind: "upsert",
                    note: null,
                    note_id: null,
                    entry: null,
                    relative_path: "src/watcher.rs",
                    origin: "agent",
                    op_id: "agent-merged-1",
                    revision: 3,
                    content_hash: "hash-merged-line",
                    graph_revision: 1,
                };
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        // rejectEditedFile removes the tracked file but keeps work cycle IDs
        expect(session.visibleWorkCycleId).toBeDefined();
        expect(session.activeWorkCycleId).toBeDefined();
        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("rejects an accumulated multi-turn file against the carried diffBase", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return defaultInvokeImplementation(command, args);
        });

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accumulated-reject-a",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc\nddd",
                    new_text: "aaa\nBBB\nccc\nddd",
                },
            ],
        });

        useChatStore.getState().notifyUserEditOnFile(
            "/vault/src/watcher.rs",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accumulated-reject-b",
            title: "Edit watcher again",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs again",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "aaXa\nBBB\nccc\nddd",
                    new_text: "aaXa\nBBB\nccc\nDDD",
                },
            ],
        });
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-accumulated-reject-b",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;
        expectTrackedFileToMatchAccumulatedDiff(
            entry,
            "aaXa\nbbb\nccc\nddd",
            "aaXa\nBBB\nccc\nDDD",
        );
        expect(entry.reviewState).toBe("finalized");

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }

            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "aaXa\nbbb\nccc\nddd",
        });
    });

    it("keeps the review tab open after rejectEditedFile resolves the last pending file", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reject-one-review-open",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useEditorStore.getState().openReview(activeSessionId, {
            title: "Review Codex",
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(
            useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === activeSessionId,
                ),
        ).toBeDefined();
    });

    it("skips deleting an agent-created note if the open editor content has changed", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/new-note",
                    path: "/vault/notes/new-note.md",
                    title: "New note",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/new-note",
                    title: "New note",
                    content: "user edited content",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-created-note",
            title: "Create note",
            kind: "write",
            status: "completed",
            target: "/vault/notes/new-note.md",
            summary: "Created new note",
            diffs: [
                {
                    path: "/vault/notes/new-note.md",
                    kind: "add",
                    old_text: null,
                    new_text: "agent content",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_restore_text_file",
            expect.anything(),
        );
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            noteId: "notes/new-note",
            content: "user edited content",
        });
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.actionLog
                ?.lastRejectUndo,
        ).toBeNull();
    });

    it("marks a reject as conflict when the file changed after the tool completed", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return "different-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const remainingEntry = getVisibleBuffer(activeSessionId)[0] ?? null;

        expect(remainingEntry).toMatchObject({
            identityKey: entry.identityKey,
            conflictHash: "different-hash",
        });
        expect(invokeMock).not.toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("waits for the applied file hash to settle before rejecting a tracked file", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict-settle",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);
        const oldHash = hashTextContent(entry.diffBase);
        const appliedHash = hashTextContent(entry.currentText);
        let hashCalls = 0;

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                hashCalls += 1;
                return hashCalls === 1 ? oldHash : appliedHash;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        vi.useFakeTimers();
        try {
            const rejectPromise = useChatStore
                .getState()
                .rejectEditedFile(activeSessionId, entry.identityKey);
            await vi.advanceTimersByTimeAsync(1000);
            await rejectPromise;
        } finally {
            vi.useRealTimers();
        }

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(hashCalls).toBeGreaterThan(1);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("marks move rejects as conflict when the original path has been reused", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-move-conflict",
            title: "Move watcher",
            kind: "move",
            status: "completed",
            target: "/vault/src/watcher-final.rs",
            summary: "Moved watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher-final.rs",
                    previous_path: "/vault/src/watcher.rs",
                    kind: "move",
                    old_text: "same content",
                    new_text: "same content",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                return path === "/vault/src/watcher-final.rs"
                    ? hashTextContent(entry.currentText)
                    : "origin-reused-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        const remainingEntry = getVisibleBuffer(activeSessionId)[0] ?? null;

        expect(remainingEntry).toMatchObject({
            identityKey: entry.identityKey,
            conflictHash: "origin-reused-hash",
        });
        expect(invokeMock).not.toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher-final.rs",
            previousPath: "/vault/src/watcher.rs",
            content: "same content",
        });
    });

    it("clears stale conflictHash when a new diff arrives for the same tracked file", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict-repro-1",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return "different-hash";
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .rejectEditedFile(activeSessionId, entry.identityKey);

        expect(getVisibleBuffer(activeSessionId)[0]?.conflictHash).toBe(
            "different-hash",
        );

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict-repro-2",
            title: "Edit watcher again",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs again",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "new line",
                    new_text: "newer line",
                },
            ],
        });

        expect(getVisibleBuffer(activeSessionId)[0]?.conflictHash).toBeNull();
    });

    it("reconciles tracked note content from the persisted vault change", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/file",
                    path: "/vault/notes/file.md",
                    title: "file",
                    created_at: 1,
                    modified_at: 1,
                },
            ],
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const authoritativeText = "before\nagent line\nafter";
        const authoritativeHash = hashTextContent(authoritativeText);

        invokeMock.mockImplementation(async (command) => {
            if (command === "read_note") {
                return {
                    title: "file",
                    content: authoritativeText,
                };
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reconcile-note",
            title: "Edit note",
            kind: "edit",
            status: "completed",
            target: "/vault/notes/file.md",
            summary: "Updated file.md",
            diffs: [
                {
                    path: "/vault/notes/file.md",
                    kind: "update",
                    old_text: "before\nold line\nafter",
                    new_text: "agent line",
                },
            ],
        });

        await useChatStore.getState().reconcileTrackedFilesFromVaultChange({
            vault_path: "/vault",
            kind: "upsert",
            note: {
                id: "notes/file",
                path: "/vault/notes/file.md",
                title: "file",
                created_at: 1,
                modified_at: 1,
            },
            note_id: "notes/file",
            entry: null,
            relative_path: null,
            origin: "agent",
            op_id: "agent-op-1",
            revision: 1,
            content_hash: authoritativeHash,
            graph_revision: 1,
        });

        expect(getVisibleBuffer(activeSessionId)).toMatchObject([
            {
                identityKey: "/vault/notes/file.md",
                currentText: authoritativeText,
                diffBase: "before\nold line\nafter",
            },
        ]);
    });

    it("rejectAllEditedFiles uses the reconciled vault-change snapshot for markdown notes", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/file",
                    path: "/vault/notes/file.md",
                    title: "file",
                    created_at: 1,
                    modified_at: 1,
                },
            ],
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const authoritativeText = "before\nagent line\nafter";
        const authoritativeHash = hashTextContent(authoritativeText);

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reject-all-note-reconcile",
            title: "Edit note",
            kind: "edit",
            status: "completed",
            target: "/vault/notes/file.md",
            summary: "Updated file.md",
            diffs: [
                {
                    path: "/vault/notes/file.md",
                    kind: "update",
                    old_text: "before\nold line\nafter",
                    new_text: "agent line",
                },
            ],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return authoritativeHash;
            }

            if (command === "read_note") {
                return {
                    title: "file",
                    content: authoritativeText,
                };
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().reconcileTrackedFilesFromVaultChange({
            vault_path: "/vault",
            kind: "upsert",
            note: {
                id: "notes/file",
                path: "/vault/notes/file.md",
                title: "file",
                created_at: 1,
                modified_at: 1,
            },
            note_id: "notes/file",
            entry: null,
            relative_path: null,
            origin: "agent",
            op_id: "agent-op-2",
            revision: 2,
            content_hash: authoritativeHash,
            graph_revision: 1,
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/notes/file.md",
            previousPath: null,
            content: "before\nold line\nafter",
        });
    });

    it("rejects all safe entries and leaves conflicting rows visible", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-safe",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-conflict-all",
            title: "Edit parser",
            kind: "edit",
            status: "completed",
            target: "/vault/src/parser.rs",
            summary: "Updated parser.rs",
            diffs: [
                {
                    path: "/vault/src/parser.rs",
                    kind: "update",
                    old_text: "old parser",
                    new_text: "new parser",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entries = getVisibleBuffer(activeSessionId);
        const safeEntry = entries.find(
            (entry) => entry.path === "/vault/src/watcher.rs",
        )!;

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                return path === "/vault/src/watcher.rs"
                    ? hashTextContent(safeEntry.currentText)
                    : "different-hash";
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntries = getVisibleBuffer(activeSessionId);

        expect(remainingEntries).toHaveLength(1);
        expect(remainingEntries[0]).toMatchObject({
            path: "/vault/src/parser.rs",
            conflictHash: "different-hash",
        });
        expect(session.visibleWorkCycleId).toBe(workCycleId);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            content: "old line",
        });
    });

    it("clears tracking without deleting when rejectAll hits an agent-created note edited in the editor", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/new-note",
                    path: "/vault/notes/new-note.md",
                    title: "New note",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    kind: "note",
                    noteId: "notes/new-note",
                    title: "New note",
                    content: "user edited content",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            activationHistory: ["tab-1"],
            tabNavigationHistory: ["tab-1"],
            tabNavigationIndex: 0,
        });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-created-note-bulk",
            title: "Create note",
            kind: "write",
            status: "completed",
            target: "/vault/notes/new-note.md",
            summary: "Created new note",
            diffs: [
                {
                    path: "/vault/notes/new-note.md",
                    kind: "add",
                    old_text: null,
                    new_text: "agent content",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entry = getEditedBufferEntry(activeSessionId, workCycleId);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_restore_text_file",
            expect.anything(),
        );
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.actionLog
                ?.lastRejectUndo,
        ).toBeNull();
    });

    it("keeps the review tab open after rejectAll resolves the last pending file", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-reject-all-review-open",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useEditorStore.getState().openReview(activeSessionId, {
            title: "Review Codex",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                return path === "/vault/src/watcher.rs"
                    ? hashTextContent(entry.currentText)
                    : null;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(
            useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === activeSessionId,
                ),
        ).toBeDefined();
    });

    it("consolidates successful rejects before a later rejectAll failure", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-partial-safe",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-partial-fail",
            title: "Edit parser",
            kind: "edit",
            status: "completed",
            target: "/vault/src/parser.rs",
            summary: "Updated parser.rs",
            diffs: [
                {
                    path: "/vault/src/parser.rs",
                    kind: "update",
                    old_text: "old parser",
                    new_text: "new parser",
                },
            ],
        });

        const workCycleId =
            useChatStore.getState().sessionsById[activeSessionId]!
                .activeWorkCycleId!;
        const entries = getVisibleBuffer(activeSessionId);
        const watcherEntry = entries.find(
            (entry) => entry.path === "/vault/src/watcher.rs",
        )!;
        const parserEntry = entries.find(
            (entry) => entry.path === "/vault/src/parser.rs",
        )!;

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/watcher.rs") {
                    return hashTextContent(watcherEntry.currentText);
                }
                if (path === "/vault/src/parser.rs") {
                    return hashTextContent(parserEntry.currentText);
                }
                return null;
            }

            if (command === "ai_restore_text_file") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/parser.rs") {
                    throw new Error("disk failure");
                }
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntries = getVisibleBuffer(activeSessionId);

        expect(session.visibleWorkCycleId).toBe(workCycleId);
        expect(remainingEntries).toHaveLength(1);
        expect(remainingEntries[0]).toMatchObject({
            path: "/vault/src/parser.rs",
            currentText: "new parser",
        });
        expect(session.actionLog?.lastRejectUndo?.snapshots).toMatchObject({
            "/vault/src/watcher.rs": expect.objectContaining({
                path: "/vault/src/watcher.rs",
                currentText: "new line",
            }),
        });
        expect(
            session.actionLog?.lastRejectUndo?.snapshots?.[
                "/vault/src/parser.rs"
            ],
        ).toBeUndefined();
    });

    it("keeps only failed snapshots in undoLastReject after a partial restore", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-undo-partial-a",
            title: "Edit watcher",
            kind: "edit",
            status: "completed",
            target: "/vault/src/watcher.rs",
            summary: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-undo-partial-b",
            title: "Edit parser",
            kind: "edit",
            status: "completed",
            target: "/vault/src/parser.rs",
            summary: "Updated parser.rs",
            diffs: [
                {
                    path: "/vault/src/parser.rs",
                    kind: "update",
                    old_text: "old parser",
                    new_text: "new parser",
                },
            ],
        });

        const entries = getVisibleBuffer(activeSessionId);
        const watcherEntry = entries.find(
            (entry) => entry.path === "/vault/src/watcher.rs",
        )!;
        const parserEntry = entries.find(
            (entry) => entry.path === "/vault/src/parser.rs",
        )!;

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/watcher.rs") {
                    return hashTextContent(watcherEntry.currentText);
                }
                if (path === "/vault/src/parser.rs") {
                    return hashTextContent(parserEntry.currentText);
                }
                return null;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().rejectAllEditedFiles(activeSessionId);
        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_get_text_file_hash") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/watcher.rs") {
                    return hashTextContent("old line");
                }
                if (path === "/vault/src/parser.rs") {
                    return hashTextContent("old parser");
                }
                return null;
            }

            if (command === "ai_restore_text_file") {
                const path =
                    typeof args === "object" && args !== null && "path" in args
                        ? String(args.path)
                        : "";
                if (path === "/vault/src/parser.rs") {
                    throw new Error("undo failure");
                }
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore.getState().undoLastReject(activeSessionId);

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const remainingEntries = getVisibleBuffer(activeSessionId);

        expect(remainingEntries).toHaveLength(1);
        expect(remainingEntries[0]).toMatchObject({
            path: "/vault/src/watcher.rs",
            currentText: "new line",
        });
        expect(session.actionLog?.lastRejectUndo?.snapshots).toMatchObject({
            "/vault/src/parser.rs": expect.objectContaining({
                path: "/vault/src/parser.rs",
                currentText: "new parser",
            }),
        });
        expect(
            session.actionLog?.lastRejectUndo?.snapshots?.[
                "/vault/src/watcher.rs"
            ],
        ).toBeUndefined();
    });

    it("upserts status events as system messages and updates them by event id", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "neverwrite:status:item:plan-1",
            kind: "item_activity",
            status: "in_progress",
            title: "Updating plan",
            detail: "Drafting next steps",
            emphasis: "neutral",
        });

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "neverwrite:status:item:plan-1",
            kind: "item_activity",
            status: "completed",
            title: "Updating plan",
            detail: "Plan ready",
            emphasis: "neutral",
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const statusMessages = session.messages.filter(
            (message) => message.kind === "status",
        );

        expect(statusMessages).toHaveLength(1);
        expect(statusMessages[0]).toMatchObject({
            id: "status:neverwrite:status:item:plan-1",
            role: "system",
            kind: "status",
            title: "Updating plan",
            content: "Plan ready",
            meta: {
                status_event: "item_activity",
                status: "completed",
                emphasis: "neutral",
            },
        });
    });

    it("upserts plan updates into a single live plan message", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "plan-1",
            title: "Plan de ejecución",
            detail: "Resumen breve del trabajo pendiente.",
            entries: [
                {
                    content: "Inspect current chat state",
                    priority: "medium",
                    status: "in_progress",
                },
                {
                    content: "Render the plan UI",
                    priority: "medium",
                    status: "pending",
                },
            ],
        });

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "plan-1",
            title: "Plan de ejecución",
            detail: "Resumen breve del trabajo pendiente.",
            entries: [
                {
                    content: "Inspect current chat state",
                    priority: "medium",
                    status: "completed",
                },
                {
                    content: "Render the plan UI",
                    priority: "medium",
                    status: "in_progress",
                },
            ],
        });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        const planMessages = session.messages.filter(
            (message) => message.kind === "plan",
        );

        expect(planMessages).toHaveLength(1);
        expect(planMessages[0]).toMatchObject({
            id: "plan:plan-1",
            kind: "plan",
            title: "Plan de ejecución",
            planDetail: "Resumen breve del trabajo pendiente.",
            meta: {
                status: "in_progress",
                completed_count: 1,
                total_count: 2,
            },
        });
        expect(planMessages[0].planEntries).toEqual([
            {
                content: "Inspect current chat state",
                priority: "medium",
                status: "completed",
            },
            {
                content: "Render the plan UI",
                priority: "medium",
                status: "in_progress",
            },
        ]);
    });

    it("tracks user input requests and resumes streaming after responding", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyUserInputRequest({
            session_id: activeSessionId,
            request_id: "input-1",
            title: "Need more detail",
            questions: [
                {
                    id: "scope",
                    header: "Scope",
                    question: "Which option should I use?",
                    is_other: true,
                    is_secret: false,
                    options: [
                        {
                            label: "Safe",
                            description: "Conservative option",
                        },
                    ],
                },
            ],
        });

        let session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("waiting_user_input");
        expect(session.messages.at(-1)).toMatchObject({
            id: "user-input:input-1",
            kind: "user_input_request",
            userInputRequestId: "input-1",
        });

        await useChatStore
            .getState()
            .respondUserInput("input-1", { scope: ["Safe"] });

        session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("streaming");
        expect(session.messages.at(-1)?.meta).toMatchObject({
            status: "resolved",
            answered: true,
        });
    });

    it("keeps Claude user input requests deferred instead of calling the backend", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.setState((state) => ({
            runtimes: [
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description: "Claude runtime",
                        capabilities: ["attachments", "permissions"],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    runtimeId: "claude-acp",
                },
            },
        }));

        useChatStore.getState().applyUserInputRequest({
            session_id: activeSessionId,
            request_id: "input-claude-1",
            title: "Need more detail",
            questions: [
                {
                    id: "scope",
                    header: "Scope",
                    question: "Which option should I use?",
                    is_other: true,
                    is_secret: false,
                    options: [
                        {
                            label: "Safe",
                            description: "Conservative option",
                        },
                    ],
                },
            ],
        });

        await useChatStore
            .getState()
            .respondUserInput("input-claude-1", { scope: ["Safe"] });

        const session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.status).toBe("waiting_user_input");
        expect(session.messages.at(-1)).toMatchObject({
            kind: "error",
            content:
                "This runtime does not support interactive user input requests in this build.",
        });
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_respond_user_input",
            ),
        ).toBe(false);
    });

    it("resumes the active persisted history into a live ACP session", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        const emptyCatalogSessionPayload = {
            ...sessionPayload,
            models: [],
            modes: [],
            config_options: [],
        };

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "m1",
                                role: "user",
                                kind: "text",
                                content: "Recovered from disk",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_load_session_history_page") {
                throw new Error(
                    "initialize should not refetch a fully hydrated persisted transcript",
                );
            }
            if (command === "ai_create_session")
                return emptyCatalogSessionPayload;
            return emptyCatalogSessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("codex-session-1");
        expect(state.sessionsById["persisted:history-1"]).toBeUndefined();
        const restored = state.sessionsById["codex-session-1"];
        expect(restored?.isPersistedSession).toBe(false);
        expect(restored?.historySessionId).toBe("history-1");
        expect(restored?.messages[0]?.content).toBe("Recovered from disk");
        expect(restored?.resumeContextPending).toBe(true);
        expect(restored?.models).toEqual([
            {
                id: "test-model",
                runtimeId: "codex-acp",
                name: "Test Model",
                description: "A test model for unit tests.",
            },
        ]);
        expect(restored?.modes).toEqual([
            {
                id: "default",
                runtimeId: "codex-acp",
                name: "Default",
                description: "Prompt for actions that need explicit approval.",
                disabled: false,
            },
        ]);
        expect(
            restored?.configOptions.find((option) => option.id === "model"),
        ).toEqual({
            id: "model",
            runtimeId: "codex-acp",
            category: "model",
            label: "Model",
            description: undefined,
            type: "select",
            value: "test-model",
            options: [
                {
                    value: "test-model",
                    label: "Test Model",
                    description: undefined,
                },
                {
                    value: "wide-model",
                    label: "Wide Model",
                    description: undefined,
                },
            ],
        });
        expect(
            restored?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            ),
        ).toEqual({
            id: "reasoning_effort",
            runtimeId: "codex-acp",
            category: "reasoning",
            label: "Reasoning Effort",
            description: undefined,
            type: "select",
            value: "medium",
            options: [
                {
                    value: "medium",
                    label: "Medium",
                    description: undefined,
                },
                {
                    value: "high",
                    label: "High",
                    description: undefined,
                },
            ],
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_create_session", {
            input: {
                runtime_id: "codex-acp",
                additional_roots: null,
            },
            vaultPath: "/vault",
        });
    });

    it("aborts resume when the required persisted transcript page cannot be loaded", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [
                {
                    runtime: runtimePayload[0].runtime,
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                "persisted:history-1": {
                    sessionId: "persisted:history-1",
                    historySessionId: "history-1",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    runtimeState: "persisted_only",
                    isPersistedSession: true,
                    persistedMessageCount: 80,
                    loadedPersistedMessageStart: null,
                    persistedTitle: "Saved session",
                    persistedPreview: "Saved session",
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["persisted:history-1"],
            activeSessionId: "persisted:history-1",
            selectedRuntimeId: "codex-acp",
            composerPartsBySessionId: {
                "persisted:history-1": [],
            },
        }));

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_load_session_history_page") {
                throw new Error("disk read failed");
            }
            if (command === "ai_create_session") {
                throw new Error("resume should stop before creating a session");
            }
            return defaultInvokeImplementation(command, args);
        });

        const nextSessionId = await useChatStore
            .getState()
            .resumeSession("persisted:history-1");

        expect(nextSessionId).toBeNull();
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_create_session",
            ),
        ).toBe(false);
        expect(
            useChatStore
                .getState()
                .sessionsById["persisted:history-1"]?.messages.at(-1),
        ).toMatchObject({
            kind: "error",
            content:
                "Failed to load the full saved transcript before resuming.",
        });
    });

    it("rehydrates Claude histories with their runtime and resumes them natively", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        const claudeRuntimePayload = [
            ...runtimePayload,
            {
                runtime: {
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "Claude runtime embedded as an ACP sidecar.",
                    capabilities: [
                        "create_session",
                        "list_sessions",
                        "resume_session",
                    ],
                },
                models: [],
                modes: [],
                config_options: [],
            },
        ];

        const claudeSessionPayload = {
            session_id: "claude-session-1",
            runtime_id: "claude-acp",
            model_id: "claude-sonnet",
            mode_id: "default",
            status: "idle" as const,
            models: [
                {
                    id: "claude-sonnet",
                    runtime_id: "claude-acp",
                    name: "Claude Sonnet",
                    description: "Claude test model.",
                },
            ],
            modes: [
                {
                    id: "default",
                    runtime_id: "claude-acp",
                    name: "Default",
                    description: "Claude default mode.",
                    disabled: false,
                },
            ],
            config_options: [
                {
                    id: "model",
                    runtime_id: "claude-acp",
                    category: "model",
                    label: "Model",
                    type: "select",
                    value: "claude-sonnet",
                    options: [
                        {
                            value: "claude-sonnet",
                            label: "Claude Sonnet",
                        },
                    ],
                },
            ],
        };

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return claudeRuntimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-claude-1",
                        runtime_id: "claude-acp",
                        model_id: "claude-sonnet",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "m1",
                                role: "user",
                                kind: "text",
                                content: "Recovered Claude chat",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_resume_runtime_session") {
                return claudeSessionPayload;
            }
            if (command === "ai_create_session") {
                throw new Error("should not create a fallback session");
            }
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("claude-session-1");
        expect(
            state.sessionsById["persisted:history-claude-1"],
        ).toBeUndefined();
        expect(state.sessionsById["claude-session-1"]).toMatchObject({
            historySessionId: "history-claude-1",
            runtimeId: "claude-acp",
            isPersistedSession: false,
            resumeContextPending: false,
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_resume_runtime_session", {
            input: {
                runtime_id: "claude-acp",
                session_id: "history-claude-1",
            },
            vaultPath: "/vault",
        });
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_create_session",
            ),
        ).toBe(false);
    });

    it("recreates an empty Claude session with additionalRoots on the first external file send", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        const claudeRuntimePayload = [
            {
                runtime: {
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "Claude runtime embedded as an ACP sidecar.",
                    capabilities: ["create_session", "attachments"],
                },
                models: [],
                modes: [],
                config_options: [],
            },
        ];
        const claudeSetupStatus = {
            ...readySetupStatus,
            runtime_id: "claude-acp",
            binary_path: "/Applications/NeverWrite/claude-agent-acp",
        };
        const claudeSessionPayload = {
            session_id: "claude-session-1",
            runtime_id: "claude-acp",
            model_id: "claude-sonnet",
            mode_id: "default",
            status: "idle" as const,
            models: [
                {
                    id: "claude-sonnet",
                    runtime_id: "claude-acp",
                    name: "Claude Sonnet",
                    description: "Claude test model.",
                },
            ],
            modes: [
                {
                    id: "default",
                    runtime_id: "claude-acp",
                    name: "Default",
                    description: "Claude default mode.",
                    disabled: false,
                },
            ],
            config_options: [],
        };
        const replacementClaudeSessionPayload = {
            ...claudeSessionPayload,
            session_id: "claude-session-2",
        };

        let createSessionCount = 0;
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return claudeRuntimePayload;
            if (command === "ai_get_setup_status") return claudeSetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_create_session") {
                createSessionCount += 1;
                return createSessionCount === 1
                    ? claudeSessionPayload
                    : replacementClaudeSessionPayload;
            }
            if (command === "ai_send_message") {
                expect(args).toMatchObject({
                    sessionId: "claude-session-2",
                    attachments: [
                        expect.objectContaining({
                            filePath:
                                "/home/user/projects/NeverWrite/README.md",
                        }),
                    ],
                });
                return {
                    ...replacementClaudeSessionPayload,
                    status: "streaming",
                };
            }
            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }
            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        useChatStore
            .getState()
            .attachFile(
                "/home/user/projects/NeverWrite/README.md",
                "README.md",
                "text/markdown",
            );
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Review this"));

        await useChatStore.getState().sendMessage();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("claude-session-2");
        expect(state.sessionsById["claude-session-1"]).toBeUndefined();
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_create_session",
            ),
        ).toHaveLength(2);
        expect(invokeMock).toHaveBeenCalledWith("ai_create_session", {
            input: {
                runtime_id: "claude-acp",
                additional_roots: null,
            },
            vaultPath: "/vault",
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_create_session", {
            input: {
                runtime_id: "claude-acp",
                additional_roots: ["/home/user/projects/NeverWrite"],
            },
            vaultPath: "/vault",
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_delete_runtime_session", {
            sessionId: "claude-session-1",
        });
        expect(invokeMock).toHaveBeenCalledWith("ai_delete_session_history", {
            vaultPath: "/vault",
            sessionId: "claude-session-1",
        });
    });

    it("keeps the existing Claude session when the first file send stays inside the vault", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        const claudeRuntimePayload = [
            {
                runtime: {
                    id: "claude-acp",
                    name: "Claude ACP",
                    description: "Claude runtime embedded as an ACP sidecar.",
                    capabilities: ["create_session", "attachments"],
                },
                models: [],
                modes: [],
                config_options: [],
            },
        ];
        const claudeSetupStatus = {
            ...readySetupStatus,
            runtime_id: "claude-acp",
            binary_path: "/Applications/NeverWrite/claude-agent-acp",
        };
        const claudeSessionPayload = {
            session_id: "claude-session-1",
            runtime_id: "claude-acp",
            model_id: "claude-sonnet",
            mode_id: "default",
            status: "idle" as const,
            models: [],
            modes: [],
            config_options: [],
        };

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") return claudeRuntimePayload;
            if (command === "ai_get_setup_status") return claudeSetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_create_session") return claudeSessionPayload;
            if (command === "ai_send_message") {
                expect(args).toMatchObject({
                    sessionId: "claude-session-1",
                });
                return {
                    ...claudeSessionPayload,
                    status: "streaming",
                };
            }
            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }
            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        useChatStore
            .getState()
            .attachFile("/vault/docs/guide.md", "guide.md", "text/markdown");
        useChatStore
            .getState()
            .setComposerParts(createTextParts("Review this"));

        await useChatStore.getState().sendMessage();

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_create_session",
            ),
        ).toHaveLength(1);
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_delete_runtime_session",
            ),
        ).toBe(false);
    });

    it("restores persisted tool diffs from session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "tool-1",
                                role: "assistant",
                                kind: "tool",
                                content: "Updated watcher.rs",
                                timestamp: 20,
                                title: "Edit watcher",
                                meta: {
                                    tool: "edit",
                                    status: "completed",
                                    target: "/vault/src/watcher.rs",
                                },
                                diffs: [
                                    {
                                        path: "/vault/src/watcher.rs",
                                        kind: "update",
                                        old_text: "old line",
                                        new_text: "new line",
                                    },
                                ],
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_load_session_history_page") {
                throw new Error(
                    "initialize should not refetch a fully hydrated persisted transcript",
                );
            }
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const restored =
            useChatStore.getState().sessionsById["codex-session-1"];
        expect(restored?.messages[0]).toMatchObject({
            kind: "tool",
            content: "Updated watcher.rs",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
        });
    });

    it("restores persisted agent catalogs for history-only sessions when ACP descriptors are empty", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") {
                return [
                    {
                        ...sessionPayload,
                        session_id: "zzz-live",
                    },
                ];
            }
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 0,
                        message_count: 1,
                        title: "Recovered chat",
                        preview: "Recovered message",
                        messages: [],
                    },
                ];
            }

            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        const state = useChatStore.getState();
        expect(state.activeSessionId).toBe("zzz-live");
        expect(state.sessionsById["persisted:history-1"]).toMatchObject({
            historySessionId: "history-1",
            runtimeId: "codex-acp",
            modelId: "test-model",
            modeId: "default",
            isPersistedSession: true,
            runtimeState: "persisted_only",
            resumeContextPending: true,
            models: [
                {
                    id: "test-model",
                    runtimeId: "codex-acp",
                    name: "Test Model",
                    description: "A test model for unit tests.",
                },
            ],
            modes: [
                {
                    id: "default",
                    runtimeId: "codex-acp",
                    name: "Default",
                    description:
                        "Prompt for actions that need explicit approval.",
                    disabled: false,
                },
            ],
            configOptions: [
                {
                    id: "model",
                    runtimeId: "codex-acp",
                    category: "model",
                    label: "Model",
                    type: "select",
                    value: "test-model",
                    options: [
                        {
                            value: "test-model",
                            label: "Test Model",
                        },
                        {
                            value: "wide-model",
                            label: "Wide Model",
                        },
                    ],
                },
                {
                    id: "reasoning_effort",
                    runtimeId: "codex-acp",
                    category: "reasoning",
                    label: "Reasoning Effort",
                    type: "select",
                    value: "medium",
                    options: [
                        {
                            value: "medium",
                            label: "Medium",
                        },
                        {
                            value: "high",
                            label: "High",
                        },
                    ],
                },
            ],
        });
        expect(
            invokeMock.mock.calls.some(
                ([command]) => command === "ai_resume_runtime_session",
            ),
        ).toBe(false);
    });

    it("persists tool diffs when saving session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const session = useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.setState({
            sessionsById: {
                ...useChatStore.getState().sessionsById,
                [activeSessionId]: {
                    ...session,
                    messages: [
                        {
                            id: "tool:tool-1",
                            role: "assistant",
                            kind: "tool",
                            title: "Edit watcher",
                            content: "Updated watcher.rs",
                            timestamp: 10,
                            diffs: [
                                {
                                    path: "/vault/src/watcher.rs",
                                    kind: "update",
                                    old_text: "old line",
                                    new_text: "new line",
                                },
                            ],
                            meta: {
                                tool: "edit",
                                status: "completed",
                                target: "/vault/src/watcher.rs",
                            },
                        },
                    ],
                },
            },
        });

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Trigger persistence",
        });
        await Promise.resolve();

        expect(invokeMock).toHaveBeenCalledWith("ai_save_session_history", {
            vaultPath: "/vault",
            history: expect.objectContaining({
                runtime_id: "codex-acp",
                models: acpModels,
                modes: acpModes,
                config_options: expect.arrayContaining([
                    expect.objectContaining({
                        id: "model",
                        runtime_id: "codex-acp",
                        category: "model",
                        value: "test-model",
                    }),
                    expect.objectContaining({
                        id: "reasoning_effort",
                        runtime_id: "codex-acp",
                        category: "reasoning",
                        value: "medium",
                    }),
                ]),
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        kind: "tool",
                        diffs: [
                            {
                                path: "/vault/src/watcher.rs",
                                kind: "update",
                                old_text: "old line",
                                new_text: "new line",
                            },
                        ],
                    }),
                ]),
            }),
        });
    });

    it("persists transcript windows with start_index and total message_count", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    historySessionId: "history-windowed",
                    persistedCreatedAt: 10,
                    persistedUpdatedAt: 90,
                    persistedTitle: "Windowed chat",
                    persistedPreview: "Recovered 79",
                    persistedMessageCount: 80,
                    loadedPersistedMessageStart: 60,
                    messages: [
                        ...Array.from({ length: 20 }, (_, index) => ({
                            id: `assistant:${index + 60}`,
                            role: "assistant" as const,
                            kind: "text" as const,
                            content: `Recovered ${index + 60}`,
                            timestamp: 100 + index,
                        })),
                        {
                            id: "assistant:new",
                            role: "assistant",
                            kind: "text",
                            content: "New tail message",
                            timestamp: 999,
                        },
                    ],
                },
            },
        }));

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Trigger persistence",
        });
        await Promise.resolve();

        expect(invokeMock).toHaveBeenCalledWith("ai_save_session_history", {
            vaultPath: "/vault",
            history: expect.objectContaining({
                session_id: "history-windowed",
                start_index: 60,
                message_count: 82,
                created_at: 10,
                updated_at: expect.any(Number),
                title: "Windowed chat",
                preview: "Error: Trigger persistence",
            }),
        });
    });

    it("does not persist the edited files buffer as part of session history", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const workCycleId = "cycle-pending";

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    activeWorkCycleId: workCycleId,
                    visibleWorkCycleId: workCycleId,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [workCycleId]: {
                                "/vault/src/watcher.rs": createTrackedFile(
                                    "/vault/src/watcher.rs",
                                    "old line",
                                    "new line",
                                ),
                            },
                        },
                        lastRejectUndo: null,
                    },
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Done",
                            timestamp: 10,
                        },
                    ],
                },
            },
        }));

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Trigger persistence",
        });
        await Promise.resolve();

        const historyCall = invokeMock.mock.calls.find(
            ([command]) => command === "ai_save_session_history",
        );
        expect(historyCall).toBeTruthy();

        const historyPayload =
            typeof historyCall?.[1] === "object" && historyCall[1] !== null
                ? (historyCall[1] as { history?: Record<string, unknown> })
                : null;

        expect(historyPayload?.history).toMatchObject({
            session_id: activeSessionId,
            messages: expect.arrayContaining([
                expect.objectContaining({
                    id: "assistant-1",
                    content: "Done",
                }),
            ]),
        });
        expect(historyPayload?.history).not.toHaveProperty("actionLog");
        expect(historyPayload?.history).not.toHaveProperty("activeWorkCycleId");
        expect(historyPayload?.history).not.toHaveProperty(
            "visibleWorkCycleId",
        );
    });

    it("coalesces repeated history persistence requests in the same microtask", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    messages: [
                        {
                            id: "assistant-1",
                            role: "assistant",
                            kind: "text",
                            content: "Done",
                            timestamp: 10,
                        },
                    ],
                },
            },
        }));

        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "First error",
        });
        useChatStore.getState().applySessionError({
            session_id: activeSessionId,
            message: "Second error",
        });

        await Promise.resolve();
        await Promise.resolve();

        const saveCalls = invokeMock.mock.calls.filter(
            ([command]) => command === "ai_save_session_history",
        );
        expect(saveCalls).toHaveLength(1);

        const payload =
            typeof saveCalls[0]?.[1] === "object" && saveCalls[0][1] !== null
                ? (saveCalls[0][1] as {
                      history?: { messages?: Array<{ content?: string }> };
                  })
                : null;

        expect(payload?.history?.messages?.at(-1)?.content).toBe(
            "Second error",
        );
    });

    it("marks a persisted session as resuming while reconnecting it to ACP", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        let resolveCreateSession:
            | ((value: typeof sessionPayload) => void)
            | null = null;
        const createSessionPromise = new Promise<typeof sessionPayload>(
            (resolve) => {
                resolveCreateSession = resolve;
            },
        );

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "msg-1",
                                role: "user",
                                kind: "text",
                                content: "Hello",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_load_session_history_page") {
                throw new Error(
                    "initialize should not refetch a fully hydrated persisted transcript",
                );
            }
            if (command === "ai_create_session") return createSessionPromise;
            return sessionPayload;
        });

        const initializePromise = useChatStore.getState().initialize();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            useChatStore.getState().sessionsById["persisted:history-1"]
                ?.isResumingSession,
        ).toBe(true);

        if (!resolveCreateSession) {
            throw new Error("Missing create-session resolver");
        }
        (resolveCreateSession as (value: typeof sessionPayload) => void)(
            sessionPayload,
        );
        await initializePromise;
    });

    it("replaces persisted tab session ids when a saved chat is resumed", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-history-1",
                    sessionId: "persisted:history-1",
                },
            ],
            activeTabId: "tab-history-1",
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-1",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [
                            {
                                id: "msg-1",
                                role: "user",
                                kind: "text",
                                content: "Hello",
                                timestamp: 20,
                            },
                        ],
                    },
                ];
            }
            if (command === "ai_load_session_history_page") {
                throw new Error(
                    "initialize should not refetch a fully hydrated persisted transcript",
                );
            }
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-history-1",
                sessionId: "codex-session-1",
                historySessionId: "history-1",
                runtimeId: "codex-acp",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-history-1");
    });

    it("does not persist empty sessions and ignores empty persisted histories", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_create_session") return sessionPayload;
            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "codex-session-1",
                        model_id: "test-model",
                        mode_id: "default",
                        created_at: 10,
                        updated_at: 20,
                        messages: [],
                    },
                ];
            }
            if (command === "ai_set_session_mode") return sessionPayload;
            if (command === "ai_set_session_model") return sessionPayload;
            if (command === "ai_set_config_option") return sessionPayload;
            return sessionPayload;
        });

        await useChatStore.getState().initialize();

        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_save_session_history",
            expect.anything(),
        );

        expect(useChatStore.getState().sessionOrder).toEqual([
            "codex-session-1",
        ]);
        expect(
            useChatStore.getState().sessionsById["codex-session-1"],
        ).toMatchObject({
            historySessionId: "codex-session-1",
            isPersistedSession: false,
            messages: [],
        });
        expect(useChatStore.getState().activeSessionId).toBe("codex-session-1");
    });

    it("does not wait for persistence when the initial session is still empty", async () => {
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_list_runtimes") return runtimePayload;
            if (command === "ai_get_setup_status") return readySetupStatus;
            if (command === "ai_list_sessions") return [];
            if (command === "ai_load_session_histories") return [];
            if (command === "ai_create_session") return sessionPayload;
            return sessionPayload;
        });

        let resolved = false;
        const initializePromise = useChatStore
            .getState()
            .initialize()
            .then(() => {
                resolved = true;
            });

        await new Promise((resolve) => setTimeout(resolve, 0));
        await initializePromise;

        expect(resolved).toBe(true);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_save_session_history",
            expect.anything(),
        );
    });

    it("removes chat tabs when deleting a session", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                messages: [
                    {
                        id: "m2",
                        role: "user",
                        kind: "text",
                        content: "Second chat",
                        timestamp: 30,
                    },
                ],
                attachments: [],
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
            },
            true,
        );

        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    sessionId: "codex-session-1",
                },
                {
                    id: "tab-2",
                    sessionId: "codex-session-2",
                },
            ],
            activeTabId: "tab-2",
        });

        await useChatStore.getState().deleteSession("codex-session-2");

        expect(useChatTabsStore.getState().tabs).toEqual([
            {
                id: "tab-1",
                sessionId: "codex-session-1",
            },
        ]);
        expect(useChatTabsStore.getState().activeTabId).toBe("tab-1");
    });

    it("clears virtualized row UI state when deleting a session", async () => {
        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                sessionId: "codex-session-2",
                historySessionId: "codex-session-2",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                messages: [
                    {
                        id: "m2",
                        role: "assistant",
                        kind: "plan",
                        content: "Second chat",
                        title: "Plan",
                        timestamp: 30,
                        planEntries: [
                            {
                                content: "Second chat",
                                priority: "medium",
                                status: "pending",
                            },
                        ],
                    },
                ],
                attachments: [],
                models: acpModels.map((model) => ({
                    id: model.id,
                    runtimeId: model.runtime_id,
                    name: model.name,
                    description: model.description,
                })),
                modes: acpModes.map((mode) => ({
                    id: mode.id,
                    runtimeId: mode.runtime_id,
                    name: mode.name,
                    description: mode.description,
                    disabled: mode.disabled,
                })),
                configOptions: [],
            },
            true,
        );

        useChatRowUiStore.getState().patchRow("codex-session-2", "m2", {
            expanded: true,
        });

        await useChatStore.getState().deleteSession("codex-session-2");

        expect(
            useChatRowUiStore.getState().rowsBySessionId["codex-session-2"],
        ).toBeUndefined();
    });

    it("drops deleted persisted history metadata from the in-memory cache", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-deleted",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 20,
                        message_count: 1,
                        title: "Deleted title",
                        preview: "Deleted preview",
                        messages: [],
                    },
                ];
            }

            if (command === "ai_load_session") {
                return {
                    ...sessionPayload,
                    session_id:
                        (args as { sessionId?: string } | undefined)
                            ?.sessionId ?? "replacement-session",
                    models: [],
                    modes: [],
                    config_options: [],
                };
            }

            if (command === "ai_load_session_history_page") {
                return {
                    session_id:
                        (args as { sessionId?: string } | undefined)
                            ?.sessionId ?? "history-deleted",
                    total_messages: 0,
                    start_index: 0,
                    end_index: 0,
                    messages: [],
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                ...createSessionWithTrackedFiles("deleted-session", []),
                historySessionId: "history-deleted",
                runtimeId: "codex-acp",
                runtimeState: "live",
                modelId: "test-model",
                modeId: "default",
            },
            true,
        );

        await useChatStore.getState().reconcileRestoredWorkspaceTabs([
            {
                id: "tab-deleted",
                sessionId: "deleted-session",
                historySessionId: "history-deleted",
                runtimeId: "codex-acp",
            },
        ]);

        expect(
            useChatStore.getState().sessionsById["deleted-session"],
        ).toMatchObject({
            persistedTitle: "Deleted title",
            models: [
                expect.objectContaining({
                    id: "test-model",
                }),
            ],
        });

        await useChatStore.getState().deleteSession("deleted-session");

        useChatStore.getState().upsertSession(
            {
                ...createSessionWithTrackedFiles("replacement-session", []),
                historySessionId: "history-deleted",
                runtimeId: "codex-acp",
                runtimeState: "live",
                modelId: "test-model",
                modeId: "default",
            },
            true,
        );

        await useChatStore.getState().reconcileRestoredWorkspaceTabs([
            {
                id: "tab-replacement",
                sessionId: "replacement-session",
                historySessionId: "history-deleted",
                runtimeId: "codex-acp",
            },
        ]);

        expect(
            useChatStore.getState().sessionsById["replacement-session"],
        ).toMatchObject({
            persistedTitle: null,
            persistedPreview: null,
        });
    });

    it("clears persisted history metadata cache for the active vault on deleteAllSessions", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_list_runtimes") {
                return runtimePayload;
            }

            if (command === "ai_get_setup_status") {
                return readySetupStatus;
            }

            if (command === "ai_list_sessions") {
                return [];
            }

            if (command === "ai_load_session_histories") {
                return [
                    {
                        version: 1,
                        session_id: "history-cleared",
                        runtime_id: "codex-acp",
                        model_id: "test-model",
                        mode_id: "default",
                        models: acpModels,
                        modes: acpModes,
                        config_options: acpConfigOptions,
                        created_at: 10,
                        updated_at: 20,
                        message_count: 1,
                        title: "Cleared title",
                        preview: "Cleared preview",
                        messages: [],
                    },
                ];
            }

            if (command === "ai_load_session") {
                return {
                    ...sessionPayload,
                    session_id:
                        (args as { sessionId?: string } | undefined)
                            ?.sessionId ?? "after-clear-session",
                    models: [],
                    modes: [],
                    config_options: [],
                };
            }

            if (command === "ai_load_session_history_page") {
                return {
                    session_id:
                        (args as { sessionId?: string } | undefined)
                            ?.sessionId ?? "history-cleared",
                    total_messages: 0,
                    start_index: 0,
                    end_index: 0,
                    messages: [],
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().initialize();

        useChatStore.getState().upsertSession(
            {
                ...createSessionWithTrackedFiles("before-clear-session", []),
                historySessionId: "history-cleared",
                runtimeId: "codex-acp",
                runtimeState: "live",
                modelId: "test-model",
                modeId: "default",
            },
            true,
        );

        await useChatStore.getState().reconcileRestoredWorkspaceTabs([
            {
                id: "tab-before-clear",
                sessionId: "before-clear-session",
                historySessionId: "history-cleared",
                runtimeId: "codex-acp",
            },
        ]);

        expect(
            useChatStore.getState().sessionsById["before-clear-session"],
        ).toMatchObject({
            persistedTitle: "Cleared title",
            models: [
                expect.objectContaining({
                    id: "test-model",
                }),
            ],
        });

        await useChatStore.getState().deleteAllSessions();

        useChatStore.getState().upsertSession(
            {
                ...createSessionWithTrackedFiles("after-clear-session", []),
                historySessionId: "history-cleared",
                runtimeId: "codex-acp",
                runtimeState: "live",
                modelId: "test-model",
                modeId: "default",
            },
            true,
        );

        await useChatStore.getState().reconcileRestoredWorkspaceTabs([
            {
                id: "tab-after-clear",
                sessionId: "after-clear-session",
                historySessionId: "history-cleared",
                runtimeId: "codex-acp",
            },
        ]);

        expect(
            useChatStore.getState().sessionsById["after-clear-session"],
        ).toMatchObject({
            persistedTitle: null,
            persistedPreview: null,
        });
    });

    it("applies agent changes while the session is busy", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                },
            },
        }));

        await useChatStore.getState().setModel("wide-model");
        await useChatStore.getState().setMode("default");
        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high");

        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_model",
            ),
        ).toHaveLength(0);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_mode",
            ),
        ).toHaveLength(1);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_config_option",
            ),
        ).toHaveLength(2);
        expect(
            useChatStore
                .getState()
                .sessionsById[
                    activeSessionId
                ]?.configOptions.find((option) => option.id === "reasoning_effort")
                ?.value,
        ).toBe("high");
    });

    it("keeps session state aligned when the ACP model config changes", async () => {
        await useChatStore.getState().initialize();

        await useChatStore.getState().setConfigOption("model", "wide-model");

        expect(
            invokeMock.mock.calls.some(
                ([command, payload]) =>
                    command === "ai_set_config_option" &&
                    (() => {
                        if (
                            typeof payload !== "object" ||
                            payload === null ||
                            !("input" in payload)
                        ) {
                            return false;
                        }

                        const input = payload.input as
                            | { option_id?: string; value?: string }
                            | undefined;
                        return (
                            input?.option_id === "model" &&
                            input?.value === "wide-model"
                        );
                    })(),
            ),
        ).toBe(true);
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_model",
            ),
        ).toHaveLength(0);
        expect(
            useChatStore.getState().sessionsById["codex-session-1"]?.modelId,
        ).toBe("wide-model");
        expect(
            useChatStore
                .getState()
                .sessionsById["codex-session-1"]?.configOptions.find(
                    (option) => option.id === "reasoning_effort",
                )
                ?.options.map((option) => option.value),
        ).toEqual(["low", "medium", "high", "xhigh"]);
    });

    it('keeps setModel observably aligned with setConfigOption("model") for live ACP sessions', async () => {
        await useChatStore.getState().initialize();

        const firstSessionId = getActiveSessionId();
        const firstSession =
            useChatStore.getState().sessionsById[firstSessionId]!;
        const secondSessionId = "codex-session-model-compare";

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              session_id?: string;
                              option_id?: string;
                              value?: string;
                          })
                        : undefined;

                if (input?.option_id === "model") {
                    return {
                        ...sessionPayload,
                        session_id:
                            input.session_id ?? sessionPayload.session_id,
                        model_id: input.value ?? "test-model",
                        config_options: [
                            {
                                ...acpConfigOptions[0],
                                value: input.value ?? "test-model",
                            },
                            {
                                ...acpConfigOptions[1],
                                value: "low",
                                options: [
                                    { value: "low", label: "Low" },
                                    { value: "medium", label: "Medium" },
                                    { value: "high", label: "High" },
                                    { value: "xhigh", label: "Extra High" },
                                ],
                            },
                        ],
                    };
                }
            }

            return defaultInvokeImplementation(command, args);
        });

        useChatStore.getState().upsertSession(
            cloneSessionForTest(firstSession, secondSessionId, {
                historySessionId: "history-model-compare",
                runtimeState: "live",
                isPersistedSession: false,
            }),
            true,
        );

        await useChatStore.getState().setModel("wide-model", firstSessionId);
        await useChatStore
            .getState()
            .setConfigOption("model", "wide-model", secondSessionId);

        const modelSession =
            useChatStore.getState().sessionsById[firstSessionId]!;
        const configSession =
            useChatStore.getState().sessionsById[secondSessionId]!;
        const prefs = JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}");
        const modelSelectionCalls = invokeMock.mock.calls.filter(
            ([command, args]) =>
                command === "ai_set_config_option" &&
                typeof args === "object" &&
                args !== null &&
                "input" in args &&
                (args.input as { option_id?: string; value?: string })
                    .option_id === "model" &&
                (args.input as { option_id?: string; value?: string }).value ===
                    "wide-model",
        );

        expect(modelSession.modelId).toBe("wide-model");
        expect(configSession.modelId).toBe("wide-model");
        expect(modelSession.modeId).toBe(configSession.modeId);
        expect(modelSession.configOptions).toEqual(configSession.configOptions);
        expect(prefs).toMatchObject({
            modelId: "wide-model",
        });
        expect(
            invokeMock.mock.calls.filter(
                ([command]) => command === "ai_set_model",
            ),
        ).toHaveLength(0);
        expect(modelSelectionCalls).toHaveLength(2);
    });

    it("preserves a fresher session-updated model change when ai_set_config_option returns stale data", async () => {
        await useChatStore.getState().initialize();

        const sessionId = getActiveSessionId();
        const existing = useChatStore.getState().sessionsById[sessionId]!;
        const deferred = createDeferred<typeof sessionPayload>();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              option_id?: string;
                              value?: string;
                          })
                        : undefined;

                expect(input?.option_id).toBe("model");
                expect(input?.value).toBe("wide-model");
                return deferred.promise;
            }

            return defaultInvokeImplementation(command, args);
        });

        const actionPromise = useChatStore
            .getState()
            .setConfigOption("model", "wide-model", sessionId);

        useChatStore.getState().upsertSession({
            ...existing,
            modelId: "wide-model",
            configOptions: existing.configOptions.map((option) =>
                option.id === "model"
                    ? { ...option, value: "wide-model" }
                    : option.id === "reasoning_effort"
                      ? {
                            ...option,
                            value: "low",
                            options: [
                                { value: "low", label: "Low" },
                                { value: "medium", label: "Medium" },
                                { value: "high", label: "High" },
                                { value: "xhigh", label: "Extra High" },
                            ],
                        }
                      : option,
            ),
        });

        deferred.resolve({
            ...sessionPayload,
            session_id: sessionId,
            model_id: existing.modelId,
            mode_id: existing.modeId,
            config_options: acpConfigOptions,
        });

        await actionPromise;

        const finalSession = useChatStore.getState().sessionsById[sessionId]!;

        expect(finalSession.modelId).toBe("wide-model");
        expect(
            finalSession.configOptions.find((option) => option.id === "model")
                ?.value,
        ).toBe("wide-model");
        expect(
            finalSession.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("low");
    });

    it("accepts updates for the active workspace session even when its stored vault path is stale", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const sessionId = getActiveSessionId();
        const existing = useChatStore.getState().sessionsById[sessionId]!;

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: {
                    ...existing,
                    vaultPath: "/stale-vault",
                },
            },
        }));
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-active",
                    sessionId,
                    historySessionId: existing.historySessionId,
                    runtimeId: existing.runtimeId,
                },
            ],
            activeTabId: "tab-active",
        });

        useChatStore.getState().upsertSession({
            ...existing,
            modelId: "wide-model",
            configOptions: existing.configOptions.map((option) =>
                option.id === "model"
                    ? { ...option, value: "wide-model" }
                    : option,
            ),
        });

        const updated = useChatStore.getState().sessionsById[sessionId]!;
        expect(updated.modelId).toBe("wide-model");
        expect(updated.vaultPath).toBe("/vault");
    });

    it("continues ignoring updates for non-workspace sessions from another vault", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const foreignSessionId = "codex-session-foreign";

        useChatStore.setState((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [foreignSessionId]: {
                    ...cloneSessionForTest(activeSession, foreignSessionId, {
                        vaultPath: "/other-vault",
                    }),
                },
            },
            sessionOrder: [...state.sessionOrder, foreignSessionId],
        }));
        useChatTabsStore.setState({
            tabs: [
                {
                    id: "tab-active",
                    sessionId: activeSessionId,
                    historySessionId: activeSession.historySessionId,
                    runtimeId: activeSession.runtimeId,
                },
            ],
            activeTabId: "tab-active",
        });

        const before = useChatStore.getState().sessionsById[foreignSessionId]!;

        useChatStore.getState().upsertSession({
            ...before,
            modelId: "wide-model",
            configOptions: before.configOptions.map((option) =>
                option.id === "model"
                    ? { ...option, value: "wide-model" }
                    : option,
            ),
        });

        const after = useChatStore.getState().sessionsById[foreignSessionId]!;
        expect(after.modelId).toBe(before.modelId);
        expect(after.vaultPath).toBe("/other-vault");
    });

    it("preserves restored agent catalogs when a live ACP session update arrives empty", async () => {
        await useChatStore.getState().initialize();

        const sessionId = getActiveSessionId();
        const existing = useChatStore.getState().sessionsById[sessionId]!;

        useChatStore.getState().upsertSession({
            ...existing,
            models: [],
            modes: [],
            configOptions: [],
        });

        const merged = useChatStore.getState().sessionsById[sessionId]!;

        expect(merged.models).toEqual(existing.models);
        expect(merged.modes).toEqual(existing.modes);
        expect(merged.configOptions).toEqual(existing.configOptions);
    });

    it("keeps model and mode config option values aligned with incoming session updates", async () => {
        await useChatStore.getState().initialize();

        const sessionId = getActiveSessionId();
        const existing = useChatStore.getState().sessionsById[sessionId]!;

        useChatStore.getState().upsertSession({
            ...existing,
            modelId: "wide-model",
            modeId: "review-mode",
            configOptions: existing.configOptions.map((option) =>
                option.category === "model"
                    ? { ...option, value: "test-model" }
                    : option.category === "mode"
                      ? { ...option, value: "default" }
                      : option,
            ),
        });

        const merged = useChatStore.getState().sessionsById[sessionId]!;

        expect(merged.modelId).toBe("wide-model");
        expect(merged.modeId).toBe("review-mode");
        expect(
            merged.configOptions.find((option) => option.category === "model")
                ?.value,
        ).toBe("wide-model");
    });

    it("refreshes the agent catalog when loading an existing live session with empty options", async () => {
        await useChatStore.getState().initialize();

        const emptyLiveSessionId = "codex-session-empty";
        useChatStore.getState().upsertSession(
            {
                ...cloneSessionForTest(
                    useChatStore.getState().sessionsById[getActiveSessionId()]!,
                    emptyLiveSessionId,
                    {
                        historySessionId: "history-empty",
                        runtimeState: "live",
                        isPersistedSession: false,
                        models: [],
                        modes: [],
                        configOptions: [],
                    },
                ),
            },
            true,
        );

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_load_session") {
                expect(
                    (args as { sessionId?: string } | undefined)?.sessionId,
                ).toBe(emptyLiveSessionId);
                return {
                    ...sessionPayload,
                    session_id: emptyLiveSessionId,
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().loadSession(emptyLiveSessionId);

        const session =
            useChatStore.getState().sessionsById[emptyLiveSessionId]!;
        expect(useChatStore.getState().activeSessionId).toBe(
            emptyLiveSessionId,
        );
        expect(session.models).toHaveLength(1);
        expect(session.modes).toHaveLength(1);
        expect(session.configOptions).not.toHaveLength(0);
    });

    it("supports targeting a non-active session for local draft and attachment mutations", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const secondSessionId = "codex-session-2";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore
            .getState()
            .upsertSession(
                cloneSessionForTest(activeSession, secondSessionId),
                true,
            );

        useChatStore
            .getState()
            .setComposerParts(
                createTextParts("second explicit"),
                secondSessionId,
            );
        useChatStore.getState().attachNote(
            {
                id: "notes/two",
                title: "Note Two",
                path: "/vault/Note Two.md",
            },
            secondSessionId,
        );
        useChatStore
            .getState()
            .attachFolder("/vault/folder", "Project Folder", secondSessionId);

        let state = useChatStore.getState();
        const noteAttachment = state.sessionsById[
            secondSessionId
        ]?.attachments.find((attachment) => attachment.type === "note");
        const folderAttachment = state.sessionsById[
            secondSessionId
        ]?.attachments.find((attachment) => attachment.type === "folder");

        expect(
            serializeComposerParts(
                state.composerPartsBySessionId[activeSessionId] ?? [],
            ),
        ).toBe("");
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId[secondSessionId] ?? [],
            ),
        ).toBe("second explicit");
        expect(state.sessionsById[activeSessionId]?.attachments).toEqual([]);
        expect(noteAttachment?.label).toBe("Note Two");
        expect(folderAttachment?.label).toBe("Project Folder");

        expect(noteAttachment).toBeDefined();
        expect(folderAttachment).toBeDefined();

        useChatStore
            .getState()
            .updateAttachment(
                noteAttachment!.id,
                { label: "Note Two Renamed" },
                secondSessionId,
            );
        useChatStore
            .getState()
            .removeAttachment(folderAttachment!.id, secondSessionId);

        state = useChatStore.getState();
        expect(
            state.sessionsById[secondSessionId]?.attachments.map(
                (attachment) => attachment.label,
            ),
        ).toEqual(["Note Two Renamed"]);

        useChatStore.getState().clearAttachments(secondSessionId);

        expect(
            useChatStore.getState().sessionsById[secondSessionId]?.attachments,
        ).toEqual([]);
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.attachments,
        ).toEqual([]);
    });

    it("supports targeting a non-active session for local session settings", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const secondSessionId = "codex-session-2";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, secondSessionId, {
                runtimeState: "persisted_only",
                modelId: "test-model",
                modeId: "draft-mode",
            }),
            true,
        );

        await useChatStore.getState().setModel("wide-model", secondSessionId);
        await useChatStore.getState().setMode("review-mode", secondSessionId);
        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high", secondSessionId);

        const state = useChatStore.getState();

        expect(state.sessionsById[secondSessionId]?.modelId).toBe("wide-model");
        expect(state.sessionsById[secondSessionId]?.modeId).toBe("review-mode");
        expect(
            state.sessionsById[secondSessionId]?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
        expect(state.sessionsById[activeSessionId]?.modelId).toBe("test-model");
        expect(state.sessionsById[activeSessionId]?.modeId).toBe("default");
        expect(
            state.sessionsById[activeSessionId]?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(
            invokeMock.mock.calls.filter(
                ([command]) =>
                    command === "ai_set_model" ||
                    command === "ai_set_mode" ||
                    command === "ai_set_config_option",
            ),
        ).toHaveLength(0);
    });

    it("resumes a restored session before applying agent settings", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const secondSessionId = "codex-session-restored";
        const resumedSessionId = "codex-session-restored-live";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const resumeSession = vi.fn(async (sessionId: string) => {
            const persistedSession =
                useChatStore.getState().sessionsById[sessionId]!;
            useChatStore.setState((state) => {
                const resumedSession = cloneSessionForTest(
                    activeSession,
                    resumedSessionId,
                    {
                        historySessionId:
                            persistedSession.historySessionId ?? sessionId,
                        runtimeState: "live",
                        isPersistedSession: false,
                        modelId: persistedSession.modelId,
                        modeId: persistedSession.modeId,
                    },
                );
                const nextSessionsById = { ...state.sessionsById };
                delete nextSessionsById[sessionId];
                nextSessionsById[resumedSessionId] = resumedSession;

                return {
                    sessionsById: nextSessionsById,
                    sessionOrder: state.sessionOrder.map((id) =>
                        id === sessionId ? resumedSessionId : id,
                    ),
                    activeSessionId:
                        state.activeSessionId === sessionId
                            ? resumedSessionId
                            : state.activeSessionId,
                };
            });

            return resumedSessionId;
        });

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, secondSessionId, {
                runtimeState: "persisted_only",
                isPersistedSession: true,
                modelId: "test-model",
                modeId: "default",
                models: [],
                modes: [],
                configOptions: [],
            }),
            true,
        );
        useChatStore.setState({ resumeSession });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_set_mode") {
                expect(
                    (
                        args as
                            | { sessionId?: string; modeId?: string }
                            | undefined
                    )?.sessionId,
                ).toBe(resumedSessionId);
                expect(
                    (
                        args as
                            | { sessionId?: string; modeId?: string }
                            | undefined
                    )?.modeId,
                ).toBe("review-mode");
                return {
                    ...sessionPayload,
                    session_id: resumedSessionId,
                    model_id: "wide-model",
                    mode_id: "review-mode",
                    config_options: [
                        {
                            ...acpConfigOptions[0],
                            value: "wide-model",
                        },
                        {
                            ...acpConfigOptions[1],
                            value: "medium",
                        },
                    ],
                };
            }

            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              session_id?: string;
                              option_id?: string;
                              value?: string;
                          })
                        : undefined;

                expect(input?.session_id).toBe(resumedSessionId);

                if (input?.option_id === "model") {
                    expect(input.value).toBe("wide-model");
                    return {
                        ...sessionPayload,
                        session_id: resumedSessionId,
                        model_id: "wide-model",
                        mode_id: "default",
                        config_options: [
                            {
                                ...acpConfigOptions[0],
                                value: "wide-model",
                            },
                            {
                                ...acpConfigOptions[1],
                                value: "medium",
                            },
                        ],
                    };
                }

                expect(input?.option_id).toBe("reasoning_effort");
                expect(input?.value).toBe("high");
                return {
                    ...sessionPayload,
                    session_id: resumedSessionId,
                    model_id: "wide-model",
                    mode_id: "review-mode",
                    config_options: [
                        {
                            ...acpConfigOptions[0],
                            value: "wide-model",
                        },
                        {
                            ...acpConfigOptions[1],
                            value: "high",
                        },
                    ],
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore.getState().setModel("wide-model", secondSessionId);

        const liveSessionId = useChatStore.getState().activeSessionId;
        expect(liveSessionId).toBe(resumedSessionId);

        await useChatStore.getState().setMode("review-mode", liveSessionId!);
        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high", liveSessionId!);

        const restored = useChatStore.getState().sessionsById[resumedSessionId];

        expect(resumeSession).toHaveBeenCalledWith(secondSessionId);
        expect(useChatStore.getState().sessionsById[secondSessionId]).toBe(
            undefined,
        );
        expect(restored?.modelId).toBe("wide-model");
        expect(restored?.modeId).toBe("review-mode");
        expect(
            restored?.configOptions.find((option) => option.id === "model")
                ?.value,
        ).toBe("wide-model");
        expect(
            restored?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
        expect(
            invokeMock.mock.calls.filter(
                ([command]) =>
                    command === "ai_set_model" ||
                    command === "ai_set_mode" ||
                    command === "ai_set_config_option",
            ),
        ).toHaveLength(3);
    });

    it("resumes a persisted session before applying a config option mutation", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const persistedSessionId = "codex-session-restored-option";
        const resumedSessionId = "codex-session-restored-option-live";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const resumeSession = vi.fn(async (sessionId: string) => {
            const persistedSession =
                useChatStore.getState().sessionsById[sessionId]!;
            useChatStore.setState((state) => {
                const resumedSession = cloneSessionForTest(
                    activeSession,
                    resumedSessionId,
                    {
                        historySessionId:
                            persistedSession.historySessionId ?? sessionId,
                        runtimeState: "live",
                        isPersistedSession: false,
                    },
                );
                const nextSessionsById = { ...state.sessionsById };
                delete nextSessionsById[sessionId];
                nextSessionsById[resumedSessionId] = resumedSession;

                return {
                    sessionsById: nextSessionsById,
                    sessionOrder: state.sessionOrder.map((id) =>
                        id === sessionId ? resumedSessionId : id,
                    ),
                    activeSessionId:
                        state.activeSessionId === sessionId
                            ? resumedSessionId
                            : state.activeSessionId,
                };
            });

            return resumedSessionId;
        });

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, persistedSessionId, {
                historySessionId: "history-restored-option",
                runtimeState: "persisted_only",
                isPersistedSession: true,
                models: [],
                modes: [],
                configOptions: [],
            }),
            true,
        );
        useChatStore.setState({ resumeSession });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              session_id?: string;
                              option_id?: string;
                              value?: string;
                          })
                        : undefined;

                expect(input).toMatchObject({
                    session_id: resumedSessionId,
                    option_id: "reasoning_effort",
                    value: "high",
                });

                return {
                    ...sessionPayload,
                    session_id: resumedSessionId,
                    config_options: [
                        {
                            ...acpConfigOptions[0],
                            value: "test-model",
                        },
                        {
                            ...acpConfigOptions[1],
                            value: "high",
                        },
                    ],
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high", persistedSessionId);

        const restored = useChatStore.getState().sessionsById[resumedSessionId];
        const prefs = JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}");

        expect(resumeSession).toHaveBeenCalledWith(persistedSessionId);
        expect(useChatStore.getState().sessionsById[persistedSessionId]).toBe(
            undefined,
        );
        expect(
            restored?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("high");
        expect(prefs).toMatchObject({
            configOptions: {
                reasoning_effort: "high",
            },
        });
    });

    it("does not simulate a persisted model change when resumeSession cannot make it live", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const persistedSessionId = "codex-session-model-resume-failure";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const resumeSession = vi.fn(async () => null);

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, persistedSessionId, {
                historySessionId: "history-model-resume-failure",
                runtimeState: "persisted_only",
                isPersistedSession: true,
                modelId: "test-model",
                models: [],
                modes: [],
                configOptions: [],
            }),
            true,
        );
        useChatStore.setState({ resumeSession });

        await useChatStore
            .getState()
            .setModel("wide-model", persistedSessionId);

        expect(resumeSession).toHaveBeenCalledWith(persistedSessionId);
        expect(
            useChatStore.getState().sessionsById[persistedSessionId],
        ).toMatchObject({
            sessionId: persistedSessionId,
            runtimeState: "persisted_only",
            modelId: "test-model",
        });
        expect(
            invokeMock.mock.calls.filter(
                ([command]) =>
                    command === "ai_set_model" ||
                    command === "ai_set_config_option",
            ),
        ).toHaveLength(0);
        expect(localStorage.getItem(AI_PREFS_KEY)).toBeNull();
    });

    it("does not simulate a resumed config option change when the remote mutation fails", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const persistedSessionId = "codex-session-option-remote-failure";
        const resumedSessionId = "codex-session-option-remote-failure-live";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;
        const resumeSession = vi.fn(async (sessionId: string) => {
            const persistedSession =
                useChatStore.getState().sessionsById[sessionId]!;
            useChatStore.setState((state) => {
                const resumedSession = cloneSessionForTest(
                    activeSession,
                    resumedSessionId,
                    {
                        historySessionId:
                            persistedSession.historySessionId ?? sessionId,
                        runtimeState: "live",
                        isPersistedSession: false,
                    },
                );
                const nextSessionsById = { ...state.sessionsById };
                delete nextSessionsById[sessionId];
                nextSessionsById[resumedSessionId] = resumedSession;

                return {
                    sessionsById: nextSessionsById,
                    sessionOrder: state.sessionOrder.map((id) =>
                        id === sessionId ? resumedSessionId : id,
                    ),
                    activeSessionId:
                        state.activeSessionId === sessionId
                            ? resumedSessionId
                            : state.activeSessionId,
                };
            });

            return resumedSessionId;
        });

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, persistedSessionId, {
                historySessionId: "history-option-remote-failure",
                runtimeState: "persisted_only",
                isPersistedSession: true,
                models: [],
                modes: [],
                configOptions: [],
            }),
            true,
        );
        useChatStore.setState({ resumeSession });

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_set_config_option") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (args.input as {
                              session_id?: string;
                              option_id?: string;
                              value?: string;
                          })
                        : undefined;

                expect(input).toMatchObject({
                    session_id: resumedSessionId,
                    option_id: "reasoning_effort",
                    value: "high",
                });
                throw new Error("remote option failure");
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high", persistedSessionId);

        const restored =
            useChatStore.getState().sessionsById[resumedSessionId] ?? null;
        const prefs = JSON.parse(localStorage.getItem(AI_PREFS_KEY) ?? "{}");

        expect(resumeSession).toHaveBeenCalledWith(persistedSessionId);
        expect(restored?.runtimeState).toBe("live");
        expect(
            restored?.configOptions.find(
                (option) => option.id === "reasoning_effort",
            )?.value,
        ).toBe("medium");
        expect(restored?.messages.at(-1)).toMatchObject({
            kind: "error",
            content: "remote option failure",
        });
        expect(prefs.configOptions ?? {}).toEqual({});
    });

    it("supports targeting a non-active live session for send, user input and stop actions", async () => {
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();
        const secondSessionId = "codex-session-2";
        const activeSession =
            useChatStore.getState().sessionsById[activeSessionId]!;

        useChatStore.getState().upsertSession(
            cloneSessionForTest(activeSession, secondSessionId, {
                runtimeState: "live",
            }),
            true,
        );

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                expect(
                    (args as { sessionId?: string } | undefined)?.sessionId,
                ).toBe(secondSessionId);
                return {
                    ...sessionPayload,
                    session_id: secondSessionId,
                    status: "streaming" as const,
                };
            }

            if (command === "ai_respond_user_input") {
                const input =
                    typeof args === "object" && args !== null && "input" in args
                        ? (
                              args as {
                                  input?: {
                                      session_id?: string;
                                      request_id?: string;
                                      answers?: Record<string, string[]>;
                                  };
                              }
                          ).input
                        : undefined;
                expect(input?.session_id).toBe(secondSessionId);
                expect(input?.request_id).toBe("input-2");
                expect(input?.answers).toEqual({ scope: ["Safe"] });
                return {
                    ...sessionPayload,
                    session_id: secondSessionId,
                    status: "streaming" as const,
                };
            }

            if (command === "ai_cancel_turn") {
                expect(
                    (args as { sessionId?: string } | undefined)?.sessionId,
                ).toBe(secondSessionId);
                return {
                    ...sessionPayload,
                    session_id: secondSessionId,
                    status: "idle" as const,
                };
            }

            return defaultInvokeImplementation(command, args);
        });

        useChatStore
            .getState()
            .setComposerParts(
                createTextParts("Send to second"),
                secondSessionId,
            );
        await useChatStore.getState().sendMessage(secondSessionId);

        let state = useChatStore.getState();
        expect(
            serializeComposerParts(
                state.composerPartsBySessionId[secondSessionId] ?? [],
            ),
        ).toBe("");
        expect(
            state.sessionsById[secondSessionId]?.messages.some(
                (message) =>
                    message.role === "user" &&
                    message.content === "Send to second",
            ),
        ).toBe(true);
        expect(state.sessionsById[activeSessionId]?.messages).toHaveLength(0);

        useChatStore.getState().applyUserInputRequest({
            session_id: secondSessionId,
            request_id: "input-2",
            title: "Need more detail",
            questions: [
                {
                    id: "scope",
                    header: "Scope",
                    question: "Which option should I use?",
                    is_other: true,
                    is_secret: false,
                    options: [
                        {
                            label: "Safe",
                            description: "Conservative option",
                        },
                    ],
                },
            ],
        });

        await useChatStore
            .getState()
            .respondUserInput("input-2", { scope: ["Safe"] }, secondSessionId);

        state = useChatStore.getState();
        expect(state.sessionsById[secondSessionId]?.status).toBe("streaming");
        expect(
            state.sessionsById[secondSessionId]?.messages.at(-1)?.meta,
        ).toMatchObject({
            status: "resolved",
            answered: true,
        });

        await useChatStore.getState().stopStreaming(secondSessionId);

        state = useChatStore.getState();
        expect(state.sessionsById[secondSessionId]?.status).toBe("idle");
        expect(
            invokeMock.mock.calls.filter(
                ([command]) =>
                    command === "ai_send_message" ||
                    command === "ai_respond_user_input" ||
                    command === "ai_cancel_turn",
            ),
        ).toHaveLength(3);
    });

    it("no-ops when no active session exists and no explicit sessionId is provided", async () => {
        await useChatStore.getState().initialize();

        const previousComposerPartsBySessionId = structuredClone(
            useChatStore.getState().composerPartsBySessionId,
        );

        useChatStore.setState({ activeSessionId: null });

        useChatStore.getState().setComposerParts(createTextParts("ignored"));
        useChatStore.getState().attachNote({
            id: "notes/ignored",
            title: "Ignored",
            path: "/vault/Ignored.md",
        });
        await useChatStore.getState().setModel("wide-model");
        await useChatStore.getState().setMode("review-mode");
        await useChatStore
            .getState()
            .setConfigOption("reasoning_effort", "high");
        await useChatStore.getState().sendMessage();
        await useChatStore.getState().respondUserInput("input-missing", {});
        await useChatStore.getState().stopStreaming();

        expect(
            invokeMock.mock.calls.filter(
                ([command]) =>
                    command === "ai_set_model" ||
                    command === "ai_set_mode" ||
                    command === "ai_set_config_option" ||
                    command === "ai_send_message" ||
                    command === "ai_respond_user_input" ||
                    command === "ai_cancel_turn",
            ),
        ).toHaveLength(0);
        expect(useChatStore.getState().composerPartsBySessionId).toEqual(
            previousComposerPartsBySessionId,
        );
    });

    it("attachSelectionFromEditor inserts a selection_mention composer part", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                path: null,
                text: "hello world",
                from: 10,
                to: 21,
                startLine: 3,
                endLine: 5,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];
        const selectionParts = parts.filter(
            (p) => p.type === "selection_mention",
        );

        expect(selectionParts).toHaveLength(1);
        expect(selectionParts[0]).toMatchObject({
            type: "selection_mention",
            noteId: "notes/demo",
            label: "(3:5)  hello world",
            selectedText: "hello world",
            startLine: 3,
            endLine: 5,
        });
    });

    it("attachSelectionFromEditor shows single line label", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                path: null,
                text: "single line",
                from: 0,
                to: 11,
                startLine: 7,
                endLine: 7,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];
        const selectionPart = parts.find((p) => p.type === "selection_mention");

        expect(selectionPart).toBeDefined();
        expect(
            selectionPart?.type === "selection_mention"
                ? selectionPart.label
                : null,
        ).toBe("(7)  single line");
    });

    it("attachSelectionFromEditor does nothing without a selection", async () => {
        await useChatStore.getState().initialize();
        useEditorStore.setState({ currentSelection: null });
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(parts.some((p) => p.type === "selection_mention")).toBe(false);
    });

    it("attachSelectionFromEditor deduplicates identical selections", async () => {
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/demo",
                    title: "Demo",
                    path: "/vault/notes/demo.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });

        useEditorStore.setState({
            currentSelection: {
                noteId: "notes/demo",
                path: null,
                text: "hello",
                from: 0,
                to: 5,
                startLine: 1,
                endLine: 1,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];

        expect(
            parts.filter((p) => p.type === "selection_mention"),
        ).toHaveLength(1);
    });

    it("attachSelectionFromEditor inserts a file-backed selection_mention", async () => {
        useEditorStore.setState({
            currentSelection: {
                noteId: null,
                path: "/vault/src/config.toml",
                text: 'name = "NeverWrite"',
                from: 0,
                to: 16,
                startLine: 1,
                endLine: 1,
            },
        });

        await useChatStore.getState().initialize();
        useChatStore.getState().attachSelectionFromEditor();

        const activeSessionId = getActiveSessionId();
        const parts =
            useChatStore.getState().composerPartsBySessionId[activeSessionId] ??
            [];
        const selectionPart = parts.find((p) => p.type === "selection_mention");

        expect(selectionPart).toMatchObject({
            type: "selection_mention",
            noteId: null,
            path: "/vault/src/config.toml",
            label: '(1)  name = "NeverWrite"',
            selectedText: 'name = "NeverWrite"',
            startLine: 1,
            endLine: 1,
        });
    });

    it("resolveReviewHunks ignores stale trackedVersion and leaves the tracked file untouched", async () => {
        const file = createTrackedFile(
            "notes/stale.md",
            "alpha\nbeta\ngamma",
            "alpha\nBETA\ngamma",
            {
                reviewState: "finalized",
            },
        );
        const session = createSessionWithTrackedFiles("session-stale", [file]);
        const projection = buildReviewProjection(file);

        useChatStore.setState({
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        });
        const [trackedBefore] = getVisibleBuffer(session.sessionId);

        await useChatStore
            .getState()
            .resolveReviewHunks(
                session.sessionId,
                file.identityKey,
                "accepted",
                file.version + 1,
                [projection.hunks[0]!.id],
            );

        const [trackedAfter] = getVisibleBuffer(session.sessionId);
        expect(trackedAfter).toEqual(trackedBefore);
    });

    it("resolveReviewHunks rejects only the selected accumulated hunk and preserves later agent hunks", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return defaultInvokeImplementation(command, args);
        });

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accumulated-hunk-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc\nddd",
                    new_text: "aaa\nBBB\nccc\nddd",
                },
            ],
        });

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accumulated-hunk-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaXa\nBBB\nccc\nddd",
                    new_text: "aaXa\nBBB\nccc\nDDD",
                },
            ],
        });
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-accumulated-hunk-b",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;
        const projection = buildReviewProjection(entry);
        expect(projection.hunks).toHaveLength(2);

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }

            if (command === "ai_get_text_file_hash") {
                return hashTextContent(entry.currentText);
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            return defaultInvokeImplementation(command, args);
        });

        await useChatStore
            .getState()
            .resolveReviewHunks(
                activeSessionId,
                entry.identityKey,
                "rejected",
                entry.version,
                [projection.hunks[0]!.id],
            );

        const [remaining] = getVisibleBuffer(activeSessionId);
        expect(remaining).toBeDefined();
        expectTrackedFileToMatchAccumulatedDiff(
            remaining!,
            "aaXa\nbbb\nccc\nddd",
            "aaXa\nbbb\nccc\nDDD",
        );
        expect(buildReviewProjection(remaining!).hunks).toHaveLength(1);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/notes/file.md",
            previousPath: null,
            content: "aaXa\nbbb\nccc\nDDD",
        });
    });

    it("resolveReviewHunks marks rejected hunks as conflict when the applied file changed on disk", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-hunk-conflict",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc",
                    new_text: "aaa\nBBB\nccc",
                },
            ],
        });
        useEditorStore.getState().openReview(activeSessionId, {
            title: "Review Codex",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;
        const projection = buildReviewProjection(entry);

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                return "different-hash";
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        await useChatStore
            .getState()
            .resolveReviewHunks(
                activeSessionId,
                entry.identityKey,
                "rejected",
                entry.version,
                [projection.hunks[0]!.id],
            );

        const [remaining] = getVisibleBuffer(activeSessionId);
        expect(remaining).toMatchObject({
            identityKey: entry.identityKey,
            conflictHash: "different-hash",
        });
        expect(
            useChatStore.getState().sessionsById[activeSessionId]?.actionLog
                ?.lastRejectUndo,
        ).toBeNull();
        expect(
            useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === activeSessionId,
                ),
        ).toBeDefined();
        expect(invokeMock).not.toHaveBeenCalledWith(
            "ai_restore_text_file",
            expect.anything(),
        );
    });

    it("resolveReviewHunks waits for the applied file hash to settle before rejecting hunks", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-hunk-conflict-settle",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc",
                    new_text: "aaa\nBBB\nccc",
                },
            ],
        });
        useEditorStore.getState().openReview(activeSessionId, {
            title: "Review Codex",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;
        const projection = buildReviewProjection(entry);
        const oldHash = hashTextContent(entry.diffBase);
        const appliedHash = hashTextContent(entry.currentText);
        let hashCalls = 0;

        invokeMock.mockImplementation(async (command) => {
            if (command === "ai_get_text_file_hash") {
                hashCalls += 1;
                return hashCalls === 1 ? oldHash : appliedHash;
            }

            if (command === "ai_restore_text_file") {
                return undefined;
            }

            if (
                command === "ai_save_session_history" ||
                command === "ai_prune_session_histories"
            ) {
                return undefined;
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        vi.useFakeTimers();
        try {
            const rejectPromise = useChatStore
                .getState()
                .resolveReviewHunks(
                    activeSessionId,
                    entry.identityKey,
                    "rejected",
                    entry.version,
                    [projection.hunks[0]!.id],
                );
            await vi.advanceTimersByTimeAsync(1000);
            await rejectPromise;
        } finally {
            vi.useRealTimers();
        }

        expect(getVisibleBuffer(activeSessionId)).toHaveLength(0);
        expect(hashCalls).toBeGreaterThan(1);
        expect(invokeMock).toHaveBeenCalledWith("ai_restore_text_file", {
            vaultPath: "/vault",
            path: "/notes/file.md",
            previousPath: null,
            content: "aaa\nbbb\nccc",
        });
    });

    it("resolveReviewHunks accepts only the selected accumulated hunk and preserves later agent hunks", async () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        await useChatStore.getState().initialize();

        invokeMock.mockImplementation(async (command, args) => {
            if (command === "ai_send_message") {
                return { ...sessionPayload, status: "streaming" };
            }
            return defaultInvokeImplementation(command, args);
        });

        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accept-hunk-a",
            title: "Edit file",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaa\nbbb\nccc\nddd",
                    new_text: "aaa\nBBB\nccc\nddd",
                },
            ],
        });

        useChatStore.getState().notifyUserEditOnFile(
            "/notes/file.md",
            [
                {
                    oldFrom: 2,
                    oldTo: 2,
                    newFrom: 2,
                    newTo: 3,
                },
            ],
            "aaXa\nBBB\nccc\nddd",
        );

        useChatStore.getState().setComposerParts(createTextParts("Next turn"));
        await useChatStore.getState().sendMessage();
        useChatStore.getState().applyToolActivity({
            session_id: activeSessionId,
            tool_call_id: "tool-accept-hunk-b",
            title: "Edit file again",
            kind: "edit",
            status: "completed",
            diffs: [
                {
                    path: "/notes/file.md",
                    kind: "update",
                    old_text: "aaXa\nBBB\nccc\nddd",
                    new_text: "aaXa\nBBB\nccc\nDDD",
                },
            ],
        });
        useChatStore.getState().applyMessageCompleted({
            session_id: activeSessionId,
            message_id: "assistant-accept-hunk-b",
        });

        const entry = getVisibleBuffer(activeSessionId)[0]!;
        const projection = buildReviewProjection(entry);
        expect(projection.hunks).toHaveLength(2);

        await useChatStore
            .getState()
            .resolveReviewHunks(
                activeSessionId,
                entry.identityKey,
                "accepted",
                entry.version,
                [projection.hunks[0]!.id],
            );

        const [remaining] = getVisibleBuffer(activeSessionId);
        expect(remaining).toBeDefined();
        expectTrackedFileToMatchAccumulatedDiff(
            remaining!,
            "aaXa\nBBB\nccc\nddd",
            "aaXa\nBBB\nccc\nDDD",
        );
        expect(buildReviewProjection(remaining!).hunks).toHaveLength(1);
    });

    it("keeps move-only tracked files pending after accepting the last text hunk", async () => {
        const file = createTrackedFile(
            "/notes/file-renamed.md",
            "alpha\nbeta\ngamma",
            "alpha\nBETA\ngamma",
            {
                originPath: "/notes/file.md",
                previousPath: "/notes/file.md",
                reviewState: "finalized",
            },
        );
        const session = createSessionWithTrackedFiles("session-move-only", [
            file,
        ]);
        const projection = buildReviewProjection(file);

        useChatStore.setState({
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        });

        await useChatStore
            .getState()
            .resolveReviewHunks(
                session.sessionId,
                file.identityKey,
                "accepted",
                file.version,
                [projection.hunks[0]!.id],
            );

        const [remaining] = getVisibleBuffer(session.sessionId);
        expect(remaining).toMatchObject({
            path: "/notes/file-renamed.md",
            originPath: "/notes/file.md",
            previousPath: "/notes/file.md",
        });
        expect(remaining?.unreviewedEdits).toEqual(emptyPatch());
        expect(buildReviewProjection(remaining!).hunks).toHaveLength(0);
    });

    it("resolveReviewHunks does not depend on the visual projection to accept hunks", async () => {
        const file = createTrackedFile(
            "notes/visual-independence.md",
            "alpha\nbeta\ngamma",
            "alpha\nBETA\ngamma",
            {
                reviewState: "finalized",
            },
        );
        const session = createSessionWithTrackedFiles("session-visual", [file]);
        const projection = buildReviewProjection(file);

        useChatStore.setState({
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        });

        const projectionSpy = vi.spyOn(
            reviewProjectionModule,
            "buildReviewProjection",
        );
        projectionSpy.mockImplementation(() => {
            throw new Error("visual projection should not be used here");
        });

        try {
            await useChatStore
                .getState()
                .resolveReviewHunks(
                    session.sessionId,
                    file.identityKey,
                    "accepted",
                    file.version,
                    [projection.hunks[0]!.id],
                );
        } finally {
            projectionSpy.mockRestore();
        }

        expect(getVisibleBuffer(session.sessionId)).toHaveLength(0);
    });

    it("resolveReviewHunks resolves the expanded overlap closure returned by the canonical index", async () => {
        const file = createTrackedFile(
            "notes/overlap-closure.md",
            "one\ntwo\nthree\nfour",
            "ONE\ntwo\nTHREE\nfour",
            {
                reviewState: "finalized",
            },
        );
        const session = createSessionWithTrackedFiles("session-overlap", [
            file,
        ]);
        const projection = buildReviewProjection(file);

        expect(projection.hunks).toHaveLength(2);
        const closureSpy = vi.spyOn(
            reviewProjectionIndexModule,
            "expandReviewHunkIdsToOverlapClosure",
        );
        closureSpy.mockImplementation((_index, selectedHunkIds) => {
            if (selectedHunkIds.length === 1) {
                return projection.hunks.map((hunk) => hunk.id);
            }
            return [...selectedHunkIds];
        });
        try {
            useChatStore.setState({
                activeSessionId: session.sessionId,
                sessionsById: {
                    [session.sessionId]: session,
                },
            });

            await useChatStore
                .getState()
                .resolveReviewHunks(
                    session.sessionId,
                    file.identityKey,
                    "accepted",
                    file.version,
                    [projection.hunks[0]!.id],
                );

            expect(closureSpy).toHaveBeenCalledTimes(1);
            expect(getVisibleBuffer(session.sessionId)).toHaveLength(0);
        } finally {
            closureSpy.mockRestore();
        }
    });

    it("ignores session updates from another vault for an existing session", () => {
        useVaultStore.setState({ vaultPath: "/vault-a", notes: [] });

        useChatStore.getState().upsertSession(
            {
                sessionId: "shared-session",
                historySessionId: "shared-session",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                messages: [
                    {
                        id: "local-message",
                        role: "assistant",
                        kind: "text",
                        content: "local",
                        timestamp: 1,
                    },
                ],
                attachments: [],
                models: [],
                modes: [],
                configOptions: [],
            },
            true,
        );

        useChatStore.getState().upsertSession({
            sessionId: "shared-session",
            historySessionId: "shared-session",
            vaultPath: "/vault-b",
            runtimeId: "codex-acp",
            modelId: "test-model",
            modeId: "default",
            status: "idle",
            messages: [
                {
                    id: "foreign-message",
                    role: "assistant",
                    kind: "text",
                    content: "foreign",
                    timestamp: 2,
                },
            ],
            attachments: [],
            models: [],
            modes: [],
            configOptions: [],
        });

        const session =
            useChatStore.getState().sessionsById["shared-session"] ?? null;

        expect(session?.vaultPath).toBe("/vault-a");
        expect(session?.messages).toEqual([
            expect.objectContaining({
                id: "local-message",
                content: "local",
            }),
        ]);
    });

    it("normalizes transcript metadata when upserting a session", () => {
        useChatStore.getState().upsertSession(
            {
                sessionId: "normalized-session",
                historySessionId: "normalized-session",
                runtimeId: "codex-acp",
                modelId: "test-model",
                modeId: "default",
                status: "idle",
                messages: [
                    {
                        id: "status:turn-a",
                        role: "system",
                        kind: "status",
                        title: "Turn started",
                        content: "Turn started",
                        timestamp: 1,
                        meta: {
                            status_event: "turn_started",
                            status: "completed",
                        },
                    },
                    {
                        id: "assistant:a",
                        role: "assistant",
                        kind: "text",
                        content: "Hello",
                        timestamp: 2,
                    },
                    {
                        id: "plan:a",
                        role: "assistant",
                        kind: "plan",
                        title: "Plan",
                        content: "Ship it",
                        timestamp: 3,
                        planEntries: [
                            {
                                content: "Ship it",
                                priority: "medium",
                                status: "in_progress",
                            },
                        ],
                    },
                ],
                attachments: [],
                models: [],
                modes: [],
                configOptions: [],
            },
            true,
        );

        const session =
            useChatStore.getState().sessionsById["normalized-session"]!;

        expect(session.messageOrder).toEqual([
            "status:turn-a",
            "assistant:a",
            "plan:a",
        ]);
        expect(session.messagesById?.["assistant:a"]).toMatchObject({
            content: "Hello",
        });
        expect(session.messageIndexById?.["plan:a"]).toBe(2);
        expect(session.lastTurnStartedMessageId).toBe("status:turn-a");
        expect(session.lastAssistantMessageId).toBe("assistant:a");
        expect(session.activePlanMessageId).toBe("plan:a");
    });

    it("keeps normalized transcript metadata in sync for hot runtime handlers", async () => {
        await useChatStore.getState().initialize();
        const activeSessionId = getActiveSessionId();

        useChatStore.getState().applyStatusEvent({
            session_id: activeSessionId,
            event_id: "turn-hot",
            kind: "turn_started",
            status: "completed",
            emphasis: "neutral",
            title: "New turn",
            detail: "New turn",
        });

        useChatStore.getState().applyMessageStarted({
            session_id: activeSessionId,
            message_id: "assistant-hot",
        });
        useChatStore.getState().applyMessageDelta({
            session_id: activeSessionId,
            message_id: "assistant-hot",
            delta: "hello world",
        });
        flushDeltasSync();

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "hot-plan",
            title: "Plan",
            entries: [
                {
                    content: "Inspect",
                    priority: "medium",
                    status: "in_progress",
                },
            ],
        });

        let session = useChatStore.getState().sessionsById[activeSessionId]!;

        expect(session.lastTurnStartedMessageId).toBe("status:turn-hot");
        expect(session.lastAssistantMessageId).toBe("assistant-hot");
        expect(session.messagesById?.["assistant-hot"]).toMatchObject({
            content: "hello world",
            inProgress: true,
        });
        expect(session.messageIndexById?.["assistant-hot"]).toBe(
            session.messages.findIndex(
                (message) => message.id === "assistant-hot",
            ),
        );
        expect(session.activePlanMessageId).toBe("plan:hot-plan");

        useChatStore.getState().applyPlanUpdate({
            session_id: activeSessionId,
            plan_id: "hot-plan",
            title: "Plan",
            entries: [
                {
                    content: "Inspect",
                    priority: "medium",
                    status: "completed",
                },
            ],
        });

        session = useChatStore.getState().sessionsById[activeSessionId]!;
        expect(session.activePlanMessageId).toBeNull();
        expect(session.messagesById?.["plan:hot-plan"]?.planEntries).toEqual([
            expect.objectContaining({ status: "completed" }),
        ]);
    });
});
