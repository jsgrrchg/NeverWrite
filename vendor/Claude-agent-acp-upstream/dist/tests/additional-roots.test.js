import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let capturedOptions;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
    ...(await vi.importActual("@anthropic-ai/claude-agent-sdk")),
    query: ({ options }) => {
        capturedOptions = options;
        return {
            initializationResult: async () => ({
                models: [{ value: "claude-sonnet-4-5", displayName: "Claude Sonnet", description: "Fast" }],
            }),
            setModel: async () => { },
            supportedCommands: async () => [],
            [Symbol.asyncIterator]: async function* () { },
        };
    },
}));
vi.mock("../tools.js", async () => ({
    ...(await vi.importActual("../tools.js")),
    registerHookCallback: vi.fn(),
}));
describe("additionalRoots", () => {
    let agent;
    const tempDirs = [];
    const newSession = (meta, cwd = "/test") => agent.newSession({ cwd, mcpServers: [], _meta: meta });
    beforeEach(async () => {
        capturedOptions = undefined;
        tempDirs.length = 0;
        vi.resetModules();
        const { ClaudeAcpAgent } = await import("../acp-agent.js");
        agent = new ClaudeAcpAgent({
            sessionUpdate: async (_notification) => { },
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
        });
    });
    afterEach(async () => void (await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))));
    it("passes through relative roots as provided", async () => {
        const projectRoot = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
        tempDirs.push(projectRoot);
        await newSession({ additionalRoots: ["."] }, projectRoot);
        expect(capturedOptions.additionalDirectories).toEqual(["."]);
    });
    it("merges additionalRoots with user additionalDirectories without normalization", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "claude-root-"));
        tempDirs.push(root);
        await newSession({
            additionalRoots: ["", root],
            claudeCode: { options: { additionalDirectories: ["/workspace/shared"] } },
        });
        expect(capturedOptions.additionalDirectories).toEqual(["/workspace/shared", "", root]);
    });
});
