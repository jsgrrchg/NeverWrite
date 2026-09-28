import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
    applyClaudeRuntimePatches, claudeInputs, claudePackage, normalizedRuntimeHash,
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

test("Sonnet 5.5 override keeps the SDK and every native package on one version", async () => {
    const { lock } = await claudeInputs("x86_64-unknown-linux-gnu");
    const sdkName = "@anthropic-ai/claude-agent-sdk";
    const manifest = JSON.parse(await fs.readFile(new URL("../runtimes/claude/package.json", import.meta.url), "utf8"));
    assert.equal(manifest.overrides[sdkName], "0.3.284");
    const sdk = lock.packages[`node_modules/${sdkName}`];
    assert.equal(sdk.version, "0.3.284");
    const suffixes = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl",
        "linux-x64", "linux-x64-musl", "win32-arm64", "win32-x64"];
    assert.deepEqual(Object.keys(sdk.optionalDependencies).sort(), suffixes.map((suffix) => `${sdkName}-${suffix}`).sort());
    for (const [name, version] of Object.entries(sdk.optionalDependencies)) {
        assert.equal(version, sdk.version, name);
        assert.equal(lock.packages[`node_modules/${name}`]?.version, sdk.version, name);
        assert.match(lock.packages[`node_modules/${name}`]?.integrity, /^sha512-/);
    }
});

test("runtime validation rejects incomplete, stale and wrong-architecture artifacts", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-validation-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = "x86_64-unknown-linux-gnu";
    const native = requiredClaudePlatformPackages(target)[0];
    const source = "export const version = 1;\n";
    const inputs = {
        fingerprint: "expected",
        baseline: { version: "0.77.0", runtimeFiles: { "dist/index.js": normalizedRuntimeHash(source) } },
        lock: { packages: { [`node_modules/${native}`]: { version: "0.3.270", optional: true },
            "node_modules/zod": { version: "4.6.5" } } },
    };
    const write = async (relative, value) => {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, value);
    };
    await write("package.json", JSON.stringify({ name: claudePackage, version: "0.77.0" }));
    await write("dist/index.js", source);
    await write(`node_modules/${native}/package.json`, JSON.stringify({ version: "0.3.270" }));
    await write("node_modules/zod/package.json", JSON.stringify({ version: "4.6.5" }));
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
    await write("dist/index.js", "modified or corrupted");
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /baseline/);
    await write("dist/index.js", source);
    header.writeUInt16LE(183, 18);
    await write(binaryPath, header);
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /architecture/);
    await fs.rm(path.join(root, "node_modules/zod/package.json"));
    await assert.rejects(validateClaudeRuntime(root, target, inputs), /ENOENT/);
});

test("local patches require both the published input and the reviewed output hashes", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-patch-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = "export const model = 'sonnet';\n";
    const output = "export const model = 'claude-sonnet-5-5';\n";
    const file = path.join(root, "model.js");
    const inputs = {
        baseline: { runtimeFiles: { "model.js": normalizedRuntimeHash(source) },
            patchedRuntimeFiles: { "model.js": normalizedRuntimeHash(output) } },
        patches: [{ file: "model.js", before: ["'sonnet'"], after: ["'claude-sonnet-5-5'"] }],
    };
    await fs.writeFile(file, source);
    await applyClaudeRuntimePatches(root, inputs);
    assert.equal(await fs.readFile(file, "utf8"), output);
    await assert.rejects(applyClaudeRuntimePatches(root, inputs), /source.*baseline/);
    await fs.writeFile(file, source);
    inputs.patches[0].after = ["'unexpected'"];
    await assert.rejects(applyClaudeRuntimePatches(root, inputs), /output.*baseline/);
    assert.equal(await fs.readFile(file, "utf8"), source);
    inputs.patches[0].before = ["missing"];
    await assert.rejects(applyClaudeRuntimePatches(root, inputs), /exactly once/);
    // Packaged validation accepts only the reviewed patched hash, never the original.
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: claudePackage, version: "0.83.0" }));
    inputs.baseline.version = "0.83.0";
    inputs.lock = { packages: {} };
    await assert.rejects(validateClaudeRuntime(root, "x86_64-unknown-linux-gnu", inputs), /baseline/);
});

test("an incomplete explicit override fails instead of selecting the cached runtime", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-override-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(resolveClaudeRuntimeSource("x86_64-unknown-linux-gnu", {
        configuredSource: root,
    }), /ENOENT/);
});
