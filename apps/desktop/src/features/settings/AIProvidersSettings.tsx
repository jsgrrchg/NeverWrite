import { Fragment, useCallback, useEffect, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    aiGetSetupStatus,
    aiListRuntimes,
    aiStartAuth,
    aiUpdateSetup,
} from "../ai/api";
import { AIAuthTerminalModal } from "../ai/components/AIAuthTerminalModal";
import type { AIRuntimeDescriptor, AIRuntimeSetupStatus } from "../ai/types";

/* ── Provider registry ─────────────────────────────────────────── */

interface ProviderMeta {
    id: string;
    name: string;
    company: string;
}

const PROVIDERS: ProviderMeta[] = [
    { id: "codex-acp", name: "Codex", company: "OpenAI" },
    { id: "claude-acp", name: "Claude", company: "Anthropic" },
    { id: "gemini-acp", name: "Gemini", company: "Google" },
];

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
        case "claude-login":
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
        case "claude-login":
            return "Opens a sign-in terminal inside the app.";
        case "openai-api-key":
            return "Store an OpenAI API key locally for VaultAI only.";
        case "codex-api-key":
            return "Store a Codex API key locally for VaultAI only.";
        case "gateway":
            return "Route requests through a custom gateway endpoint.";
        case "login_with_google":
            return "Opens a Gemini sign-in terminal inside the app.";
        case "use_gemini":
            return "Store a Gemini API key locally for VaultAI only.";
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
    if (methodId === "claude-login") return "Open sign-in terminal";
    if (methodId === "login_with_google") return "Open sign-in terminal";
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

/* ── Expanded panel ─────────────────────────────────────────────── */

function ProviderExpandedPanel({
    setupStatus,
    error,
    saving,
    onAuth,
    onLogout,
}: {
    setupStatus: AIRuntimeSetupStatus;
    error: string | null;
    saving: boolean;
    onAuth: (input: {
        runtimeId: string;
        methodId: string;
        codexApiKey?: string;
        openaiApiKey?: string;
        geminiApiKey?: string;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders?: string;
        anthropicAuthToken?: string;
    }) => void;
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

    const canSubmit =
        !saving &&
        selectedMethod != null &&
        (!apiKeySelected || apiKey.trim() !== "") &&
        (!gatewaySelected || gatewayUrl.trim() !== "");

    const handleSubmit = () => {
        onAuth({
            runtimeId: setupStatus.runtimeId,
            methodId: selectedMethodId,
            openaiApiKey: isOpenAi ? apiKey || undefined : undefined,
            codexApiKey: isCodex ? apiKey || undefined : undefined,
            geminiApiKey: isGemini ? apiKey || undefined : undefined,
            anthropicBaseUrl: gatewaySelected
                ? gatewayUrl || undefined
                : undefined,
            anthropicCustomHeaders: gatewaySelected
                ? gatewayHeaders || undefined
                : undefined,
            anthropicAuthToken: gatewaySelected
                ? gatewayToken || undefined
                : undefined,
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

/* ── Main component ─────────────────────────────────────────────── */

export function AIProvidersSettings() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [runtimes, setRuntimes] = useState<AIRuntimeDescriptor[]>([]);
    const [setupStatusMap, setSetupStatusMap] = useState<
        Record<string, AIRuntimeSetupStatus>
    >({});
    const [errorMap, setErrorMap] = useState<Record<string, string>>({});
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [authTerminalRequest, setAuthTerminalRequest] = useState<{
        runtimeId: string;
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
            codexApiKey?: string;
            openaiApiKey?: string;
            geminiApiKey?: string;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders?: string;
            anthropicAuthToken?: string;
        }) => {
            const runtime = runtimes.find(
                (r) => r.runtime.id === input.runtimeId,
            );

            if (
                (input.runtimeId === "claude-acp" &&
                    input.methodId === "claude-login") ||
                (input.runtimeId === "gemini-acp" &&
                    input.methodId === "login_with_google")
            ) {
                setAuthTerminalRequest({
                    runtimeId: input.runtimeId,
                    runtimeName:
                        runtime?.runtime.name.replace(/ ACP$/, "") ??
                        (input.runtimeId === "claude-acp"
                            ? "Claude"
                            : "Gemini"),
                    customBinaryPath: input.customBinaryPath,
                });
                return;
            }

            setSavingId(input.runtimeId);
            try {
                if (
                    input.customBinaryPath !== undefined ||
                    input.codexApiKey !== undefined ||
                    input.openaiApiKey !== undefined ||
                    input.geminiApiKey !== undefined ||
                    input.anthropicBaseUrl !== undefined ||
                    input.anthropicCustomHeaders !== undefined ||
                    input.anthropicAuthToken !== undefined
                ) {
                    const preflight = await aiUpdateSetup({
                        runtimeId: input.runtimeId,
                        customBinaryPath: input.customBinaryPath,
                        codexApiKey: input.codexApiKey,
                        openaiApiKey: input.openaiApiKey,
                        geminiApiKey: input.geminiApiKey,
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
                    codexApiKey: "",
                    openaiApiKey: "",
                    geminiApiKey: "",
                    anthropicBaseUrl: "",
                    anthropicCustomHeaders: "",
                    anthropicAuthToken: "",
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

    /* ── Derived data ── */

    const installedProviders = PROVIDERS.flatMap((p) => {
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

    /* ── Render ── */

    return (
        <>
            {/* ── Installed ── */}
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
                    installedProviders.map((provider, i) => {
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
                                    {isExpanded && provider.setupStatus && (
                                        <ProviderExpandedPanel
                                            setupStatus={provider.setupStatus}
                                            error={provider.error}
                                            saving={isSaving}
                                            onAuth={(input) => {
                                                void handleAuth(input);
                                            }}
                                            onLogout={() => {
                                                void handleLogout(provider.id);
                                            }}
                                        />
                                    )}
                                </div>
                            </Fragment>
                        );
                    })
                )}
            </div>

            {/* ── All ── */}
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
                {PROVIDERS.map((provider, i) => {
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

            {/* ── Auth terminal modal ── */}
            {authTerminalRequest && (
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
            )}
        </>
    );
}
