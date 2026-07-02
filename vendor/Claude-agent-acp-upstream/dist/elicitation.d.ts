import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
/**
 * Bridges between the Claude Agent SDK's elicitation/dialog callbacks and ACP's
 * (unstable) elicitation protocol.
 *
 * Two distinct SDK surfaces flow through here:
 *
 *   1. `onElicitation` — fired when an MCP server requests user input. These map
 *      directly onto ACP `session/create_elicitation` (form or url mode).
 *   2. The built-in AskUserQuestion tool — when a `canUseTool` callback is
 *      registered the SDK routes its permission check through `canUseTool`
 *      (not the interactive `permission_ask_user_question` dialog). We render
 *      its questions as an ACP form elicitation and feed the user's selections
 *      back as the tool's `updatedInput`, which the tool's own `call()` reads.
 */
/** Modes the connected client advertised support for. */
export type ElicitationSupport = {
    form: boolean;
    url: boolean;
};
/**
 * Convert an MCP elicitation request (from the SDK's `onElicitation` callback)
 * into an ACP `CreateElicitationRequest`. Returns `null` when the request can't
 * be represented (e.g. a url-mode request with no url).
 */
export declare function mcpElicitationToCreateRequest(request: ElicitationRequest, sessionId: string): CreateElicitationRequest | null;
/**
 * Map an ACP elicitation response back to the MCP `ElicitResult` the SDK expects
 * to hand back to the requesting server.
 */
export declare function createElicitationResponseToElicitResult(response: CreateElicitationResponse): ElicitationResult;
/**
 * A single question as supplied by the AskUserQuestion tool. Derived from the
 * SDK's input type so the shape stays in sync; the SDK validates the model's
 * tool call against this schema before it reaches us.
 */
export type AskUserQuestion = AskUserQuestionInput["questions"][number];
/**
 * Pull the well-formed questions out of an AskUserQuestion tool input. Returns
 * `null` when there are no usable questions — including the case where every
 * entry is malformed and filtering leaves an empty list — so callers can treat
 * "nothing to ask" uniformly.
 */
export declare function extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] | null;
/**
 * Render the AskUserQuestion tool's questions as an ACP form elicitation.
 *
 * Fields are keyed by a short stable id (`question_<n>`) rather than the full
 * question text, so the question text appears in exactly one place per field.
 * Single-select questions use a titled `oneOf` enum; multi-select questions use
 * an array with a titled `anyOf` item enum. The enum `const` is always the
 * option label, since that is what the tool records as the answer.
 *
 * Each question is followed by its own optional free-text "custom answer" field
 * (`question_<n>_custom`), mirroring the CLI's per-question "Other" box: the
 * user can type their own answer instead of picking an option, scoped to that
 * specific question. Nothing is marked required, so the user can also just skip
 * — matching the built-in tool, which always offers Skip + a free-text box.
 */
export declare function askUserQuestionsToCreateRequest(questions: AskUserQuestion[], sessionId: string, toolCallId: string | undefined): CreateElicitationRequest;
/** Outcome of an AskUserQuestion elicitation, decoupled from any transport. */
export type AskUserQuestionOutcome = {
    action: "answered";
    updatedInput: Record<string, unknown>;
} | {
    action: "cancel";
};
/**
 * Fold an ACP elicitation response into the AskUserQuestion tool's input.
 *
 * Selected labels are read back from the indexed form fields and written into
 * `answers` as a `{ [questionText]: label }` map (comma-joining multi-selects)
 * — the key shape the tool's own `call()` reads. A non-empty per-question
 * custom-answer field (`question_<n>_custom`) takes precedence over that
 * question's selection, since the user typed their own answer instead of
 * picking one. Decline yields empty answers (the model is told the user skipped
 * rather than the turn aborting); cancel aborts the tool call.
 */
export declare function applyAskElicitationResponse(response: CreateElicitationResponse, toolInput: Record<string, unknown>, questions: AskUserQuestion[]): AskUserQuestionOutcome;
/**
 * The `request_user_dialog` kind the CLI emits when a model refusal has a
 * fallback available but needs user consent before retrying (e.g. Claude Fable
 * declining a request with Opus available as the fallback). Declaring this
 * kind in `supportedDialogKinds` is the opt-in: the CLI fails closed and never
 * emits an undeclared kind — the flow degrades to the classic refusal error
 * ending the turn.
 */
export declare const REFUSAL_FALLBACK_DIALOG_KIND = "refusal_fallback_prompt";
/**
 * Payload of the `refusal_fallback_prompt` dialog. The dialog protocol
 * transports payloads opaquely, so this shape is recovered from the CLI's own
 * schema (v2.1.177): `originalModel`/`fallbackModel` are required strings;
 * `apiRefusalCategory` (nullable), `guidanceText`, and
 * `retractedMessageUuids` are optional. We ignore `retractedMessageUuids` —
 * ACP has no way to retract already-streamed chunks.
 */
export type RefusalFallbackPrompt = {
    originalModel: string;
    fallbackModel: string;
    apiRefusalCategory: string | null;
    guidanceText?: string;
};
/**
 * Validate the opaque dialog payload into a {@link RefusalFallbackPrompt}.
 * Returns `null` when the required fields are missing or mistyped (a newer CLI
 * may reshape the payload), so the caller can cancel the dialog and let the
 * CLI apply its default behavior instead of rendering something misleading.
 */
export declare function extractRefusalFallbackPrompt(payload: Record<string, unknown>): RefusalFallbackPrompt | null;
/**
 * Render the refusal-fallback consent prompt as an ACP form elicitation: a
 * single-select between retrying on the fallback model and keeping the
 * refusal. The enum `const`s are the dialog's wire result values, so the
 * response maps back without a translation table.
 */
export declare function refusalFallbackToCreateRequest(prompt: RefusalFallbackPrompt, sessionId: string): CreateElicitationRequest;
/**
 * Map the elicitation response back to the dialog's result enum. Only an
 * explicit accept-with-retry resolves to `retry_fallback`; decline, cancel, a
 * skipped field, or an unrecognized value all keep the refusal — the dialog's
 * own default — so a dismissed or half-filled form can never trigger a model
 * switch the user didn't ask for.
 */
export declare function refusalFallbackResultFromResponse(response: CreateElicitationResponse): string;
//# sourceMappingURL=elicitation.d.ts.map