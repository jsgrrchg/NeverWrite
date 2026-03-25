import { createMarkdownContent } from "defuddle/full";

export function convertHtmlToMarkdown(html: string, url: string): string {
    const normalized = html.trim();
    if (!normalized) {
        return "";
    }

    return createMarkdownContent(normalized, url).trim();
}
