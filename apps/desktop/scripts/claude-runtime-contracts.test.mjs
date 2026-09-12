import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = process.env.NEVERWRITE_CLAUDE_CONTRACT_RUNTIME
    || path.resolve(appRoot, "../../vendor/Claude-agent-acp-upstream");
const baseline = JSON.parse(await fs.readFile(
    new URL("../runtimes/claude/baseline.json", import.meta.url), "utf8",
));
const execute = promisify(execFile);

test("runtime JavaScript matches the patched 0.75.1 baseline", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(runtimeRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, baseline.version);
    for (const [relative, expected] of Object.entries(baseline.runtimeFiles)) {
        const text = await fs.readFile(path.join(runtimeRoot, relative), "utf8");
        const normalized = text.trimEnd().split(/\r?\n/).map((line) => line.trimEnd()).join("\n") + "\n";
        assert.equal(createHash("sha256").update(normalized).digest("hex"), expected, relative);
    }
});

test("TaskList contracts execute the runtime parser with an external timeout", async () => {
    const moduleUrl = pathToFileURL(path.join(runtimeRoot, "dist/tools.js")).href;
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
