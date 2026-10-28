#!/bin/sh
# Seeds an /office-hours eval work dir: a git repo holding the CSV-merge idea, plus a gstack state root at ./.gstack-home.
# Usage (from a task's setup, cwd = the run's work dir): sh "$SKILL_EVAL_FIXTURES/seed.sh"
set -eu
git init -q -b main
git config user.email eval@example.com
git config user.name eval
cat > README.md <<'EOF'
# csvmerge

Idea: small online shops export CSVs from Stripe, Shopify and their bookkeeping tool, and someone
spends hours each month lining the rows up by hand. csvmerge would take those exports and produce
one clean spreadsheet: rows matched by customer email, duplicate orders removed, columns renamed
to one schema.

Nothing is built yet.
EOF
git add -A
git commit -qm init
printf '.gstack-home/\n' >> .git/info/exclude
mkdir -p .gstack-home/projects
