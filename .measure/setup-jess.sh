#!/usr/bin/env bash
# MEASUREMENT SCAFFOLDING — NOT FOR MERGE.
#
# Builds the four jess dialect grammars against THIS parseman worktree, which is
# what makes them measurable at all:
#
#  · jess pins parseman ^0.32.0 from the registry. The carried-IR artifacts in
#    @jesscss/internal-css-recognition are version-locked, so a 0.34.0 macro
#    REJECTS 0.32.0 pieces — the recognition package must be rebuilt too, not
#    just the parsers.
#  · pnpm writes `link:` overrides as node_modules-relative symlinks, which for an
#    absolute target come out broken. They are re-pointed below.
set -euo pipefail
PM="${PM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${DEST:-/Users/matthew/git/worktrees/jess-dispatch-measure}"
JESS="${JESS:-/Users/matthew/git/oss/jess}"

[ -d "$DEST" ] || git -C "$JESS" worktree add "$DEST" origin/dev
node -e "
const fs=require('fs'),p='$DEST/package.json',j=JSON.parse(fs.readFileSync(p,'utf8'));
j.pnpm=j.pnpm||{}; j.pnpm.overrides={...j.pnpm.overrides, parseman:'link:$PM'};
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
(cd "$DEST" && pnpm install)
# Re-point the broken relative symlinks pnpm produced.
find "$DEST" -maxdepth 4 -name parseman -type l -not -path '*/.pnpm/*' \
  -exec sh -c 'rm "$1"; ln -s "$2" "$1"' _ {} "$PM" \;
echo "jess measurement worktree ready at $DEST"
