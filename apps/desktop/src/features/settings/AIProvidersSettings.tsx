import { Fragment, useCallback, useEffect, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    aiGetEnvironmentDiagnostics,
    aiGetSetupStatus,
    aiListRuntimes,
    aiStartAuth,
    aiUpdateSetup,
} from "../ai/api";
import { AIAuthTerminalModal } from "../ai/components/AIAuthTerminalModal";
import { APP_BRAND_NAME } from "../../app/utils/branding";
import {
    isClaudeTerminalAuthMethodId,
    isIntegratedTerminalAuthMethod,
} from "../ai/utils/authMethods";
import {
    getRuntimeDisplayName,
    PROVIDER_CATALOG,
} from "../ai/utils/runtimeMetadata";
import { getClaudeGatewayUrlValidationMessage } from "../ai/utils/claudeGatewayUrl";
import {
    EMPTY_SEARCH_QUERY,
    matchesSettingsSearch,
    type SearchValue,
    type SettingsSearchQuery,
} from "./settingsSearch";
import type {
    AIEnvironmentDiagnostics,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
    AISecretPatch,
} from "../ai/types";

/* ── Helpers ────────────────────────────────────────────────────── */

function getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
}

function isApiKeyMethod(id?: string) {
    return (
        id === "openai-api-key" || id === "codex-api-key" || id === "use_gemini"
    );
}

function isGatewayMethod(id?: string) {
    return id === "gateway";
}

function getMethodDisplayName(
    status: AIRuntimeSetupStatus | null,
): string | null {
    if (!status?.authMethod) return null;
    return (
        status.authMethods.find((m) => m.id === status.authMethod)?.name ?? null
    );
}

function getShortMethodDesc(id: string): string {
    switch (id) {
        case "chatgpt":
            return "Browser sign-in";
        case "claude-ai-login":
        case "console-login":
        case "claude-login":
        case "kilo-login":
            return "Terminal sign-in";
        case "openai-api-key":
            return "OpenAI API key";
        case "codex-api-key":
            return "Codex API key";
        case "gateway":
            return "Custom endpoint";
        case "login_with_google":
            return "Google sign-in";
        case "use_gemini":
            return "Gemini API key";
        default:
            return "";
    }
}

function getAuthHelpText(id: string): string {
    switch (id) {
        case "chatgpt":
            return "Opens the browser to complete sign-in with your ChatGPT account.";
        case "claude-ai-login":
            return "Opens a sign-in terminal for your Claude subscription inside the app.";
        case "console-login":
            return "Opens a sign-in terminal for Anthropic Console inside the app.";
        case "claude-login":
            return "Opens a sign-in terminal inside the app.";
        case "kilo-login":
            return "Opens a Kilo sign-in terminal inside the app.";
        case "openai-api-key":
            return `Store an OpenAI API key locally for ${APP_BRAND_NAME} only.`;
        case "codex-api-key":
            return `Store a Codex API key locally for ${APP_BRAND_NAME} only.`;
        case "gateway":
            return "Route requests through a custom gateway endpoint. Remote gateways must use HTTPS. Plain HTTP is only allowed for localhost.";
        case "login_with_google":
            return "Opens a Gemini sign-in terminal inside the app.";
        case "use_gemini":
            return `Store a Gemini API key locally for ${APP_BRAND_NAME} only.`;
        default:
            return "Complete authentication to connect this provider.";
    }
}

function getApiKeyPlaceholder(id?: string): string {
    if (id === "codex-api-key") return "Codex API key";
    if (id === "openai-api-key") return "OpenAI API key";
    if (id === "use_gemini") return "Gemini API key";
    return "API key";
}

function getActionLabel(
    methodId: string | undefined,
    status: AIRuntimeSetupStatus,
): string {
    if (!methodId) return "Connect";
    if (methodId === "chatgpt") return "Continue with ChatGPT";
    if (isClaudeTerminalAuthMethodId(methodId)) return "Open sign-in terminal";
    if (methodId === "login_with_google") return "Open sign-in terminal";
    if (methodId === "kilo-login") return "Open sign-in terminal";
    if (isApiKeyMethod(methodId)) {
        return status.authReady && status.authMethod === methodId
            ? "Replace key"
            : "Save and connect";
    }
    if (isGatewayMethod(methodId)) return "Save gateway";
    return "Connect";
}

function getDefaultMethodId(status: AIRuntimeSetupStatus): string {
    if (
        status.authMethod &&
        status.authMethods.some((m) => m.id === status.authMethod)
    ) {
        return status.authMethod;
    }
    const chatgpt = status.authMethods.find((m) => m.id === "chatgpt");
    if (chatgpt) return chatgpt.id;
    return status.authMethods[0]?.id ?? "openai-api-key";
}

