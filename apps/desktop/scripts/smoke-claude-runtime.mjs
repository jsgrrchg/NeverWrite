import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeHostTarget, claudeRuntimePath, validateClaudeRuntime } from "./claude-runtime.mjs";

const execute = promisify(execFile);
const marker = "NEVERWRITE_CLAUDE_SMOKE";
const fixtureContent = "NeverWrite packaged Claude read this fixture.";

function smokeEnvironment(root, baseUrl) {
    // Deliberately exclude credentials, routing overrides and Node module hooks.
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
        TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
        XDG_DATA_HOME: root, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: "neverwrite-local-smoke",
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: "claude-sonnet-4-6",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    };
}

function sendMessage(response, body, content) {
    const message = { id: "msg_neverwrite_smoke", type: "message", role: "assistant",
        model: body.model, content, stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } };
    if (!body.stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(message));
        return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
        event("content_block_start", { index, content_block: block.type === "tool_use"
            ? { ...block, input: {} } : { type: "text", text: "" } });
        event("content_block_delta", { index, delta: block.type === "tool_use"
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            : { type: "text_delta", text: block.text } });
        event("content_block_stop", { index });
    });
    event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 10 } });
    event("message_stop", {});
    response.end();
}

async function createMock(fixture) {
    const state = { readRequested: false, readCompleted: false, requests: [] };
    let cancelStarted;
    const cancellationRequest = new Promise((resolve) => { cancelStarted = resolve; });
    const server = http.createServer(async (request, response) => {
        try {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const body = raw ? JSON.parse(raw) : {};
            state.requests.push(request.url);
            if (request.url.startsWith("/v1/messages/count_tokens")) {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ input_tokens: 20 }));
            } else if (request.url.startsWith("/v1/messages")) {
                if (JSON.stringify(body.messages?.at(-1)?.content).includes(`${marker}_CANCEL`)) {
                    // Keep inference pending until the client cancels the actual SDK query.
                    response.writeHead(200, { "Content-Type": "text/event-stream" });
                    response.flushHeaders();
                    cancelStarted();
                    return;
                }
                const blocks = (body.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : []);
                const result = blocks.find((block) => block.type === "tool_result" && block.tool_use_id === "neverwrite_read");
                if (result) {
                    assert.ok(!result.is_error, `Read failed: ${JSON.stringify(result)}`);
                    assert.ok(JSON.stringify(result.content).includes(fixtureContent), "Real Read did not return the fixture");
                    state.readCompleted = true;
                    sendMessage(response, body, [{ type: "text", text: `${marker} complete` }]);
                } else if (JSON.stringify(body.messages).includes(marker) && !state.readRequested) {
                    assert.ok(body.tools?.some((tool) => tool.name === "Read"), "Native CLI did not advertise Read");
                    state.readRequested = true;
                    sendMessage(response, body, [{ type: "tool_use", id: "neverwrite_read", name: "Read", input: { file_path: fixture } }]);
                } else {
                    sendMessage(response, body, [{ type: "text", text: "NeverWrite smoke session" }]);
                }
            } else {
                response.writeHead(404, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: { type: "not_found_error", message: "Unsupported smoke endpoint" } }));
            }
        } catch (error) {
            state.error = error;
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: { type: "api_error", message: error.message } }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { state, cancellationRequest, baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}

