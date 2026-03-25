import type { ClipperTemplate } from "../../../lib/types";

interface TemplateManagerProps {
    templates: ClipperTemplate[];
    vaultOptions: Array<{ value: string; label: string }>;
    onChange: (templates: ClipperTemplate[]) => void;
}

function updateTemplate(
    templates: ClipperTemplate[],
    templateId: string,
    updater: (template: ClipperTemplate) => ClipperTemplate,
): ClipperTemplate[] {
    return templates.map((template) =>
        template.id === templateId ? updater(template) : template,
    );
}

export function TemplateManager({
    templates,
    vaultOptions,
    onChange,
}: TemplateManagerProps) {
    return (
        <div className="grid gap-4">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h4 className="text-sm font-semibold text-fg">Templates</h4>
                    <p className="mt-1 text-xs leading-6 text-fg-muted">
                        Match templates by vault and/or domain. The most
                        specific match wins.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() =>
                        onChange([
                            ...templates,
                            {
                                id: crypto.randomUUID(),
                                name: "New template",
                                body: "# {{title}}\n\n{{content}}",
                                vaultId: "",
                                domain: "",
                            },
                        ])
                    }
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-edge bg-surface-hover px-3 text-xs font-semibold text-fg transition hover:bg-surface-hover"
                >
                    Add template
                </button>
            </div>

            {templates.length === 0 && (
                <div className="rounded-[10px] border border-dashed border-edge bg-surface-raised px-4 py-5 text-sm leading-6 text-fg-muted">
                    No custom templates yet. The default template remains the
                    fallback.
                </div>
            )}

            {templates.map((template) => (
                <div
                    key={template.id}
                    className="rounded-[10px] border border-edge bg-surface-alt p-4"
                >
                    <div className="flex items-center justify-between gap-3">
                        <input
                            value={template.name}
                            onChange={(event) =>
                                onChange(
                                    updateTemplate(
                                        templates,
                                        template.id,
                                        (current) => ({
                                            ...current,
                                            name: event.target.value,
                                        }),
                                    ),
                                )
                            }
                            className="h-10 min-w-0 flex-1 rounded-[10px] border border-edge bg-surface-raised px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                        />
                        <button
                            type="button"
                            onClick={() =>
                                onChange(
                                    templates.filter(
                                        (current) => current.id !== template.id,
                                    ),
                                )
                            }
                            className="inline-flex h-9 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/18"
                        >
                            Remove
                        </button>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="grid gap-2">
                            <span className="text-xs uppercase tracking-wider text-fg-muted">
                                Vault scope
                            </span>
                            <select
                                value={template.vaultId}
                                onChange={(event) =>
                                    onChange(
                                        updateTemplate(
                                            templates,
                                            template.id,
                                            (current) => ({
                                                ...current,
                                                vaultId: event.target.value,
                                            }),
                                        ),
                                    )
                                }
                                className="h-10 rounded-[10px] border border-edge bg-surface-raised px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                            >
                                <option value="">Any vault</option>
                                {vaultOptions.map((option) => (
                                    <option
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="grid gap-2">
                            <span className="text-xs uppercase tracking-wider text-fg-muted">
                                Domain scope
                            </span>
                            <input
                                value={template.domain}
                                onChange={(event) =>
                                    onChange(
                                        updateTemplate(
                                            templates,
                                            template.id,
                                            (current) => ({
                                                ...current,
                                                domain: event.target.value,
                                            }),
                                        ),
                                    )
                                }
                                placeholder="example.com"
                                className="h-10 rounded-[10px] border border-edge bg-surface-raised px-4 text-sm text-fg outline-none transition focus:border-accent/60"
                            />
                        </label>
                    </div>

                    <label className="mt-3 grid gap-2">
                        <span className="text-xs uppercase tracking-wider text-fg-muted">
                            Template body
                        </span>
                        <textarea
                            rows={7}
                            value={template.body}
                            onChange={(event) =>
                                onChange(
                                    updateTemplate(
                                        templates,
                                        template.id,
                                        (current) => ({
                                            ...current,
                                            body: event.target.value,
                                        }),
                                    ),
                                )
                            }
                            className="rounded-[10px] border border-edge bg-surface-raised px-4 py-3 text-sm leading-6 text-fg outline-none transition focus:border-accent/60"
                        />
                    </label>
                </div>
            ))}
        </div>
    );
}

export default TemplateManager;
