import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const executableName =
    process.platform === "win32"
        ? "neverwrite-native-backend.exe"
        : "neverwrite-native-backend";
const outputRoot =
    process.env.NEVERWRITE_ELECTRON_OUTPUT_DIR?.trim() ||
    path.join(appRoot, "dist-electron");
const distArch =
    process.env.NEVERWRITE_ELECTRON_DIST_ARCH?.trim() || process.arch;
const DEFAULT_SMOKE_TIMEOUT_MS = 15000;
const configuredSmokeTimeoutMs = Number(
    process.env.NEVERWRITE_PACKAGED_SIDECAR_SMOKE_TIMEOUT_MS,
);
const smokeTimeoutMs =
    Number.isFinite(configuredSmokeTimeoutMs) && configuredSmokeTimeoutMs > 0
        ? configuredSmokeTimeoutMs
        : DEFAULT_SMOKE_TIMEOUT_MS;

function defaultPackagedSidecarCandidates() {
    if (process.platform === "darwin") {
        const appRelativePath = path.join(
            "NeverWrite.app",
            "Contents",
            "Resources",
            "native-backend",
            executableName,
        );
        return [
            path.join(outputRoot, `mac-${distArch}`, appRelativePath),
            path.join(outputRoot, "mac", appRelativePath),
        ];
    }

    if (process.platform === "linux") {
        return [
            path.join(
                outputRoot,
                `linux-${distArch}-unpacked`,
                "resources",
                "native-backend",
                executableName,
            ),
            path.join(
                outputRoot,
                "linux-unpacked",
                "resources",
                "native-backend",
                executableName,
            ),
            path.join(outputRoot, "native-backend", executableName),
        ];
    }

    return [
        path.join(
            outputRoot,
            `win-${distArch}-unpacked`,
            "resources",
            "native-backend",
            executableName,
        ),
        path.join(
            outputRoot,
            "win-unpacked",
            "resources",
            "native-backend",
            executableName,
        ),
        path.join(outputRoot, "native-backend", executableName),
    ];
}

async function findSidecarPath() {
    if (process.env.NEVERWRITE_PACKAGED_SIDECAR_PATH) {
        return process.env.NEVERWRITE_PACKAGED_SIDECAR_PATH;
    }

    const candidates = defaultPackagedSidecarCandidates();
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Try the next electron-builder output name.
        }
    }

    throw new Error(
        `Packaged native backend sidecar was not found. Tried:\n${candidates
            .map((candidate) => `- ${candidate}`)
            .join("\n")}`,
    );
}

function assertExecutableMode(stats, executablePath, description) {
    if (process.platform === "win32") return;
    if ((stats.mode & 0o111) === 0) {
        throw new Error(`Packaged ${description} is not executable: ${executablePath}`);
    }
}

async function findCodeModeHostPath(sidecarPath) {
    const hostName =
        process.platform === "win32"
            ? "codex-code-mode-host.exe"
            : "codex-code-mode-host";
    const hostPath = path.join(path.dirname(sidecarPath), "binaries", hostName);

    let stats;
    try {
        stats = await fs.stat(hostPath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`Packaged Codex code-mode host is missing: ${hostPath}`);
        }
        throw new Error(
            `Could not inspect packaged Codex code-mode host: ${hostPath}`,
            { cause: error },
        );
    }
    if (!stats.isFile()) {
        throw new Error(`Packaged Codex code-mode host is not a file: ${hostPath}`);
    }
    assertExecutableMode(stats, hostPath, "Codex code-mode host");
    return hostPath;
}

async function findCodexAcpPath(sidecarPath) {
    const acpName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
    const acpPath = path.join(path.dirname(sidecarPath), "binaries", acpName);

    let stats;
    try {
        stats = await fs.stat(acpPath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`Packaged Codex ACP runtime is missing: ${acpPath}`);
        }
        throw new Error(`Could not inspect packaged Codex ACP runtime: ${acpPath}`, {
            cause: error,
        });
    }
    if (!stats.isFile()) {
        throw new Error(`Packaged Codex ACP runtime is not a file: ${acpPath}`);
    }
    assertExecutableMode(stats, acpPath, "Codex ACP runtime");
    return acpPath;
}

