#!/usr/bin/env bash
# Build the test page once per packed editor tarball and serve each build under its own path:
# page/dist/<variant>/editor.html. The plain controls sit at the root, page/dist/plain.html.
# Usage: scripts/build-variants.sh (from the repo root). Prints one EDITOR_VERSION line per variant.
set -eu
cd page
variants="main:editor-main-280e61b70 placeholder:editor-placeholder-03840d379 zw:editor-zw-b5a5c6ca7 both:editor-both-a90f36a35"
mkdir -p dist-all
for entry in $variants; do
  name=${entry%%:*}
  tgz=${entry#*:}
  npm pkg set "dependencies.@portabletext/editor=file:tarballs/$tgz.tgz"
  npm install --no-audit --no-fund --no-package-lock
  npm run build
  echo "EDITOR_VERSION $name $tgz $(node -p "require('./node_modules/@portabletext/editor/package.json').version")"
  mv dist "dist-all/$name"
done
cp src/plain.html src/plain-zw.html src/probe.js dist-all/
mv dist-all dist
ls dist dist/*
