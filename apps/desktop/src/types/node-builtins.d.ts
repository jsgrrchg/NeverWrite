declare module "node:fs/promises" {
    export function readFile(path: string | URL): Promise<Uint8Array>;
}

declare module "node:path" {
    export function join(...paths: string[]): string;
}

declare module "node:url" {
    export function fileURLToPath(url: string | URL): string;
}
