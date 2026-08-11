import path from "node:path";

export const MAC_UNIVERSAL_TARGET = "universal-apple-darwin";
export const MAC_UNIVERSAL_COMPONENT_TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
];

const TARGET_EXECUTABLE_ARCHITECTURES = new Map([
    ["aarch64-apple-darwin", "arm64"],
    ["x86_64-apple-darwin", "x86_64"],
    ["aarch64-pc-windows-msvc", "arm64"],
    ["x86_64-pc-windows-msvc", "x86_64"],
    ["aarch64-unknown-linux-gnu", "arm64"],
    ["x86_64-unknown-linux-gnu", "x86_64"],
]);

const MACHO_CPU_ARCHITECTURES = new Map([
    [0x01000007, "x86_64"],
    [0x0100000c, "arm64"],
]);

const ELF_MACHINE_ARCHITECTURES = new Map([
    [62, "x86_64"],
    [183, "arm64"],
]);

const PE_MACHINE_ARCHITECTURES = new Map([
    [0x8664, "x86_64"],
    [0xaa64, "arm64"],
]);

export const CODEX_RUNTIME_COMPONENTS = [
    {
        baseName: "codex-acp",
        description: "Codex ACP",
        baseEnvKey: "NEVERWRITE_CODEX_ACP_BUNDLE_BIN",
    },
    {
        baseName: "codex-code-mode-host",
        description: "Codex code-mode host",
        baseEnvKey: "NEVERWRITE_CODEX_CODE_MODE_HOST_BUNDLE_BIN",
    },
];

export function executableNameForTarget(baseName, targetTriple) {
    return targetTriple.includes("windows") ? `${baseName}.exe` : baseName;
}

export function universalMacLipoVerifyArgs(filePath) {
    return [filePath, "-verify_arch", "arm64", "x86_64"];
}

export function detectExecutableArchitecture(header) {
    if (!Buffer.isBuffer(header) || header.length < 20) {
        return null;
    }

    const littleEndianMagic = header.readUInt32LE(0);
    const bigEndianMagic = header.readUInt32BE(0);
    const machoMagic = new Set([0xfeedface, 0xfeedfacf]);
    if (
        machoMagic.has(littleEndianMagic) ||
        machoMagic.has(bigEndianMagic)
    ) {
        const cpuType = machoMagic.has(littleEndianMagic)
            ? header.readUInt32LE(4)
            : header.readUInt32BE(4);
        return MACHO_CPU_ARCHITECTURES.get(cpuType) ?? null;
    }

    if (
        header[0] === 0x7f &&
        header[1] === 0x45 &&
        header[2] === 0x4c &&
        header[3] === 0x46
    ) {
        const machine =
            header[5] === 2
                ? header.readUInt16BE(18)
                : header.readUInt16LE(18);
        return ELF_MACHINE_ARCHITECTURES.get(machine) ?? null;
    }

    if (header[0] === 0x4d && header[1] === 0x5a && header.length >= 64) {
        const peOffset = header.readUInt32LE(0x3c);
        if (
            peOffset + 6 <= header.length &&
            header.readUInt32LE(peOffset) === 0x00004550
        ) {
            return (
                PE_MACHINE_ARCHITECTURES.get(
                    header.readUInt16LE(peOffset + 4),
                ) ?? null
            );
        }
    }

    return null;
}

export function envSuffixForTarget(targetTriple) {
    if (targetTriple === "aarch64-apple-darwin") return "ARM64";
    if (targetTriple === "x86_64-apple-darwin") return "X64";
    if (targetTriple === "aarch64-pc-windows-msvc") return "ARM64";
    if (targetTriple === "x86_64-pc-windows-msvc") return "X64";
    if (targetTriple === "aarch64-unknown-linux-gnu") return "ARM64";
    if (targetTriple === "x86_64-unknown-linux-gnu") return "X64";
    throw new Error(
        `Unsupported target for environment suffix: ${targetTriple}`,
    );
}

export function targetSpecificEnvKey(baseEnvKey, targetTriple) {
    return `${baseEnvKey}_${envSuffixForTarget(targetTriple)}`;
}

export function codexRuntimePathForTarget(
    workspaceRoot,
    baseName,
    targetTriple,
) {
    return path.join(
        workspaceRoot,
        "vendor",
        "codex-acp",
        "target",
        targetTriple,
        "release",
        executableNameForTarget(baseName, targetTriple),
    );
}

function configuredValue(env, envKey) {
    return env[envKey]?.trim() || null;
}

function assertExpectedBinaryName(filePath, component, targetTriple, envKey) {
    const expectedName = executableNameForTarget(
        component.baseName,
        targetTriple,
    );
    if (path.basename(filePath) !== expectedName) {
        throw new Error(
            `${component.description} override from ${envKey} must point to ${expectedName}: ${filePath}`,
        );
    }
}

function pairedOverridesForTarget(env, targetTriple) {
    const overrides = CODEX_RUNTIME_COMPONENTS.map((component) => {
        const envKey = targetSpecificEnvKey(component.baseEnvKey, targetTriple);
        return {
            component,
            envKey,
            value: configuredValue(env, envKey),
        };
    });
    const configured = overrides.filter((override) => override.value);
    if (configured.length > 0 && configured.length !== overrides.length) {
        const missing = overrides
            .filter((override) => !override.value)
            .map((override) => override.envKey)
            .join(", ");
        throw new Error(
            `Codex runtime overrides for ${targetTriple} must cover both binaries; missing: ${missing}`,
        );
    }
    for (const override of configured) {
        assertExpectedBinaryName(
            override.value,
            override.component,
            targetTriple,
            override.envKey,
        );
    }
    return overrides;
}

