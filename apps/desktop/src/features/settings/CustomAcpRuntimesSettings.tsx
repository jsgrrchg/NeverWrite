import { useCallback, useEffect, useMemo, useState } from "react";
import {
    aiCreateCustomRuntime,
    aiDeleteCustomRuntime,
    aiListCustomRuntimes,
    aiListDeletedCustomRuntimes,
    aiRestoreCustomRuntime,
    aiUpdateCustomRuntime,
    aiVerifyCustomRuntime,
} from "../ai/api";
import type {
    AICustomAcpExecutableVerification,
    AICustomAcpRuntimeDefinition,
    AICustomAcpRuntimeDefinitionInput,
    AICustomAcpRuntimeId,
} from "../ai/types";
import {
    EMPTY_SEARCH_QUERY,
    matchesSettingsSearch,
    type SettingsSearchQuery,
} from "./settingsSearch";

const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontFamily: "inherit",
    fontSize: 12,
    outline: "none",
};

const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
};

type FormState = {
    displayName: string;
    command: string;
    args: string;
    env: string;
};

function getErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
}

function createEmptyForm(): FormState {
    return { displayName: "", command: "", args: "", env: "" };
}

function definitionToForm(
    definition: AICustomAcpRuntimeDefinition,
): FormState {
    return {
        displayName: definition.displayName,
        command: definition.command,
        args: definition.args.join("\n"),
        env: Object.entries(definition.env)
            .map(([name, value]) => `${name}=${value}`)
            .join("\n"),
    };
}

function formToDefinition(
    form: FormState,
): AICustomAcpRuntimeDefinitionInput {
    const env: Record<string, string> = {};
    for (const rawLine of form.env.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const separator = line.indexOf("=");
        if (separator < 1) {
            throw new Error("Environment entries must use NAME=value.");
        }
        const name = line.slice(0, separator).trim();
        if (!name) {
            throw new Error("Environment entries must use NAME=value.");
        }
        env[name] = line.slice(separator + 1);
    }

    return {
        displayName: form.displayName.trim(),
        command: form.command.trim(),
        args: form.args
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        env,
        authMode: "external",
    };
}

function VerificationMessage({
    verification,
}: {
    verification: AICustomAcpExecutableVerification;
}) {
    const ready = verification.state === "ready";
    return (
        <div
            style={{
                padding: "8px 10px",
                borderRadius: 6,
                fontSize: 11,
                color: ready ? "#34d399" : "#fca5a5",
                border: `1px solid ${ready ? "#166534" : "#7f1d1d"}`,
                backgroundColor: ready
                    ? "color-mix(in srgb, #166534 12%, var(--bg-primary))"
                    : "color-mix(in srgb, #991b1b 12%, var(--bg-primary))",
            }}
        >
            {verification.message ??
                (ready ? "Executable is ready." : "Executable is unavailable.")}
        </div>
    );
}

function RuntimeForm({
    form,
    error,
    busy,
    verification,
    submitLabel,
    onChange,
    onVerify,
    onSubmit,
    onCancel,
}: {
    form: FormState;
    error: string | null;
    busy: boolean;
    verification: AICustomAcpExecutableVerification | null;
    submitLabel: string;
    onChange: (form: FormState) => void;
    onVerify: () => void;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "12px 14px 14px",
                borderTop: "1px solid var(--border)",
                backgroundColor: "var(--bg-primary)",
            }}
        >
            <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                    Runtime name
                </span>
                <input
                    aria-label="Runtime name"
                    value={form.displayName}
                    onChange={(event) =>
                        onChange({ ...form, displayName: event.target.value })
                    }
                    style={inputStyle}
                />
            </label>
            <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>Command</span>
                <input
                    aria-label="Command"
                    value={form.command}
                    onChange={(event) =>
                        onChange({ ...form, command: event.target.value })
                    }
                    style={inputStyle}
                />
            </label>
            <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                    Arguments
                </span>
                <textarea
                    aria-label="Arguments"
                    value={form.args}
                    onChange={(event) =>
                        onChange({ ...form, args: event.target.value })
                    }
                    placeholder="One argument per line"
                    rows={3}
                    style={{ ...inputStyle, resize: "vertical" }}
                />
            </label>
            <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>
                    Environment
                </span>
                <textarea
                    aria-label="Environment"
                    value={form.env}
                    onChange={(event) =>
                        onChange({ ...form, env: event.target.value })
                    }
                    placeholder="NAME=value, one per line"
                    rows={3}
                    style={{ ...inputStyle, resize: "vertical" }}
                />
            </label>
            <div
                style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                }}
            >
                Authentication managed by the runtime. NeverWrite does not
                store custom runtime secrets.
            </div>
            {error && (
                <div style={{ color: "#fca5a5", fontSize: 11 }}>{error}</div>
            )}
            {verification && <VerificationMessage verification={verification} />}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onVerify}
                    style={buttonStyle}
                >
                    Verify executable
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onSubmit}
                    style={{
                        ...buttonStyle,
                        borderColor: "var(--accent)",
                        backgroundColor: "var(--accent)",
                        color: "var(--bg-primary)",
                    }}
                >
                    {busy ? "Saving…" : submitLabel}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onCancel}
                    style={buttonStyle}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

