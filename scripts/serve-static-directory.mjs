import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
    const args = {
        dir: null,
        port: 8787,
        host: "127.0.0.1",
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--dir") {
            args.dir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--port") {
            args.port = Number.parseInt(next, 10);
            index += 1;
            continue;
        }
        if (arg === "--host") {
            args.host = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --dir, --port, --host.`,
        );
    }

    if (!args.dir) {
        throw new Error("Missing required argument --dir <directory>.");
    }
    if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
        throw new Error(`Invalid port "${args.port}".`);
    }
    if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
        throw new Error(`Static directory does not exist: ${args.dir}`);
    }

    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "/", `http://${args.host}`);
        const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
        const filePath = path.resolve(
            args.dir,
            relativePath === "" ? "index.html" : relativePath,
        );

        if (!filePath.startsWith(args.dir)) {
            response.statusCode = 403;
            response.end("Forbidden");
            return;
        }

        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.statusCode = 404;
            response.end("Not found");
            return;
        }

        const extension = path.extname(filePath).toLowerCase();
        response.setHeader(
            "Content-Type",
            CONTENT_TYPES[extension] ?? "application/octet-stream",
        );
        fs.createReadStream(filePath).pipe(response);
    });

    server.listen(args.port, args.host, () => {
        console.log(`Serving ${args.dir} at http://${args.host}:${args.port}/`);
    });
}

main();
