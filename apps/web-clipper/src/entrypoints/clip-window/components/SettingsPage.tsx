import { useState } from "react";
import { type ClipperSettings, type VaultConfig } from "../../../lib/types";

interface SettingsPageProps {
    settings: ClipperSettings;
    onChange: (settings: ClipperSettings) => void;
}

function Toggle({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                checked ? "bg-accent" : "bg-edge"
            }`}
        >
            <span
                className={`absolute top-0.5 block h-3 w-3 rounded-full transition-transform ${
                    checked
                        ? "translate-x-3.5 bg-white"
                        : "translate-x-0.5 bg-fg-muted"
                }`}
            />
        </button>
    );
}

export function SettingsPage({ settings, onChange }: SettingsPageProps) {
    const [expandedVault, setExpandedVault] = useState<string | null>(null);

    function updateVault(index: number, patch: Partial<VaultConfig>) {
        const nextVaults = settings.vaults.map((v, i) =>
            i === index ? { ...v, ...patch } : v,
        );
        onChange({ ...settings, vaults: nextVaults });
    }

    function removeVault(index: number) {
        if (settings.vaults.length <= 1) return;

        const nextVaults = settings.vaults.filter((_, i) => i !== index);
        const nextActiveIndex = Math.min(
            settings.activeVaultIndex,
            nextVaults.length - 1,
        );
        onChange({
            ...settings,
            vaults: nextVaults,
            activeVaultIndex: nextActiveIndex,
        });
    }

    function addVault() {
        const id = crypto.randomUUID();
        onChange({
            ...settings,
            vaults: [
                ...settings.vaults,
                {
                    id,
                    name: "New vault",
                    path: "",
                    defaultFolder: "",
                    folderHints: [],
                },
            ],
        });
        setExpandedVault(id);
    }

    function updateOption<K extends keyof ClipperSettings>(
        key: K,
        value: ClipperSettings[K],
    ) {
        onChange({ ...settings, [key]: value });
    }

    return (
        <div
            className="flex flex-1 flex-col overflow-y-auto"
            style={{ zoom: 1.2 }}
        >
            <div className="flex flex-col gap-1 px-4 pt-5 pb-4">
                <h2 className="text-sm font-semibold tracking-tight text-fg">
                    Vaults
                </h2>
                <p className="text-[11px] text-fg-muted">Add your Vaults</p>

                <div className="mt-3 flex flex-col gap-2">
                    {settings.vaults.map((vault, index) => {
                        const isExpanded = expandedVault === vault.id;

                        return (
                            <div
                                key={vault.id}
                                className="flex flex-col rounded-lg border border-edge bg-surface-raised"
                            >
                                <div
                                    className="flex h-8 cursor-pointer items-center gap-2 px-2.5"
                                    onClick={() =>
                                        setExpandedVault(
                                            isExpanded ? null : vault.id,
                                        )
                                    }
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="shrink-0 text-accent"
                                    >
                                        <rect
                                            width="18"
                                            height="18"
                                            x="3"
                                            y="3"
                                            rx="2"
                                        />
                                        <path d="M7 3v18" />
                                        <path d="M3 7.5h4" />
                                        <path d="M3 12h18" />
                                        <path d="M3 16.5h4" />
                                    </svg>
                                    <span className="text-[11px] font-medium text-fg">
                                        {vault.name}
                                    </span>
                                    <div className="flex-1" />
                                    {!isExpanded && (
                                        <span className="max-w-35 truncate text-[10px] text-fg-dim">
                                            {vault.path || "No path set"}
                                        </span>
                                    )}
                                    <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className={`shrink-0 text-fg-dim transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                    >
                                        <path d="m6 9 6 6 6-6" />
                                    </svg>
                                </div>

                                {isExpanded && (
                                    <div className="flex flex-col gap-1.5 border-t border-edge px-2.5 py-2.5">
                                        <div>
                                            <label className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
                                                Name
                                            </label>
                                            <input
                                                value={vault.name}
                                                onChange={(e) =>
                                                    updateVault(index, {
                                                        name: e.target.value,
                                                    })
                                                }
                                                className="mt-1 h-7 w-full rounded-md border border-edge bg-surface px-2 text-[11px] text-fg outline-none focus:border-accent/50"
                                                placeholder="Vault name"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
                                                Path
                                            </label>
                                            <input
                                                value={vault.path}
                                                onChange={(e) =>
                                                    updateVault(index, {
                                                        path: e.target.value,
                                                    })
                                                }
                                                className="mt-1 h-7 w-full rounded-md border border-edge bg-surface px-2 text-[11px] text-fg outline-none focus:border-accent/50"
                                                placeholder="/path/to/vault"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
                                                Default folder
                                            </label>
                                            <input
                                                value={vault.defaultFolder}
                                                onChange={(e) =>
                                                    updateVault(index, {
                                                        defaultFolder:
                                                            e.target.value,
                                                    })
                                                }
                                                className="mt-1 h-7 w-full rounded-md border border-edge bg-surface px-2 text-[11px] text-fg outline-none focus:border-accent/50"
                                                placeholder="Clippings"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => removeVault(index)}
                                            disabled={
                                                settings.vaults.length <= 1
                                            }
                                            className="mt-0.5 flex h-6 items-center justify-center gap-1 rounded-md text-[10px] font-medium text-danger transition hover:bg-danger/10 disabled:opacity-30"
                                        >
                                            <svg
                                                width="12"
                                                height="12"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            >
                                                <path d="M3 6h18" />
                                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                            </svg>
                                            Remove vault
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    <button
                        type="button"
                        onClick={addVault}
                        className="flex h-7 items-center justify-center gap-1 rounded-md border border-edge text-[11px] font-medium text-fg-dim transition hover:border-fg-dim hover:text-fg-muted"
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                        >
                            <path d="M12 5v14" />
                            <path d="M5 12h14" />
                        </svg>
                        Add Vault
                    </button>
                </div>

                <div className="my-4 h-px bg-edge" />

                <div className="flex flex-col gap-1">
                    <h3 className="text-xs font-semibold text-fg">Options</h3>

                    <div className="mt-2 flex flex-col gap-2">
                        <div className="flex h-8 items-center gap-2 rounded-md border border-edge bg-surface-raised px-2.5">
                            <div className="flex flex-1 flex-col gap-0.5">
                                <span className="text-[11px] font-medium text-fg">
                                    Clip selected text only
                                </span>
                                <span className="text-[9px] text-fg-dim">
                                    Only clip highlighted text instead of full
                                    page
                                </span>
                            </div>
                            <Toggle
                                checked={settings.clipSelectedOnly}
                                onChange={(v) =>
                                    updateOption("clipSelectedOnly", v)
                                }
                            />
                        </div>

                        <div className="flex h-8 items-center gap-2 rounded-md border border-edge bg-surface-raised px-2.5">
                            <div className="flex flex-1 flex-col gap-0.5">
                                <span className="text-[11px] font-medium text-fg">
                                    Prefer clipboard bridge
                                </span>
                                <span className="text-[9px] text-fg-dim">
                                    Use clipboard to send content to the app
                                </span>
                            </div>
                            <Toggle
                                checked={settings.useClipboard}
                                onChange={(v) =>
                                    updateOption("useClipboard", v)
                                }
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SettingsPage;
