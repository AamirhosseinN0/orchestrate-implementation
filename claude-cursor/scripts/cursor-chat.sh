#!/usr/bin/env bash
# Open a chat and print its uuid — the address a chip is resumed on.
#
# Taken by shape rather than by position. A banner on either side of the uuid
# would otherwise become part of the address, and that failure does not surface
# until much later, as --resume quietly opening a new chat.
set -uo pipefail

CID=$(agent create-chat 2>/dev/null \
      | tr -d '\r' \
      | grep -Eoi '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
      | tail -1)

if [ -z "$CID" ]; then
  echo "✗ create-chat produced no uuid — refusing to hand out an address that is not one." >&2
  exit 1
fi
printf '%s\n' "$CID"