/* ── Shared styles ──────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 6,
    fontSize: 13,
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-primary)",
    border: "1px solid var(--border)",
    outline: "none",
};

const unchangedSecretPatch: AISecretPatch = { action: "unchanged" };
const clearSecretPatch: AISecretPatch = { action: "clear" };

function setSecretPatch(value: string): AISecretPatch {
    return {
        action: "set",
        value,
    };
}

function EmptyProviderSearchResult() {
    return (
        <div
            style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
                padding: "24px 0",
            }}
        >
            No matching AI provider settings.
        </div>
    );
}

function getProviderSearchValues(
    provider: (typeof PROVIDER_CATALOG)[number],
    setupStatus: AIRuntimeSetupStatus | null,
    error: string | null,
): readonly SearchValue[] {
    return [
        provider.id,
        provider.name,
        provider.company,
        setupStatus?.runtimeId,
        setupStatus?.binaryPath,
        setupStatus?.binarySource,
        setupStatus?.authMethod,
        setupStatus?.authReady ? "Connected" : "Not configured",
        setupStatus?.binaryReady ? "Binary ready" : "Binary missing",
        setupStatus?.hasGatewayConfig ? "Custom gateway" : undefined,
        setupStatus?.hasGatewayUrl ? "Gateway URL" : undefined,
        getMethodDisplayName(setupStatus),
        error,
        ...(setupStatus?.authMethods.flatMap((method) => [
            method.id,
            method.name,
            method.description,
            getShortMethodDesc(method.id),
            getAuthHelpText(method.id),
            getApiKeyPlaceholder(method.id),
            getActionLabel(method.id, setupStatus),
        ]) ?? []),
    ];
}

const diagnosticCodeStyle: React.CSSProperties = {
    margin: 0,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontSize: 11,
    lineHeight: 1.5,
    fontFamily:
        '"Geist Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
};

function formatCommand(program?: string, args: string[] = []) {
    if (!program) return "Not resolved";
    return [program, ...args].join(" ");
}

function DiagnosticsPathBlock({
    label,
    entries,
    helper,
}: {
    label: string;
    entries: string[];
    helper: string;
}) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div
                style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                }}
            >
                {label}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {helper}
            </div>
            <pre style={diagnosticCodeStyle}>
                {entries.length > 0 ? entries.join("\n") : "No entries"}
            </pre>
        </div>
    );
}

function DiagnosticsRuntimeCard({
    runtime,
}: {
    runtime: AIEnvironmentDiagnostics["runtimes"][number];
}) {
    const setupStatus = runtime.setupStatus;
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--border)",
                backgroundColor: "var(--bg-primary)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                }}
            >
                <div
                    style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                    }}
                >
                    {runtime.runtimeName}
                </div>
                <div
                    style={{
                        padding: "3px 8px",
                        borderRadius: 999,
                        fontSize: 10,
                        fontWeight: 600,
                        backgroundColor: setupStatus?.binaryReady
                            ? "color-mix(in srgb, #34d399 15%, var(--bg-secondary))"
                            : "color-mix(in srgb, #ef4444 15%, var(--bg-secondary))",
                        color: setupStatus?.binaryReady ? "#34d399" : "#ef4444",
                    }}
                >
                    {setupStatus?.binaryReady
                        ? "Binary ready"
                        : "Binary missing"}
                </div>
            </div>

            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                Launch command
            </div>
            <pre style={diagnosticCodeStyle}>
                {formatCommand(runtime.launchProgram, runtime.launchArgs)}
            </pre>

            {runtime.resolutionDisplay && (
                <>
                    <div
                        style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                        Resolution source
                    </div>
                    <pre style={diagnosticCodeStyle}>
                        {runtime.resolutionDisplay}
                    </pre>
                </>
            )}

            {setupStatus?.binaryPath && (
                <>
                    <div
                        style={{ fontSize: 11, color: "var(--text-secondary)" }}
                    >
                        Setup binary path
                    </div>
                    <pre style={diagnosticCodeStyle}>
                        {setupStatus.binaryPath}
                    </pre>
                </>
            )}

            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                Source: {setupStatus?.binarySource ?? "unknown"}
                {setupStatus?.authMethod
                    ? `  •  Auth: ${setupStatus.authMethod}`
                    : ""}
            </div>

            {runtime.setupError && (
                <div
                    style={{
                        padding: "10px 12px",
                        borderRadius: 8,
                        fontSize: 11,
                        border: "1px solid #7f1d1d",
                        backgroundColor:
                            "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                        color: "#fecaca",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {runtime.setupError}
                </div>
            )}
        </div>
    );
}

function setOptionalSecretPatch(value?: string): AISecretPatch {
    return value?.trim() ? setSecretPatch(value) : unchangedSecretPatch;
}

/* ── Expanded panel ─────────────────────────────────────────────── */

