import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { Logger } from "./acp-agent.js";
import { ClaudeCodeSettings } from "./settings.js";
export declare class Pushable<T> implements AsyncIterable<T> {
    private queue;
    private resolvers;
    private done;
    push(item: T): void;
    end(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
export declare function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array>;
export declare function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array>;
export declare function unreachable(value: never, logger?: Logger): void;
export declare function sleep(time: number): Promise<void>;
export declare function loadManagedSettings(): ClaudeCodeSettings | null;
export declare function applyEnvironmentSettings(settings: ClaudeCodeSettings): void;
//# sourceMappingURL=utils.d.ts.map