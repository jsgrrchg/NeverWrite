import { type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
type ResumeLogger = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};
export type ResumedSessionSnapshot = {
    messages?: SessionMessage[];
    model?: string;
};
/** Return the concrete model recorded by the last real assistant response.
 * Claude Code restores a resumed query from this same transcript field.
 * Synthetic assistant records use angle-bracket placeholders and do not
 * describe a model the resumed query can run. */
export declare function resumedModelFromTranscript(messages: SessionMessage[]): string | undefined;
/** Read the resume model from the local transcript without starting a Claude
 * control request. This is intentionally on the load critical path. */
export declare function readResumedSession(sessionId: string, logger?: ResumeLogger): Promise<ResumedSessionSnapshot>;
export {};
//# sourceMappingURL=resumed-session.d.ts.map