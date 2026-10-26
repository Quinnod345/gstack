# Negative control for test/launch-env-echo-ratchet.test.ts

Every fenced command below that would print the environment must be reported;
the allowed lines must not. Prose mentions such as "never `export $(...)`" are
not commands and are not scanned.

```bash
export $(sed -n 's/^GSTACK_LAUNCH: //p' install.log)
export "$(cat launch.env)"
env
env | grep -i key
printenv
printenv ANTHROPIC_API_KEY
set
export
export -p
declare -x
typeset -x
declare -p
cd /repo && env
```

Allowed:

```bash
set -euo pipefail
set -u
env FOO=1 ./tool --flag
export FOO=bar
export GSTACK_SESSION_KIND=spawned
. "$GSTACK_LAUNCH_FILE"
set | grep '^SCOPE_'
declare -x FOO=1
declare -p FOO
echo "$HOME"
# env
```

```json
{"env": "not a command"}
```
