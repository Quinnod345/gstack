#!/usr/bin/env bash
# ubi-runner — run a command on an ephemeral Ubicloud VM.
#
#   UBICLOUD_API_KEY=... scripts/ubicloud/ubi-runner.sh run --setup S.sh -- 'make test'
#
# UBICLOUD_API_TOKEN is accepted as an alias for UBICLOUD_API_KEY. SSH
# connections are multiplexed per VM, and `pack` / `unpack` upload one prebuilt
# checkout tarball to many VMs. This is the repo copy the user-scope Capy
# `ubicloud` skill and gbrain's scripts/ubicloud/ubi-runner.sh are kept in sync
# with (plan E2); `bun run test:ubicloud` drives it through test-free.sh.
#
# Scratch record: every VM this machine creates is appended to a VM-id file
# (UBI_VM_RECORD; default ~/.capy/work/ubi-runner/vms.tsv when ~/.capy/work
# exists, else $STATE_ROOT/vms.tsv) as `name location owner created_at pid`,
# and removed once `down` confirms it gone. A resumed Capy thread reads that
# file to find VMs an earlier turn left behind (docs/TESTING_INTERNALS.md,
# "Resuming after a wake").
#
# Creates a VM (standard-16 by default), streams the checkout to it (tracked +
# untracked-unignored files + .git, so uncommitted edits are included), runs an
# optional setup script and the command, copies requested artifacts back, and
# destroys the VM on every exit path. Exits with the command's status.
# Needs only bash, curl, python3, ssh, ssh-keygen, and tar locally, so it works
# from dev boxes, containers, and cloud sandboxes.
#
# Ownership: VMs are named ubirun-<owner>-<epoch>-<suffix>. <owner> is UBI_OWNER
# (lowercased, letters and digits only, at most 12 characters, starting with a
# letter) or a random per-machine id kept in $STATE_ROOT/owner-id. Ubicloud names
# allow 63 characters of [a-z0-9-], so a full name stays under 40.
#
# Teardown: `up` records each VM's state (location, create status) before it
# sends the create request, and `down` destroys and polls until the VM is
# confirmed gone or provably never existed, waiting out a create that may still
# be in flight. An interrupted `up` or `run` (EXIT, INT, TERM, HUP, QUIT) runs
# that `down`; further signals are ignored until it finishes. A create refused
# for vCPU quota prints the project's usage per owner.
#
# Stale-VM sweeps are off by default. With UBI_GC_HOURS set to a positive
# number, every `up` first destroys this owner's VMs older than that; `gc HOURS`
# runs the same sweep on demand. Neither ever touches another owner's VMs.
#
# TTL and reaper: a name this script generates ends in -t<hours> (UBI_TTL_HOURS,
# default 4; 0 omits it), the creator's own declaration of how long the VM may
# live. `reap` destroys every VM in the project whose TTL expired more than ten
# minutes ago, whichever owner made it, and every `up` runs it first (UBI_REAP=0
# skips it), so a runner killed by a sleeping machine leaves nothing behind for
# longer than its TTL. Names without a TTL are never reaped.
#
# Quota preflight: when the project's vCPU ceiling is known (UBI_QUOTA_VCPUS, or
# the maximum a refusal printed, cached in $STATE_ROOT/quota-max), `up` adds the
# size's vCPUs to the project's running VMs and refuses before any create when
# that exceeds it; UBI_QUOTA_WAIT=<seconds> waits for room instead.
#
# Watchdog: `run`, `verify` and `ssh NAME COMMAND` stream the remote output
# through a watchdog that logs a heartbeat every UBI_HEARTBEAT seconds (300)
# and kills a command silent for UBI_IDLE_TIMEOUT seconds (1800) or older than
# UBI_RUN_TIMEOUT seconds (0, unlimited), exiting 124 with the last 40 lines,
# so a hung verify fails fast instead of holding the VM until its TTL.
#
# `verify` is the one entry point for a repository's full remote verify: it
# reads .gstack/ubicloud.json (setup, command, size, location, env, pass, pull)
# and runs it through `run`, so lanes share one committed definition instead of
# per-lane wrappers.
set -euo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