function formatSse(events) {
    return events
        .map(
            (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}

function responseCreated(id) {
    return { type: "response.created", response: { id } };
}

function responseCompleted(id) {
    return {
        type: "response.completed",
        response: {
            id,
            usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
                total_tokens: 0,
            },
        },
    };
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

async function startResponsesMock(marker) {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        try {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
            }

            if (
                request.headers.authorization !==
                "Bearer neverwrite-packaging-smoke"
            ) {
                throw new Error(
                    "Responses request did not use the configured smoke API key",
                );
            }

            const body = JSON.parse(await readRequestBody(request));
            requests.push(body);
            let events;
            if (requests.length === 1) {
                if (
                    body.model !== "test-gpt-5.1-codex" ||
                    body.stream !== true
                ) {
                    throw new Error(
                        "Initial Responses request did not use the smoke configuration",
                    );
                }
                events = [
                    responseCreated("neverwrite-smoke-response-1"),
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "custom_tool_call",
                            call_id: "neverwrite-code-mode-call",
                            name: "exec",
                            input: `text(${JSON.stringify(marker)});`,
                        },
                    },
                    responseCompleted("neverwrite-smoke-response-1"),
                ];
            } else if (requests.length === 2) {
                const toolOutput = body.input?.find(
                    (item) =>
                        item.type === "custom_tool_call_output" &&
                        item.call_id === "neverwrite-code-mode-call",
                );
                if (!JSON.stringify(toolOutput).includes(marker)) {
                    throw new Error(
                        "Code-mode output did not contain the expected marker",
                    );
                }
                events = [
                    responseCreated("neverwrite-smoke-response-2"),
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            id: "neverwrite-smoke-message",
                            // The mock only reaches this response after receiving the host's
                            // custom-tool output, so this message proves the full code-mode loop.
                            content: [{ type: "output_text", text: marker }],
                        },
                    },
                    responseCompleted("neverwrite-smoke-response-2"),
                ];
            } else {
                throw new Error(`Unexpected Responses request ${requests.length}`);
            }

            response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            });
            response.end(formatSse(events));
        } catch (error) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: String(error) }));
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Responses mock server did not expose a TCP address");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
    };
}

class AcpClient {
    constructor(executablePath, env) {
        this.child = spawn(executablePath, [], {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });
        this.nextId = 1;
        this.pending = new Map();
        this.notifications = [];
        this.stderrChunks = [];
        this.stopped = false;
        this.lines = readline.createInterface({ input: this.child.stdout });

        this.child.stderr.on("data", (chunk) =>
            this.stderrChunks.push(String(chunk)),
        );
        this.lines.on("line", (line) => this.receive(line));
        this.child.on("error", (error) => this.failPending(error));
        this.child.on("exit", (code, signal) => {
            if (!this.stopped) {
                this.failPending(
                    new Error(
                        `Packaged Codex ACP runtime exited (${code ?? signal ?? "unknown"}).${formatStderr(this.stderrChunks)}`,
                    ),
                );
            }
        });
    }

    receive(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this.failPending(
                new Error(`Invalid JSON from packaged Codex ACP runtime: ${error}`),
            );
            return;
        }

        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timeout);
            if (message.error) {
                pending.reject(
                    new Error(
                        `ACP ${pending.method} failed: ${JSON.stringify(message.error)}`,
                    ),
                );
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message.method === "session/update") {
            this.notifications.push(message.params);
        }
    }

    failPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        `Timed out waiting for ACP ${method}.${formatStderr(this.stderrChunks)}`,
                    ),
                );
            }, smokeTimeoutMs);
            this.pending.set(id, { method, resolve, reject, timeout });
            this.child.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
            );
        });
    }

    async close() {
        this.stopped = true;
        this.failPending(new Error("Packaged Codex ACP runtime was stopped"));
        this.lines.close();
        this.child.stdin.end();
        if (this.child.exitCode === null && !this.child.killed) {
            this.child.kill("SIGTERM");
        }
        if (this.child.exitCode === null) {
            await new Promise((resolve) => this.child.once("exit", resolve));
        }
    }
}

