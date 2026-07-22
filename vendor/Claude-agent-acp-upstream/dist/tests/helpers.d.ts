/**
 * Shared test doubles. Deliberately vitest-free so `vi.mock` async factories
 * can `await import("./helpers.js")` without ordering hazards; tests supply
 * their own vi.fn spies via `overrides`.
 */
/** The context-usage report the base mock query returns. `rawMaxTokens`
 *  matches the agent's DEFAULT_CONTEXT_WINDOW so window-related assertions
 *  don't shift in tests that don't care about context usage. */
export declare const DEFAULT_CONTEXT_USAGE: {
    totalTokens: number;
    rawMaxTokens: number;
};
/**
 * Base stub for the SDK `query()` return object, covering the surface
 * ClaudeAcpAgent touches unconditionally at session creation. Tests pass
 * `overrides` for the parts they assert on (spies, custom models, rejecting
 * getContextUsage, …).
 *
 * When the agent starts calling a new SDK method on every session, add it
 * here once — the getContextUsage adoption required hand-editing ~10 inline
 * mocks across five files, and any missed copy didn't fail: it silently
 * rerouted that test through the error-fallback branch and re-polluted test
 * output.
 */
export declare function makeMockQuery(overrides?: Record<string, unknown>): {
    initializationResult: () => Promise<{
        models: never[];
    }>;
    setModel: () => Promise<void>;
    setPermissionMode: () => Promise<void>;
    supportedCommands: () => Promise<never[]>;
    getContextUsage: () => Promise<{
        totalTokens: number;
        rawMaxTokens: number;
    }>;
    [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
};
//# sourceMappingURL=helpers.d.ts.map