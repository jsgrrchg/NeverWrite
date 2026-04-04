import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_APPCAST_CHANNEL,
  buildChannelAppcastUrl,
  createStaticAppcastManifest,
  getDefaultAppcastOutputPath,
  normalizeAppcastChannel,
  normalizeReleaseVersion,
  readNotesForVersion,
  readPlatformsFile,
  serializeAppcastManifest,
} from "./appcast-lib.mjs";

function parseArgs(argv) {
  const args = {
    channel: DEFAULT_APPCAST_CHANNEL,
    version: null,
    pubDate: null,
    platformsFile: null,
    notesFile: null,
    output: null,
    publicBaseUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] ?? null;

    if (arg === "--channel") {
      args.channel = next;
      index += 1;
      continue;
    }
    if (arg === "--version") {
      args.version = next;
      index += 1;
      continue;
    }
    if (arg === "--pub-date") {
      args.pubDate = next;
      index += 1;
      continue;
    }
    if (arg === "--platforms-file") {
      args.platformsFile = next;
      index += 1;
      continue;
    }
    if (arg === "--notes-file") {
      args.notesFile = next;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      args.output = next;
      index += 1;
      continue;
    }
    if (arg === "--public-base-url") {
      args.publicBaseUrl = next;
      index += 1;
      continue;
    }

    throw new Error(
      `Unknown argument "${arg}". Supported args: --channel, --version, --pub-date, --platforms-file, --notes-file, --output, --public-base-url.`,
    );
  }

  if (!args.version) {
    throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
  }
  if (!args.pubDate) {
    throw new Error("Missing required argument --pub-date <RFC3339>.");
  }
  if (!args.platformsFile) {
    throw new Error("Missing required argument --platforms-file <path>.");
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const channel = normalizeAppcastChannel(args.channel);
  const version = normalizeReleaseVersion(args.version);
  const notes = readNotesForVersion(version, args.notesFile);
  const platforms = readPlatformsFile(args.platformsFile);
  const manifest = createStaticAppcastManifest({
    version,
    notes,
    pubDate: args.pubDate,
    platforms,
  });

  const outputPath = args.output
    ? path.resolve(args.output)
    : getDefaultAppcastOutputPath(channel);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serializeAppcastManifest(manifest), "utf8");

  console.log(`Appcast manifest written to ${outputPath}`);
  if (args.publicBaseUrl) {
    console.log(
      `Public URL: ${buildChannelAppcastUrl(args.publicBaseUrl, channel)}`,
    );
  }
}

main();
