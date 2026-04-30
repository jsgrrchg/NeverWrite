#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. $0 0.2.0)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TOML="$ROOT/apps/desktop/native-backend/Cargo.toml"
PACKAGE_JSON="$ROOT/apps/desktop/package.json"
PACKAGE_LOCK="$ROOT/apps/desktop/package-lock.json"

VERSION="$VERSION" PACKAGE_JSON="$PACKAGE_JSON" PACKAGE_LOCK="$PACKAGE_LOCK" node --input-type=module <<'EOF'
import fs from "node:fs";

const { VERSION, PACKAGE_JSON, PACKAGE_LOCK } = process.env;

for (const filePath of [PACKAGE_JSON, PACKAGE_LOCK]) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  json.version = VERSION;
  if (json.packages?.[""]) {
    json.packages[""].version = VERSION;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 4)}\n`);
}
EOF

VERSION="$VERSION" CARGO_TOML="$CARGO_TOML" node --input-type=module <<'EOF'
import fs from "node:fs";

const { VERSION, CARGO_TOML } = process.env;
const input = fs.readFileSync(CARGO_TOML, "utf8");
const output = input.replace(
  /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
  `$1"${VERSION}"`,
);

if (output === input) {
  throw new Error(`Could not update [package] version in ${CARGO_TOML}`);
}

fs.writeFileSync(CARGO_TOML, output);
EOF

echo "Bumped to $VERSION:"
echo "  $CARGO_TOML"
echo "  $PACKAGE_JSON"
echo "  $PACKAGE_LOCK"