export function CustomAcpRuntimesSettings({
    searchQuery = EMPTY_SEARCH_QUERY,
    onCatalogChanged,
}: {
    searchQuery?: SettingsSearchQuery;
    onCatalogChanged: () => Promise<void>;
}) {
    const [active, setActive] = useState<AICustomAcpRuntimeDefinition[]>([]);
    const [deleted, setDeleted] = useState<AICustomAcpRuntimeDefinition[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<AICustomAcpRuntimeId | "new" | null>(
        null,
    );
    const [form, setForm] = useState<FormState>(createEmptyForm);
    const [error, setError] = useState<string | null>(null);
    const [verification, setVerification] =
        useState<AICustomAcpExecutableVerification | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [nextActive, nextDeleted] = await Promise.all([
                aiListCustomRuntimes(),
                aiListDeletedCustomRuntimes(),
            ]);
            setActive(nextActive);
            setDeleted(nextDeleted);
            setError(null);
        } catch (loadError) {
            setError(getErrorMessage(loadError, "Failed to load custom runtimes."));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const closeForm = () => {
        setEditingId(null);
        setForm(createEmptyForm());
        setError(null);
        setVerification(null);
    };

    const startCreate = () => {
        setEditingId("new");
        setForm(createEmptyForm());
        setError(null);
        setVerification(null);
    };

    const startEdit = (definition: AICustomAcpRuntimeDefinition) => {
        setEditingId(definition.id);
        setForm(definitionToForm(definition));
        setError(null);
        setVerification(null);
    };

    const definitionFromForm = () => {
        try {
            return formToDefinition(form);
        } catch (formError) {
            setError(getErrorMessage(formError, "Invalid runtime definition."));
            return null;
        }
    };

    const handleVerify = async () => {
        const definition = definitionFromForm();
        if (!definition) return;
        setBusy(true);
        try {
            setVerification(await aiVerifyCustomRuntime(definition));
            setError(null);
        } catch (verifyError) {
            setError(getErrorMessage(verifyError, "Failed to verify executable."));
            setVerification(null);
        } finally {
            setBusy(false);
        }
    };

    const handleSubmit = async () => {
        const definition = definitionFromForm();
        if (!definition || !editingId) return;
        setBusy(true);
        try {
            if (editingId === "new") {
                await aiCreateCustomRuntime(definition);
            } else {
                await aiUpdateCustomRuntime({ id: editingId, definition });
            }
            await Promise.all([load(), onCatalogChanged()]);
            closeForm();
        } catch (submitError) {
            setError(getErrorMessage(submitError, "Failed to save custom runtime."));
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (id: AICustomAcpRuntimeId) => {
        setBusy(true);
        try {
            await aiDeleteCustomRuntime(id);
            await Promise.all([load(), onCatalogChanged()]);
            if (editingId === id) closeForm();
        } catch (deleteError) {
            setError(getErrorMessage(deleteError, "Failed to delete custom runtime."));
        } finally {
            setBusy(false);
        }
    };

    const handleRestore = async (id: AICustomAcpRuntimeId) => {
        setBusy(true);
        try {
            await aiRestoreCustomRuntime(id);
            await Promise.all([load(), onCatalogChanged()]);
        } catch (restoreError) {
            setError(getErrorMessage(restoreError, "Failed to restore custom runtime."));
        } finally {
            setBusy(false);
        }
    };

    const filteredActive = useMemo(
        () =>
            active.filter((definition) =>
                matchesSettingsSearch(
                    searchQuery,
                    "Custom ACP runtimes",
                    "Runtime name",
                    "Command",
                    "Arguments",
                    "Environment",
                    "Authentication managed by the runtime",
                    definition.id,
                    definition.displayName,
                    definition.command,
                    ...definition.args,
                    ...Object.entries(definition.env).map(
                        ([name, value]) => `${name}=${value}`,
                    ),
                ),
            ),
        [active, searchQuery],
    );
    const filteredDeleted = useMemo(
        () =>
            deleted.filter((definition) =>
                matchesSettingsSearch(
                    searchQuery,
                    "Deleted definitions retained for history",
                    "Restore",
                    definition.id,
                    definition.displayName,
                    definition.command,
                    ...definition.args,
                    ...Object.entries(definition.env).map(
                        ([name, value]) => `${name}=${value}`,
                    ),
                ),
            ),
        [deleted, searchQuery],
    );
    const hasSearchMatch =
        filteredActive.length > 0 ||
        filteredDeleted.length > 0 ||
        matchesSettingsSearch(
            searchQuery,
            "Custom ACP runtimes",
            "Add runtime",
            "Authentication managed by the runtime",
        );

    if (!hasSearchMatch) return null;

    return (
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
                Custom ACP runtimes
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
                        padding: "12px 14px",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                    }}
                >
                    Add ACP-compatible local runtimes. Authentication managed by
                    the runtime; NeverWrite does not store custom runtime secrets.
                </div>
                <div style={{ padding: "0 14px 12px" }}>
                    <button type="button" onClick={startCreate} style={buttonStyle}>
                        Add runtime
                    </button>
                </div>
                {editingId === "new" && (
                    <RuntimeForm
                        form={form}
                        error={error}
                        busy={busy}
                        verification={verification}
                        submitLabel="Add runtime"
                        onChange={setForm}
                        onVerify={() => void handleVerify()}
                        onSubmit={() => void handleSubmit()}
                        onCancel={closeForm}
                    />
                )}
                {loading ? (
                    <div
                        style={{
                            padding: "12px 14px",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            borderTop: "1px solid var(--border)",
                        }}
                    >
                        Loading custom runtimes…
                    </div>
                ) : (
                    filteredActive.map((definition) => (
                        <div
                            key={definition.id}
                            style={{ borderTop: "1px solid var(--border)" }}
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
                                <div style={{ minWidth: 0 }}>
                                    <div
                                        style={{
                                            fontSize: 13,
                                            fontWeight: 600,
                                            color: "var(--text-primary)",
                                        }}
                                    >
                                        {definition.displayName}
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 2,
                                            fontSize: 11,
                                            color: "var(--text-secondary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {definition.command}
                                    </div>
                                </div>
                                <div style={{ display: "flex", gap: 6 }}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => startEdit(definition)}
                                        style={buttonStyle}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void handleDelete(definition.id)}
                                        style={{ ...buttonStyle, color: "#fca5a5" }}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                            {editingId === definition.id && (
                                <RuntimeForm
                                    form={form}
                                    error={error}
                                    busy={busy}
                                    verification={verification}
                                    submitLabel="Save changes"
                                    onChange={setForm}
                                    onVerify={() => void handleVerify()}
                                    onSubmit={() => void handleSubmit()}
                                    onCancel={closeForm}
                                />
                            )}
                        </div>
                    ))
                )}
                {!loading && filteredActive.length === 0 && editingId !== "new" && (
                    <div
                        style={{
                            padding: "12px 14px",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            borderTop: "1px solid var(--border)",
                        }}
                    >
                        No custom runtimes configured.
                    </div>
                )}
                {error && editingId == null && (
                    <div
                        style={{
                            padding: "0 14px 12px",
                            fontSize: 11,
                            color: "#fca5a5",
                        }}
                    >
                        {error}
                    </div>
                )}
            </div>

            {filteredDeleted.length > 0 && (
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
                        Deleted definitions retained for history
                    </div>
                    <div
                        style={{
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            overflow: "hidden",
                            backgroundColor: "var(--bg-secondary)",
                        }}
                    >
                        {filteredDeleted.map((definition, index) => (
                            <div
                                key={definition.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 12,
                                    padding: "12px 14px",
                                    borderTop:
                                        index === 0
                                            ? undefined
                                            : "1px solid var(--border)",
                                }}
                            >
                                <div style={{ minWidth: 0 }}>
                                    <div
                                        style={{
                                            fontSize: 13,
                                            fontWeight: 600,
                                            color: "var(--text-primary)",
                                        }}
                                    >
                                        {definition.displayName}
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 2,
                                            fontSize: 11,
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        {definition.id}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleRestore(definition.id)}
                                    style={buttonStyle}
                                >
                                    Restore
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </>
    );
}
