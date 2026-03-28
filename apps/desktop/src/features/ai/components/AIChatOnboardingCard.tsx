import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AIRuntimeOption, AIRuntimeSetupStatus } from "../types";

interface AIChatOnboardingCardProps {
    runtime?: AIRuntimeOption | null;
    setupStatus: AIRuntimeSetupStatus;
    saving?: boolean;
    mode?: "onboarding" | "settings";
    onSaveSetup: (input: {
        runtimeId?: string;
        customBinaryPath?: string;
        geminiApiKey?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders?: string;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders?: string;
        anthropicAuthToken?: string;
    }) => void;
    onAuthenticate: (input: {
        runtimeId?: string;
        methodId: string;
        customBinaryPath?: string;
        openaiApiKey?: string;
        codexApiKey?: string;
        geminiApiKey?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders?: string;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders?: string;
        anthropicAuthToken?: string;
    }) => void;
}

const inputStyle = {
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    outline: "none",
} as const;

export function AIChatOnboardingCard({
    runtime = null,
    setupStatus,
    saving = false,
    mode = "onboarding",
    onSaveSetup,
    onAuthenticate,
}: AIChatOnboardingCardProps) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [customBinaryPath, setCustomBinaryPath] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [gatewayBaseUrl, setGatewayBaseUrl] = useState("");
    const [gatewayHeaders, setGatewayHeaders] = useState("");
    const [gatewayAuthToken, setGatewayAuthToken] = useState("");
    const [manualSelectedMethodId, setManualSelectedMethodId] = useState(
        getDefaultMethodId(setupStatus),
    );
    const selectedMethodId = setupStatus.authMethods.some(
        (method) => method.id === manualSelectedMethodId,
    )
        ? manualSelectedMethodId
        : getDefaultMethodId(setupStatus);

    const runtimeMissing = !setupStatus.binaryReady;
    const authMissing = setupStatus.binaryReady && !setupStatus.authReady;
    const activeAuthMethodName =
        setupStatus.authMethods.find(
            (method) => method.id === setupStatus.authMethod,
        )?.name ?? null;
    const statusLabel = runtimeMissing
        ? "Runtime unavailable"
        : authMissing
          ? "Authentication required"
          : "Ready";
    const selectedMethod =
        setupStatus.authMethods.find(
            (method) => method.id === selectedMethodId,
        ) ?? null;
    const runtimeName = runtime?.name ?? getRuntimeDisplayName(setupStatus);
    const isOpenAiApiKeyMethod = selectedMethod?.id === "openai-api-key";
    const isCodexApiKeyMethod = selectedMethod?.id === "codex-api-key";
    const isGeminiApiKeyMethod = selectedMethod?.id === "use_gemini";
    const isGatewayMethod = selectedMethod?.id === "gateway";
    const isApiKeyMethod =
        isOpenAiApiKeyMethod || isCodexApiKeyMethod || isGeminiApiKeyMethod;
    const apiKeyPlaceholder = getApiKeyPlaceholder(selectedMethod?.id);
    const isSettingsMode = mode === "settings";
    const title = isSettingsMode
        ? `Manage ${runtimeName}`
        : `Connect ${runtimeName} to start chatting`;
    const subtitle = isSettingsMode
        ? "Update credentials, reconnect authentication, or override the runtime path."
        : "VaultAI keeps a runtime-specific local setup. Existing external editor settings are not modified.";

    return (
        <div className="px-3 pt-3">
            <div
                className="rounded-xl p-4"
                style={{
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                }}
            >
                <div
                    className="text-[11px] uppercase tracking-[0.16em]"
                    style={{ color: "var(--accent)" }}
                >
                    AI setup
                </div>
                <div
                    className="mt-1 text-base font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    {title}
                </div>
                <div
                    className="mt-2 text-sm"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {subtitle}
                </div>

                <div
                    className="mt-3 rounded-lg px-3 py-2 text-xs"
                    style={{
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--bg-primary)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Status:{" "}
                    <span style={{ color: "var(--text-primary)" }}>
                        {statusLabel}
                    </span>
                    {activeAuthMethodName ? (
                        <span>
                            {" · "}Method:{" "}
                            <span style={{ color: "var(--text-primary)" }}>
                                {activeAuthMethodName}
                            </span>
                        </span>
                    ) : null}
                </div>

                {runtimeMissing ? (
                    <div
                        className="mt-3 rounded-lg px-3 py-2 text-sm"
                        style={{
                            color: "#fecaca",
                            border: "1px solid #7f1d1d",
                            backgroundColor:
                                "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
                        }}
                    >
                        {runtimeName} is not available yet in this build. End
                        users should not have to configure a binary path
                        manually.
                        {setupStatus.hasCustomBinaryPath ? (
                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        onSaveSetup({
                                            runtimeId: setupStatus.runtimeId,
                                            customBinaryPath: "",
                                        })
                                    }
                                    disabled={saving}
                                    className="rounded-md px-3 py-1.5 text-xs font-medium"
                                    style={{
                                        color: "#fff",
                                        border: "1px solid #7f1d1d",
                                        backgroundColor: "#991b1b",
                                        opacity: saving ? 0.5 : 1,
                                    }}
                                >
                                    Reset custom path
                                </button>
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <div className="mt-3">
                        <div
                            className="text-sm font-medium"
                            style={{ color: "var(--text-primary)" }}
                        >
                            Authentication
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            {setupStatus.authMethods.map((method) => {
                                const selected =
                                    method.id === selectedMethod?.id;
                                return (
                                    <button
                                        key={method.id}
                                        type="button"
                                        onClick={() =>
                                            setManualSelectedMethodId(method.id)
                                        }
                                        className="rounded-lg px-3 py-2 text-left"
                                        style={{
                                            border: `1px solid ${
                                                selected
                                                    ? "var(--accent)"
                                                    : "var(--border)"
                                            }`,
                                            backgroundColor: selected
                                                ? "color-mix(in srgb, var(--accent) 10%, var(--bg-primary))"
                                                : "var(--bg-primary)",
                                        }}
                                    >
                                        <div
                                            className="text-sm font-medium"
                                            style={{
                                                color: selected
                                                    ? "var(--text-primary)"
                                                    : "var(--text-secondary)",
                                            }}
                                        >
                                            {method.name}
                                        </div>
                                        <div
                                            className="mt-1 text-[11px]"
                                            style={{
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            {method.description}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {selectedMethod ? (
                            <div
                                className="mt-3 rounded-lg px-3 py-3"
                                style={{
                                    border: "1px solid var(--border)",
                                    backgroundColor: "var(--bg-primary)",
                                }}
                            >
                                <div
                                    className="text-sm font-medium"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    {selectedMethod.name}
                                </div>
                                <div
                                    className="mt-1 text-xs"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {getAuthMethodHelpText(
                                        selectedMethod.id,
                                        runtimeName,
                                    )}
                                </div>
                                {selectedMethod.id === "gateway" &&
                                setupStatus.hasGatewayConfig ? (
                                    <div className="mt-3">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setGatewayBaseUrl("");
                                                setGatewayHeaders("");
                                                setGatewayAuthToken("");
                                                onSaveSetup({
                                                    runtimeId:
                                                        setupStatus.runtimeId,
                                                    anthropicBaseUrl: "",
                                                    anthropicCustomHeaders: "",
                                                    anthropicAuthToken: "",
                                                });
                                            }}
                                            disabled={saving}
                                            className="rounded-md px-3 py-1.5 text-xs"
                                            style={{
                                                color: "var(--text-primary)",
                                                backgroundColor:
                                                    "var(--bg-secondary)",
                                                border: "1px solid var(--border)",
                                                opacity: saving ? 0.5 : 1,
                                            }}
                                        >
                                            Clear gateway settings
                                        </button>
                                    </div>
                                ) : null}

                                {isApiKeyMethod ? (
                                    <>
                                        <input
                                            type="password"
                                            value={apiKey}
                                            onChange={(event) =>
                                                setApiKey(event.target.value)
                                            }
                                            placeholder={apiKeyPlaceholder}
                                            className="mt-3 w-full rounded-md px-3 py-2 text-sm"
                                            style={inputStyle}
                                        />
                                        <div
                                            className="mt-1 text-[11px]"
                                            style={{
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            Stored locally for VaultAI only.
                                        </div>
                                    </>
                                ) : null}

                                {isGatewayMethod ? (
                                    <>
                                        <input
                                            type="url"
                                            value={gatewayBaseUrl}
                                            onChange={(event) =>
                                                setGatewayBaseUrl(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder="Gateway base URL"
                                            className="mt-3 w-full rounded-md px-3 py-2 text-sm"
                                            style={inputStyle}
                                        />
                                        <textarea
                                            value={gatewayHeaders}
                                            onChange={(event) =>
                                                setGatewayHeaders(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder={
                                                "Headers, one per line\nx-api-key: secret"
                                            }
                                            className="mt-3 min-h-22 w-full rounded-md px-3 py-2 text-sm"
                                            style={inputStyle}
                                        />
                                        <input
                                            type="password"
                                            value={gatewayAuthToken}
                                            onChange={(event) =>
                                                setGatewayAuthToken(
                                                    event.target.value,
                                                )
                                            }
                                            placeholder="Gateway auth token (optional)"
                                            className="mt-3 w-full rounded-md px-3 py-2 text-sm"
                                            style={inputStyle}
                                        />
                                        <div
                                            className="mt-1 text-[11px]"
                                            style={{
                                                color: "var(--text-secondary)",
                                            }}
                                        >
                                            Headers are stored locally for
                                            VaultAI only.
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                )}

                <div className="mt-4">
                    <button
                        type="button"
                        onClick={() =>
                            setAdvancedOpen((openState) => !openState)
                        }
                        className="rounded-md px-2 py-1 text-xs"
                        style={{
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                            border: "1px solid transparent",
                        }}
                    >
                        {advancedOpen ? "Hide advanced" : "Advanced setup"}
                    </button>

                    {advancedOpen ? (
                        <div
                            className="mt-2 rounded-lg px-3 py-3"
                            style={{
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-primary)",
                            }}
                        >
                            <div
                                className="text-xs font-medium"
                                style={{ color: "var(--text-primary)" }}
                            >
                                Custom runtime path
                            </div>
                            <div
                                className="mt-1 text-[11px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Development only. Normal users should rely on
                                the bundled runtime.
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <input
                                    value={customBinaryPath}
                                    onChange={(event) =>
                                        setCustomBinaryPath(event.target.value)
                                    }
                                    placeholder={`Path to ${setupStatus.runtimeId} binary`}
                                    className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm"
                                    style={inputStyle}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        void open({
                                            directory: false,
                                            multiple: false,
                                            title: `Select ${runtimeName} binary`,
                                        }).then((selected) => {
                                            if (typeof selected === "string") {
                                                setCustomBinaryPath(selected);
                                            }
                                        });
                                    }}
                                    className="shrink-0 rounded-md px-3 py-2 text-xs"
                                    style={{
                                        color: "var(--text-primary)",
                                        backgroundColor: "var(--bg-tertiary)",
                                        border: "1px solid var(--border)",
                                    }}
                                >
                                    Browse
                                </button>
                                {setupStatus.hasCustomBinaryPath ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setCustomBinaryPath("");
                                            onSaveSetup({
                                                runtimeId:
                                                    setupStatus.runtimeId,
                                                customBinaryPath: "",
                                            });
                                        }}
                                        disabled={saving}
                                        className="shrink-0 rounded-md px-3 py-2 text-xs"
                                        style={{
                                            color: "var(--text-primary)",
                                            backgroundColor:
                                                "var(--bg-secondary)",
                                            border: "1px solid var(--border)",
                                            opacity: saving ? 0.5 : 1,
                                        }}
                                    >
                                        Reset
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </div>

                {setupStatus.message ? (
                    <div
                        className="mt-3 rounded-lg px-3 py-2 text-[11px]"
                        style={{
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-primary)",
                        }}
                    >
                        {setupStatus.message}
                    </div>
                ) : null}

                <div className="mt-4 flex justify-end">
                    <button
                        type="button"
                        onClick={() =>
                            onAuthenticate({
                                runtimeId: setupStatus.runtimeId,
                                methodId:
                                    selectedMethod?.id ?? "openai-api-key",
                                customBinaryPath: customBinaryPath || undefined,
                                openaiApiKey: isOpenAiApiKeyMethod
                                    ? apiKey || undefined
                                    : undefined,
                                codexApiKey: isCodexApiKeyMethod
                                    ? apiKey || undefined
                                    : undefined,
                                geminiApiKey: isGeminiApiKeyMethod
                                    ? apiKey || undefined
                                    : undefined,
                                gatewayBaseUrl: isGatewayMethod
                                    ? gatewayBaseUrl || undefined
                                    : undefined,
                                gatewayHeaders: isGatewayMethod
                                    ? gatewayHeaders || undefined
                                    : undefined,
                                anthropicBaseUrl: isGatewayMethod
                                    ? gatewayBaseUrl || undefined
                                    : undefined,
                                anthropicCustomHeaders: isGatewayMethod
                                    ? gatewayHeaders || undefined
                                    : undefined,
                                anthropicAuthToken: isGatewayMethod
                                    ? gatewayAuthToken || undefined
                                    : undefined,
                            })
                        }
                        disabled={
                            saving ||
                            runtimeMissing ||
                            !selectedMethod ||
                            (isApiKeyMethod && !apiKey.trim()) ||
                            (isGatewayMethod && !gatewayBaseUrl.trim())
                        }
                        className="rounded-md px-3 py-1.5 text-xs font-medium"
                        style={{
                            color: "#fff",
                            border: "none",
                            opacity:
                                saving ||
                                runtimeMissing ||
                                !selectedMethod ||
                                (isApiKeyMethod && !apiKey.trim()) ||
                                (isGatewayMethod && !gatewayBaseUrl.trim())
                                    ? 0.45
                                    : 1,
                            background:
                                "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 56%, black))",
                        }}
                    >
                        {saving
                            ? "Connecting…"
                            : isApiKeyMethod
                              ? isSettingsMode &&
                                setupStatus.authMethod === selectedMethod?.id &&
                                setupStatus.authReady
                                  ? "Replace key"
                                  : "Save and continue"
                              : isGatewayMethod
                                ? "Save gateway"
                                : getContinueLabel(selectedMethod?.id)}
                    </button>
                </div>
            </div>
        </div>
    );
}

function getRuntimeDisplayName(setupStatus: AIRuntimeSetupStatus) {
    if (setupStatus.runtimeId === "claude-acp") {
        return "Claude";
    }
    if (setupStatus.runtimeId === "codex-acp") {
        return "Codex";
    }
    if (setupStatus.runtimeId === "gemini-acp") {
        return "Gemini";
    }
    return setupStatus.runtimeId;
}

function getApiKeyPlaceholder(methodId?: string) {
    if (methodId === "codex-api-key") {
        return "Codex API key";
    }
    if (methodId === "openai-api-key") {
        return "OpenAI API key";
    }
    if (methodId === "use_gemini") {
        return "Gemini API key";
    }
    return "API key";
}

function getAuthMethodHelpText(methodId: string, runtimeName: string) {
    if (methodId === "chatgpt") {
        return "VaultAI will open the browser to complete sign-in.";
    }
    if (methodId === "claude-login") {
        return "VaultAI will open a limited sign-in terminal inside the app.";
    }
    if (methodId === "login_with_google") {
        return "VaultAI will open a Gemini sign-in terminal inside the app.";
    }
    if (methodId === "gateway") {
        return `Configure a custom ${runtimeName} gateway for this app only.`;
    }
    if (methodId === "codex-api-key") {
        return "Store a Codex API key locally for VaultAI only.";
    }
    if (methodId === "openai-api-key") {
        return "Store an OpenAI API key locally for VaultAI only.";
    }
    if (methodId === "use_gemini") {
        return "Store a Gemini API key locally for VaultAI only.";
    }
    return `Complete ${runtimeName} authentication in VaultAI.`;
}

function getContinueLabel(methodId?: string) {
    if (methodId === "chatgpt") {
        return "Continue with ChatGPT";
    }
    if (methodId === "claude-login") {
        return "Open sign-in terminal";
    }
    if (methodId === "login_with_google") {
        return "Open sign-in terminal";
    }
    return "Continue";
}

function getDefaultMethodId(setupStatus: AIRuntimeSetupStatus): string {
    const current = setupStatus.authMethod;
    if (
        current &&
        setupStatus.authMethods.some((method) => method.id === current)
    ) {
        return current;
    }

    const chatGptMethod = setupStatus.authMethods.find(
        (method) => method.id === "chatgpt",
    );
    if (chatGptMethod) {
        return chatGptMethod.id;
    }

    return setupStatus.authMethods[0]?.id ?? "openai-api-key";
}
