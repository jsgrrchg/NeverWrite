import path from "node:path";

export const MAC_UNIVERSAL_TARGET = "universal-apple-darwin";
export const MAC_UNIVERSAL_COMPONENT_TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
];

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
