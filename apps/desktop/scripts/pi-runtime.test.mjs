import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

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

test("bundled Pi ACP initializes as protocol v1 and advertises session load", async (t) => {
    const runtime = await preparePiRuntime();
    const child = spawn(process.execPath, [path.join(runtime, "dist", "index.js")], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill());

    const response = await new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        const timer = setTimeout(() => reject(new Error("Pi ACP initialize timed out")), 5_000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            reject(new Error(`Pi ACP exited before initialize (${code ?? signal})`));
        });
        lines.once("line", (line) => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(line));
            } catch (error) {
                reject(error);
            }
        });
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "neverwrite-test", version: "0" },
            },
        })}\n`);
    });

    assert.equal(response.result.protocolVersion, 1);
    assert.equal(response.result.agentInfo.name, "pi-acp");
    assert.equal(response.result.agentInfo.version, (await piInputs()).version);
    assert.equal(response.result.agentCapabilities.loadSession, true);
});
