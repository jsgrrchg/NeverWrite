import { useCallback, useEffect, useMemo, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    aiGetSetupStatus,
    aiListRuntimes,
    aiStartAuth,
    aiUpdateSetup,
} from "../ai/api";
import { AIAuthTerminalModal } from "../ai/components/AIAuthTerminalModal";
import { AIChatOnboardingCard } from "../ai/components/AIChatOnboardingCard";
import type {
    AIRuntimeBinarySource,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
} from "../ai/types";

function getErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === "string" && error.trim()) {
        return error;
    }
    return fallback;
}

function getRuntimeStatusLabel(setupStatus: AIRuntimeSetupStatus | null) {
    if (!setupStatus) return "Checking status";
    if (!setupStatus.binaryReady) return "Runtime unavailable";
    if (!setupStatus.authReady) return "Authentication required";
    return "Ready";
}

function getRuntimeStatusTone(setupStatus: AIRuntimeSetupStatus | null) {
    if (!setupStatus) return "var(--text-secondary)";
    if (!setupStatus.binaryReady) return "#fca5a5";
    if (!setupStatus.authReady) return "#fcd34d";
    return "#86efac";
}

function getRuntimeSourceLabel(source: AIRuntimeBinarySource) {
    switch (source) {
        case "bundled":
            return "Bundled";
        case "custom":
            return "Custom path";
        case "env":
            return "Detected in PATH";
        case "vendor":
            return "Detected locally";
        case "missing":
            return "Missing";
        default:
            return "Unknown";
    }
}

function getMethodLabel(
    runtime: AIRuntimeDescriptor | undefined,
    setupStatus: AIRuntimeSetupStatus | null,
) {
    if (!setupStatus?.authMethod) return "No method configured";
    return (
        runtime?.runtime.capabilities &&
        setupStatus.authMethods.find(
            (method) => method.id === setupStatus.authMethod,
        )?.name
    ) ?? setupStatus.authMethod;
}

function isApiKeyMethod(methodId?: string) {
    return methodId === "openai-api-key" || methodId === "codex-api-key";
}

