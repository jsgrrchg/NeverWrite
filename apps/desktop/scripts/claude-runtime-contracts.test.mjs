import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { claudeRuntimePath } from "./claude-runtime.mjs";

const runtimeRoot = process.env.NEVERWRITE_CLAUDE_CONTRACT_RUNTIME
    || claudeRuntimePath();
const baseline = JSON.parse(await fs.readFile(
    new URL("../runtimes/claude/baseline.json", import.meta.url), "utf8",
));
const execute = promisify(execFile);

test("runtime JavaScript matches the published dependency baseline", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(runtimeRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, baseline.version);
    for (const [relative, expected] of Object.entries(baseline.runtimeFiles)) {
        const text = await fs.readFile(path.join(runtimeRoot, relative), "utf8");
        const normalized = text.trimEnd().split(/\r?\n/).map((line) => line.trimEnd()).join("\n") + "\n";
        assert.equal(createHash("sha256").update(normalized).digest("hex"), expected, relative);
    }
});

test("shell permission titles preserve the exact command", async () => {
    const { buildClaudePermissionPresentation } = await import(
        pathToFileURL(path.join(runtimeRoot, "dist/permissions/presentation.js")).href
    );
    for (const [toolName, command] of [
        ["Bash", "  printf '%s\\n' \"a  b\" # keep spacing\\nprintf done  "],
        ["PowerShell", "  Write-Output \"a  b\" # keep spacing\\nWrite-Output done  "],
    ]) {
        const presentation = buildClaudePermissionPresentation({
            toolName,
            input: { command, description: "Model-authored summary" },
            toolUseID: `tool-${toolName}`,
        });
        assert.equal(presentation.toolCall.title, command);
        assert.equal(presentation._meta.permission.title, command);
        assert.notEqual(presentation._meta.permission.title, "Model-authored summary");
    }
});

test("compaction remains tool activity without the experimental client capability", async () => {
    const { ContextCompactionLifecycle, clientSupportsCompactionUpdates } = await import(
        pathToFileURL(path.join(runtimeRoot, "dist/context-compaction.js")).href
    );
    const capabilities = { fs: {}, elicitation: { form: {}, url: {} } };
    assert.equal(clientSupportsCompactionUpdates(capabilities), false);
    const notifications = [];
    const lifecycle = new ContextCompactionLifecycle(async (notification) => {
        notifications.push(notification);
    }, { sessionId: "legacy-session" });

    await lifecycle.start("compact-1");
    await lifecycle.heartbeat("compact-1", "Summary text");
    await lifecycle.finish("compact-1", "completed");
    await lifecycle.reset();

    assert.deepEqual(notifications.map(({ sessionId, update }) => ({
        sessionId, type: update.sessionUpdate, id: update.toolCallId, status: update.status,
    })), [
        { sessionId: "legacy-session", type: "tool_call", id: "compact-1", status: "in_progress" },
        { sessionId: "legacy-session", type: "tool_call_update", id: "compact-1", status: "in_progress" },
        { sessionId: "legacy-session", type: "tool_call_update", id: "compact-1", status: "completed" },
    ]);
    assert.equal(notifications[0].update.title, "Compact conversation");
});

test("shell output keeps the content fallback without terminal delta support", async () => {
    const { toolUpdateFromToolResult } = await import(
        pathToFileURL(path.join(runtimeRoot, "dist/tools.js")).href
    );
    const toolUse = { id: "shell-1", name: "Bash", input: { command: "printf hello" } };
    const toolResult = { tool_use_id: "shell-1", content: "hello\n" };
    assert.deepEqual(toolUpdateFromToolResult(toolResult, toolUse), {
        content: [{ type: "content", content: { type: "text", text: "```console\nhello\n```" } }],
    });
    const withTerminal = toolUpdateFromToolResult(toolResult, toolUse, true);
    assert.deepEqual(withTerminal._meta.terminal_output, {
        terminal_id: "shell-1", data: "hello\n",
    });
    assert.equal(withTerminal._meta.terminal_output_delta, undefined);
});

test("TaskList contracts execute an isolated runtime with an external timeout", async (t) => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "claude contracts "));
    t.after(() => fs.rm(isolated, { recursive: true, force: true }));
    await fs.cp(runtimeRoot, isolated, { recursive: true, dereference: true });
    const moduleUrl = pathToFileURL(path.join(isolated, "dist/tools.js")).href;
    // A parent-enforced timeout also terminates synchronous regex backtracking.
    const source = `
        import assert from 'node:assert/strict';
        const { parseTaskListOutput: parse } = await import(${JSON.stringify(moduleUrl)});
        const tasks = [{ id: '1', subject: 'Run tests', status: 'pending', blockedBy: [] }];
        assert.deepEqual(parse({ tasks }), { tasks });
        assert.deepEqual(parse(JSON.stringify({ tasks })), { tasks });
        assert.deepEqual(parse([{ type: 'text', text: JSON.stringify({ tasks }) }]), { tasks });
        assert.deepEqual(parse('#1 [pending] Run tests'), { tasks });
        assert.deepEqual(parse('No tasks found'), { tasks: [] });
        assert.equal(parse('unrelated output'), undefined);
        assert.deepEqual(parse('#2 [in_progress] Release (bot) [blocked by #1, #3]'), {
            tasks: [{ id: '2', subject: 'Release', status: 'in_progress', owner: 'bot', blockedBy: ['1', '3'] }],
        });
        for (const subject of ['Release [blocked by invalid]', 'Release (bad(owner))',
            'x'.repeat(20000) + ' [blocked by ' + '#1, '.repeat(5000) + 'x']) {
            assert.deepEqual(parse('#1 [pending] ' + subject), {
                tasks: [{ id: '1', subject, status: 'pending', blockedBy: [] }],
            });
        }
    `;
    await execute(process.execPath, ["--input-type=module", "--eval", source], {
        timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
});
