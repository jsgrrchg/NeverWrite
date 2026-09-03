/**
 * Shared session-level test doubles for the agent suites.
 *
 * Distinct from `helpers.ts`, which is deliberately vitest-free so `vi.mock`
 * factories can `await import` it; these need `vi.fn` spies, so they live apart.
 */
/** Build the replayed `user` message the SDK echoes back for a pushed prompt,
 *  used by mock generators to promote a turn to active. */
export declare function userEcho(u: any): {
    type: string;
    message: any;
    parent_tool_use_id: null;
    uuid: any;
    session_id: string;
    isReplay: boolean;
};
/** Wrap a mock async generator with the `Query` methods the agent calls outside
 *  of iteration — `close()` (teardown/closeQueryStream), `interrupt()` (cancel),
 *  and `setModel()` — so a bare generator doesn't trip "x is not a function". */
export declare function wrapQuery(generator: AsyncGenerator<any>): any;
/** The common `Session` mock fields, with per-test overrides spread on top.
 *  Centralizes the boilerplate (usage accumulator, caches, controllers) so a new
 *  Session field is added in one place rather than every inline literal.
 *
 *  Pass `agent` when the test exercises titles — `SessionTitles` publishes and
 *  logs through it, and compares `agent.sessions[sessionId]` to spot a session
 *  replaced mid-generation. */
export declare function mockSessionState(overrides?: Record<string, any>, agent?: any, sessionId?: string): any;
/** One successful turn: echo the pushed prompt, emit a result, go idle. Shared
 *  by suites that only need a session to reach turn-end. */
export declare function successfulResultMessage(overrides?: Record<string, any>): {
    type: "result";
    subtype: string;
    stop_reason: string;
    is_error: boolean;
    result: string;
    errors: never[];
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
    total_cost_usd: number;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
    };
    modelUsage: {};
    permission_denials: never[];
    uuid: `${string}-${string}-${string}-${string}-${string}`;
    session_id: string;
};
//# sourceMappingURL=session-doubles.d.ts.map