async function smokeCodexAcpCodeMode(acpPath, hostPath) {
    const marker = "neverwrite_code_mode_packaged_smoke";
    const codexHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-codex-acp-smoke-"),
    );
    const workspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-code-mode-workspace-"),
    );
    let mock;
    let client;

    try {
        mock = await startResponsesMock(marker);
        await fs.writeFile(
            path.join(codexHome, "config.toml"),
            `model = "test-gpt-5.1-codex"\nmodel_provider = "neverwrite-packaging-smoke"\nsuppress_unstable_features_warning = true\n\n[features]\ncode_mode = true\n\n[model_providers.neverwrite-packaging-smoke]\nname = "NeverWrite packaging smoke"\nbase_url = "${mock.baseUrl}"\nenv_key = "NEVERWRITE_PACKAGING_SMOKE_API_KEY"\nwire_api = "responses"\n`,
        );
        client = new AcpClient(acpPath, {
            ...process.env,
            CODEX_HOME: codexHome,
            CODEX_CODE_MODE_HOST_PATH: hostPath,
            NEVERWRITE_PACKAGING_SMOKE_API_KEY: "neverwrite-packaging-smoke",
        });

        const initialized = await client.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "NeverWrite packaging smoke", version: "0.0.0" },
        });
        if (
            initialized?.agentInfo?.name !== "codex-acp" ||
            initialized?.protocolVersion !== 1
        ) {
            throw new Error(
                `Unexpected ACP initialize response: ${JSON.stringify(initialized)}`,
            );
        }

        const session = await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        });
        const sessionId = session?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new Error(
                `ACP did not return a session ID: ${JSON.stringify(session)}`,
            );
        }

        const prompt = await client.request("session/prompt", {
            sessionId,
            prompt: [
                { type: "text", text: "Run the packaging code-mode smoke." },
            ],
        });
        if (prompt?.stopReason !== "end_turn") {
            throw new Error(
                `Code-mode prompt did not finish normally: ${JSON.stringify(prompt)}`,
            );
        }
        if (mock.requests.length !== 2) {
            throw new Error(`Expected two Responses requests, received ${mock.requests.length}`);
        }

        const sawCodeModeResult = client.notifications.some(
            (notification) =>
                notification?.update?.sessionUpdate === "agent_message_chunk" &&
                notification.update.content?.text === marker,
        );
        if (!sawCodeModeResult) {
            throw new Error("ACP did not publish the packaged code-mode result");
        }
    } finally {
        await client?.close();
        await mock?.close();
        await Promise.all([
            fs.rm(codexHome, { recursive: true, force: true }),
            fs.rm(workspace, { recursive: true, force: true }),
        ]);
    }
}

async function smokePing(sidecarPath) {
    const child = spawn(sidecarPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks = [];
    let settled = false;

    child.stderr.on("data", (chunk) => {
        stderrChunks.push(String(chunk));
    });

    return new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        const timeout = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    `Timed out waiting for sidecar ping response.${formatStderr(
                        stderrChunks,
                    )}`,
                ),
            );
        }, smokeTimeoutMs);

        function cleanup() {
            settled = true;
            clearTimeout(timeout);
            lines.close();
            child.stdin.destroy();
            if (!child.killed) child.kill("SIGTERM");
        }

        child.on("error", (error) => {
            if (settled) return;
            cleanup();
            reject(error);
        });

        child.on("exit", (code, signal) => {
            if (settled || child.killed) return;
            cleanup();
            reject(
                new Error(
                    `Sidecar exited before ping succeeded with ${
                        code ?? signal ?? "unknown status"
                    }.${formatStderr(stderrChunks)}`,
                ),
            );
        });

        lines.on("line", (line) => {
            if (settled) return;
            let message;
            try {
                message = JSON.parse(line);
            } catch (error) {
                cleanup();
                reject(new Error(`Invalid JSON response from sidecar: ${error}`));
                return;
            }

            if (message?.ok === true && message?.result?.ok === true) {
                cleanup();
                resolve();
                return;
            }

            cleanup();
            reject(new Error(`Unexpected ping response: ${line}`));
        });

        child.stdin.write('{"id":1,"command":"ping","args":{}}\n');
    });
}

function formatStderr(chunks) {
    const stderr = chunks.join("").trim();
    return stderr ? `\nStderr:\n${stderr}` : "";
}

const sidecarPath = await findSidecarPath();
const stats = await fs.stat(sidecarPath);

if (!stats.isFile()) {
    throw new Error(`Packaged sidecar path is not a file: ${sidecarPath}`);
}

assertExecutableMode(stats, sidecarPath, "sidecar");
const codexAcpPath = await findCodexAcpPath(sidecarPath);
const codeModeHostPath = await findCodeModeHostPath(sidecarPath);
await smokeCodexAcpCodeMode(codexAcpPath, codeModeHostPath);
await smokePing(sidecarPath);

console.log(`Packaged Codex ACP completed a code-mode turn: ${codexAcpPath}`);
console.log(`Packaged Codex code-mode host executed JavaScript: ${codeModeHostPath}`);
console.log(`Packaged native backend sidecar responded to ping: ${sidecarPath}`);
