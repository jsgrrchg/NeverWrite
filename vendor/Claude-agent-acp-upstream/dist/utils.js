// A pushable async iterable: allows you to push items and consume them with for-await.
import { WritableStream, ReadableStream } from "node:stream/web";
import { readFileSync } from "node:fs";
import { getManagedSettingsPath } from "./settings.js";
// Useful for bridging push-based and async-iterator-based code.
export class Pushable {
    constructor() {
        this.queue = [];
        this.resolvers = [];
        this.done = false;
    }
    push(item) {
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve({ value: item, done: false });
        }
        else {
            this.queue.push(item);
        }
    }
    end() {
        this.done = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve({ value: undefined, done: true });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                if (this.queue.length > 0) {
                    const value = this.queue.shift();
                    return Promise.resolve({ value, done: false });
                }
                if (this.done) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => {
                    this.resolvers.push(resolve);
                });
            },
        };
    }
}
// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream) {
    return new WritableStream({
        write(chunk) {
            return new Promise((resolve, reject) => {
                nodeStream.write(Buffer.from(chunk), (err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
        },
    });
}
export function nodeToWebReadable(nodeStream) {
    return new ReadableStream({
        start(controller) {
            nodeStream.on("data", (chunk) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => controller.error(err));
        },
    });
}
export function unreachable(value, logger = console) {
    let valueAsString;
    try {
        valueAsString = JSON.stringify(value);
    }
    catch {
        valueAsString = value;
    }
    logger.error(`Unexpected case: ${valueAsString}`);
}
export function sleep(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}
export function loadManagedSettings() {
    try {
        return JSON.parse(readFileSync(getManagedSettingsPath(), "utf8"));
    }
    catch {
        return null;
    }
}
export function applyEnvironmentSettings(settings) {
    if (settings.env) {
        for (const [key, value] of Object.entries(settings.env)) {
            process.env[key] = value;
        }
    }
}
