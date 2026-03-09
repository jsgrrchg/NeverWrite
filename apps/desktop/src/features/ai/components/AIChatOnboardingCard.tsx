import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AIRuntimeSetupStatus } from "../types";

interface AIChatOnboardingCardProps {
    setupStatus: AIRuntimeSetupStatus;
    saving?: boolean;
    onAuthenticate: (input: {
        methodId: string;
        customBinaryPath?: string;
        openaiApiKey?: string;
        codexApiKey?: string;
    }) => void;
}

const inputStyle = {
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border)",
    outline: "none",
} as const;

export function AIChatOnboardingCard({
    setupStatus,
    saving = false,
    onAuthenticate,
}: AIChatOnboardingCardProps) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [customBinaryPath, setCustomBinaryPath] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [selectedMethodId, setSelectedMethodId] = useState(
        getDefaultMethodId(setupStatus),
    );

    useEffect(() => {
        setSelectedMethodId((current) => {
            if (setupStatus.authMethods.some((method) => method.id === current)) {
                return current;
            }
            return getDefaultMethodId(setupStatus);
        });
    }, [setupStatus]);

    const runtimeMissing = !setupStatus.binaryReady;
    const authMissing = setupStatus.binaryReady && !setupStatus.authReady;
    const statusLabel = runtimeMissing
        ? "Runtime unavailable"
        : authMissing
          ? "Authentication required"
          : "Ready";
    const selectedMethod =
        setupStatus.authMethods.find((method) => method.id === selectedMethodId) ?? null;
    const isApiKeyMethod = selectedMethod?.id === "openai-api-key";

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
                    Connect Codex to start chatting
                </div>
                <div
                    className="mt-2 text-sm"
                    style={{ color: "var(--text-secondary)" }}
                >
                    VaultAI uses its own embedded runtime and keeps its own local config.
                    Your Zed setup is not modified.
                </div>

                <div
                    className="mt-3 rounded-lg px-3 py-2 text-xs"
                    style={{
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--bg-primary)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Status: <span style={{ color: "var(--text-primary)" }}>{statusLabel}</span>
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
                        This build does not include the Codex runtime yet. End users should
                        not have to configure a binary path manually.
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
                                const selected = method.id === selectedMethod?.id;
                                return (
                                    <button
                                        key={method.id}
                                        type="button"
                                        onClick={() => setSelectedMethodId(method.id)}
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
                                            style={{ color: "var(--text-secondary)" }}
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
                                    {selectedMethod.id === "chatgpt"
                                        ? "VaultAI will open the browser to complete sign-in."
                                        : "Store your OpenAI API key locally for VaultAI only."}
                                </div>

                                {isApiKeyMethod ? (
                                    <>
                                        <input
                                            type="password"
                                            value={apiKey}
                                            onChange={(event) => setApiKey(event.target.value)}
                                            placeholder="OpenAI API key"
                                            className="mt-3 w-full rounded-md px-3 py-2 text-sm"
                                            style={inputStyle}
                                        />
                                        <div
                                            className="mt-1 text-[11px]"
                                            style={{ color: "var(--text-secondary)" }}
                                        >
                                            Stored locally for VaultAI only.
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
                        onClick={() => setAdvancedOpen((openState) => !openState)}
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
                                Development only. Normal users should rely on the bundled
                                runtime.
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <input
                                    value={customBinaryPath}
                                    onChange={(event) =>
                                        setCustomBinaryPath(event.target.value)
                                    }
                                    placeholder="Path to codex-acp binary"
                                    className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm"
                                    style={inputStyle}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        void open({
                                            directory: false,
                                            multiple: false,
                                            title: "Select Codex ACP binary",
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
                                methodId: selectedMethod?.id ?? "openai-api-key",
                                customBinaryPath: customBinaryPath || undefined,
                                openaiApiKey: isApiKeyMethod
                                    ? apiKey || undefined
                                    : undefined,
                            })
                        }
                        disabled={
                            saving ||
                            runtimeMissing ||
                            !selectedMethod ||
                            (isApiKeyMethod && !apiKey.trim())
                        }
                        className="rounded-md px-3 py-1.5 text-xs font-medium"
                        style={{
                            color: "#fff",
                            border: "none",
                            opacity:
                                saving ||
                                runtimeMissing ||
                                !selectedMethod ||
                                (isApiKeyMethod && !apiKey.trim())
                                    ? 0.45
                                    : 1,
                            background:
                                "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 56%, black))",
                        }}
                    >
                        {saving
                            ? "Connecting…"
                            : isApiKeyMethod
                              ? "Save and continue"
                              : "Continue with ChatGPT"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function getDefaultMethodId(setupStatus: AIRuntimeSetupStatus): string {
    const current = setupStatus.authMethod;
    if (current && setupStatus.authMethods.some((method) => method.id === current)) {
        return current;
    }

    const chatGptMethod = setupStatus.authMethods.find((method) => method.id === "chatgpt");
    if (chatGptMethod) {
        return chatGptMethod.id;
    }

    return setupStatus.authMethods[0]?.id ?? "openai-api-key";
}