API="${UBICLOUD_API_URL:-https://api.ubicloud.com}"
STATE_ROOT="${UBI_RUNNER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ubi-runner}"
DEFAULT_SIZE="${UBI_SIZE:-standard-16}"
DEFAULT_LOCATION="${UBI_LOCATION:-eu-central-h1}"
GC_HOURS="${UBI_GC_HOURS:-0}"
API_TIMEOUT="${UBI_API_TIMEOUT:-120}"
CREATE_GRACE="${UBI_CREATE_GRACE:-180}"
DOWN_TIMEOUT="${UBI_DOWN_TIMEOUT:-900}"
POLL="${UBI_POLL_SECONDS:-5}"
ALLOWED_STORAGE="${UBI_ALLOWED_STORAGE:-320 640}"
TTL_HOURS="${UBI_TTL_HOURS:-4}"
REAP="${UBI_REAP:-1}"
REAP_GRACE=600
IDLE_TIMEOUT="${UBI_IDLE_TIMEOUT:-1800}"
RUN_TIMEOUT="${UBI_RUN_TIMEOUT:-0}"
HEARTBEAT="${UBI_HEARTBEAT:-300}"
QUOTA_VCPUS="${UBI_QUOTA_VCPUS:-}"
QUOTA_WAIT="${UBI_QUOTA_WAIT:-0}"
PREFIX="ubirun"
if [ -n "${UBI_VM_RECORD:-}" ]; then VM_RECORD="$UBI_VM_RECORD"
elif [ -d "$HOME/.capy/work" ]; then VM_RECORD="$HOME/.capy/work/ubi-runner/vms.tsv"
else VM_RECORD="$STATE_ROOT/vms.tsv"; fi

die() { echo "ubi-runner: $*" >&2; exit 1; }
log() { echo "ubi-runner: $*" >&2; }

for bin in curl python3 ssh ssh-keygen tar; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
UBICLOUD_API_KEY="${UBICLOUD_API_KEY:-${UBICLOUD_API_TOKEN:-}}"
[[ "$GC_HOURS" =~ ^[0-9]+$ ]] || die "UBI_GC_HOURS must be a whole number of hours (unset or 0 disables the sweep)"
[[ "$TTL_HOURS" =~ ^[0-9]+$ ]] || die "UBI_TTL_HOURS must be a whole number of hours (0 names VMs without a TTL)"
for v in IDLE_TIMEOUT RUN_TIMEOUT HEARTBEAT QUOTA_WAIT; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || die "UBI_$v must be a whole number of seconds (0 disables it)"
done
[ -z "$QUOTA_VCPUS" ] || [[ "$QUOTA_VCPUS" =~ ^[0-9]+$ ]] || die "UBI_QUOTA_VCPUS must be a whole number of vCPUs"