class ClaudeSmokeClient {
    constructor(nodeBinary, entry, cwd, env) {
        this.pending = new Map();
        this.notifications = [];
        this.nextId = 1;
        this.stderr = "";
        this.child = spawn(nodeBinary, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32", windowsHide: true });
        this.closed = new Promise((resolve) => this.child.once("close", resolve));
        this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-16384); });
        this.lines = readline.createInterface({ input: this.child.stdout });
        this.lines.on("line", (line) => {
            try {
                const message = JSON.parse(line);
                if (message.method && message.id !== undefined) {
                    let reply;
                    if (message.method === "session/request_permission") {
                        const option = message.params.options.find((option) => option.kind === "allow_once");
                        assert.ok(option, "Read permission must offer allow_once");
                        reply = { result: { outcome: { outcome: "selected", optionId: option.optionId } } };
                    } else {
                        reply = { error: { code: -32601, message: `Unexpected client request: ${message.method}` } };
                    }
                    this.send({ id: message.id, ...reply });
                } else if (message.method) this.notifications.push(message);
                else {
                    const pending = this.pending.get(message.id);
                    if (!pending) return;
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
                    else pending.resolve(message.result);
                }
            } catch (error) { this.fail(error); }
        });
        this.child.on("error", (error) => this.fail(error));
        this.child.on("exit", (code) => this.fail(new Error(`Claude exited: ${code}\n${this.stderr}`)));
        this.child.stdin.on("error", (error) => this.fail(error));
    }

    send(message) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Claude ${method} timed out\n${this.stderr}`));
            }, 45000);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ id, method, params });
        });
    }
    fail(error) {
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
        this.pending.clear();
    }
    async close() {
        this.fail(new Error("Smoke stopped"));
        this.lines.close();
        if (this.child.pid) {
            if (process.platform === "win32") {
                await execute("taskkill", ["/pid", String(this.child.pid), "/T", "/F"]).catch(() => {});
            } else {
                try { process.kill(-this.child.pid, "SIGKILL"); }
                catch (error) { if (error.code !== "ESRCH") throw error; }
            }
        }
        await Promise.race([this.closed, new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Claude smoke process cleanup timed out")), 5000);
            timer.unref();
        })]);
    }
}

export async function smokeClaudeRuntime({ runtimeRoot, nodeBinary, target = claudeHostTarget() }) {
    await validateClaudeRuntime(runtimeRoot, target);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "neverwrite claude smoke "));
    let mock;
    let client;
    try {
        // Copy outside the checkout so ancestor node_modules cannot mask missing dependencies.
        const isolatedRuntime = path.join(root, "runtime");
        await fs.cp(runtimeRoot, isolatedRuntime, { recursive: true, dereference: true });
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace);
        const fixture = path.join(workspace, "fixture.txt");
        await fs.writeFile(fixture, fixtureContent);
        mock = await createMock(fixture);
        const env = smokeEnvironment(root, mock.baseUrl);
        const entry = path.join(isolatedRuntime, "dist", "index.js");
        const options = { cwd: workspace, env, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 };
        assert.equal((await execute(nodeBinary, [entry, "--version"], options)).stdout.trim(), "0.75.1");
        const cliVersion = (await execute(nodeBinary, [entry, "--cli", "--version"], options)).stdout.trim();
        assert.match(cliVersion, /\d+\.\d+\.\d+/);
        client = new ClaudeSmokeClient(nodeBinary, entry, workspace, env);
        const initialized = await client.request("initialize", {
            protocolVersion: 1, clientCapabilities: {},
            clientInfo: { name: "NeverWrite Claude smoke", version: "1.0.0" },
        });
        assert.equal(initialized.protocolVersion, 1);
        const session = await client.request("session/new", { cwd: workspace, mcpServers: [] });
        assert.ok(session.sessionId);
        const result = await client.request("session/prompt", {
            sessionId: session.sessionId, prompt: [{ type: "text", text: `${marker}: read fixture.txt then finish.` }],
        });
        if (mock.state.error) throw mock.state.error;
        assert.equal(result.stopReason, "end_turn");
        assert.ok(mock.state.readRequested && mock.state.readCompleted, "Native SDK must execute Read and return its output to the API");
        const updates = client.notifications.filter((item) => item.method === "session/update").map((item) => item.params.update);
        assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed"), "ACP must publish tool completion");
        assert.ok(updates.some((update) => update.sessionUpdate === "agent_message_chunk" && update.content?.text?.includes(`${marker} complete`)), "ACP must publish the final assistant answer");
        const cancelledTurn = client.request("session/prompt", {
            sessionId: session.sessionId, prompt: [{ type: "text", text: `${marker}_CANCEL` }],
        });
        // Attach a handler immediately so an early prompt rejection cannot be unhandled.
        const cancelOutcome = cancelledTurn.then((value) => ({ value }), (error) => ({ error }));
        let waitTimer;
        try {
            await Promise.race([mock.cancellationRequest, new Promise((_, reject) => {
                waitTimer = setTimeout(() => reject(new Error("Cancellation prompt did not reach the local API")), 30000);
            }), cancelOutcome.then((outcome) => { throw outcome.error ?? new Error("Cancellation prompt ended prematurely"); })]);
            client.send({ method: "session/cancel", params: { sessionId: session.sessionId } });
            const outcome = await cancelOutcome;
            if (outcome.error) throw outcome.error;
            assert.equal(outcome.value.stopReason, "cancelled");
        } finally { clearTimeout(waitTimer); }
        console.log(`Claude ACP 0.75.1 completed a real Read turn and cancellation (${target}, CLI ${cliVersion}).`);
    } finally {
        try { if (client) await client.close(); }
        finally {
            if (mock) await mock.close();
            await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const options = { runtimeRoot: claudeRuntimePath(), nodeBinary: process.execPath };
    for (let index = 0; index < args.length; index++) {
        const key = { "--runtime": "runtimeRoot", "--node": "nodeBinary", "--target": "target" }[args[index]];
        if (!key || !args[index + 1]) throw new Error(`Unknown/incomplete argument: ${args[index]}`);
        const value = args[++index];
        options[key] = key === "target" ? value : path.resolve(value);
    }
    await smokeClaudeRuntime(options);
}
