/**
 * AI-generated session titles.
 *
 * Claude Code's own auto-title generation never runs under the Agent SDK — the
 * latch that arms it is pre-set in the headless path — so `SDKSessionInfo.summary`
 * degrades to the raw first prompt. This module asks the CLI for a real title
 * instead, via the `generate_session_title` control request, and publishes it
 * over ACP as a `session_info_update`.
 *
 * {@link SessionTitles} holds the per-session state and is owned by `Session`.
 * `acp-agent.ts` drives it from four places: {@link SessionTitles.onPrompt} and
 * {@link SessionTitles.onAssistantText} to collect text,
 * {@link SessionTitles.onTurnEnd} at `session_state_changed: idle`, and
 * {@link SessionTitles.reset} on `conversation_reset`.
 */
import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent, Session } from "./acp-agent.js";
export declare function sanitizeTitle(text: string): string;
/** Rolling text a title is generated from: `previous` plus `text`, keeping only
 *  the trailing {@link MAX_TITLE_CONTEXT_LENGTH} characters. */
export declare function appendTitleContext(previous: string | undefined, text: string): string;
/** One session's title: the text a generated title is derived from, whether a
 *  title has been settled on, and the last one published. Created with the
 *  session and reachable as `session.titles`. */
export declare class SessionTitles {
    private readonly agent;
    private readonly sessionId;
    /** Last title pushed to the client via `session_info_update`, so an unchanged
     *  title is never re-notified. Undefined until the first push. */
    private lastTitle?;
    /** Rolling tail of this session's own user + assistant text, capped at
     *  {@link MAX_TITLE_CONTEXT_LENGTH}. Dropped once a title exists. */
    private context?;
    /** Set once this session has a title or has asked for one. A title is
     *  generated at most once per session: the SDK reports a generated title in
     *  the same field as a user `/rename`, so re-titling could silently overwrite
     *  one. Released by {@link reset}, and when generation yields nothing. */
    private settled;
    constructor(agent: ClaudeAcpAgent, sessionId: string);
    /** Collect a prompt's own text for the title, skipping openers not worth
     *  titling after. No-op once the title is settled. */
    onPrompt(prompt: PromptRequest["prompt"]): void;
    /** Collect the assistant's own answer for the title. Chunks are appended
     *  verbatim so streamed text reassembles. No-op once the title is settled. */
    onAssistantText(content: ContentBlock): void;
    /** Drop the title state so the next turn re-evaluates. Used on
     *  `conversation_reset`, which mounts a fresh transcript. */
    reset(): void;
    /** Turn-end title handling. `idle` is the SDK's turn-over signal, so it is
     *  when a title may have landed or become generatable.
     *
     *  `info.customTitle` is non-empty only once the session file holds a real
     *  title — a user `/rename` or one generated earlier; the SDK folds both into
     *  that one field. Adopt it and latch, so neither is ever titled over.
     *
     *  With no title yet, ask the SDK to generate one in the background: it is a
     *  ~2s small-model call and turn-end must not wait on it. Only when that is
     *  not possible do we fall back to `summary`, which for an SDK-driven session
     *  is just the raw first prompt. */
    onTurnEnd(session: Session): Promise<void>;
    /** Read the SDK's stored info for this session. A missing session file or read
     *  error is non-fatal: the title is best-effort and another turn will retry. */
    private readSessionInfo;
    /** Notify the client of a title, unless it is the one we last sent. */
    private publish;
    /** Whether to ask the SDK for a generated title now: once per session, on a
     *  live query, with enough collected text for the generator to work with. */
    private canRequest;
    /** Generate a title from the session's own text and publish it. `persist`
     *  writes it to the session file, which is what carries it into
     *  `session/list` and `session/load`. A null or failed generation releases the
     *  latch so a later turn retries, and publishes `fallback` (the stored
     *  summary) so a backend that can't generate titles is no worse off than
     *  before. */
    private requestGenerateTitle;
}
//# sourceMappingURL=session-titles.d.ts.map