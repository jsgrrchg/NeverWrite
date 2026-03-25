import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownDocumentProps {
    markdown: string;
    emptyLabel?: string;
}

export function MarkdownDocument({
    markdown,
    emptyLabel = "No preview available.",
}: MarkdownDocumentProps) {
    if (!markdown.trim()) {
        return <p className="text-sm leading-7 text-fg-muted">{emptyLabel}</p>;
    }

    return (
        <div className="clipper-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdown}
            </ReactMarkdown>
        </div>
    );
}

export default MarkdownDocument;
