import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";

import { AcpClient, runCodeModeTurn } from "./smoke-packaged-sidecar.mjs";

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
        for (const [label, executable] of [["upgrade", current], ["rollback", previous], ["re-upgrade", current]]) {
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
                const loaded = await client.request("session/load", {
                    sessionId, cwd: workspace, mcpServers: [],
                });
                assert.equal(loaded.configOptions.find((option) => option.id === "model")?.currentValue,
                    "test-gpt-5.1-codex", `${label}: explicit model changed`);
                assert(client.notifications.some((notification) =>
                    notification.update?.sessionUpdate === "agent_message_chunk" &&
                    notification.update.content?.text === marker), `${label}: assistant history was not replayed`);

                const before = mock.requests.length;
                const result = await client.request("session/prompt", {
                    sessionId, prompt: [{ type: "text", text: `Continue after ${label}.` }],
                });
                assert.equal(result.stopReason, "end_turn");
                assert.equal(mock.requests.length, before + 1,
                    `${label}: expected one continuation request`);
                await client.request("session/close", { sessionId });
                console.log(`Codex ${label}: listed, replayed, continued and closed ${sessionId}`);
            } finally {
                await client.close();
            }
        }
    },
});
