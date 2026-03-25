import type { ClipContentMode } from "./ClipForm";
import MarkdownDocument from "./MarkdownDocument";

interface MarkdownPreviewProps {
    contentMode: ClipContentMode;
    markdown: string;
}

function modeLabel(contentMode: ClipContentMode): string {
    switch (contentMode) {
        case "selection":
            return "Selection preview";
        case "url-only":
            return "Bookmark preview";
        default:
            return "Full page preview";
    }
}

export function MarkdownPreview({
    contentMode,
    markdown,
}: MarkdownPreviewProps) {
    return (
        <section className="clipper-fade-up flex min-h-[420px] flex-col rounded-xl border border-edge bg-surface-alt shadow-soft">
            <div className="flex items-center justify-between gap-3 border-b border-edge px-6 py-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                        Clip preview
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-fg">
                        {modeLabel(contentMode)}
                    </h3>
                </div>
                <span className="rounded-full border border-edge bg-surface-raised px-3 py-1 text-xs font-medium text-fg-muted">
                    {markdown ? `${markdown.length} chars` : "No content"}
                </span>
            </div>

            <div className="flex-1 overflow-auto px-6 py-5">
                <MarkdownDocument markdown={markdown} />
            </div>
        </section>
    );
}

export default MarkdownPreview;