owner_id() {
  local raw=${UBI_OWNER:-} file="$STATE_ROOT/owner-id" tmp
  if [ -z "$raw" ]; then
    if [ ! -s "$file" ]; then
      mkdir -p "$STATE_ROOT"
      tmp="$file.$$"
      echo "m$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$tmp"
      mv -n "$tmp" "$file"
      rm -f "$tmp"
    fi
    raw=$(cat "$file")
  fi
  raw=$(printf %s "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
  [ -n "$raw" ] || die "UBI_OWNER must contain letters or digits"
  [[ "$raw" =~ ^[a-z] ]] || raw="u$raw"
  echo "${raw:0:12}"
}
OWNER=$(owner_id)

# api OUT ARGS...: send one Ubicloud CLI command, write the body to OUT, and
# print the HTTP status (000 when no response arrived).
api() {
  local out=$1 code
  shift
  code=$(python3 -c 'import json,sys; print(json.dumps({"argv": sys.argv[1:]}))' "$@" \
    | curl -sS -o "$out" -w '%{http_code}' --max-time "$API_TIMEOUT" -X POST \
        -H "Authorization: Bearer $UBICLOUD_API_KEY" \
        -H 'Accept: text/plain' -H 'Content-Type: application/json' \
        -H 'X-Ubi-Version: 1.0.0' --data @- "$API/cli") || true
  echo "${code:-000}"
}

cli() {
  local out code
  out=$(mktemp)
  code=$(api "$out" "$@")
  if [ "$code" = 000 ]; then
    rm -f "$out"
    die "request failed: ubi $*"
  fi
  if [ "$code" != 200 ]; then
    cat "$out" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

state_dir() { echo "$STATE_ROOT/$1"; }

load() {
  local dir
  dir=$(state_dir "$1")
  [ -f "$dir/env" ] || die "no local state for VM '$1' (created on another machine?)"
  # shellcheck disable=SC1091
  . "$dir/env"
  KEY="$dir/key"
}

ssh_opts() {
  echo -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10 \
    -o ControlMaster=auto -o "ControlPath=$(dirname "$KEY")/ctl" -o ControlPersist=300
}

# Ubuntu's default umask (002) leaves new directories group-writable, which
# permission-checking code under test rejects; every remote command uses 022.
remote() {
  local name=$1; shift
  load "$name"
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "ubi@$IP" "umask 022; $*"
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# watched NAME PHASE COMMAND: run COMMAND on the VM, streaming its output and
# keeping a copy of both streams in the VM's state dir, with a heartbeat every HEARTBEAT
# seconds and a watchdog that kills it after IDLE_TIMEOUT seconds of silence or
# RUN_TIMEOUT seconds in total: exit 124, reason and the last 40 lines on
# stderr. The ssh runs in its own session (python3's setsid) so the watchdog
# kills it and anything it started, not just the shell that launched it.
watched() {
  local name=$1 phase=$2 cmd=$3 out pid rc=0 start now last_beat idle elapsed why=""
  load "$name"
  out="$(state_dir "$name")/$phase.log"
  : >"$out"
  # shellcheck disable=SC2046
  ( exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      ssh $(ssh_opts) "ubi@$IP" "umask 022; $cmd" ) > >(tee -a "$out") 2> >(tee -a "$out" >&2) &
  pid=$!
  start=$(date +%s)
  last_beat=$start
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL"
    now=$(date +%s)
    elapsed=$(( now - start ))
    idle=$(( now - $(mtime "$out") ))
    if [ "$IDLE_TIMEOUT" -gt 0 ] && [ "$idle" -ge "$IDLE_TIMEOUT" ]; then
      why="printed nothing for ${idle}s (UBI_IDLE_TIMEOUT=$IDLE_TIMEOUT)"
    elif [ "$RUN_TIMEOUT" -gt 0 ] && [ "$elapsed" -ge "$RUN_TIMEOUT" ]; then
      why="ran ${elapsed}s (UBI_RUN_TIMEOUT=$RUN_TIMEOUT)"
    fi
    if [ -n "$why" ]; then
      log "watchdog: $phase $why; killing it. Last output:"
      tail -n 40 "$out" >&2
      kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    if [ "$HEARTBEAT" -gt 0 ] && [ $(( now - last_beat )) -ge "$HEARTBEAT" ]; then
      log "heartbeat: $phase ${elapsed}s elapsed, last output ${idle}s ago"
      last_beat=$now
    fi
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# vm_rows: "location name owner expires" for every VM in the project; owner is
# "-" for untagged ubirun-<epoch>-* names and "." for VMs this runner did not
# name; expires is the epoch the name's -t<hours> TTL ends at, or "-".
vm_rows() {
  local loc name owner created expires
  cli vm list -N -f location,name | while read -r loc name; do
    owner=. created="" expires=-
    if [[ "$name" =~ ^${PREFIX}-([a-z][a-z0-9]{0,11})-([0-9]{10})- ]]; then
      owner=${BASH_REMATCH[1]} created=${BASH_REMATCH[2]}
    elif [[ "$name" =~ ^${PREFIX}-([0-9]{10})- ]]; then
      owner=- created=${BASH_REMATCH[1]}
    fi
    if [ -n "$created" ] && [[ "$name" =~ -t([0-9]+)$ ]]; then
      expires=$(( created + BASH_REMATCH[1] * 3600 ))
    fi
    echo "$loc $name $owner $expires"
  done
}

# reap: destroy every VM whose name carries a TTL that ended more than
# REAP_GRACE seconds ago, whichever owner created it (the TTL is that owner's
# own declaration). Names without a TTL are never touched.
cmd_reap() {
  local now loc name owner expires n=0
  now=$(date +%s)
  while read -r loc name owner expires; do
    [ "$expires" != - ] || continue
    [ "$now" -ge $(( expires + REAP_GRACE )) ] || continue
    n=$(( n + 1 ))
    log "reaping expired $loc/$name (owner $owner; its TTL ended $(( (now - expires) / 60 )) min ago)"
    cmd_down "$name" -l "$loc" || log "failed to reap $loc/$name"
  done < <(vm_rows)
  [ "$n" -gt 0 ] || log "reap: no expired VMs"
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name owner
  [[ "$hours" =~ ^[0-9]+$ ]] || die "gc: HOURS must be a whole number (or set UBI_GC_HOURS)"
  if [ "$hours" -eq 0 ]; then log "gc: no sweep (give HOURS > 0 or set UBI_GC_HOURS); nothing listed, nothing destroyed"; return 0; fi
  now=$(date +%s)
  vm_rows | while read -r loc name owner _; do
    [ "$owner" = "$OWNER" ] || continue
    [[ "$name" =~ -([0-9]{10})- ]] || continue
    if [ $(( (now - BASH_REMATCH[1]) / 3600 )) -ge "$hours" ]; then
      log "destroying stale $loc/$name (owner $OWNER, older than ${hours}h)"
      cmd_down "$name" -l "$loc" || log "failed to destroy $loc/$name"
    fi
  done
}

cmd_list() {
  case ${1:-} in
    "") cli vm list ;;
    --mine) vm_rows | awk -v o="$OWNER" '$3==o {print $1 "  " $2}' ;;
    *) die "list: unknown option $1 (use --mine)" ;;
  esac
}

# usage: VMs and vCPUs per owner, from each VM's size (standard-16 = 16 vCPUs).
cmd_usage() {
  local tmp loc name owner i=0
  tmp=$(mktemp -d)
  while read -r loc name owner _; do
    i=$(( i + 1 ))
    cli vm "$loc/$name" show 2>/dev/null | sed -n "s/^size: /$owner /p" >"$tmp/$i" &
    [ $(( i % 8 )) -ne 0 ] || wait
  done < <(vm_rows)
  wait
  cat "$tmp"/* 2>/dev/null | awk -v me="$OWNER" '
    { n = $2; sub(/^.*-/, "", n); o = $1 == "-" ? "(untagged)" : $1 == "." ? "(other)" : $1
      vms[o]++; cpu[o] += n; total += n; count++ }
    END {
      printf "%-14s %4s %6s\n", "OWNER", "VMS", "VCPUS"
      for (o in cpu) printf "%-14s %4d %6d%s\n", o, vms[o], cpu[o], o == me ? "  (you)" : "" | "sort -k3,3nr"
      close("sort -k3,3nr")
      printf "%-14s %4d %6d\n", "total", count, total
    }'
  rm -rf "$tmp"
}

write_state() {
  printf 'NAME=%q\nLOCATION=%q\nSIZE=%q\nIP=%q\nCREATED=%q\nCREATE_AT=%q\nCREATE_PID=%q\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$$" >"$(state_dir "$1")/env"
}

# record_vm NAME LOCATION: append to the scratch VM-id file (record-before-create).
record_vm() {
  mkdir -p "$(dirname "$VM_RECORD")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$OWNER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >>"$VM_RECORD"
}

# forget_vm NAME: drop the VM from the scratch file once it is confirmed gone.
forget_vm() {
  [ -f "$VM_RECORD" ] || return 0
  local tmp="$VM_RECORD.$$"
  awk -F'\t' -v n="$1" '$1!=n' "$VM_RECORD" >"$tmp" && mv "$tmp" "$VM_RECORD"
}

# records: print the scratch file (VMs this machine created and has not confirmed gone).
cmd_records() {
  echo "record: $VM_RECORD"
  [ -s "$VM_RECORD" ] || { echo "(no VMs recorded)"; return 0; }
  printf '%-40s %-14s %-12s %-20s %s\n' NAME LOCATION OWNER CREATED_AT PID
  awk -F'\t' '{ printf "%-40s %-14s %-12s %-20s %s\n", $1, $2, $3, $4, $5 }' "$VM_RECORD"
}

new_name() {
  local ttl=""
  [ "$TTL_HOURS" -eq 0 ] || ttl="-t$TTL_HOURS"
  echo "$PREFIX-$OWNER-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')$ttl"
}

# vcpus SIZE: the vCPU count a Ubicloud size name carries (standard-16 -> 16).
vcpus() { [[ "$1" =~ -([0-9]+)$ ]] && echo "${BASH_REMATCH[1]}"; }

# quota_preflight LOCATION NAME SIZE: refuse (or wait UBI_QUOTA_WAIT seconds)
# before the create request when the project's running VMs plus this size
# exceed the known vCPU ceiling. The ceiling comes from UBI_QUOTA_VCPUS or the
# maximum the last refusal printed; without either the API's own refusal rules.
quota_preflight() {
  local location=$1 name=$2 size=$3 need max used wait_until
  need=$(vcpus "$size") || return 0
  max=${QUOTA_VCPUS:-$(cat "$STATE_ROOT/quota-max" 2>/dev/null || true)}
  [[ "$max" =~ ^[0-9]+$ ]] || return 0
  wait_until=$(( $(date +%s) + QUOTA_WAIT ))
  while :; do
    used=$(cmd_usage 2>/dev/null | awk '$1=="total" {print $3}')
    [[ "$used" =~ ^[0-9]+$ ]] || return 0
    [ $(( used + need )) -gt "$max" ] || return 0
    if [ "$(date +%s)" -ge "$wait_until" ]; then
      log "quota preflight refused $location/$name ($size): it needs $need vCPUs and the project's VMs already use $used of $max (ceiling from UBI_QUOTA_VCPUS or the last refusal; other usage such as managed runners counts on top)"
      cmd_usage >&2 || true
      die "create refused before any request: vCPU quota full; wait for running VMs to finish (UBI_QUOTA_WAIT=<seconds> waits here), run $0 reap, or use a smaller size"
    fi
    log "quota: $used of $max vCPUs in use and $need needed; waiting up to $(( wait_until - $(date +%s) ))s more for room"
    sleep 30
  done
}

valid_name() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

# check_storage GIB: Ubicloud accepts only these disk sizes; refuse before any API call.
check_storage() {
  case " $ALLOWED_STORAGE " in
    *" $1 "*) [ -n "$1" ] && return 0 ;;
  esac
  die "invalid storage '$1' GiB (allowed: $ALLOWED_STORAGE; set UBI_ALLOWED_STORAGE when Ubicloud adds sizes)"
}

UP_NAME=""
UP_READY=""
cmd_up() {
  local size=$DEFAULT_SIZE location=$DEFAULT_LOCATION name="" storage="" image=ubuntu-noble
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size) size=$2; shift 2 ;;
      -l|--location) location=$2; shift 2 ;;
      -n|--name) name=$2; shift 2 ;;
      -S|--storage) check_storage "$2"; storage=$2; shift 2 ;;
      -b|--image) image=$2; shift 2 ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  [ -n "$name" ] || name=$(new_name)
  valid_name "$name" || die "invalid VM name '$name' (Ubicloud allows 1-63 of a-z, 0-9 and '-', starting and ending with a letter or digit)"
  if [ "$REAP" != 0 ]; then
    cmd_reap || log "reap failed; continuing"
  fi
  if [ "$GC_HOURS" -gt 0 ]; then
    cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"
  fi
  quota_preflight "$location" "$name" "$size"

  local dir create_at
  dir=$(state_dir "$name")
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/key"

  local args=(vm "$location/$name" create -s "$size" -b "$image")
  [ -z "$storage" ] || args+=(-S "$storage")
  args+=("$(cat "$dir/key.pub")")
  create_at=$(date +%s)
  write_state "$name" "$location" "$size" "" unknown "$create_at"
  record_vm "$name" "$location"
  UP_NAME=$name
  log "creating $location/$name ($size)"
  # Hold signals until the create answer is recorded, so teardown knows
  # whether the VM exists instead of waiting out UBI_CREATE_GRACE.
  local interrupted="" created=yes refusal need used max
  trap 'interrupted=1' INT TERM HUP QUIT
  cli "${args[@]}" >/dev/null 2>"$dir/create.err" || created=no
  write_state "$name" "$location" "$size" "" "$created" "$create_at"
  trap 'exit 130' INT TERM HUP QUIT
  [ -z "$interrupted" ] || exit 130
  if [ "$created" = no ]; then
    refusal=$(sed -n 's/.*Requested vCPU count: \([0-9]*\), currently used vCPU count: \([0-9]*\), maximum allowed vCPU count: \([0-9]*\).*/\1 \2 \3/p' "$dir/create.err")
    if [ -z "$refusal" ]; then
      cat "$dir/create.err" >&2
      die "create failed"
    fi
    read -r need used max <<<"$refusal"
    echo "$max" >"$STATE_ROOT/quota-max"
    log "quota refused $location/$name ($size): it needs $need vCPUs and the project already uses $used of $max"
    log "VMs in the project by owner (the rest of the used count is other usage, such as managed GitHub runners):"
    cmd_usage >&2 || true
    die "create failed: vCPU quota exhausted; wait for running VMs to finish, or use fewer or smaller VMs (ci:ubicloud --vms N)"
  fi

  local deadline=$(( $(date +%s) + 600 )) show state ip
  while :; do
    show=$(cli vm "$location/$name" show 2>/dev/null || true)
    state=$(sed -n 's/^state: //p' <<<"$show")
    ip=$(sed -n 's/^ip4: //p' <<<"$show")
    [ "$state" = running ] && [ -n "$ip" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "VM did not reach running in 10 minutes (last state: ${state:-unknown})"
    sleep "$POLL"
  done
  write_state "$name" "$location" "$size" "$ip" yes "$create_at"

  load "$name"
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  until ssh $(ssh_opts) "ubi@$IP" true 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "SSH did not come up on $IP"
    sleep "$POLL"
  done
  remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true'
  UP_READY=1
  log "ready: $name ($IP)"
  echo "$name"
}

# down NAME [-l LOCATION]: destroy NAME and return 0 only once it is confirmed
# gone or never existed. While this machine's create request for NAME may
# still be in flight (its `up` process is alive, or the create was sent less
# than UBI_CREATE_GRACE seconds ago with no answer), "not found" is not final.
cmd_down() {
  local name=${1:-} loc="" dir
  [ -n "$name" ] || die "down: missing NAME"
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      -l|--location) loc=$2; shift 2 ;;
      *) die "down: unknown option $1" ;;
    esac
  done
  valid_name "$name" || die "invalid VM name '$name'"
  dir=$(state_dir "$name")
  local CREATED=none CREATE_AT=0 CREATE_PID="" IP="" LOCATION="" KEY=""
  if [ -f "$dir/env" ]; then
    load "$name"
    loc=$LOCATION
    if [ -S "$dir/ctl" ] && [ -n "$IP" ]; then
      # shellcheck disable=SC2046
      ssh $(ssh_opts) -O exit "ubi@$IP" >/dev/null 2>&1 || true
    fi
  fi

  local deadline=$(( $(date +%s) + DOWN_TIMEOUT )) seen=0 asked=0 out code now
  out=$(mktemp)
  while :; do
    now=$(date +%s)
    if [ -z "$loc" ]; then
      loc=$(vm_rows 2>/dev/null | awk -v n="$name" '$2==n {print $1}') || loc=""
      code=404
      [ -z "$loc" ] || code=$(api "$out" vm "$loc/$name" show)
    else
      code=$(api "$out" vm "$loc/$name" show)
    fi
    if [ "$code" = 200 ]; then
      seen=1
      if [ $(( now - asked )) -ge 60 ]; then
        code=$(api "$out" vm "$loc/$name" destroy -f)
        if [ "$code" != 200 ]; then
          cat "$out" >&2
          rm -f "$out"
          log "FAILED to destroy $loc/$name (HTTP $code); retry: $0 down $name"
          return 1
        fi
        asked=$now
        log "destroy requested: $loc/$name"
      fi
    elif [ "$code" = 404 ]; then
      if [ "$seen" = 1 ] || [ "$CREATED" != unknown ] || { [ $(( now - CREATE_AT )) -ge "$CREATE_GRACE" ] \
        && { [ "$CREATE_PID" = "$$" ] || ! kill -0 "$CREATE_PID" 2>/dev/null; }; }; then
        rm -f "$out"
        rm -rf "$dir"
        forget_vm "$name"
        if [ "$seen" = 1 ]; then log "destroyed ${loc:-?}/$name"; else log "gone: ${loc:-?}/$name (never existed or already destroyed)"; fi
        return 0
      fi
      log "waiting for an in-flight create of $name to resolve"
    fi
    if [ "$now" -ge "$deadline" ]; then
      rm -f "$out"
      log "WARNING: could not confirm ${loc:-?}/$name is gone after ${DOWN_TIMEOUT}s; rerun: $0 down $name"
      return 1
    fi
    sleep "$POLL"
  done
}

