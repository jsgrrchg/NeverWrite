import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
    createCodexRuntimeBundlePlan,
    executableNameForTarget,
    validateCodexRuntimeBundleInputs,
} from "./stage-electron-sidecar-helpers.mjs";

const workspaceRoot = path.resolve("/workspace");

function existingPaths(...paths) {
    const existing = new Set(paths);
    return async (filePath) => existing.has(filePath);
}

test("derives runtime binary names from the target platform", () => {
    assert.equal(
        executableNameForTarget("codex-acp", "aarch64-apple-darwin"),
        "codex-acp",
    );
    assert.equal(
        executableNameForTarget(
            "codex-code-mode-host",
            "x86_64-pc-windows-msvc",
        ),
        "codex-code-mode-host.exe",
    );
});

test("uses paired target-specific overrides without scheduling a build", () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-apple-darwin",
        workspaceRoot,
        env: {
            NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64: "/inputs/codex-acp",
            NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64:
                "/inputs/codex-code-mode-host",
        },
    });

    assert.deepEqual(plan.buildTargets, []);
    assert.deepEqual(
        plan.binaries.map((binary) => binary.inputPaths[0]),
        ["/inputs/codex-acp", "/inputs/codex-code-mode-host"],
    );
});

test("uses paired Windows overrides with executable names", () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "x86_64-pc-windows-msvc",
        workspaceRoot,
        env: {
            NEVERWRITE_CODEX_ACP_BUNDLE_BIN_X64: "/inputs/codex-acp.exe",
            NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_X64:
                "/inputs/codex-code-mode-host.exe",
        },
    });

    assert.deepEqual(plan.buildTargets, []);
    assert.deepEqual(
        plan.binaries.map((binary) => binary.outputName),
        ["codex-acp.exe", "codex-code-mode-host.exe"],
    );
    assert.deepEqual(
        plan.binaries.map((binary) => binary.inputPaths[0]),
        ["/inputs/codex-acp.exe", "/inputs/codex-code-mode-host.exe"],
    );
});

test("uses paired generic overrides without scheduling a build", () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-unknown-linux-gnu",
        workspaceRoot,
        env: {
            NEVERWRITE_CODEX_ACP_BUNDLE_BIN: "/inputs/codex-acp",
            NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN:
                "/inputs/codex-code-mode-host",
        },
    });

    assert.deepEqual(plan.buildTargets, []);
    assert.deepEqual(
        plan.binaries.map((binary) => binary.inputPaths[0]),
        ["/inputs/codex-acp", "/inputs/codex-code-mode-host"],
    );
});

test("rejects mixing generic and target-specific runtime overrides", () => {
    assert.throws(
        () =>
            createCodexRuntimeBundlePlan({
                targetTriple: "aarch64-apple-darwin",
                workspaceRoot,
                env: {
                    NEVERWRITE_CODEX_ACP_BUNDLE_BIN: "/inputs/codex-acp",
                    NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN:
                        "/inputs/codex-code-mode-host",
                    NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64:
                        "/arm64/codex-acp",
                    NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64:
                        "/arm64/codex-code-mode-host",
                },
            }),
        /cannot mix target-specific and generic bundle paths/,
    );
});

test("rejects a bundle missing only the code-mode host", async () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-apple-darwin",
        workspaceRoot,
        env: {},
        skipBuild: true,
    });
    const acpPath = plan.binaries.find(
        (binary) => binary.baseName === "codex-acp",
    ).inputPaths[0];

    await assert.rejects(
        validateCodexRuntimeBundleInputs(plan, existingPaths(acpPath)),
        /Codex code-mode host binary was not found/,
    );
});

test("rejects a bundle missing only the ACP binary", async () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-apple-darwin",
        workspaceRoot,
        env: {},
        skipBuild: true,
    });
    const hostPath = plan.binaries.find(
        (binary) => binary.baseName === "codex-code-mode-host",
    ).inputPaths[0];

    await assert.rejects(
        validateCodexRuntimeBundleInputs(plan, existingPaths(hostPath)),
        /Codex ACP binary was not found/,
    );
});

test("does not reuse an arm64 host override for an x64 target", () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "x86_64-apple-darwin",
        workspaceRoot,
        env: {
            NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64:
                "/inputs/codex-code-mode-host",
        },
    });

    assert.deepEqual(plan.buildTargets, ["x86_64-apple-darwin"]);
    assert.match(
        plan.binaries.find(
            (binary) => binary.baseName === "codex-code-mode-host",
        ).inputPaths[0],
        /x86_64-apple-darwin/,
    );
});

test("universal staging requires four inputs and produces two outputs", async () => {
    const env = {
        NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64: "/arm64/codex-acp",
        NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64:
            "/arm64/codex-code-mode-host",
        NEVERWRITE_CODEX_ACP_BUNDLE_BIN_X64: "/x64/codex-acp",
        NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_X64:
            "/x64/codex-code-mode-host",
    };
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "universal-apple-darwin",
        workspaceRoot,
        env,
    });

    assert.deepEqual(plan.buildTargets, []);
    assert.equal(plan.binaries.length, 2);
    assert.deepEqual(
        plan.binaries.map((binary) => binary.inputPaths.length),
        [2, 2],
    );
    await validateCodexRuntimeBundleInputs(
        plan,
        existingPaths(...Object.values(env)),
    );
});

test("universal staging rejects a missing component slice", () => {
    assert.throws(
        () =>
            createCodexRuntimeBundlePlan({
                targetTriple: "universal-apple-darwin",
                workspaceRoot,
                env: {
                    NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64: "/arm64/codex-acp",
                },
            }),
        /must cover both binaries/,
    );
});

test("universal staging rejects one missing binary input", async () => {
    const env = {
        NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64: "/arm64/codex-acp",
        NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64:
            "/arm64/codex-code-mode-host",
        NEVERWRITE_CODEX_ACP_BUNDLE_BIN_X64: "/x64/codex-acp",
        NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_X64:
            "/x64/codex-code-mode-host",
    };
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "universal-apple-darwin",
        workspaceRoot,
        env,
    });

    await assert.rejects(
        validateCodexRuntimeBundleInputs(
            plan,
            existingPaths(
                env.NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64,
                env.NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64,
                env.NEVERWRITE_CODEX_ACP_BUNDLE_BIN_X64,
            ),
        ),
        /Codex code-mode host binary was not found.*x64/,
    );
});