export function AIProvidersSettings() {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [runtimes, setRuntimes] = useState<AIRuntimeDescriptor[]>([]);
    const [setupStatusByRuntimeId, setSetupStatusByRuntimeId] = useState<
        Record<string, AIRuntimeSetupStatus>
    >({});
    const [errorByRuntimeId, setErrorByRuntimeId] = useState<
        Record<string, string>
    >({});
    const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(
        null,
    );
    const [isLoading, setIsLoading] = useState(false);
    const [savingRuntimeId, setSavingRuntimeId] = useState<string | null>(null);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [authTerminalRequest, setAuthTerminalRequest] = useState<{
        runtimeId: string;
        runtimeName: string;
        customBinaryPath?: string;
    } | null>(null);

    const refreshRuntime = useCallback(async (runtimeId: string) => {
        try {
            const setupStatus = await aiGetSetupStatus(runtimeId);
            setSetupStatusByRuntimeId((current) => ({
                ...current,
                [runtimeId]: setupStatus,
            }));
            setErrorByRuntimeId((current) => {
                const next = { ...current };
                delete next[runtimeId];
                return next;
            });
            return setupStatus;
        } catch (error) {
            const message = getErrorMessage(
                error,
                "Failed to check the AI setup.",
            );
            setErrorByRuntimeId((current) => ({
                ...current,
                [runtimeId]: message,
            }));
            throw error;
        }
    }, []);

    const loadProviders = useCallback(async () => {
        setIsLoading(true);
        setGlobalError(null);
        try {
            const nextRuntimes = await aiListRuntimes();
            setRuntimes(nextRuntimes);
            setSelectedRuntimeId((current) =>
                current &&
                nextRuntimes.some(
                    (descriptor) => descriptor.runtime.id === current,
                )
                    ? current
                    : (nextRuntimes[0]?.runtime.id ?? null),
            );

            const setupResults = await Promise.allSettled(
                nextRuntimes.map((descriptor) =>
                    aiGetSetupStatus(descriptor.runtime.id),
                ),
            );

            const nextStatuses: Record<string, AIRuntimeSetupStatus> = {};
            const nextErrors: Record<string, string> = {};
            setupResults.forEach((result, index) => {
                const runtimeId = nextRuntimes[index]?.runtime.id;
                if (!runtimeId) return;
                if (result.status === "fulfilled") {
                    nextStatuses[runtimeId] = result.value;
                    return;
                }
                nextErrors[runtimeId] = getErrorMessage(
                    result.reason,
                    "Failed to check the AI setup.",
                );
            });

            setSetupStatusByRuntimeId(nextStatuses);
            setErrorByRuntimeId(nextErrors);
        } catch (error) {
            setGlobalError(
                getErrorMessage(error, "Failed to load AI providers."),
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadProviders();
    }, [loadProviders]);

    const selectedRuntime =
        runtimes.find((descriptor) => descriptor.runtime.id === selectedRuntimeId) ??
        null;
    const selectedSetupStatus = selectedRuntimeId
        ? (setupStatusByRuntimeId[selectedRuntimeId] ?? null)
        : null;
    const selectedRuntimeError = selectedRuntimeId
        ? (errorByRuntimeId[selectedRuntimeId] ?? null)
        : null;
    const isSavingSelectedRuntime =
        selectedRuntimeId !== null && savingRuntimeId === selectedRuntimeId;

    const runtimeRows = useMemo(
        () =>
            runtimes.map((descriptor) => {
                const setupStatus =
                    setupStatusByRuntimeId[descriptor.runtime.id] ?? null;
                const error = errorByRuntimeId[descriptor.runtime.id] ?? null;
                return {
                    descriptor,
                    setupStatus,
                    error,
                };
            }),
        [errorByRuntimeId, runtimes, setupStatusByRuntimeId],
    );

    const handleSaveSetup = useCallback(
        async (input: {
            runtimeId?: string;
            customBinaryPath?: string;
            codexApiKey?: string;
            openaiApiKey?: string;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders?: string;
            anthropicAuthToken?: string;
        }) => {
            const runtimeId = input.runtimeId ?? selectedRuntimeId;
            if (!runtimeId) return;
            setSavingRuntimeId(runtimeId);
            try {
                const setupStatus = await aiUpdateSetup({
                    runtimeId,
                    customBinaryPath: input.customBinaryPath,
                    codexApiKey: input.codexApiKey,
                    openaiApiKey: input.openaiApiKey,
                    anthropicBaseUrl: input.anthropicBaseUrl,
                    anthropicCustomHeaders: input.anthropicCustomHeaders,
                    anthropicAuthToken: input.anthropicAuthToken,
                });
                setSetupStatusByRuntimeId((current) => ({
                    ...current,
                    [runtimeId]: setupStatus,
                }));
                setErrorByRuntimeId((current) => {
                    const next = { ...current };
                    delete next[runtimeId];
                    return next;
                });
            } catch (error) {
                setErrorByRuntimeId((current) => ({
                    ...current,
                    [runtimeId]: getErrorMessage(
                        error,
                        "Failed to save the AI setup.",
                    ),
                }));
            } finally {
                setSavingRuntimeId(null);
            }
        },
        [selectedRuntimeId],
    );

    const handleStartAuth = useCallback(
        async (input: {
            runtimeId?: string;
            methodId: string;
            customBinaryPath?: string;
            codexApiKey?: string;
            openaiApiKey?: string;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders?: string;
            anthropicAuthToken?: string;
        }) => {
            const runtimeId = input.runtimeId ?? selectedRuntimeId;
            if (!runtimeId || !selectedRuntime) return;

            if (runtimeId === "claude-acp" && input.methodId === "claude-login") {
                setAuthTerminalRequest({
                    runtimeId,
                    runtimeName: selectedRuntime.runtime.name.replace(
                        / ACP$/,
                        "",
                    ),
                    customBinaryPath: input.customBinaryPath,
                });
                return;
            }

            setSavingRuntimeId(runtimeId);
            try {
                if (
                    input.customBinaryPath !== undefined ||
                    input.codexApiKey !== undefined ||
                    input.openaiApiKey !== undefined ||
                    input.anthropicBaseUrl !== undefined ||
                    input.anthropicCustomHeaders !== undefined ||
                    input.anthropicAuthToken !== undefined
                ) {
                    const preflightSetup = await aiUpdateSetup({
                        runtimeId,
                        customBinaryPath: input.customBinaryPath,
                        codexApiKey: input.codexApiKey,
                        openaiApiKey: input.openaiApiKey,
                        anthropicBaseUrl: input.anthropicBaseUrl,
                        anthropicCustomHeaders: input.anthropicCustomHeaders,
                        anthropicAuthToken: input.anthropicAuthToken,
                    });
                    setSetupStatusByRuntimeId((current) => ({
                        ...current,
                        [runtimeId]: preflightSetup,
                    }));
                }

                const setupStatus = await aiStartAuth(
                    { methodId: input.methodId, runtimeId },
                    vaultPath,
                );
                setSetupStatusByRuntimeId((current) => ({
                    ...current,
                    [runtimeId]: setupStatus,
                }));
                setErrorByRuntimeId((current) => {
                    const next = { ...current };
                    delete next[runtimeId];
                    return next;
                });
            } catch (error) {
                setErrorByRuntimeId((current) => ({
                    ...current,
                    [runtimeId]: getErrorMessage(
                        error,
                        "Failed to authenticate the AI runtime.",
                    ),
                }));
            } finally {
                setSavingRuntimeId(null);
            }
        },
        [selectedRuntime, selectedRuntimeId, vaultPath],
    );

    const handleClearCredentials = useCallback(async () => {
        if (!selectedRuntimeId) return;
        await handleSaveSetup({
            runtimeId: selectedRuntimeId,
            codexApiKey: "",
            openaiApiKey: "",
            anthropicBaseUrl: "",
            anthropicCustomHeaders: "",
            anthropicAuthToken: "",
        });
        await refreshRuntime(selectedRuntimeId).catch(() => undefined);
    }, [handleSaveSetup, refreshRuntime, selectedRuntimeId]);

    return (
        <>
            <div
                style={{
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    backgroundColor: "var(--bg-secondary)",
                    padding: 14,
                    marginBottom: 18,
                }}
            >
                <div
                    style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.16em",
                        color: "var(--accent)",
                    }}
                >
                    AI providers
                </div>
                <div
                    style={{
                        marginTop: 6,
                        fontSize: 15,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                    }}
                >
                    Manage runtimes, authentication, and API keys
                </div>
                <div
                    style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                    }}
                >
                    These connections apply to VaultAI globally.
                </div>

                {globalError ? (
                    <div
                        style={{
                            marginTop: 12,
                            borderRadius: 8,
                            border: "1px solid #7f1d1d",
                            backgroundColor:
                                "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                            color: "#fecaca",
                            padding: "10px 12px",
                            fontSize: 12,
                        }}
                    >
                        {globalError}
                    </div>
                ) : null}

                <div
                    style={{
                        display: "grid",
                        gap: 10,
                        marginTop: 14,
                    }}
                >
                    {isLoading && runtimeRows.length === 0 ? (
                        <div
                            style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                            }}
                        >
                            Loading AI providers…
                        </div>
                    ) : null}

                    {runtimeRows.map(({ descriptor, setupStatus, error }) => {
                        const isSelected =
                            descriptor.runtime.id === selectedRuntimeId;
                        return (
                            <button
                                key={descriptor.runtime.id}
                                type="button"
                                onClick={() =>
                                    setSelectedRuntimeId(descriptor.runtime.id)
                                }
                                style={{
                                    width: "100%",
                                    textAlign: "left",
                                    borderRadius: 10,
                                    border: `1px solid ${
                                        isSelected
                                            ? "var(--accent)"
                                            : "var(--border)"
                                    }`,
                                    backgroundColor: isSelected
                                        ? "color-mix(in srgb, var(--accent) 10%, var(--bg-primary))"
                                        : "var(--bg-primary)",
                                    padding: 12,
                                    cursor: "pointer",
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        gap: 12,
                                        alignItems: "center",
                                    }}
                                >
                                    <div>
                                        <div
                                            style={{
                                                fontSize: 13,
                                                fontWeight: 600,
                                                color: "var(--text-primary)",
                                            }}
                                        >
                                            {descriptor.runtime.name.replace(
                                                / ACP$/,
                                                "",
                                            )}
                                        </div>
                                        <div
                                            style={{
                                                marginTop: 3,
                                                fontSize: 12,
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            {getMethodLabel(
                                                descriptor,
                                                setupStatus,
                                            )}
                                            {" · "}
                                            {getRuntimeSourceLabel(
                                                setupStatus?.binarySource ??
                                                    "missing",
                                            )}
                                        </div>
                                    </div>
                                    <div
                                        style={{
                                            fontSize: 11,
                                            color: getRuntimeStatusTone(
                                                setupStatus,
                                            ),
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {getRuntimeStatusLabel(setupStatus)}
                                    </div>
                                </div>
                                {error ? (
                                    <div
                                        style={{
                                            marginTop: 8,
                                            fontSize: 11,
                                            color: "#fca5a5",
                                        }}
                                    >
                                        {error}
                                    </div>
                                ) : null}
                            </button>
                        );
                    })}
                </div>

                {selectedRuntime && selectedSetupStatus ? (
                    <div style={{ marginTop: 18 }}>
                        <div
                            style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 8,
                                marginBottom: 10,
                            }}
                        >
                            <div
                                style={{
                                    borderRadius: 999,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                    padding: "5px 9px",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                Status: {getRuntimeStatusLabel(selectedSetupStatus)}
                            </div>
                            <div
                                style={{
                                    borderRadius: 999,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                    padding: "5px 9px",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                Source:{" "}
                                {getRuntimeSourceLabel(
                                    selectedSetupStatus.binarySource,
                                )}
                            </div>
                            <div
                                style={{
                                    borderRadius: 999,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                    padding: "5px 9px",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                }}
                            >
                                Method:{" "}
                                {getMethodLabel(
                                    selectedRuntime,
                                    selectedSetupStatus,
                                )}
                            </div>
                        </div>

                        {selectedSetupStatus.binaryPath ? (
                            <div
                                style={{
                                    marginBottom: 10,
                                    borderRadius: 8,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                    padding: "10px 12px",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 11,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.12em",
                                        color: "var(--text-secondary)",
                                        marginBottom: 6,
                                    }}
                                >
                                    Runtime path
                                </div>
                                <div
                                    style={{
                                        fontSize: 12,
                                        color: "var(--text-primary)",
                                        wordBreak: "break-all",
                                        fontFamily: "monospace",
                                    }}
                                >
                                    {selectedSetupStatus.binaryPath}
                                </div>
                            </div>
                        ) : null}

                        {selectedRuntimeError ? (
                            <div
                                style={{
                                    marginBottom: 10,
                                    borderRadius: 8,
                                    border: "1px solid #7f1d1d",
                                    backgroundColor:
                                        "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                                    color: "#fecaca",
                                    padding: "10px 12px",
                                    fontSize: 12,
                                }}
                            >
                                {selectedRuntimeError}
                            </div>
                        ) : null}

                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                                marginBottom: 10,
                            }}
                        >
                            <button
                                type="button"
                                onClick={() =>
                                    void refreshRuntime(selectedRuntime.runtime.id)
                                }
                                disabled={isSavingSelectedRuntime}
                                style={{
                                    borderRadius: 8,
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                    color: "var(--text-primary)",
                                    padding: "7px 10px",
                                    fontSize: 12,
                                    cursor: isSavingSelectedRuntime
                                        ? "not-allowed"
                                        : "pointer",
                                    opacity: isSavingSelectedRuntime ? 0.6 : 1,
                                }}
                            >
                                Refresh status
                            </button>
                            {(isApiKeyMethod(selectedSetupStatus.authMethod) ||
                                selectedSetupStatus.hasGatewayConfig) && (
                                <button
                                    type="button"
                                    onClick={() => void handleClearCredentials()}
                                    disabled={isSavingSelectedRuntime}
                                    style={{
                                        borderRadius: 8,
                                        border: "1px solid var(--border)",
                                        backgroundColor: "var(--bg-primary)",
                                        color: "var(--text-primary)",
                                        padding: "7px 10px",
                                        fontSize: 12,
                                        cursor: isSavingSelectedRuntime
                                            ? "not-allowed"
                                            : "pointer",
                                        opacity: isSavingSelectedRuntime
                                            ? 0.6
                                            : 1,
                                    }}
                                >
                                    Clear credentials
                                </button>
                            )}
                        </div>

                        <AIChatOnboardingCard
                            mode="settings"
                            runtime={selectedRuntime.runtime}
                            setupStatus={selectedSetupStatus}
                            saving={isSavingSelectedRuntime}
                            onSaveSetup={(
                                input: {
                                    runtimeId?: string;
                                    customBinaryPath?: string;
                                    anthropicBaseUrl?: string;
                                    anthropicCustomHeaders?: string;
                                    anthropicAuthToken?: string;
                                },
                            ) => {
                                void handleSaveSetup(input);
                            }}
                            onAuthenticate={(input) => {
                                void handleStartAuth(input);
                            }}
                        />
                    </div>
                ) : null}

                <div
                    style={{
                        marginTop: 16,
                        borderRadius: 10,
                        border: "1px dashed var(--border)",
                        backgroundColor: "var(--bg-primary)",
                        padding: 12,
                    }}
                >
                    <div
                        style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                        }}
                    >
                        External runtimes
                    </div>
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: "var(--text-secondary)",
                        }}
                    >
                        Add Runtime is not wired yet. The backend is still
                        hardcoded to bundled Claude and Codex, so external ACP
                        registration needs a descriptor-driven runtime layer
                        first.
                    </div>
                </div>
            </div>

            {authTerminalRequest ? (
                <AIAuthTerminalModal
                    open
                    runtimeId={authTerminalRequest.runtimeId}
                    runtimeName={authTerminalRequest.runtimeName}
                    vaultPath={vaultPath}
                    customBinaryPath={authTerminalRequest.customBinaryPath}
                    onClose={() => setAuthTerminalRequest(null)}
                    onRefreshSetup={async (runtimeId) => {
                        await refreshRuntime(runtimeId);
                    }}
                />
            ) : null}
        </>
    );
}
