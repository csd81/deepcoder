#!/usr/bin/env bash
# Build a self-contained deepcoder bundle for injection into SWE-bench containers.
#
# The official SWE-bench instance images are Python/conda only (no Node), so the
# in-container solve loop needs its own runtime. This produces:
#
#   evals/swebench/deepcoder-bundle.tgz  ->  ./node  ./dist  ./node_modules  ./package.json
#
# In a container it runs as:  /opt/deepcoder/node /opt/deepcoder/dist/cli/main.js …
#
# Node is reproducible: a PINNED LTS tarball is downloaded once into
# evals/swebench/.cache/ and CHECKSUM-VERIFIED (no network on later builds).
# Set DEEPCODER_BUNDLE_NODE=system to reuse a compatible host Node (linux-x64, >=20).
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root (deepcoder/)
ROOT="$(pwd)"

NODE_VERSION="v20.18.1"             # pinned LTS
NODE_ARCH="linux-x64"
NODE_SHA256="c6fa75c841cbffac851678a472f2a5bd612fff8308ef39236190e1f8dbb0e567"  # node-v20.18.1-linux-x64.tar.xz
CACHE="$ROOT/evals/swebench/.cache"
OUT="$ROOT/evals/swebench/deepcoder-bundle.tgz"
mkdir -p "$CACHE"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "== building dist =="
npm run build >/dev/null

echo "== staging production node_modules (no devDeps) =="
cp package.json package-lock.json "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts >/dev/null )

# --- acquire the node binary -------------------------------------------------
NODE_BIN=""
if [ "${DEEPCODER_BUNDLE_NODE:-}" = "system" ]; then
  if [ "$(node -p 'process.platform+"-"+process.arch' 2>/dev/null)" = "linux-x64" ] \
     && [ "$(node -p 'Number(process.versions.node.split(".")[0])>=20' 2>/dev/null)" = "true" ]; then
    NODE_BIN="$(command -v node)"
    echo "== using system node: $NODE_BIN ($(node --version)) =="
  else
    echo "!! system node is not linux-x64/>=20; falling back to pinned download" >&2
  fi
fi
if [ -z "$NODE_BIN" ]; then
  TARBALL="node-$NODE_VERSION-$NODE_ARCH.tar.xz"
  if [ ! -f "$CACHE/$TARBALL" ]; then
    echo "== downloading pinned $TARBALL =="
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL"
  fi
  echo "== verifying checksum =="
  echo "$NODE_SHA256  $CACHE/$TARBALL" | sha256sum -c -
  EXTRACT="$CACHE/node-$NODE_VERSION-$NODE_ARCH"
  if [ ! -x "$EXTRACT/bin/node" ]; then
    tar -xf "$CACHE/$TARBALL" -C "$CACHE"
  fi
  NODE_BIN="$EXTRACT/bin/node"
fi

# --- assemble bundle ---------------------------------------------------------
echo "== assembling bundle =="
BUNDLE="$STAGE/bundle"
mkdir -p "$BUNDLE"
cp "$NODE_BIN" "$BUNDLE/node"; chmod +x "$BUNDLE/node"
cp -r "$ROOT/dist" "$BUNDLE/dist"
cp -r "$STAGE/node_modules" "$BUNDLE/node_modules"
cp "$ROOT/package.json" "$BUNDLE/package.json"

tar -czf "$OUT" -C "$BUNDLE" .
echo "== wrote $OUT ($(du -h "$OUT" | cut -f1)) =="

# --- self-check: the bundled node runs and the CLI loads --------------------
"$BUNDLE/node" --version
"$BUNDLE/node" "$BUNDLE/dist/cli/main.js" --help >/dev/null && echo "bundle CLI --help OK"
