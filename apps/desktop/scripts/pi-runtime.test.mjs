import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
    piInputs,
    piPackage,
    preparePiRuntime,
    validatePiRuntime,
} from "./pi-runtime.mjs";

test("Pi ACP is pinned and its prepared runtime is valid", async () => {
    const inputs = await piInputs();
    assert.equal(piPackage, "pi-acp");
    assert.equal(inputs.version, "0.0.33");
    if (process.env.NEVERWRITE_PI_CONTRACT_RUNTIME) {
        await validatePiRuntime(process.env.NEVERWRITE_PI_CONTRACT_RUNTIME, inputs);
    }
});

async function startPiRuntime(t) {
    const runtime = await preparePiRuntime();
    const child = spawn(process.execPath, [path.join(runtime, "dist", "index.js")], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    t.after(() => {
        lines.close();
        child.kill();
    });
    let nextId = 1;
    return (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const finish = (error, response) => {
            clearTimeout(timer);
            lines.off("line", onLine);
            child.off("error", onError);
            child.off("exit", onExit);
            if (error) reject(error);
            else resolve(response);
        };
        const onError = (error) => finish(error);
        const onExit = (code, signal) => finish(
            new Error(`Pi ACP exited during ${method} (${code ?? signal})`),
        );
        const onLine = (line) => {
            try {
                const response = JSON.parse(line);
                if (response.id === id) finish(null, response);
            } catch (error) {
                finish(error);
            }
        };
        const timer = setTimeout(() => {
            finish(new Error(`Pi ACP ${method} timed out`));
        }, 5_000);
        lines.on("line", onLine);
        child.once("error", onError);
        child.once("exit", onExit);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

const initializeParams = {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "neverwrite-test", version: "0" },
};

test("bundled Pi ACP initializes as protocol v1 and advertises session load", async (t) => {
    const request = await startPiRuntime(t);
    const response = await request("initialize", initializeParams);

    assert.equal(response.result.protocolVersion, 1);
    assert.equal(response.result.agentInfo.name, "pi-acp");
    assert.equal(response.result.agentInfo.version, (await piInputs()).version);
    assert.equal(response.result.agentCapabilities.loadSession, true);
});

test("bundled Pi ACP rejects malformed requests and remains usable", async (t) => {
    const request = await startPiRuntime(t);
    await request("initialize", initializeParams);
    const malformedRequests = [
        ["initialize", { ...initializeParams, protocolVersion: "1" }],
        ["session/new", { cwd: process.cwd(), mcpServers: [null] }],
        ["session/load", { cwd: process.cwd(), mcpServers: [], sessionId: 1 }],
        ["session/prompt", { sessionId: "unused", prompt: [{ type: "text", text: 1 }] }],
    ];
    for (const [method, params] of malformedRequests) {
        const response = await request(method, params);
        assert.equal(response.error?.code, -32602, method);
    }
    const response = await request("initialize", initializeParams);
    assert.equal(response.result.protocolVersion, 1);
});

test("bundled Zod rejects oversized constrained collections before parsing elements", async (t) => {
    const runtime = await preparePiRuntime();
    const require = createRequire(path.join(runtime, "package.json"));
    const { z } = await import(pathToFileURL(require.resolve("zod/v4")).href);
    const invalid = Array.from({ length: 512 }, (_, index) => index);
    const cases = [
        ["array max", () => z.array(z.string()).max(2), invalid, ["a"]],
        ["array length", () => z.array(z.string()).length(2), invalid, ["a", "b"]],
        ["set max", () => z.set(z.string()).max(2), new Set(invalid), new Set(["a"])],
        ["map max", () => z.map(z.string(), z.string()).max(2),
            new Map(invalid.map((value) => [value, value])), new Map([["a", "b"]])],
    ];
    for (const [name, createSchema, oversized, valid] of cases) {
        await t.test(name, () => {
            const schema = createSchema();
            const result = schema.safeParse(oversized);
            assert.equal(result.success, false);
            assert.equal(result.error.issues.length, 1);
            assert.equal(result.error.issues[0].code, "too_big");
            assert.deepEqual(schema.parse(valid), valid);
        });
    }
});