# pack SRC: write a gzipped checkout tarball to stdout (tracked + untracked
# files that are not ignored, plus .git; a non-git directory is taken whole).
cmd_pack() {
  local src
  src=$(cd "${1:-.}" && pwd)
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    (
      cd "$src"
      { git ls-files -z -co --exclude-standard; printf '.git\0'; } \
        | while IFS= read -r -d '' f; do
            if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - -czf -
    )
  else
    tar -C "$src" -czf - .
  fi
}

# unpack NAME DEST: extract a tarball read from stdin into DEST on the VM.
cmd_unpack() {
  local qdest
  qdest=$(printf %q "$2")
  remote "$1" "mkdir -p $qdest && tar -xzf - -C $qdest"
}

cmd_sync() {
  local name=$1 src=${2:-.} dest=${3:-}
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"
  cmd_pack "$src" | cmd_unpack "$name" "$dest"
  log "synced $src -> $name:$dest"
}

# pull NAME REMOTE_GLOB LOCAL_DIR: copy matching remote entries into LOCAL_DIR.
# Relative remote paths start at /home/ubi. A glob that matches nothing (for
# example an optional flake ledger) is reported and skipped, not a failure.
cmd_pull() {
  local name=$1 from=$2 to=$3 dir
  dir=$(printf %q "$(dirname "$from")")
  if ! remote "$name" "cd $dir 2>/dev/null && ls -d -- $(basename "$from") >/dev/null 2>&1"; then
    log "pull: nothing matches $from"
    return 0
  fi
  mkdir -p "$to"
  remote "$name" "cd $dir && tar -czf - $(basename "$from")" | tar -xzf - -C "$to"
}

