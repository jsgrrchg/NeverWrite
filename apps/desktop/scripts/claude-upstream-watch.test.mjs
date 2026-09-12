import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { readPinnedClaudeVersion, parseSemver, compareSemver } from "../../../scripts/watch-claude-agent-acp-upstream.mjs";

test("watcher reads the dependency version, not the private package version", async () => {
    const manifest = JSON.parse(await fs.readFile(new URL("../runtimes/claude/package.json", import.meta.url), "utf8"));
    assert.equal(readPinnedClaudeVersion({ ...manifest, version: "9.0.0" }), "0.75.1");
    assert.equal(compareSemver(parseSemver("v0.76.0"), parseSemver(readPinnedClaudeVersion(manifest))), 1);
});

test("watcher rejects floating, preview and missing runtime pins", () => {
    for (const version of [undefined, "latest", "^0.75.1", "~0.75.1", "0.75.1-preview.1", "v0.75.1"]) {
        assert.throws(() => readPinnedClaudeVersion({ dependencies: {
            "@agentclientprotocol/claude-agent-acp": version,
        } }), /exact stable/);
    }
});
