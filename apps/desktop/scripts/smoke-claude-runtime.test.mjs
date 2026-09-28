import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeSmokeMock } from "./smoke-claude-runtime.mjs";

const marker = "NEVERWRITE_CLAUDE_SMOKE";
const model = "claude-sonnet-5-5";
const post = (mock, messages, extra = {}) => fetch(`${mock.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...extra }),
    signal: AbortSignal.timeout(5000),
});

test("smoke cancellation holds the real user turn despite trailing system messages", { timeout: 10000 }, async (t) => {
    const mock = await createClaudeSmokeMock("/fixture.txt");
    t.after(() => mock.close());
    let cancellationStarted = false;
    mock.cancellationRequest.then(() => { cancellationStarted = true; });

    // A title request quotes the markers but must finish without releasing the
    // cancellation barrier or being counted as a main-conversation request.
    const titleRequest = [{ role: "user", content: [{ type: "text",
        text: `<session>\n${marker}: read fixture.txt then finish.\n${marker}_CANCEL\n</session>\nWrite the title.` }] }];
    const first = await (await post(mock, titleRequest, { model: "claude-haiku-4-5" })).json();
    const second = await (await post(mock, titleRequest)).json();
    assert.notEqual(first.id, second.id, "Separate assistant messages must not share an ID");
    assert.equal(cancellationStarted, false);
    assert.deepEqual(mock.state.turnModels, []);
    assert.equal(mock.state.readRequested, false);

    const response = await post(mock, [
        { role: "user", content: [
            { type: "tool_result", tool_use_id: "neverwrite_read", content: "Earlier read result" },
            { type: "text", text: `${marker}_CANCEL` },
        ] },
        { role: "system", content: [{ type: "text", text: "SDK context reminder" }] },
    ], { stream: true });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(cancellationStarted, true);
    assert.deepEqual(mock.state.turnModels, [model]);
    assert.equal(mock.state.readCompleted, false, "Cancellation must precede the historical tool result");
    assert.equal(mock.state.error, undefined);
    await response.body.cancel();
});
