import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
    createCodexRuntimeBundlePlan,
    detectExecutableArchitecture,
    executableNameForTarget,
    universalMacLipoVerifyArgs,
    validateCodexRuntimeBundleArchitectures,
    validateCodexRuntimeBundleInputs,
    validateCodexRuntimeSourceAlignment,
} from "./stage-electron-sidecar-helpers.mjs";

const workspaceRoot = path.resolve("/workspace");
const checkedInWorkspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
);

function existingPaths(...paths) {
    const existing = new Set(paths);
    return async (filePath) => existing.has(filePath);
}

function machoHeader(cpuType) {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpuType, 4);
    return header;
}

function elfHeader(machine) {
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    header.writeUInt16LE(machine, 18);
    return header;
}

function peHeader(machine) {
    const header = Buffer.alloc(256);
    header.set([0x4d, 0x5a], 0);
    header.writeUInt32LE(128, 0x3c);
    header.writeUInt32LE(0x00004550, 128);
    header.writeUInt16LE(machine, 132);
    return header;
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

test("keeps runtime, PTY, lock commit, and V8 on one checked-in baseline", async () => {
    const adapterRoot = path.join(
        checkedInWorkspaceRoot,
        "vendor",
        "codex-acp",
    );
    await assert.doesNotReject(async () =>
        validateCodexRuntimeSourceAlignment({
            adapterManifest: await fs.readFile(
                path.join(adapterRoot, "Cargo.toml"),
                "utf8",
            ),
            lockfile: await fs.readFile(
                path.join(adapterRoot, "Cargo.lock"),
                "utf8",
            ),
            ptyManifest: await fs.readFile(
                path.join(
                    adapterRoot,
                    "vendor",
                    "codex-utils-pty",
                    "Cargo.toml",
                ),
                "utf8",
            ),
        }),
    );
});

test("rejects a mixed runtime source baseline before staging", () => {
    assert.throws(
        () =>
            validateCodexRuntimeSourceAlignment({
                adapterManifest:
                    '[dependencies]\ncodex-core = { tag = "rust-v0.149.0" }',
                lockfile: "",
                ptyManifest: '[package]\nversion = "0.150.0"',
            }),
        /must all use tag = "rust-v0\.150\.0"/,
    );
});

test("places the universal input before the lipo verification command", () => {
    assert.deepEqual(universalMacLipoVerifyArgs("/build/runtime"), [
        "/build/runtime",
        "-verify_arch",
        "arm64",
        "x86_64",
    ]);
});

test("detects the supported executable architectures", () => {
    assert.equal(detectExecutableArchitecture(machoHeader(0x0100000c)), "arm64");
    assert.equal(detectExecutableArchitecture(machoHeader(0x01000007)), "x86_64");
    assert.equal(detectExecutableArchitecture(elfHeader(183)), "arm64");
    assert.equal(detectExecutableArchitecture(elfHeader(62)), "x86_64");
    assert.equal(detectExecutableArchitecture(peHeader(0xaa64)), "arm64");
    assert.equal(detectExecutableArchitecture(peHeader(0x8664)), "x86_64");
    assert.equal(detectExecutableArchitecture(Buffer.alloc(64)), null);
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
    const headers = new Map([
        [env.NEVERWRITE_CODEX_ACP_BUNDLE_BIN_ARM64, machoHeader(0x0100000c)],
        [env.NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_ARM64, machoHeader(0x0100000c)],
        [env.NEVERWRITE_CODEX_ACP_BUNDLE_BIN_X64, machoHeader(0x01000007)],
        [env.NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN_X64, machoHeader(0x01000007)],
    ]);
    await validateCodexRuntimeBundleArchitectures(
        plan,
        "universal-apple-darwin",
        async (filePath) => headers.get(filePath),
    );
});

test("rejects a runner binary reused for a cross-compiled target", async () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-unknown-linux-gnu",
        workspaceRoot,
        env: {},
        skipBuild: true,
    });

    await assert.rejects(
        validateCodexRuntimeBundleArchitectures(
            plan,
            "aarch64-unknown-linux-gnu",
            async () => elfHeader(62),
        ),
        /expected arm64, detected x86_64/,
    );
});

test("validates both Windows runtime executables for the requested target", async () => {
    const plan = createCodexRuntimeBundlePlan({
        targetTriple: "aarch64-pc-windows-msvc",
        workspaceRoot,
        env: {},
        skipBuild: true,
    });

    await assert.doesNotReject(() =>
        validateCodexRuntimeBundleArchitectures(
            plan,
            "aarch64-pc-windows-msvc",
            async () => peHeader(0xaa64),
        ),
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
