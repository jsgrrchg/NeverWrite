import { MarkdownDocument } from "./MarkdownDocument";

interface PreviewBoxProps {
    title: string;
    markdown: string;
}

export function PreviewBox({ title, markdown }: PreviewBoxProps) {
    return (
        <div className="h-35 overflow-hidden overflow-y-auto rounded-lg border border-edge bg-surface-raised p-3">
            <h3 className="text-sm font-semibold text-fg">{title}</h3>
            <div className="mt-1">
                <MarkdownDocument markdown={markdown} />
            </div>
        </div>
    );
}

export default PreviewBox;
