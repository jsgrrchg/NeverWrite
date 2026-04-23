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

sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"
sed -i '' "1,/^version = / s/^version = \".*\"/version = \"$VERSION\"/" "$CARGO_TOML"

echo "Bumped to $VERSION:"
echo "  $CARGO_TOML"
echo "  $PACKAGE_JSON"
