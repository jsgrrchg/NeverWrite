import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_FILE_CHANGE_REPORT_CAPABILITY, FILE_CHANGE_AUDIT_SERVER_NAME, FILE_CHANGE_AUDIT_TOOL_NAME, FILE_CHANGE_AUDIT_WIRE_TOOL_NAME, } from "../file-change-audit.js";
let observedStopOutputs = [];
let observedPreToolDecision;
let observedCanUseToolDecision;
let replayMessages = [];
let auditScenario = "reported";
let auditTurnActivated = Promise.resolve();
let resolveAuditTurnActivated = () => { };
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
    const actual = await vi.importActual("@anthropic-ai/claude-agent-sdk");
    return {
        ...actual,
        getSessionMessages: vi.fn(async () => replayMessages),
        query: ({ prompt, options }) => {
            let resolveInterrupt = () => { };
            const interrupted = new Promise((resolve) => {
                resolveInterrupt = resolve;
            });
            return Object.assign(runAuditedTurn(prompt, options, interrupted), {
                initializationResult: async () => ({
                    models: [
                        {
                            value: "claude-sonnet-4-6",
                            displayName: "Claude Sonnet",
                            description: "Fast",
                            supportsAutoMode: true,
                        },
                    ],
                }),
                setModel: vi.fn(async () => { }),
                setPermissionMode: vi.fn(async () => { }),
                supportedAgents: vi.fn(async () => []),
                supportedCommands: vi.fn(async () => []),
                getContextUsage: vi.fn(async () => ({ totalTokens: 0, rawMaxTokens: 200000 })),
                interrupt: vi.fn(async () => {
                    resolveInterrupt();
                    return undefined;
                }),
                close: vi.fn(),
            });
        },
    };
});
vi.mock("../tools.js", async () => ({
    ...(await vi.importActual("../tools.js")),
    registerHookCallback: vi.fn(),
}));
function hookFrom(options, event) {
    const matcher = options.hooks?.[event]?.at(-1);
    const hook = matcher?.hooks.at(-1);
    if (!hook)
        throw new Error(`Missing ${event} audit hook`);
    return hook;
}
function auditToolFrom(options) {
    const server = options.mcpServers?.[FILE_CHANGE_AUDIT_SERVER_NAME];
    const tool = server.instance._registeredTools[FILE_CHANGE_AUDIT_TOOL_NAME];
    if (!tool)
        throw new Error("Missing internal audit tool");
    return tool;
}
function assistantMessage(content) {
    return {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "sdk-session",
        message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
            content,
        },
    };
}
function successResult() {
    return {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "",
        errors: [],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 2,
        total_cost_usd: 0,
        usage: {
            input_tokens: 2,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        session_id: "sdk-session",
    };
}
async function* runAuditedTurn(input, options, interrupted) {
    const iterator = input[Symbol.asyncIterator]();
    const { value: userMessage } = await iterator.next();
    if (!userMessage)
        return;
    if (auditScenario === "localOnly") {
        yield { ...successResult(), result: "Local command output" };
        return;
    }
    yield {
        type: "user",
        message: userMessage.message,
        parent_tool_use_id: null,
        uuid: userMessage.uuid,
        session_id: "sdk-session",
        isReplay: true,
    };
    resolveAuditTurnActivated();
    if (auditScenario === "successWithoutReport") {
        yield assistantMessage([{ type: "text", text: "Visible answer" }]);
        yield successResult();
        return;
    }
    if (auditScenario === "providerError") {
        yield {
            ...successResult(),
            is_error: true,
            result: "Provider failed",
            errors: ["Provider failed"],
        };
        return;
    }
    if (auditScenario === "waitForCancel") {
        await interrupted;
        yield {
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            uuid: randomUUID(),
            session_id: "sdk-session",
        };
        return;
    }
    yield assistantMessage([{ type: "text", text: "Visible answer" }]);
    const hookOptions = { signal: new AbortController().signal };
    const stopHook = hookFrom(options, "Stop");
    observedStopOutputs.push(await stopHook({ hook_event_name: "Stop", stop_hook_active: false }, undefined, hookOptions));
    const preToolUseHook = hookFrom(options, "PreToolUse");
    observedPreToolDecision = await preToolUseHook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_use_id: "blocked-tool",
    }, "blocked-tool", hookOptions);
    observedCanUseToolDecision = await options.canUseTool?.("Bash", { command: "git status" }, {
        signal: hookOptions.signal,
        toolUseID: "blocked-tool",
        requestId: "permission-request",
    });
    const toolUseId = "audit-tool-use";
    yield assistantMessage([
        { type: "text", text: "Audit prose must stay hidden" },
        {
            type: "tool_use",
            id: toolUseId,
            name: FILE_CHANGE_AUDIT_WIRE_TOOL_NAME,
            input: { paths: ["src/changed.ts"], complete: true },
        },
    ]);
    const toolResult = await auditToolFrom(options).handler({
        paths: ["src/changed.ts"],
        complete: true,
    });
    yield {
        type: "user",
        message: {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: toolUseId,
                    content: toolResult.content,
                },
            ],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "sdk-session",
    };
    observedStopOutputs.push(await stopHook({ hook_event_name: "Stop", stop_hook_active: true }, undefined, hookOptions));
    yield successResult();
}
describe("agent file-change audit integration", () => {
    beforeEach(() => {
        observedStopOutputs = [];
        observedPreToolDecision = undefined;
        observedCanUseToolDecision = undefined;
        replayMessages = [];
        auditScenario = "reported";
        auditTurnActivated = new Promise((resolve) => {
            resolveAuditTurnActivated = resolve;
        });
    });
    const negotiatedCapabilities = {
        _meta: {
            jetbrains: {
                air: {
                    version: 1,
                    capabilities: [AGENT_FILE_CHANGE_REPORT_CAPABILITY, "sessionFailure"],
                },
            },
        },
    };
    async function createAuditAgent(updates) {
        const client = {
            sessionUpdate: async (notification) => void updates.push(notification),
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
        };
        const { ClaudeAcpAgent } = await import("../acp-agent.js");
        const agent = new ClaudeAcpAgent(client, {
            log: () => { },
            error: () => { },
        });
        await agent.initialize({
            protocolVersion: 1,
            clientCapabilities: negotiatedCapabilities,
        });
        const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
        return { agent, sessionId };
    }
    function fileChangeTerminals(updates) {
        return updates.flatMap((notification) => {
            if (notification.update.sessionUpdate !== "session_info_update")
                return [];
            const meta = notification.update._meta;
            const report = meta?.jetbrains?.air?.agentFileChangeReport;
            return report ? [report] : [];
        });
    }
    function auditedPrompt(sessionId, requestId, text) {
        return {
            sessionId,
            prompt: [{ type: "text", text }],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: { version: 1, requestId },
                    },
                },
            },
        };
    }
    it.each([
        {
            name: "normal success without a Stop report",
            scenario: "successWithoutReport",
            prompt: "Finish normally",
            reason: "notReported",
            rejects: false,
        },
        {
            name: "a local-only command",
            scenario: "localOnly",
            prompt: "/context",
            reason: "notReported",
            rejects: false,
        },
        {
            name: "a provider error",
            scenario: "providerError",
            prompt: "Call the provider",
            reason: "providerError",
            rejects: false,
        },
    ])("publishes one terminal for $name", async ({ scenario, prompt, reason, rejects }) => {
        auditScenario = scenario;
        const updates = [];
        const { agent, sessionId } = await createAuditAgent(updates);
        const requestId = `request-${scenario}`;
        const result = agent.prompt(auditedPrompt(sessionId, requestId, prompt));
        if (rejects) {
            await expect(result).rejects.toBeDefined();
        }
        else {
            await expect(result).resolves.toBeDefined();
        }
        expect(fileChangeTerminals(updates)).toEqual([
            {
                version: 1,
                requestId,
                status: "unavailable",
                reason,
            },
        ]);
        await agent.dispose();
        expect(fileChangeTerminals(updates)).toHaveLength(1);
    });
    it.each([
        { name: "cancel", close: false },
        { name: "session close", close: true },
    ])("publishes one cancelled terminal and settles the prompt on $name", async ({ close }) => {
        auditScenario = "waitForCancel";
        const updates = [];
        const { agent, sessionId } = await createAuditAgent(updates);
        const requestId = close ? "request-close" : "request-cancel";
        const result = agent.prompt(auditedPrompt(sessionId, requestId, "Wait"));
        await auditTurnActivated;
        if (close) {
            await agent.closeSession({ sessionId });
        }
        else {
            await agent.cancel({ sessionId });
        }
        await expect(result).resolves.toMatchObject({ stopReason: "cancelled" });
        expect(fileChangeTerminals(updates)).toEqual([
            {
                version: 1,
                requestId,
                status: "unavailable",
                reason: "cancelled",
            },
        ]);
        await agent.dispose();
        expect(fileChangeTerminals(updates)).toHaveLength(1);
    });
    it("negotiates an opt-in turn, publishes one report, and hides the audit continuation", async () => {
        const updates = [];
        const client = {
            sessionUpdate: async (notification) => void updates.push(notification),
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
        };
        const { ClaudeAcpAgent } = await import("../acp-agent.js");
        const agent = new ClaudeAcpAgent(client, {
            log: () => { },
            error: () => { },
        });
        const capabilities = {
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        capabilities: [AGENT_FILE_CHANGE_REPORT_CAPABILITY],
                    },
                },
            },
        };
        const initialize = await agent.initialize({
            protocolVersion: 1,
            clientCapabilities: capabilities,
        });
        expect(initialize._meta).toMatchObject({
            jetbrains: {
                air: {
                    version: 1,
                    capabilities: expect.arrayContaining([AGENT_FILE_CHANGE_REPORT_CAPABILITY]),
                },
            },
        });
        const cwd = process.cwd();
        const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Change the file" }],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: { version: 1, requestId: "request-integration" },
                    },
                },
            },
        });
        expect(response.stopReason).toBe("end_turn");
        expect(observedStopOutputs).toHaveLength(2);
        expect(observedStopOutputs[0]).toMatchObject({
            hookSpecificOutput: {
                hookEventName: "Stop",
                additionalContext: expect.stringContaining(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME),
            },
        });
        expect(observedStopOutputs[1]).toEqual({});
        expect(observedPreToolDecision).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
        });
        expect(observedCanUseToolDecision).toMatchObject({ behavior: "deny" });
        const reportUpdates = updates.filter((notification) => {
            if (notification.update.sessionUpdate !== "session_info_update")
                return false;
            const meta = notification.update._meta;
            return meta?.jetbrains?.air?.agentFileChangeReport !== undefined;
        });
        expect(reportUpdates).toEqual([
            {
                sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                        jetbrains: {
                            air: {
                                version: 1,
                                agentFileChangeReport: {
                                    version: 1,
                                    requestId: "request-integration",
                                    status: "reported",
                                    paths: [path.join(cwd, "src/changed.ts")],
                                    declaredComplete: true,
                                    truncated: false,
                                },
                            },
                        },
                    },
                },
            },
        ]);
        const serializedUpdates = JSON.stringify(updates);
        expect(serializedUpdates).toContain("Visible answer");
        expect(serializedUpdates).not.toContain("Audit prose must stay hidden");
        expect(serializedUpdates).not.toContain(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME);
        await agent.dispose();
        const firstStop = observedStopOutputs[0];
        const auditContext = firstStop.hookSpecificOutput?.additionalContext;
        if (!auditContext)
            throw new Error("Missing audit continuation context");
        const replayToolUseId = "replay-audit-tool";
        const deniedReplayToolUseId = "replay-denied-tool";
        const replayUserMessage = (content) => ({
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: "replay-session",
        });
        replayMessages = [
            replayUserMessage("Original prompt"),
            assistantMessage([{ type: "text", text: "Visible persisted answer" }]),
            replayUserMessage(auditContext),
            assistantMessage([{ type: "text", text: "Separate audit prose must stay hidden" }]),
            assistantMessage([
                {
                    type: "tool_use",
                    id: deniedReplayToolUseId,
                    name: "Bash",
                    input: { command: "git status" },
                },
            ]),
            replayUserMessage([
                {
                    type: "tool_result",
                    tool_use_id: deniedReplayToolUseId,
                    content: "denied",
                    is_error: true,
                },
            ]),
            assistantMessage([{ type: "text", text: "Prose after denial must stay hidden" }]),
            assistantMessage([
                {
                    type: "tool_use",
                    id: replayToolUseId,
                    name: FILE_CHANGE_AUDIT_WIRE_TOOL_NAME,
                    input: { paths: ["src/changed.ts"], complete: true },
                },
            ]),
            replayUserMessage([
                {
                    type: "tool_result",
                    tool_use_id: replayToolUseId,
                    content: "recorded",
                },
            ]),
            replayUserMessage("Follow-up prompt"),
            assistantMessage([{ type: "text", text: "Follow-up answer" }]),
        ];
        const replayUpdates = [];
        const replayAgent = new ClaudeAcpAgent({
            ...client,
            sessionUpdate: async (notification) => void replayUpdates.push(notification),
        }, { log: () => { }, error: () => { } });
        await replayAgent.initialize({
            protocolVersion: 1,
            clientCapabilities: capabilities,
        });
        await replayAgent.loadSession({
            sessionId: "replay-session",
            cwd,
            mcpServers: [],
        });
        const serializedReplay = JSON.stringify(replayUpdates);
        expect(serializedReplay).toContain("Original prompt");
        expect(serializedReplay).toContain("Visible persisted answer");
        expect(serializedReplay).toContain("Follow-up prompt");
        expect(serializedReplay).toContain("Follow-up answer");
        expect(serializedReplay).not.toContain("Separate audit prose must stay hidden");
        expect(serializedReplay).not.toContain("Prose after denial must stay hidden");
        expect(serializedReplay).not.toContain(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME);
        expect(serializedReplay).not.toContain("claude-agent-acp-file-change-audit");
        await replayAgent.dispose();
    });
});
