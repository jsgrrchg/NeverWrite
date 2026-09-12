import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
    applyClaudePatch, claudeInputs, claudePackage, normalizedRuntimeHash,
    requiredClaudePlatformPackages, resolveClaudeRuntimeSource, validateClaudeRuntime,
} from "./claude-runtime.mjs";

test("isolated lock retains every baseline production version and integrity", async () => {
    const { lock, baseline } = await claudeInputs("x86_64-unknown-linux-gnu");
    for (const [name, expected] of Object.entries(baseline.productionPackages)) {
        assert.equal(lock.packages[name]?.version, expected.version, name);
        assert.equal(lock.packages[name]?.integrity, expected.integrity, name);
    }
    assert.deepEqual(Object.keys(lock.packages).sort(), ["", `node_modules/${claudePackage}`,
        ...Object.keys(baseline.productionPackages)].sort());
    assert.equal(lock.packages[""].dependencies[claudePackage], baseline.version);
});

test("each release target explicitly selects its native packages", () => {
    assert.deepEqual(requiredClaudePlatformPackages("universal-apple-darwin"), [
        "@anthropic-ai/claude-agent-sdk-darwin-arm64", "@anthropic-ai/claude-agent-sdk-darwin-x64",
    ]);
    for (const [target, suffix] of [
        ["aarch64-apple-darwin", "darwin-arm64"], ["x86_64-apple-darwin", "darwin-x64"],
        ["aarch64-pc-windows-msvc", "win32-arm64"], ["x86_64-pc-windows-msvc", "win32-x64"],
        ["aarch64-unknown-linux-gnu", "linux-arm64"], ["x86_64-unknown-linux-gnu", "linux-x64"],
    ]) assert.deepEqual(requiredClaudePlatformPackages(target), [`@anthropic-ai/claude-agent-sdk-${suffix}`]);
    assert.throws(() => requiredClaudePlatformPackages("unknown"), /Unsupported/);
});

test("runtime validation rejects incomplete, stale and wrong-architecture artifacts", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-validation-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = "x86_64-unknown-linux-gnu";
    const native = requiredClaudePlatformPackages(target)[0];
    const source = "export const version = 1;\n";
    const inputs = {
        fingerprint: "expected",
        baseline: { version: "0.75.1", runtimeFiles: { "dist/index.js": normalizedRuntimeHash(source) } },
        lock: { packages: { [`node_modules/${native}`]: { version: "0.3.257", optional: true },
            "node_modules/zod": { version: "4.5.4" } } },
    };
    const write = async (relative, value) => {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, value);
    };
    await write("package.json", JSON.stringify({ name: claudePackage, version: "0.75.1" }));
    await write("dist/index.js", source);
    await write(`node_modules/${native}/package.json`, JSON.stringify({ version: "0.3.257" }));
    await write("node_modules/zod/package.json", JSON.stringify({ version: "4.5.4" }));
    const binaryPath = `node_modules/${native}/claude`;
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(62, 18);
    await write(binaryPath, header);
    await fs.chmod(path.join(root, binaryPath), 0o755);
    await write(".neverwrite-runtime.json", JSON.stringify({ target, fingerprint: "expected" }));
    await validateClaudeRuntime(root, target, inputs, { requireStamp: true });
    await write(".neverwrite-runtime.json", JSON.stringify({ target: "aarch64-unknown-linux-gnu", fingerprint: "expected" }));
    await assert.rejects(validateClaudeRuntime(root, target, inputs, { requireStamp: true }), /wrong-target/);
    await write(".neverwrite-runtime.json", JSON.stringify({ target, fingerprint: "old" }));
    await assert.rejects(validateClaudeRuntime(root, target, inputs, { requireStamp: true }), /Stale/);
    await write("dist/index.js", "unpatched or corrupted");
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /baseline/);
    await write("dist/index.js", source);
    header.writeUInt16LE(183, 18);
    await write(binaryPath, header);
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /architecture/);
    await fs.rm(path.join(root, "node_modules/zod/package.json"));
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /ENOENT/);
});

test("patch rejects a mismatched published input before running patch-package", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-patch-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const packageRoot = path.join(root, "node_modules", claudePackage);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const { checksums } = await claudeInputs("x86_64-unknown-linux-gnu");
    await assert.rejects(applyClaudePatch(root, checksums), /exact, unmodified/);
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: checksums.version }));
    await fs.mkdir(path.join(packageRoot, "dist"));
    await fs.writeFile(path.join(packageRoot, "dist/tools.js"), "unexpected published content");
    await assert.rejects(applyClaudePatch(root, checksums), /exact, unmodified/);
});

test("an incomplete explicit override fails instead of selecting the cached runtime", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-override-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(resolveClaudeRuntimeSource("x86_64-unknown-linux-gnu", {
        configuredSource: root,
    }), /ENOENT/);
});
