import fs from "node:fs";
import path from "node:path";

import { readNotesForVersion } from "./appcast-lib.mjs";
import { buildReleaseBody } from "./release-assets-lib.mjs";

function parseArgs(argv) {
  const args = {
    version: null,
    notesFile: null,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] ?? null;

    if (arg === "--version") {
      args.version = next;
      index += 1;
      continue;
    }
    if (arg === "--notes-file") {
      args.notesFile = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      args.output = path.resolve(next);
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown argument "${arg}". Supported args: --version, --notes-file, --output.`,
    );
  }

  if (!args.version) {
    throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const notes = readNotesForVersion(args.version, args.notesFile);
  const body = buildReleaseBody(args.version, notes);

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, body, "utf8");
    console.log(`Release body written to ${args.output}`);
    return;
  }

  process.stdout.write(body);
}

main();