function ProviderExpandedPanel({
    setupStatus,
    error,
    saving,
    onAuth,
    onClearGateway,
    onLogout,
}: {
    setupStatus: AIRuntimeSetupStatus;
    error: string | null;
    saving: boolean;
    onAuth: (input: {
        runtimeId: string;
        methodId: string;
        codexApiKey: AISecretPatch;
        openaiApiKey: AISecretPatch;
        geminiApiKey: AISecretPatch;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders: AISecretPatch;
        anthropicAuthToken: AISecretPatch;
    }) => void;
    onClearGateway: () => void;
    onLogout: () => void;
}) {
    const [selectedMethodId, setSelectedMethodId] = useState(() =>
        getDefaultMethodId(setupStatus),
    );
    const [apiKey, setApiKey] = useState("");
    const [gatewayUrl, setGatewayUrl] = useState("");
    const [gatewayHeaders, setGatewayHeaders] = useState("");
    const [gatewayToken, setGatewayToken] = useState("");

    const selectedMethod =
        setupStatus.authMethods.find((m) => m.id === selectedMethodId) ?? null;
    const apiKeySelected = isApiKeyMethod(selectedMethodId);
    const gatewaySelected = isGatewayMethod(selectedMethodId);
    const isOpenAi = selectedMethodId === "openai-api-key";
    const isCodex = selectedMethodId === "codex-api-key";
    const isGemini = selectedMethodId === "use_gemini";
    const gatewayUrlError = gatewaySelected
        ? getClaudeGatewayUrlValidationMessage(gatewayUrl)
        : null;

    const canSubmit =
        !saving &&
        selectedMethod != null &&
        (!apiKeySelected || apiKey.trim() !== "") &&
        (!gatewaySelected ||
            (gatewayUrl.trim() !== "" && gatewayUrlError == null));

    const handleSubmit = () => {
        onAuth({
            runtimeId: setupStatus.runtimeId,
            methodId: selectedMethodId,
            openaiApiKey: isOpenAi
                ? setSecretPatch(apiKey)
                : unchangedSecretPatch,
            codexApiKey: isCodex
                ? setSecretPatch(apiKey)
                : unchangedSecretPatch,
            geminiApiKey: isGemini
                ? setSecretPatch(apiKey)
                : unchangedSecretPatch,
            anthropicBaseUrl: gatewaySelected
                ? gatewayUrl || undefined
                : undefined,
            anthropicCustomHeaders: gatewaySelected
                ? setOptionalSecretPatch(gatewayHeaders)
                : unchangedSecretPatch,
            anthropicAuthToken: gatewaySelected
                ? setOptionalSecretPatch(gatewayToken)
                : unchangedSecretPatch,
        });
    };

    return (
        <div
            style={{
                padding: "0 14px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
            }}
        >
            {/* Auth method selector */}
            {setupStatus.authMethods.length > 0 && (
                <div style={{ display: "flex", gap: 8 }}>
                    {setupStatus.authMethods.map((method) => {
                        const selected = method.id === selectedMethodId;
                        return (
                            <button
                                key={method.id}
                                type="button"
                                onClick={() => setSelectedMethodId(method.id)}
                                style={{
                                    flex: 1,
                                    textAlign: "left",
                                    padding: "10px 12px",
                                    borderRadius: 6,
                                    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                                    backgroundColor: selected
                                        ? "color-mix(in srgb, var(--accent) 10%, var(--bg-primary))"
                                        : "var(--bg-primary)",
                                    cursor: "pointer",
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 600,
                                        color: selected
                                            ? "var(--text-primary)"
                                            : "var(--text-secondary)",
                                    }}
                                >
                                    {method.name}
                                </div>
                                <div
                                    style={{
                                        fontSize: 11,
                                        color: "var(--text-secondary)",
                                        marginTop: 2,
                                    }}
                                >
                                    {getShortMethodDesc(method.id)}
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* API key input */}
            {apiKeySelected && (
                <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={getApiKeyPlaceholder(selectedMethodId)}
                    style={inputStyle}
                />
            )}

            {/* Gateway inputs */}
            {gatewaySelected && (
                <>
                    <input
                        type="url"
                        value={gatewayUrl}
                        onChange={(e) => setGatewayUrl(e.target.value)}
                        placeholder="Gateway base URL"
                        style={inputStyle}
                    />
                    <textarea
                        value={gatewayHeaders}
                        onChange={(e) => setGatewayHeaders(e.target.value)}
                        placeholder={"Headers, one per line\nx-api-key: secret"}
                        style={{
                            ...inputStyle,
                            minHeight: 60,
                            resize: "vertical",
                        }}
                    />
                    <input
                        type="password"
                        value={gatewayToken}
                        onChange={(e) => setGatewayToken(e.target.value)}
                        placeholder="Auth token (optional)"
                        style={inputStyle}
                    />
                    <div
                        style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            marginTop: -2,
                        }}
                    >
                        Use HTTPS for remote gateways. Plain HTTP is only
                        allowed for localhost.
                    </div>
                    {gatewayUrlError && (
                        <div
                            style={{
                                padding: "10px 12px",
                                borderRadius: 6,
                                fontSize: 12,
                                border: "1px solid #7f1d1d",
                                backgroundColor:
                                    "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                                color: "#fecaca",
                            }}
                        >
                            {gatewayUrlError}
                        </div>
                    )}
                    {(setupStatus.hasGatewayConfig ||
                        setupStatus.hasGatewayUrl) && (
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "flex-start",
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => {
                                    setGatewayUrl("");
                                    setGatewayHeaders("");
                                    setGatewayToken("");
                                    onClearGateway();
                                }}
                                disabled={saving}
                                style={{
                                    padding: "6px 10px",
                                    borderRadius: 6,
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    border: "1px solid var(--border)",
                                    backgroundColor: "transparent",
                                    cursor: saving ? "not-allowed" : "pointer",
                                    opacity: saving ? 0.5 : 1,
                                }}
                            >
                                Clear gateway settings
                            </button>
                        </div>
                    )}
                </>
            )}

            {/* Info box */}
            {selectedMethod && (
                <div
                    style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        padding: "10px 12px",
                        borderRadius: 6,
                        backgroundColor: "var(--bg-primary)",
                    }}
                >
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            flexShrink: 0,
                        }}
                    >
                        ℹ
                    </span>
                    <span
                        style={{ fontSize: 12, color: "var(--text-secondary)" }}
                    >
                        {getAuthHelpText(selectedMethodId)}
                    </span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div
                    style={{
                        padding: "10px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        border: "1px solid #7f1d1d",
                        backgroundColor:
                            "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                        color: "#fecaca",
                    }}
                >
                    {error}
                </div>
            )}

            {/* Action row */}
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                }}
            >
                {setupStatus.authReady ? (
                    <button
                        type="button"
                        onClick={onLogout}
                        disabled={saving}
                        style={{
                            padding: "6px 10px",
                            borderRadius: 6,
                            fontSize: 11,
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                            backgroundColor: "transparent",
                            cursor: saving ? "not-allowed" : "pointer",
                            opacity: saving ? 0.5 : 1,
                        }}
                    >
                        Log Out
                    </button>
                ) : (
                    <div />
                )}
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    style={{
                        padding: "7px 14px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#fff",
                        border: "none",
                        background:
                            "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 56%, black))",
                        opacity: canSubmit ? 1 : 0.45,
                        cursor: canSubmit ? "pointer" : "not-allowed",
                    }}
                >
                    {saving
                        ? "Connecting…"
                        : getActionLabel(selectedMethodId, setupStatus)}
                </button>
            </div>
        </div>
    );
}

