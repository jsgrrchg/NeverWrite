import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { readPinnedClaudeVersion, parseSemver, compareSemver } from "../../../scripts/watch-claude-agent-acp-upstream.mjs";

test("watcher reads the dependency version, not the private package version", async () => {
    const manifest = JSON.parse(await fs.readFile(new URL("../runtimes/claude/package.json", import.meta.url), "utf8"));
    assert.equal(readPinnedClaudeVersion({ ...manifest, version: "9.0.0" }), "0.81.2");
    assert.equal(compareSemver(parseSemver("v0.81.2"), parseSemver(readPinnedClaudeVersion(manifest))), 0);
    assert.equal(compareSemver(parseSemver("v0.81.3"), parseSemver(readPinnedClaudeVersion(manifest))), 1);
});

test("watcher rejects floating, preview and missing runtime pins", () => {
    for (const version of [undefined, "latest", "^0.81.2", "~0.81.2", "0.81.2-preview.1", "v0.81.2"]) {
        assert.throws(() => readPinnedClaudeVersion({ dependencies: {
            "@agentclientprotocol/claude-agent-acp": version,
        } }), /exact stable/);
    }
});
