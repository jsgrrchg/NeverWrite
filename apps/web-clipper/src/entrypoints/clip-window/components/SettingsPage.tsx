import type { ChangeEvent } from "react";
import {
    parseFolderHintsInput,
    serializeFolderHintsInput,
} from "../../../lib/clipper-preferences";
import type { ClipperSettings, VaultConfig } from "../../../lib/types";
import MarkdownDocument from "./MarkdownDocument";
import TemplateManager from "./TemplateManager";

interface SettingsPageProps {
    settings: ClipperSettings;
    onChange: (settings: ClipperSettings) => void;
    onClose: () => void;
    onSave: () => void;
    saveStateLabel: string;
    templatePreview: string;
    vaultOptions: Array<{ value: string; label: string }>;
}

function updateVault(
    vaults: VaultConfig[],
    vaultId: string,
    updater: (vault: VaultConfig) => VaultConfig,
): VaultConfig[] {
    return vaults.map((vault) =>
        vault.id === vaultId ? updater(vault) : vault,
    );
}

export function SettingsPage({
    settings,
    onChange,
    onClose,
    onSave,
    saveStateLabel,
    templatePreview,
    vaultOptions,
}: SettingsPageProps) {
    function handleVaultChange(
        vaultId: string,
        field: keyof VaultConfig,
        event: ChangeEvent<HTMLInputElement>,
    ) {
        onChange({
            ...settings,
            vaults: updateVault(settings.vaults, vaultId, (vault) => ({
                ...vault,
                [field]: event.target.value,
            })),
        });
    }

    function handleRemoveVault(vaultId: string) {
        const vaults = settings.vaults.filter((vault) => vault.id !== vaultId);
        if (vaults.length === 0) {
            return;
        }

        onChange({
            ...settings,
            vaults,
            activeVaultIndex: Math.min(
                settings.activeVaultIndex,
                vaults.length - 1,
            ),
        });
    }

    function handleAddVault() {
        onChange({
            ...settings,
            vaults: [
                ...settings.vaults,
                {
                    id: crypto.randomUUID(),
                    name: "New vault",
                    path: "",
                    defaultFolder: "",
                    folderHints: [],
                },
            ],
        });
    }

    return (
        <section className="clipper-fade-up rounded-xl border border-edge bg-surface-alt p-6 shadow-soft">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                        Settings
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-fg">
                        Vault routing and clipper behavior
                    </h2>
                </div>

                <div className="flex flex-wrap gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface-hover px-4 text-sm font-semibold text-fg transition hover:bg-surface-hover"
                    >
                        Back to clipper
                    </button>
                    <button
                        type="button"
                        onClick={onSave}
                        className="inline-flex h-11 items-center justify-center rounded-[10px] border border-accent/30 bg-accent/15 px-4 text-sm font-semibold text-fg transition hover:bg-accent/22"
                    >
                        {saveStateLabel}
                    </button>
                </div>
            </div>

            <div className="mt-8 grid gap-8 lg:grid-cols-[1.25fr_0.75fr]">
                <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold text-fg">
                                Vaults
                            </h3>
                            <p className="mt-1 text-sm leading-6 text-fg-muted">
                                Paths are only local hints. The desktop app must
                                revalidate everything before writing.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={handleAddVault}
                            className="inline-flex h-10 items-center justify-center rounded-[10px] border border-edge bg-surface-hover px-4 text-sm font-semibold text-fg transition hover:bg-surface-hover"
                        >
                            Add vault
                        </button>
                    </div>

                    {settings.vaults.map((vault, index) => (
                        <div
                            key={vault.id}
                            className="rounded-[10px] border border-edge bg-surface-raised p-4"
                        >
                            <div className="mb-4 flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-fg">
                                    Vault {index + 1}
                                </div>
                                <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-2 text-xs text-fg-muted">
                                        <input
                                            type="radio"
                                            name="active-vault"
                                            checked={
                                                settings.activeVaultIndex ===
                                                index
                                            }
                                            onChange={() =>
                                                onChange({
                                                    ...settings,
                                                    activeVaultIndex: index,
                                                })
                                            }
                                            className="h-4 w-4"
                                        />
                                        Active
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            handleRemoveVault(vault.id)
                                        }
                                        disabled={settings.vaults.length === 1}
                                        className="inline-flex h-9 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/18 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>

                            <div className="grid gap-3 md:grid-cols-2">
                                <label className="grid gap-2">
                                    <span className="text-xs uppercase tracking-wider text-fg-muted">
                                        Name
                                    </span>
                                    <input
                                        value={vault.name}
                                        onChange={(event) =>
                                            handleVaultChange(
                                                vault.id,
                                                "name",
                                                event,
                                            )
                                        }
                                        className="h-11 rounded-[10px] border border-edge bg-surface-alt px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                                    />
                                </label>

                                <label className="grid gap-2">
                                    <span className="text-xs uppercase tracking-wider text-fg-muted">
                                        Default folder
                                    </span>
                                    <input
                                        value={vault.defaultFolder}
                                        onChange={(event) =>
                                            handleVaultChange(
                                                vault.id,
                                                "defaultFolder",
                                                event,
                                            )
                                        }
                                        placeholder="Clips/Web"
                                        className="h-11 rounded-[10px] border border-edge bg-surface-alt px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                                    />
                                </label>
                            </div>

                            <label className="mt-3 grid gap-2">
                                <span className="text-xs uppercase tracking-wider text-fg-muted">
                                    Local path hint
                                </span>
                                <input
                                    value={vault.path}
                                    onChange={(event) =>
                                        handleVaultChange(
                                            vault.id,
                                            "path",
                                            event,
                                        )
                                    }
                                    placeholder="/Users/name/Documents/Vault"
                                    className="h-11 rounded-[10px] border border-edge bg-surface-alt px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                                />
                            </label>

                            <label className="mt-3 grid gap-2">
                                <span className="text-xs uppercase tracking-wider text-fg-muted">
                                    Known subfolders
                                </span>
                                <textarea
                                    value={serializeFolderHintsInput(
                                        vault.folderHints,
                                    )}
                                    onChange={(event) =>
                                        onChange({
                                            ...settings,
                                            vaults: updateVault(
                                                settings.vaults,
                                                vault.id,
                                                (currentVault) => ({
                                                    ...currentVault,
                                                    folderHints:
                                                        parseFolderHintsInput(
                                                            event.target.value,
                                                        ),
                                                }),
                                            ),
                                        })
                                    }
                                    rows={4}
                                    placeholder={"Clips/Web\nClips/Research"}
                                    className="rounded-[10px] border border-edge bg-surface-alt px-4 py-3 text-sm leading-6 text-fg outline-none transition focus:border-accent/60"
                                />
                            </label>
                        </div>
                    ))}
                </div>

                <div className="grid gap-5 rounded-xl border border-edge bg-surface-raised p-5">
                    <div>
                        <h3 className="text-lg font-semibold text-fg">
                            Behavior
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-fg-muted">
                            These settings stay local to the extension via
                            `browser.storage.local`.
                        </p>
                    </div>

                    <label className="flex items-start gap-3 rounded-[10px] border border-edge bg-surface-alt p-4">
                        <input
                            type="checkbox"
                            checked={settings.clipSelectedOnly}
                            onChange={(event) =>
                                onChange({
                                    ...settings,
                                    clipSelectedOnly: event.target.checked,
                                })
                            }
                            className="mt-1 h-4 w-4"
                        />
                        <span className="grid gap-1">
                            <span className="text-sm font-medium text-fg">
                                Clip selected text only
                            </span>
                            <span className="text-xs leading-6 text-fg-muted">
                                If text is selected on the page, the clipper
                                forces Selection mode.
                            </span>
                        </span>
                    </label>

                    <label className="flex items-start gap-3 rounded-[10px] border border-edge bg-surface-alt p-4">
                        <input
                            type="checkbox"
                            checked={settings.useClipboard}
                            onChange={(event) =>
                                onChange({
                                    ...settings,
                                    useClipboard: event.target.checked,
                                })
                            }
                            className="mt-1 h-4 w-4"
                        />
                        <span className="grid gap-1">
                            <span className="text-sm font-medium text-fg">
                                Prefer clipboard bridge
                            </span>
                            <span className="text-xs leading-6 text-fg-muted">
                                When enabled, send clip content through the
                                clipboard even if it fits inline in the URI.
                            </span>
                        </span>
                    </label>

                    <label className="grid gap-2">
                        <span className="text-xs uppercase tracking-wider text-fg-muted">
                            Default template
                        </span>
                        <textarea
                            value={settings.defaultTemplate}
                            onChange={(event) =>
                                onChange({
                                    ...settings,
                                    defaultTemplate: event.target.value,
                                })
                            }
                            rows={8}
                            className="rounded-[10px] border border-edge bg-surface-alt px-4 py-3 text-sm leading-6 text-fg outline-none transition focus:border-accent/60"
                        />
                    </label>

                    <div className="rounded-[10px] border border-edge bg-surface-alt p-4">
                        <h4 className="text-sm font-semibold text-fg">
                            Template preview
                        </h4>
                        <p className="mt-1 text-xs leading-6 text-fg-muted">
                            Live preview using the current clip and this draft
                            template.
                        </p>
                        <div className="mt-4 max-h-[260px] overflow-auto pr-1">
                            <MarkdownDocument markdown={templatePreview} />
                        </div>
                    </div>

                    <TemplateManager
                        templates={settings.templates}
                        vaultOptions={vaultOptions}
                        onChange={(templates) =>
                            onChange({
                                ...settings,
                                templates,
                            })
                        }
                    />
                </div>
            </div>
        </section>
    );
}

export default SettingsPage;