function ProviderSetupUnavailablePanel({
    error,
    loading,
    onRetry,
}: {
    error: string | null;
    loading: boolean;
    onRetry: () => void;
}) {
    return (
        <div
            style={{
                padding: "0 14px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
            }}
        >
            <div
                style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--bg-primary)",
                    color: "var(--text-secondary)",
                    lineHeight: 1.45,
                }}
            >
                {loading
                    ? "Loading provider setup…"
                    : (error ??
                      "Provider setup status is not available yet. Check diagnostics or retry loading this provider.")}
            </div>
            {!loading && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                        type="button"
                        onClick={onRetry}
                        style={{
                            padding: "7px 12px",
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-primary)",
                            cursor: "pointer",
                        }}
                    >
                        Retry
                    </button>
                </div>
            )}
        </div>
    );
}

/* ── Main component ─────────────────────────────────────────────── */

export function AIProvidersSettings({
    searchQuery = EMPTY_SEARCH_QUERY,
}: {
    searchQuery?: SettingsSearchQuery;
}) {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [runtimes, setRuntimes] = useState<AIRuntimeDescriptor[]>([]);
    const [setupStatusMap, setSetupStatusMap] = useState<
        Record<string, AIRuntimeSetupStatus>
    >({});
    const [errorMap, setErrorMap] = useState<Record<string, string>>({});
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [diagnostics, setDiagnostics] =
        useState<AIEnvironmentDiagnostics | null>(null);
    const [diagnosticsError, setDiagnosticsError] = useState<string | null>(
        null,
    );
    const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
    const [authTerminalRequest, setAuthTerminalRequest] = useState<{
        runtimeId: string;
        methodId: string;
        runtimeName: string;
        customBinaryPath?: string;
    } | null>(null);

    /* ── Data loading ── */

    const refreshRuntime = useCallback(async (runtimeId: string) => {
        try {
            const status = await aiGetSetupStatus(runtimeId);
            setSetupStatusMap((prev) => ({ ...prev, [runtimeId]: status }));
            setErrorMap((prev) => {
                const next = { ...prev };
                delete next[runtimeId];
                return next;
            });
        } catch (error) {
            setErrorMap((prev) => ({
                ...prev,
                [runtimeId]: getErrorMessage(
                    error,
                    "Failed to check setup status.",
                ),
            }));
        }
    }, []);

    const loadDiagnostics = useCallback(async () => {
        setDiagnosticsLoading(true);
        try {
            const next = await aiGetEnvironmentDiagnostics();
            setDiagnostics(next);
            setDiagnosticsError(null);
        } catch (error) {
            setDiagnosticsError(
                getErrorMessage(error, "Failed to load diagnostics."),
            );
        } finally {
            setDiagnosticsLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadProviders = async () => {
            setIsLoading(true);
            try {
                const descriptors = await aiListRuntimes();
                if (cancelled) return;
                setRuntimes(descriptors);

                const results = await Promise.allSettled(
                    descriptors.map((d) => aiGetSetupStatus(d.runtime.id)),
                );
                if (cancelled) return;

                const statuses: Record<string, AIRuntimeSetupStatus> = {};
                const errors: Record<string, string> = {};
                results.forEach((result, i) => {
                    const id = descriptors[i]?.runtime.id;
                    if (!id) return;
                    if (result.status === "fulfilled") {
                        statuses[id] = result.value;
                    } else {
                        errors[id] = getErrorMessage(
                            result.reason,
                            "Failed to check setup.",
                        );
                    }
                });

                setSetupStatusMap(statuses);
                setErrorMap(errors);
            } catch {
                /* runtimes will remain empty */
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };

        void loadProviders();

        return () => {
            cancelled = true;
        };
    }, []);

    /* ── Handlers ── */

    const handleAuth = useCallback(
        async (input: {
            runtimeId: string;
            methodId: string;
            customBinaryPath?: string;
            codexApiKey: AISecretPatch;
            openaiApiKey: AISecretPatch;
            geminiApiKey: AISecretPatch;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders: AISecretPatch;
            anthropicAuthToken: AISecretPatch;
        }) => {
            const runtime = runtimes.find(
                (r) => r.runtime.id === input.runtimeId,
            );

            if (
                isIntegratedTerminalAuthMethod(input.runtimeId, input.methodId)
            ) {
                setAuthTerminalRequest({
                    runtimeId: input.runtimeId,
                    methodId: input.methodId,
                    runtimeName: getRuntimeDisplayName(
                        input.runtimeId,
                        runtime?.runtime.name,
                    ),
                    customBinaryPath: input.customBinaryPath,
                });
                return;
            }

            setSavingId(input.runtimeId);
            try {
                if (
                    input.customBinaryPath !== undefined ||
                    input.codexApiKey.action !== "unchanged" ||
                    input.openaiApiKey.action !== "unchanged" ||
                    input.geminiApiKey.action !== "unchanged" ||
                    input.anthropicBaseUrl !== undefined ||
                    input.anthropicCustomHeaders.action !== "unchanged" ||
                    input.anthropicAuthToken.action !== "unchanged"
                ) {
                    const preflight = await aiUpdateSetup({
                        runtimeId: input.runtimeId,
                        customBinaryPath: input.customBinaryPath,
                        codexApiKey: input.codexApiKey,
                        openaiApiKey: input.openaiApiKey,
                        geminiApiKey: input.geminiApiKey,
                        googleApiKey: unchangedSecretPatch,
                        googleCloudProject: undefined,
                        googleCloudLocation: undefined,
                        gatewayBaseUrl: undefined,
                        gatewayHeaders: unchangedSecretPatch,
                        anthropicBaseUrl: input.anthropicBaseUrl,
                        anthropicCustomHeaders: input.anthropicCustomHeaders,
                        anthropicAuthToken: input.anthropicAuthToken,
                    });
                    setSetupStatusMap((prev) => ({
                        ...prev,
                        [input.runtimeId]: preflight,
                    }));
                }

                const status = await aiStartAuth(
                    { methodId: input.methodId, runtimeId: input.runtimeId },
                    vaultPath,
                );
                setSetupStatusMap((prev) => ({
                    ...prev,
                    [input.runtimeId]: status,
                }));
                setErrorMap((prev) => {
                    const next = { ...prev };
                    delete next[input.runtimeId];
                    return next;
                });
            } catch (error) {
                setErrorMap((prev) => ({
                    ...prev,
                    [input.runtimeId]: getErrorMessage(
                        error,
                        "Failed to authenticate.",
                    ),
                }));
            } finally {
                setSavingId(null);
            }
        },
        [runtimes, vaultPath],
    );

    const handleLogout = useCallback(
        async (runtimeId: string) => {
            setSavingId(runtimeId);
            try {
                await aiUpdateSetup({
                    runtimeId,
                    codexApiKey: clearSecretPatch,
                    openaiApiKey: clearSecretPatch,
                    geminiApiKey: clearSecretPatch,
                    googleApiKey: clearSecretPatch,
                    googleCloudProject: undefined,
                    googleCloudLocation: undefined,
                    gatewayBaseUrl: undefined,
                    gatewayHeaders: unchangedSecretPatch,
                    anthropicBaseUrl: "",
                    anthropicCustomHeaders: clearSecretPatch,
                    anthropicAuthToken: clearSecretPatch,
                });
                await refreshRuntime(runtimeId);
            } catch (error) {
                setErrorMap((prev) => ({
                    ...prev,
                    [runtimeId]: getErrorMessage(error, "Failed to log out."),
                }));
            } finally {
                setSavingId(null);
            }
        },
        [refreshRuntime],
    );

    const handleClearGateway = useCallback(
        async (runtimeId: string) => {
            setSavingId(runtimeId);
            try {
                await aiUpdateSetup({
                    runtimeId,
                    codexApiKey: unchangedSecretPatch,
                    openaiApiKey: unchangedSecretPatch,
                    geminiApiKey: unchangedSecretPatch,
                    googleApiKey: unchangedSecretPatch,
                    googleCloudProject: undefined,
                    googleCloudLocation: undefined,
                    gatewayBaseUrl: undefined,
                    gatewayHeaders: unchangedSecretPatch,
                    anthropicBaseUrl: "",
                    anthropicCustomHeaders: clearSecretPatch,
                    anthropicAuthToken: clearSecretPatch,
                });
                await refreshRuntime(runtimeId);
            } catch (error) {
                setErrorMap((prev) => ({
                    ...prev,
                    [runtimeId]: getErrorMessage(
                        error,
                        "Failed to clear gateway settings.",
                    ),
                }));
            } finally {
                setSavingId(null);
            }
        },
        [refreshRuntime],
    );

    /* ── Derived data ── */

    const installedProviders = PROVIDER_CATALOG.flatMap((p) => {
        const hasRuntime = runtimes.some((r) => r.runtime.id === p.id);
        if (!hasRuntime) return [];
        return [
            {
                ...p,
                setupStatus: setupStatusMap[p.id] ?? null,
                error: errorMap[p.id] ?? null,
            },
        ];
    });
    const filteredInstalledProviders = installedProviders.filter((provider) =>
        matchesSettingsSearch(
            searchQuery,
            "Installed",
            ...getProviderSearchValues(
                provider,
                provider.setupStatus,
                provider.error,
            ),
        ),
    );
    const filteredProviderCatalog = PROVIDER_CATALOG.filter((provider) =>
        matchesSettingsSearch(
            searchQuery,
            "All",
            "Install",
            "Installed",
            ...getProviderSearchValues(
                provider,
                setupStatusMap[provider.id] ?? null,
                errorMap[provider.id] ?? null,
            ),
        ),
    );
    const diagnosticsSearchValues = [
        "Diagnostics",
        "AI runtime environment",
        "Inspect the PATH inherited by the app",
        "PATH injected into runtimes",
        "binaries",
        "Process PATH",
        "Injected Runtime PATH",
        "Tool resolution",
        "Runtime launch resolution",
        diagnosticsError,
        ...(diagnostics?.inheritedEntries ?? []),
        ...(diagnostics?.preferredEntries ?? []),
        ...(diagnostics?.executables.flatMap((item) => [
            item.name,
            item.path,
        ]) ?? []),
        ...(diagnostics?.runtimes.flatMap((runtime) => [
            runtime.runtimeId,
            runtime.runtimeName,
            runtime.launchProgram,
            ...(runtime.launchArgs ?? []),
            runtime.resolutionDisplay,
            runtime.setupError,
        ]) ?? []),
    ];
    const showInstalledSection =
        isLoading ||
        matchesSettingsSearch(searchQuery, "Installed", "Loading providers") ||
        filteredInstalledProviders.length > 0;
    const showDiagnosticsSection = matchesSettingsSearch(
        searchQuery,
        ...diagnosticsSearchValues,
    );
    const showAllSection =
        matchesSettingsSearch(searchQuery, "All", "Install", "Installed") ||
        filteredProviderCatalog.length > 0;

    const handleToggleDiagnostics = useCallback(() => {
        setShowDiagnostics((prev) => {
            const next = !prev;
            if (next && !diagnostics && !diagnosticsLoading) {
                void loadDiagnostics();
            }
            return next;
        });
    }, [diagnostics, diagnosticsLoading, loadDiagnostics]);

    if (!showInstalledSection && !showDiagnosticsSection && !showAllSection) {
        return <EmptyProviderSearchResult />;
    }

    /* ── Render ── */

    return (
        <>
            {/* ── Installed ── */}
            {showInstalledSection ? (
                <>
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: "var(--text-secondary)",
                            paddingBottom: 6,
                        }}
                    >
                        Installed
                    </div>

                    <div
                        style={{
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            overflow: "hidden",
                        }}
                    >
                        {isLoading && runtimes.length === 0 ? (
                            <div
                                style={{
                                    padding: "14px",
                                    fontSize: 12,
                                    color: "var(--text-secondary)",
                                    backgroundColor: "var(--bg-secondary)",
                                }}
                            >
                                Loading providers…
                            </div>
                        ) : (
                            filteredInstalledProviders.map((provider, i) => {
                        const isExpanded = expandedId === provider.id;
                        const isSaving = savingId === provider.id;
                        const connected =
                            provider.setupStatus?.authReady === true;
                        const methodName = getMethodDisplayName(
                            provider.setupStatus,
                        );

                        return (
                            <Fragment key={provider.id}>
                                {i > 0 && (
                                    <div
                                        style={{
                                            height: 1,
                                            backgroundColor: "var(--border)",
                                        }}
                                    />
                                )}
                                <div
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                    }}
                                >
                                    {/* Header row */}
                                    <div
                                        role="button"
                                        aria-expanded={isExpanded}
                                        tabIndex={0}
                                        onClick={() =>
                                            setExpandedId((prev) =>
                                                prev === provider.id
                                                    ? null
                                                    : provider.id,
                                            )
                                        }
                                        onKeyDown={(e) => {
                                            if (
                                                e.key === "Enter" ||
                                                e.key === " "
                                            ) {
                                                e.preventDefault();
                                                setExpandedId((prev) =>
                                                    prev === provider.id
                                                        ? null
                                                        : provider.id,
                                                );
                                            }
                                        }}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            height: 48,
                                            padding: "0 14px",
                                            cursor: "pointer",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 10,
                                            }}
                                        >
                                            <span
                                                style={{
                                                    fontSize: 10,
                                                    color: "var(--text-secondary)",
                                                    width: 10,
                                                    textAlign: "center",
                                                }}
                                            >
                                                {isExpanded ? "▾" : "▸"}
                                            </span>
                                            <div
                                                style={{
                                                    width: 8,
                                                    height: 8,
                                                    borderRadius: "50%",
                                                    backgroundColor: connected
                                                        ? "#34d399"
                                                        : "#ef4444",
                                                    flexShrink: 0,
                                                }}
                                            />
                                            <span
                                                style={{
                                                    fontSize: 13,
                                                    fontWeight: 600,
                                                    color: "var(--text-primary)",
                                                }}
                                            >
                                                {provider.name}
                                            </span>
                                            {methodName && (
                                                <span
                                                    style={{
                                                        fontSize: 12,
                                                        color: "var(--text-secondary)",
                                                    }}
                                                >
                                                    {methodName}
                                                </span>
                                            )}
                                        </div>
                                        <div
                                            style={{
                                                padding: "3px 8px",
                                                borderRadius: 999,
                                                fontSize: 10,
                                                fontWeight: 600,
                                                backgroundColor: connected
                                                    ? "color-mix(in srgb, #34d399 15%, var(--bg-primary))"
                                                    : "color-mix(in srgb, #ef4444 15%, var(--bg-primary))",
                                                color: connected
                                                    ? "#34d399"
                                                    : "#ef4444",
                                            }}
                                        >
                                            {connected
                                                ? "Connected"
                                                : "Not configured"}
                                        </div>
                                    </div>

                                    {/* Expanded content */}
                                    {isExpanded &&
                                        (provider.setupStatus ? (
                                            <ProviderExpandedPanel
                                                setupStatus={
                                                    provider.setupStatus
                                                }
                                                error={provider.error}
                                                saving={isSaving}
                                                onAuth={(input) => {
                                                    void handleAuth(input);
                                                }}
                                                onClearGateway={() => {
                                                    void handleClearGateway(
                                                        provider.id,
                                                    );
                                                }}
                                                onLogout={() => {
                                                    void handleLogout(
                                                        provider.id,
                                                    );
                                                }}
                                            />
                                        ) : (
                                            <ProviderSetupUnavailablePanel
                                                error={provider.error}
                                                loading={isLoading}
                                                onRetry={() => {
                                                    void refreshRuntime(
                                                        provider.id,
                                                    );
                                                }}
                                            />
                                        ))}
                                </div>
                            </Fragment>
                        );
                            })
                        )}
                    </div>
                </>
            ) : null}

            {showDiagnosticsSection ? (
                <>
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: "var(--text-secondary)",
                            paddingTop: 20,
                            paddingBottom: 6,
                        }}
                    >
                        Diagnostics
                    </div>

                    <div
                        style={{
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            overflow: "hidden",
                            backgroundColor: "var(--bg-secondary)",
                        }}
                    >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "12px 14px",
                    }}
                >
                    <div style={{ display: "flex", flexDirection: "column" }}>
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                            }}
                        >
                            AI runtime environment
                        </div>
                        <div
                            style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                                marginTop: 2,
                            }}
                        >
                            Inspect the PATH inherited by {APP_BRAND_NAME}, the
                            PATH injected into runtimes, and which binaries are
                            actually resolvable.
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                        <button
                            type="button"
                            onClick={() => {
                                void loadDiagnostics();
                            }}
                            disabled={diagnosticsLoading}
                            style={{
                                padding: "6px 10px",
                                borderRadius: 6,
                                fontSize: 11,
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border)",
                                backgroundColor: "transparent",
                                cursor: diagnosticsLoading
                                    ? "not-allowed"
                                    : "pointer",
                                opacity: diagnosticsLoading ? 0.5 : 1,
                            }}
                        >
                            {diagnosticsLoading ? "Refreshing…" : "Refresh"}
                        </button>
                        <button
                            type="button"
                            onClick={handleToggleDiagnostics}
                            style={{
                                padding: "6px 10px",
                                borderRadius: 6,
                                fontSize: 11,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-primary)",
                                cursor: "pointer",
                            }}
                        >
                            {showDiagnostics ? "Hide" : "Show"}
                        </button>
                    </div>
                </div>

                {showDiagnostics && (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 14,
                            padding: "0 14px 14px",
                        }}
                    >
                        {diagnosticsError && (
                            <div
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: 8,
                                    fontSize: 12,
                                    border: "1px solid #7f1d1d",
                                    backgroundColor:
                                        "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                                    color: "#fecaca",
                                }}
                            >
                                {diagnosticsError}
                            </div>
                        )}

                        {diagnostics && (
                            <>
                                <DiagnosticsPathBlock
                                    label="Process PATH"
                                    helper={`This is the PATH inherited by the ${APP_BRAND_NAME} desktop process itself.`}
                                    entries={diagnostics.inheritedEntries}
                                />
                                <DiagnosticsPathBlock
                                    label="Injected Runtime PATH"
                                    helper={`This is the normalized PATH that ${APP_BRAND_NAME} now injects into Codex, Claude, Gemini, and Kilo child processes.`}
                                    entries={diagnostics.preferredEntries}
                                />

                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                    }}
                                >
                                    <div
                                        style={{
                                            fontSize: 11,
                                            fontWeight: 600,
                                            color: "var(--text-primary)",
                                        }}
                                    >
                                        Tool resolution
                                    </div>
                                    <div
                                        style={{
                                            display: "grid",
                                            gap: 8,
                                            gridTemplateColumns:
                                                "repeat(auto-fit, minmax(180px, 1fr))",
                                        }}
                                    >
                                        {diagnostics.executables.map((item) => (
                                            <div
                                                key={item.name}
                                                style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: 6,
                                                    padding: 12,
                                                    borderRadius: 8,
                                                    border: "1px solid var(--border)",
                                                    backgroundColor:
                                                        "var(--bg-primary)",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        color: "var(--text-primary)",
                                                    }}
                                                >
                                                    {item.name}
                                                </div>
                                                <pre
                                                    style={diagnosticCodeStyle}
                                                >
                                                    {item.path ?? "Not found"}
                                                </pre>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                    }}
                                >
                                    <div
                                        style={{
                                            fontSize: 11,
                                            fontWeight: 600,
                                            color: "var(--text-primary)",
                                        }}
                                    >
                                        Runtime launch resolution
                                    </div>
                                    <div
                                        style={{
                                            display: "grid",
                                            gap: 8,
                                            gridTemplateColumns:
                                                "repeat(auto-fit, minmax(260px, 1fr))",
                                        }}
                                    >
                                        {diagnostics.runtimes.map((runtime) => (
                                            <DiagnosticsRuntimeCard
                                                key={runtime.runtimeId}
                                                runtime={runtime}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}

                        {diagnosticsLoading &&
                            !diagnostics &&
                            !diagnosticsError && (
                                <div
                                    style={{
                                        padding: "10px 12px",
                                        borderRadius: 8,
                                        fontSize: 12,
                                        color: "var(--text-secondary)",
                                        backgroundColor: "var(--bg-primary)",
                                        border: "1px solid var(--border)",
                                    }}
                                >
                                    Loading diagnostics…
                                </div>
                            )}
                    </div>
                )}
                    </div>
                </>
            ) : null}

            {/* ── All ── */}
            {showAllSection ? (
                <>
                    <div
                        style={{
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: "var(--text-secondary)",
                            paddingTop: 20,
                            paddingBottom: 6,
                        }}
                    >
                        All
                    </div>

                    <div
                        style={{
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            overflow: "hidden",
                        }}
                    >
                        {filteredProviderCatalog.map((provider, i) => {
                    const installed = runtimes.some(
                        (r) => r.runtime.id === provider.id,
                    );
                    return (
                        <Fragment key={provider.id}>
                            {i > 0 && (
                                <div
                                    style={{
                                        height: 1,
                                        backgroundColor: "var(--border)",
                                    }}
                                />
                            )}
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    height: 44,
                                    padding: "0 14px",
                                    backgroundColor: "var(--bg-secondary)",
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 10,
                                    }}
                                >
                                    <span
                                        style={{
                                            fontSize: 13,
                                            fontWeight: 500,
                                            color: "var(--text-primary)",
                                        }}
                                    >
                                        {provider.name}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        {provider.company}
                                    </span>
                                </div>
                                {installed ? (
                                    <span
                                        style={{
                                            fontSize: 11,
                                            fontWeight: 600,
                                            color: "#34d399",
                                        }}
                                    >
                                        Installed
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        style={{
                                            padding: "4px 10px",
                                            borderRadius: 6,
                                            fontSize: 11,
                                            fontWeight: 600,
                                            border: "1px solid color-mix(in srgb, #34d399 40%, transparent)",
                                            backgroundColor: "transparent",
                                            color: "#34d399",
                                            cursor: "pointer",
                                        }}
                                    >
                                        Install
                                    </button>
                                )}
                            </div>
                        </Fragment>
                    );
                        })}
                    </div>
                </>
            ) : null}

            {/* ── Auth terminal modal ── */}
            {authTerminalRequest && (
                <AIAuthTerminalModal
                    open
                    runtimeId={authTerminalRequest.runtimeId}
                    methodId={authTerminalRequest.methodId}
                    runtimeName={authTerminalRequest.runtimeName}
                    vaultPath={vaultPath}
                    customBinaryPath={authTerminalRequest.customBinaryPath}
                    onClose={() => setAuthTerminalRequest(null)}
                    onRefreshSetup={async (runtimeId) => {
                        await refreshRuntime(runtimeId);
                    }}
                />
            )}
        </>
    );
}
