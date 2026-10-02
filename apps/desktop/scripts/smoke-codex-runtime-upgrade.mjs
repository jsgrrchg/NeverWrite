import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { AcpClient, runCodeModeTurn, smokeMissingCodeModeHostFailsClosed } from "./smoke-packaged-sidecar.mjs";

// Use independently built runtime pairs. All state and requests stay in the
// temporary CODEX_HOME and loopback Responses mock owned by runCodeModeTurn.
const { values } = parseArgs({
    options: {
        previous: { type: "string" },
        current: { type: "string" },
    },
});

assert(values.previous && values.current,
    "Usage: node scripts/smoke-codex-runtime-upgrade.mjs --previous <codex-acp> --current <codex-acp>");
const previous = path.resolve(values.previous);
const current = path.resolve(values.current);
assert.notEqual(previous, current, "Supply two separately built runtime versions");
const hostName = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";

await runCodeModeTurn({
    acpPath: previous,
    hostPath: path.join(path.dirname(previous), hostName),
    marker: "neverwrite_runtime_upgrade_history",
    expectedToolOutput: (output) => output.includes("neverwrite_runtime_upgrade_history"),
    requireStandaloneHost: true,
    async afterTurn({ codexHome, workspace, sessionId, marker, mock }) {
        // Exercise upgrade, rollback, then upgrade again against the same data.
        for (const [transition, executable] of [["upgrade", current], ["rollback", previous], ["re-upgrade", current]]) {
            for (const restoreMethod of ["load", "resume"]) {
                const label = `${transition}/${restoreMethod}`;
                const client = new AcpClient(executable, {
                    ...process.env,
                    CODEX_HOME: codexHome,
                    NEVERWRITE_PACKAGING_SMOKE_API_KEY: "neverwrite-packaging-smoke",
                });
                try {
                    const initialized = await client.request("initialize", {
                        protocolVersion: 1,
                        clientCapabilities: {},
                        clientInfo: { name: "NeverWrite runtime upgrade smoke", version: "0.0.0" },
                    });
                    assert.equal(initialized.protocolVersion, 1);
                    const listed = await client.request("session/list", { cwd: workspace });
                    assert(listed.sessions.some((session) => session.sessionId === sessionId),
                        `${label}: saved session disappeared from listing`);
                    const loaded = await client.request(`session/${restoreMethod}`, {
                        sessionId, cwd: workspace, mcpServers: [],
                    });
                    assert.equal(loaded.configOptions.find((option) => option.id === "model")?.currentValue,
                        "test-gpt-5.1-codex", `${label}: explicit model changed`);
                    const replayed = client.notifications.some((notification) =>
                        notification.update?.sessionUpdate === "agent_message_chunk" &&
                        notification.update.content?.text === marker);
                    assert.equal(replayed, restoreMethod === "load",
                        `${label}: load must replay history and resume must avoid duplicate messages`);

                    const before = mock.requests.length;
                    const result = await client.request("session/prompt", {
                        sessionId, prompt: [{ type: "text", text: `Continue after ${label}.` }],
                    });
                    assert.equal(result.stopReason, "end_turn");
                    assert.equal(mock.requests.length, before + 1,
                        `${label}: expected one continuation request`);
                    await client.request("session/close", { sessionId });
                    console.log(`Codex ${label}: listed, restored, continued and closed ${sessionId}`);
                } finally {
                    await client.close();
                }
            }
        }

        // Seed a separate paginated fixture; do not reuse SQLite projections or
        // change the legacy state used to verify rollback above.
        const paginatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "neverwrite-paginated-history-"));
        try {
            await fs.copyFile(path.join(codexHome, "config.toml"), path.join(paginatedHome, "config.toml"));
            const sessionsRoot = path.join(codexHome, "sessions");
            const files = await fs.readdir(sessionsRoot, { recursive: true });
            const rolloutName = files.find((name) => name.endsWith(`${sessionId}.jsonl`));
            assert(rolloutName, "saved smoke rollout must exist");
            const lines = (await fs.readFile(path.join(sessionsRoot, rolloutName), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line));
            lines[0].payload.history_mode = "paginated";
            const messageIndex = lines.findIndex((line) =>
                line.type === "event_msg" && line.payload.type === "agent_message");
            const turnStarted = lines.find((line) => line.type === "event_msg" && line.payload.type === "task_started");
            assert(messageIndex >= 0 && turnStarted, "seed requires a completed conversation");
            const template = {
                timestamp: lines[messageIndex].timestamp,
                type: "event_msg",
                payload: {
                    type: "item_completed", thread_id: sessionId, turn_id: turnStarted.payload.turn_id,
                    item: { type: "AgentMessage" }, started_at_ms: 1000, completed_at_ms: 2000,
                },
            };
            const displayItems = Array.from({ length: 105 }, (_, index) => {
                const line = structuredClone(template);
                line.payload.item.id = `paginated-fixture-${index}`;
                line.payload.item.content = [{ type: "Text", text: `paginated display ${index}` }];
                return line;
            });
            lines.splice(messageIndex, 0, ...displayItems);
            lines.forEach((line, ordinal) => { line.ordinal = ordinal; });
            const fixturePath = path.join(paginatedHome, "sessions", rolloutName);
            await fs.mkdir(path.dirname(fixturePath), { recursive: true });
            await fs.writeFile(fixturePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

            for (const restoreMethod of ["load", "resume"]) {
                const client = new AcpClient(current, {
                    ...process.env,
                    CODEX_HOME: paginatedHome,
                    NEVERWRITE_PACKAGING_SMOKE_API_KEY: "neverwrite-packaging-smoke",
                });
                try {
                    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
                    await client.request(`session/${restoreMethod}`, { sessionId, cwd: workspace, mcpServers: [] });
                    const displayMessages = client.notifications
                        .filter((notification) => notification.update?.sessionUpdate === "agent_message_chunk")
                        .map((notification) => notification.update.content?.text)
                        .filter((text) => text?.startsWith("paginated display "));
                    assert.equal(displayMessages.length, restoreMethod === "load" ? 105 : 0,
                        `paginated/${restoreMethod}: replay must cross page boundaries exactly once`);
                    assert.equal(new Set(displayMessages).size, displayMessages.length);
                    const before = mock.requests.length;
                    const result = await client.request("session/prompt", {
                        sessionId, prompt: [{ type: "text", text: `Continue paginated ${restoreMethod}.` }],
                    });
                    assert.equal(result.stopReason, "end_turn");
                    assert.equal(mock.requests.length, before + 1);
                    await client.request("session/close", { sessionId });
                    console.log(`Codex paginated/${restoreMethod}: restored, continued and closed ${sessionId}`);
                } finally {
                    await client.close();
                }
            }
        } finally {
            await fs.rm(paginatedHome, { recursive: true, force: true });
        }
    },
});

await smokeMissingCodeModeHostFailsClosed(current, path.join(path.dirname(current), hostName));
console.log("Codex current runtime failed closed without its matching code-mode host.");
