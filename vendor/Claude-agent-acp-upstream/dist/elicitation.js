import { randomUUID } from "node:crypto";
/**
 * Convert an MCP elicitation request (from the SDK's `onElicitation` callback)
 * into an ACP `CreateElicitationRequest`. Returns `null` when the request can't
 * be represented (e.g. a url-mode request with no url).
 */
export function mcpElicitationToCreateRequest(request, sessionId) {
    if (request.mode === "url") {
        if (!request.url) {
            return null;
        }
        return {
            mode: "url",
            sessionId,
            message: request.message,
            url: request.url,
            // URL elicitations need a stable id so the client can correlate the
            // later `session/complete_elicitation` notification. MCP servers usually
            // provide one; fall back to a generated id if not.
            elicitationId: request.elicitationId ?? randomUUID(),
        };
    }
    // Form mode (the default). The MCP `requestedSchema` is already a JSON Schema
    // with primitive-typed properties, which is structurally what ACP expects.
    return {
        mode: "form",
        sessionId,
        message: request.message,
        requestedSchema: normalizeElicitationSchema(request.requestedSchema),
    };
}
/**
 * Map an ACP elicitation response back to the MCP `ElicitResult` the SDK expects
 * to hand back to the requesting server.
 */
export function createElicitationResponseToElicitResult(response) {
    switch (response.action) {
        case "accept":
            return { action: "accept", content: response.content ?? {} };
        case "decline":
            return { action: "decline" };
        case "cancel":
        default:
            return { action: "cancel" };
    }
}
/**
 * Pull the well-formed questions out of an AskUserQuestion tool input. Returns
 * `null` when there are no usable questions — including the case where every
 * entry is malformed and filtering leaves an empty list — so callers can treat
 * "nothing to ask" uniformly.
 */
export function extractAskUserQuestions(input) {
    const questions = input.questions;
    if (!Array.isArray(questions)) {
        return null;
    }
    const valid = questions.filter((q) => !!q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0);
    return valid.length > 0 ? valid : null;
}
/** Stable form-field key for the question at the given index. */
function questionFieldKey(index) {
    return `question_${index}`;
}
/**
 * Form-field key for the per-question free-text "custom answer" field that sits
 * alongside `question_<n>`. Mirrors the first-party clients, where every
 * question carries its own "Other" box rather than one form-level field.
 */
function questionCustomFieldKey(index) {
    return `question_${index}_custom`;
}
/**
 * `_meta` key under which a bridged enum option carries its structured
 * `description`/`preview`, since ACP's `EnumOption` has no field for either.
 * Namespaced like the agent's other `_meta` extensions (`_claude/...`).
 */
const OPTION_META_KEY = "_claude/askUserQuestionOption";
/**
 * Build the `_meta` payload that carries an option's structured `description`
 * and optional `preview` for clients that can render them as distinct fields.
 * Returns `undefined` when neither is present, so we don't emit an empty `_meta`.
 */
function askUserQuestionOptionMeta(option) {
    const detail = {};
    if (option.description) {
        detail.description = option.description;
    }
    if (option.preview) {
        detail.preview = option.preview;
    }
    return Object.keys(detail).length > 0 ? { [OPTION_META_KEY]: detail } : undefined;
}
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
export function askUserQuestionsToCreateRequest(questions, sessionId, toolCallId) {
    const single = questions.length === 1;
    const properties = {};
    questions.forEach((question, index) => {
        const options = question.options.map((option) => {
            const enumOption = {
                const: option.label,
                // `title` stays a flattened "label — description" string so clients that
                // only read `const`/`title` still surface the description. Clients that
                // understand the `_meta` below should prefer its structured fields (and
                // treat `const` as the clean label) rather than parsing this title.
                title: option.description ? `${option.label} — ${option.description}` : option.label,
            };
            // The SDK option carries a `description` (secondary text) and an optional
            // `preview` (mockups, code snippets, comparisons shown on focus). Neither
            // has a structural slot in `EnumOption`, so forward them under ACP's
            // reserved `_meta` extension point for clients that can render them.
            const meta = askUserQuestionOptionMeta(option);
            if (meta) {
                enumOption._meta = meta;
            }
            return enumOption;
        });
        // For a single question the prompt is carried by `message`, so we don't
        // repeat it in the field description. With multiple questions each field
        // needs its own question text.
        const description = single ? undefined : question.question;
        const title = question.header || undefined;
        properties[questionFieldKey(index)] = question.multiSelect
            ? { type: "array", title, description, items: { anyOf: options } }
            : { type: "string", title, description, oneOf: options };
        properties[questionCustomFieldKey(index)] = {
            type: "string",
            title: "Other",
            description: "Type your own answer instead of choosing an option above (optional).",
        };
    });
    const requestedSchema = {
        type: "object",
        properties,
    };
    const message = single ? questions[0].question : "Please answer the following questions.";
    return {
        mode: "form",
        sessionId,
        ...(toolCallId ? { toolCallId } : {}),
        message,
        requestedSchema,
    };
}
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
export function applyAskElicitationResponse(response, toolInput, questions) {
    if (response.action === "cancel") {
        return { action: "cancel" };
    }
    if (response.action === "decline") {
        return { action: "answered", updatedInput: { ...toolInput, answers: {} } };
    }
    const content = response.content ?? {};
    // Typed against the tool's own output schema so the answer/response shapes
    // stay in sync with what the built-in tool's call() expects to read back.
    const answers = {};
    questions.forEach((question, index) => {
        // A typed custom answer wins over the selection: the user chose to write
        // their own answer for this question instead of picking an option.
        const custom = content[questionCustomFieldKey(index)];
        if (typeof custom === "string" && custom.trim() !== "") {
            answers[question.question] = custom.trim();
            return;
        }
        const value = content[questionFieldKey(index)];
        if (value === undefined || value === null) {
            return;
        }
        const text = Array.isArray(value) ? value.join(", ") : String(value);
        if (text === "") {
            return;
        }
        answers[question.question] = text;
    });
    return { action: "answered", updatedInput: { ...toolInput, answers } };
}
/**
 * Coerce an arbitrary MCP `requestedSchema` into an ACP `ElicitationSchema`.
 * The two are structurally compatible JSON Schemas; we just guarantee the
 * `type: "object"` discriminator is present.
 */
function normalizeElicitationSchema(schema) {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {} };
    }
    return { ...schema, type: "object" };
}
