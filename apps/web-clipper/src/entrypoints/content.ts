import {
    type ClipperExtractResponse,
    isClipperExtractMessage,
} from "../lib/clipper-contract";
import { convertHtmlToMarkdown } from "../lib/converter";
import { extractClipSource } from "../lib/extractor";
import { sanitizeHtml } from "../lib/sanitizer";

function createExtractResponse(): ClipperExtractResponse {
    const extracted = extractClipSource(document, window);
    const sanitizedContentHtml = sanitizeHtml(extracted.contentHtml);
    const sanitizedSelectionHtml = extracted.selection
        ? sanitizeHtml(extracted.selection.html)
        : "";

    return {
        ok: true,
        data: {
            metadata: extracted.metadata,
            content: {
                html: sanitizedContentHtml,
                markdown: convertHtmlToMarkdown(
                    sanitizedContentHtml,
                    extracted.metadata.url,
                ),
                wordCount: extracted.wordCount,
            },
            selection: extracted.selection
                ? {
                      text: extracted.selection.text,
                      html: sanitizedSelectionHtml,
                      markdown:
                          convertHtmlToMarkdown(
                              sanitizedSelectionHtml,
                              extracted.metadata.url,
                          ) || extracted.selection.text,
                  }
                : null,
            extractedAt: new Date().toISOString(),
        },
    };
}

export default defineContentScript({
    matches: ["http://*/*", "https://*/*"],
    runAt: "document_idle",
    main() {
        browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!isClipperExtractMessage(message)) {
                return;
            }

            try {
                sendResponse(createExtractResponse());
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Unknown content extraction error";

                sendResponse({
                    ok: false,
                    error: message,
                } satisfies ClipperExtractResponse);
            }

            return true;
        });
    },
});