function genericOverrides(env, targetTriple) {
    const overrides = CODEX_RUNTIME_COMPONENTS.map((component) => ({
        component,
        envKey: component.baseEnvKey,
        value: configuredValue(env, component.baseEnvKey),
    }));
    const configured = overrides.filter((override) => override.value);
    if (configured.length > 0 && configured.length !== overrides.length) {
        const missing = overrides
            .filter((override) => !override.value)
            .map((override) => override.envKey)
            .join(", ");
        throw new Error(
            `Codex runtime overrides must cover both binaries; missing: ${missing}`,
        );
    }
    for (const override of configured) {
        assertExpectedBinaryName(
            override.value,
            override.component,
            targetTriple,
            override.envKey,
        );
    }
    return overrides;
}

function binaryPlan(component, targetTriple, inputPaths) {
    return {
        ...component,
        outputName: executableNameForTarget(component.baseName, targetTriple),
        inputPaths,
    };
}

export function createCodexRuntimeBundlePlan({
    targetTriple,
    workspaceRoot,
    env = process.env,
    skipBuild = false,
}) {
    if (targetTriple === MAC_UNIVERSAL_TARGET) {
        const generic = genericOverrides(env, targetTriple);
        if (generic.every((override) => override.value)) {
            return {
                buildTargets: [],
                binaries: generic.map((override) =>
                    binaryPlan(override.component, targetTriple, [
                        override.value,
                    ]),
                ),
            };
        }

        const inputPathsByComponent = new Map(
            CODEX_RUNTIME_COMPONENTS.map((component) => [
                component.baseName,
                [],
            ]),
        );
        const buildTargets = [];
        for (const componentTarget of MAC_UNIVERSAL_COMPONENT_TARGETS) {
            const overrides = pairedOverridesForTarget(env, componentTarget);
            const hasOverrides = overrides.every((override) => override.value);
            if (!hasOverrides && !skipBuild) {
                buildTargets.push(componentTarget);
            }
            for (const override of overrides) {
                inputPathsByComponent
                    .get(override.component.baseName)
                    .push(
                        override.value ||
                            codexRuntimePathForTarget(
                                workspaceRoot,
                                override.component.baseName,
                                componentTarget,
                            ),
                    );
            }
        }

        return {
            buildTargets,
            binaries: CODEX_RUNTIME_COMPONENTS.map((component) =>
                binaryPlan(
                    component,
                    targetTriple,
                    inputPathsByComponent.get(component.baseName),
                ),
            ),
        };
    }

    const specific = pairedOverridesForTarget(env, targetTriple);
    const hasSpecificOverrides = specific.every((override) => override.value);
    const generic = genericOverrides(env, targetTriple);
    const hasGenericOverrides = generic.every((override) => override.value);
    if (hasSpecificOverrides && hasGenericOverrides) {
        throw new Error(
            `Codex runtime overrides for ${targetTriple} cannot mix target-specific and generic bundle paths`,
        );
    }

    const selectedOverrides = hasSpecificOverrides
        ? specific
        : hasGenericOverrides
          ? generic
          : null;
    return {
        buildTargets: selectedOverrides || skipBuild ? [] : [targetTriple],
        binaries: CODEX_RUNTIME_COMPONENTS.map((component) => {
            const override = selectedOverrides?.find(
                (candidate) =>
                    candidate.component.baseName === component.baseName,
            );
            return binaryPlan(component, targetTriple, [
                override?.value ||
                    codexRuntimePathForTarget(
                        workspaceRoot,
                        component.baseName,
                        targetTriple,
                    ),
            ]);
        }),
    };
}

export async function validateCodexRuntimeBundleInputs(plan, exists) {
    for (const binary of plan.binaries) {
        for (const inputPath of binary.inputPaths) {
            if (!(await exists(inputPath))) {
                throw new Error(
                    `${binary.description} binary was not found: ${inputPath}`,
                );
            }
        }
    }
}

export async function validateCodexRuntimeBundleArchitectures(
    plan,
    targetTriple,
    readHeader,
) {
    if (targetTriple === MAC_UNIVERSAL_TARGET) {
        for (const binary of plan.binaries) {
            // A single universal override is checked with lipo by the staging
            // script because its fat Mach-O header contains multiple slices.
            if (binary.inputPaths.length === 1) continue;
            for (let index = 0; index < binary.inputPaths.length; index += 1) {
                await validateBinaryArchitecture(
                    binary,
                    binary.inputPaths[index],
                    MAC_UNIVERSAL_COMPONENT_TARGETS[index],
                    readHeader,
                );
            }
        }
        return;
    }

    for (const binary of plan.binaries) {
        await validateBinaryArchitecture(
            binary,
            binary.inputPaths[0],
            targetTriple,
            readHeader,
        );
    }
}

async function validateBinaryArchitecture(
    binary,
    inputPath,
    targetTriple,
    readHeader,
) {
    const expectedArchitecture = TARGET_EXECUTABLE_ARCHITECTURES.get(targetTriple);
    if (!expectedArchitecture) {
        throw new Error(
            `Unsupported target for runtime architecture validation: ${targetTriple}`,
        );
    }

    const detectedArchitecture = detectExecutableArchitecture(
        await readHeader(inputPath),
    );
    if (!detectedArchitecture) {
        throw new Error(
            `${binary.description} executable format could not be inspected for ${targetTriple}: ${inputPath}`,
        );
    }
    if (detectedArchitecture !== expectedArchitecture) {
        throw new Error(
            `${binary.description} architecture mismatch for ${targetTriple}: expected ${expectedArchitecture}, detected ${detectedArchitecture}: ${inputPath}`,
        );
    }
}
