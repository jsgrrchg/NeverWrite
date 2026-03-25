import type { ClipHistoryEntry } from "../../../lib/types";
import MarkdownDocument from "./MarkdownDocument";

interface HistoryPageProps {
    history: ClipHistoryEntry[];
    onBack: () => void;
    onReuse: (entry: ClipHistoryEntry) => void;
    onDelete: (entryId: string) => void;
}

function formatMethodLabel(entry: ClipHistoryEntry): string {
    switch (entry.method) {
        case "desktop-api":
            return "Desktop API";
        case "deep-link-clipboard":
            return "Deep link + clipboard";
        default:
            return "Deep link";
    }
}

export function HistoryPage({
    history,
    onBack,
    onReuse,
    onDelete,
}: HistoryPageProps) {
    return (
        <section className="clipper-fade-up rounded-xl border border-edge bg-surface-alt p-6 shadow-soft">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                        History
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-fg">
                        Recent clips
                    </h2>
                </div>

                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface-hover px-4 text-sm font-semibold text-fg transition hover:bg-surface-hover"
                >
                    Back to clipper
                </button>
            </div>

            <div className="mt-8 grid gap-4">
                {history.length === 0 && (
                    <div className="rounded-[10px] border border-dashed border-edge bg-surface-raised px-4 py-8 text-sm leading-7 text-fg-muted">
                        No clips recorded yet.
                    </div>
                )}

                {history.map((entry) => (
                    <article
                        key={entry.id}
                        className="rounded-[10px] border border-edge bg-surface-raised p-4"
                    >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">
                                    {entry.title}
                                </h3>
                                <p className="mt-1 text-xs leading-6 text-fg-muted">
                                    {entry.domain || "Unknown domain"} ·{" "}
                                    {new Date(entry.createdAt).toLocaleString()}{" "}
                                    · {formatMethodLabel(entry)}
                                </p>
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => onReuse(entry)}
                                    className="inline-flex h-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/14 px-3 text-xs font-semibold text-fg transition hover:bg-accent/20"
                                >
                                    Use again
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onDelete(entry.id)}
                                    className="inline-flex h-9 items-center justify-center rounded-lg border border-edge bg-surface-hover px-3 text-xs font-semibold text-fg transition hover:bg-surface-hover"
                                >
                                    Remove
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                            {entry.folder && (
                                <span className="rounded-full border border-edge bg-surface-alt px-3 py-1 text-xs text-fg-muted">
                                    {entry.folder}
                                </span>
                            )}
                            {entry.tags.map((tag) => (
                                <span
                                    key={tag}
                                    className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs text-fg"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>

                        <div className="mt-4 max-h-[220px] overflow-auto rounded-[10px] border border-edge bg-surface-alt px-4 py-3">
                            <MarkdownDocument markdown={entry.markdown} />
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}

export default HistoryPage;
