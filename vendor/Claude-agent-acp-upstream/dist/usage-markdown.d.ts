import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
/** Validate the experimental SDK response at the runtime boundary. */
export declare function parseUsageResponse(value: unknown): SDKControlGetUsageResponse | null;
export declare function isUsageCommandText(text: string): boolean;
/** Render the SDK's structured `/usage` response as Markdown. */
export declare function formatUsageResponse(usage: SDKControlGetUsageResponse): string;
//# sourceMappingURL=usage-markdown.d.ts.map