cmd_run() {
  local up_args=() src=. dest="" setup="" keep=0 pulls=() envs=()
  while [ $# -gt 0 ]; do
    case $1 in
      -S|--storage) check_storage "$2"; up_args+=("$1" "$2"); shift 2 ;;
      -s|--size|-l|--location|-n|--name|-b|--image) up_args+=("$1" "$2"); shift 2 ;;
      --src) src=$2; shift 2 ;;
      --dest) dest=$2; shift 2 ;;
      --setup) setup=$2; shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      --pass) [ -n "${!2+x}" ] || die "--pass $2: not set locally"; envs+=("$2=${!2}"); shift 2 ;;
      --pull) pulls+=("$2"); shift 2 ;;
      --keep) keep=1; shift ;;
      --) shift; break ;;
      *) die "run: unknown option $1" ;;
    esac
  done
  [ $# -gt 0 ] || die "run: missing command after --"
  [ -z "$setup" ] || [ -f "$setup" ] || die "setup script not found: $setup"
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"

  local i name=""
  for (( i = 0; i < ${#up_args[@]}; i += 2 )); do
    case ${up_args[i]} in -n|--name) name=${up_args[i+1]} ;; esac
  done
  [ -n "$name" ] || { name=$(new_name); up_args+=(-n "$name"); }
  RUN_VM=$name
  # Armed before the create request: an interrupted `up` still destroys its VM.
  # A second signal must not cut teardown short, so the EXIT handler ignores them.
  trap 'trap "" INT TERM HUP QUIT; cmd_down "$RUN_VM" || log "WARNING: failed to destroy $RUN_VM; run: $0 down $RUN_VM"' EXIT
  trap 'exit 130' INT TERM HUP QUIT
  cmd_up "${up_args[@]}" >/dev/null
  if [[ "$name" =~ -t([0-9]+)$ ]]; then
    log "$name carries a ${BASH_REMATCH[1]}h TTL (any later run of this script reaps it); if this process dies first: $0 down $name"
  else
    log "$name has no TTL; if this process dies before its teardown line, destroy it with: $0 down $name"
  fi
  if [ "$keep" = 1 ]; then
    trap - EXIT
    log "--keep: leaving $name running; destroy with: $0 down $name"
  fi

  local e
  for e in ${envs[@]+"${envs[@]}"}; do printf 'export %s=%q\n' "${e%%=*}" "${e#*=}"; done \
    | remote "$name" 'umask 077 && cat > ~/.ubirun-env'

  cmd_sync "$name" "$src" "$dest"
  local qdest
  qdest=$(printf %q "$dest")
  if [ -n "$setup" ]; then
    remote "$name" 'cat > ~/.ubirun-setup.sh' <"$setup"
    log "running setup $(basename "$setup")"
    watched "$name" setup "cd $qdest && . ~/.ubirun-env && bash -l ~/.ubirun-setup.sh" || die "setup failed (exit $?)"
  fi

  local start rc=0
  start=$(date +%s)
  log "running on $name: $*"
  watched "$name" command "cd $qdest && . ~/.ubirun-env && bash -lc $(printf %q "$*")" || rc=$?
  log "command exited $rc after $(( $(date +%s) - start ))s"

  local p
  for p in ${pulls[@]+"${pulls[@]}"}; do
    cmd_pull "$name" "${p%%:*}" "${p#*:}" || log "pull failed: $p"
  done
  return "$rc"
}

# verify [run opts] [-- COMMAND]: run the repository's committed remote verify.
# .gstack/ubicloud.json under --src (default .) supplies setup, command, size,
# location, storage, image, env, pass and pull; flags given here and a trailing
# -- COMMAND override it. Without the file it refuses, so every lane runs the
# one committed definition instead of its own wrapper.
cmd_verify() {
  local src=. i j cfg cfg_setup cfg_cmd user_pre=() user_cmd=()
  for (( i = 1; i <= $#; i++ )); do
    [ "${!i}" = -- ] && break
    if [ "${!i}" = --src ]; then j=$(( i + 1 )); src=${!j}; fi
  done
  cfg="$src/.gstack/ubicloud.json"
  [ -f "$cfg" ] || die "verify: no $cfg; commit one ({\"setup\": \"scripts/ubicloud/bootstrap.sh\", \"command\": \"bash scripts/ubicloud/verify.sh\"}) so every lane runs the same verify instead of its own wrapper"
  local cfg_args=() parsed
  parsed=$(python3 -c '
import json, shlex, sys
c = json.load(open(sys.argv[1]))
q = lambda s: shlex.quote(str(s))
args = []
for key, flag in (("size", "-s"), ("location", "-l"), ("storage", "-S"), ("image", "-b")):
    if key in c: args += [flag, q(c[key])]
for key, flag in (("env", "--env"), ("pass", "--pass"), ("pull", "--pull")):
    for item in c.get(key, []): args += [flag, q(item)]
print("cfg_args=(" + " ".join(args) + ")")
print("cfg_setup=" + q(c.get("setup", "")))
print("cfg_cmd=" + q(c.get("command", "")))
' "$cfg" 2>/dev/null) || die "verify: $cfg is not valid JSON"
  eval "$parsed"
  while [ $# -gt 0 ]; do
    if [ "$1" = -- ]; then shift; user_cmd=("$@"); break; fi
    user_pre+=("$1"); shift
  done
  [ -z "$cfg_setup" ] || [[ "$cfg_setup" = /* ]] || cfg_setup="$src/$cfg_setup"
  [ ${#user_cmd[@]} -gt 0 ] || [ -n "$cfg_cmd" ] || die "verify: $cfg names no command and none was given after --"
  [ ${#user_cmd[@]} -gt 0 ] || user_cmd=("$cfg_cmd")
  log "verify: $cfg"
  cmd_run ${cfg_args[@]+"${cfg_args[@]}"} ${cfg_setup:+--setup "$cfg_setup"} --src "$src" ${user_pre[@]+"${user_pre[@]}"} -- "${user_cmd[@]}"
}

usage() {
  cat <<EOF
usage: ubi-runner.sh <command> [args]

  run [up opts] [--src DIR] [--dest PATH] [--setup FILE] [--env K=V]...
      [--pass NAME]... [--pull REMOTE_GLOB:LOCAL_DIR]... [--keep] -- COMMAND
                         up + sync + setup + command + pull + destroy; exits with COMMAND's status
  verify [run opts] [-- COMMAND]
                         run the repository's committed verify (.gstack/ubicloud.json under --src)
  up [-s SIZE] [-l LOCATION] [-n NAME] [-S STORAGE_GIB] [-b IMAGE]
                         create a VM and wait for SSH; prints its name
                         (STORAGE_GIB: one of $ALLOWED_STORAGE)
  ssh NAME [COMMAND]     shell or login-shell command on the VM (user ubi, passwordless sudo)
  sync NAME [SRC] [DEST] stream a checkout (tracked + untracked-unignored + .git)
  pack [SRC]             write that checkout tarball to stdout
  unpack NAME DEST       extract a tarball from stdin into DEST on the VM
  pull NAME REMOTE_GLOB LOCAL_DIR
                         copy matching remote entries into LOCAL_DIR
  down NAME [-l LOC]     destroy the VM; returns once it is confirmed gone or never existed
  list [--mine]          list all VMs in the project, or only this owner's
  usage                  VMs and vCPUs per owner across the project
  owner                  print this caller's owner tag ($OWNER)
  records                VMs this machine created and has not confirmed gone ($VM_RECORD)
  gc HOURS               destroy this owner's VMs older than HOURS (never other owners')
  reap                   destroy every VM whose -t<hours> TTL has ended (any owner; TTL-less names never)
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

VMs are named $PREFIX-<owner>-<epoch>-<suffix>-t<ttl hours>; set UBI_OWNER (e.g. your
thread code) to tag them, otherwise a per-machine id is used.
defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
env: UBI_TTL_HOURS (${TTL_HOURS}h in the name; 0 omits it), UBI_REAP (0: up skips the reap),
     UBI_IDLE_TIMEOUT (${IDLE_TIMEOUT}s of silence kills the remote command, exit 124; 0 disables),
     UBI_RUN_TIMEOUT (${RUN_TIMEOUT}s wall clock; 0 unlimited), UBI_HEARTBEAT (${HEARTBEAT}s between heartbeat lines),
     UBI_QUOTA_VCPUS (project vCPU ceiling for the preflight; else the last refusal's maximum),
     UBI_QUOTA_WAIT (${QUOTA_WAIT}s to wait for quota room instead of refusing),
     UBI_GC_HOURS (unset/0: no sweep on up), UBI_CREATE_GRACE (${CREATE_GRACE}s),
     UBI_DOWN_TIMEOUT (${DOWN_TIMEOUT}s), UBI_API_TIMEOUT (${API_TIMEOUT}s), UBI_VM_RECORD (scratch VM-id file),
     UBI_ALLOWED_STORAGE (the -S sizes Ubicloud accepts; default "320 640")
EOF
}

cmd=${1:-help}
[ $# -eq 0 ] || shift
case $cmd in
  owner|pack|records|help|-h|--help) ;;
  *) [ -n "${UBICLOUD_API_KEY:-}" ] || die "UBICLOUD_API_KEY is not set (create a token under your Ubicloud project's Tokens page)" ;;
esac
case $cmd in
  run) cmd_run "$@" ;;
  verify) cmd_verify "$@" ;;
  up) trap 'trap "" INT TERM HUP QUIT; [ -z "$UP_NAME" ] || [ -n "$UP_READY" ] || cmd_down "$UP_NAME" || log "WARNING: failed to destroy $UP_NAME; run: $0 down $UP_NAME"' EXIT
      trap 'exit 130' INT TERM HUP QUIT
      cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else watched "$name" ssh "bash -lc $(printf %q "$*")"; fi ;;
  sync) cmd_sync "$@" ;;
  pack) cmd_pack "$@" ;;
  unpack) cmd_unpack "$@" ;;
  pull) cmd_pull "$@" ;;
  down) cmd_down "$@" ;;
  list) cmd_list "$@" ;;
  usage) cmd_usage ;;
  owner) echo "$OWNER" ;;
  records) cmd_records ;;
  gc) cmd_gc "$@" ;;
  reap) cmd_reap ;;
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
