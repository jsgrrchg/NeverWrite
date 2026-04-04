import {
  CHANGELOG_PATH,
  getChangelogEntry,
  normalizeReleaseTag,
  readFile,
} from "./release-metadata-lib.mjs";

function main() {
  const rawVersion = process.argv[2];
  if (!rawVersion) {
    console.error("Usage: node scripts/extract-changelog-release-notes.mjs <version-or-tag>");
    process.exit(1);
  }

  const version = rawVersion.startsWith("v") ? normalizeReleaseTag(rawVersion) : rawVersion;
  const changelog = readFile(CHANGELOG_PATH);
  const entry = getChangelogEntry(changelog, version);

  if (!entry) {
    console.error(`CHANGELOG.md does not contain a release entry for ${version}.`);
    process.exit(1);
  }

  process.stdout.write(entry.notes);
}

main();
