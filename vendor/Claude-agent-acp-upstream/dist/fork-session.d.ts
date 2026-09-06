import { ForkSessionRequest, ForkSessionResponse } from "@agentclientprotocol/sdk";
type ForkSessionDependencies = {
    liveMessageIdToUuid?: ReadonlyMap<string, string>;
    logger?: {
        log: (...args: unknown[]) => void;
    };
    messageIdForGrouping: (message: {
        type?: string;
        uuid?: string | null;
        message?: unknown;
    }) => string | undefined;
};
export declare function forkSession(params: ForkSessionRequest, dependencies: ForkSessionDependencies): Promise<ForkSessionResponse>;
export {};
//# sourceMappingURL=fork-session.d.ts.map