#!/usr/bin/env bash
# gstack-harness-ledger.sh — sourced; removes what gstack-harness registered,
# from its ledger, without bun (bin/gstack-uninstall runs it before it removes
# the checkout and the state root). Ledger format: lib/harness-register.ts.
# Callers set GSTACK_STATE_ROOT first (bin/gstack-state-root.sh).
#
#   gstack_harness_unregister_ledger <ledger>   remove one registration
#   gstack_harness_unregister_all               remove every registration under
#                                               $GSTACK_STATE_ROOT/harness
#
# A file whose bytes still match the ledger is removed; an edited one is moved
# to $GSTACK_STATE_ROOT/backups/harness/<stamp>/; a context block is cut out of
# its file between the gstack:begin/end harness-routing markers (the file is
# removed only when nothing else is left in it); folders gstack created are
# removed only when empty. A QM pack is never touched here: detaching it from
# the org is `gstack-harness unregister qm --remote`.

_gstack_harness_sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

_gstack_harness_cut_block() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  tmp="$file.gstack-cut.$$"
  awk 'index($0, "<!-- gstack:begin harness-routing -->") { skip = 1 } !skip { print } index($0, "<!-- gstack:end harness-routing -->") { skip = 0 }' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  if [ -z "$(tr -d '[:space:]' < "$tmp")" ]; then rm -f "$tmp" "$file"; else mv "$tmp" "$file"; fi
}

gstack_harness_unregister_ledger() {
  local ledger="$1" root="${GSTACK_STATE_ROOT:?gstack-harness-ledger: GSTACK_STATE_ROOT is not set}" stamp kind a b target="" dest="" pack="" backup
  [ -f "$ledger" ] || return 0
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"
  backup="$root/backups/harness/$stamp"
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      meta) case "$a" in target) target="$b" ;; dest) dest="$b" ;; qm_pack) pack="$b" ;; esac ;;
      file)
        { [ -f "$b" ] && [ ! -L "$b" ]; } || continue
        if [ "$(_gstack_harness_sha "$b")" = "$a" ]; then rm -f "$b"
        else mkdir -p "$backup$(dirname "$b")" && mv "$b" "$backup$b" && echo "  kept your edit: $b moved to $backup$b"; fi ;;
      block) _gstack_harness_cut_block "$b" ;;
    esac
  done < "$ledger"
  while IFS=$'\t' read -r kind a b; do
    [ "$kind" = dir ] && [ -d "$b" ] && rmdir "$b" 2>/dev/null
  done < "$ledger"
  case "$target" in
    openclaw|hermes)
      if command -v gstack_install_registry_remove >/dev/null 2>&1; then gstack_install_registry_remove "$target" "$dest" || true; fi ;;
    qm) [ -z "$pack" ] || echo "  QM: dropped the local record of pack $pack; the pack stays in your QM org until an org admin archives it (DELETE $dest/v1/admin/skill-packs/$pack)" ;;
  esac
  rm -f "$ledger"
}

gstack_harness_unregister_all() {
  local root="${GSTACK_STATE_ROOT:?gstack-harness-ledger: GSTACK_STATE_ROOT is not set}" l
  for l in "$root"/harness/*.ledger; do
    [ -f "$l" ] || continue
    gstack_harness_unregister_ledger "$l" && echo "harness: $(basename "$l" .ledger)"
  done
}

_gstack_harness_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_gstack_harness_dir/gstack-install-registry.sh" ] && . "$_gstack_harness_dir/gstack-install-registry.sh"
