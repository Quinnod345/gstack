# mask-commit-message.awk — read by careful/bin/check-careful.sh (#1060).
# Prints the command with the quoted message argument of git commit
# (-m, -am, --message) replaced by an empty quoted string.
function handle_msg(s, n, i,    j, safe) {
  if (i > n) return i
  if (substr(s, i, 1) == "'") {
    result = result "'"
    i++
    while (i <= n && substr(s, i, 1) != "'") i++
    result = result "'"
    if (i <= n) i++
  } else if (substr(s, i, 1) == "\"") {
    j = i+1; safe = 1
    while (j <= n && substr(s, j, 1) != "\"") {
      if (substr(s,j,1) == "$" || substr(s,j,1) == "`" || substr(s,j,1) == "\\") safe = 0
      j++
    }
    if (safe) { result = result "\"\""; i = j+1 }
    else {
      result = result substr(s, i, j-i)
      if (j <= n) result = result "\""
      i = j+1
    }
  }
  return i
}
{
  n = length($0); sq = 0; dq = 0; bs = 0; i = 1
  while (i <= n) {
    c = substr($0, i, 1)
    if (bs) { result = result c; bs = 0; i++; continue }
    if (!sq && dq && c == "\\") { result = result c; bs = 1; i++; continue }
    if (!dq && c == "'") { sq = !sq; result = result c; i++; continue }
    if (!sq && c == "\"") { dq = !dq; result = result c; i++; continue }
    if (sq || dq) { result = result c; i++; continue }
    rest = substr($0, i)
    if (rest ~ /^--message=/) {
      result = result "--message="; i += 10
      i = handle_msg($0, n, i); continue
    }
    if (rest ~ /^--message([ \t]|$)/) {
      result = result "--message"; i += 9
      while (i <= n && substr($0,i,1) ~ /[ \t]/) { result = result substr($0,i,1); i++ }
      i = handle_msg($0, n, i); continue
    }
    if (rest ~ /^-am([ \t]|$)/) {
      result = result "-am"; i += 3
      while (i <= n && substr($0,i,1) ~ /[ \t]/) { result = result substr($0,i,1); i++ }
      i = handle_msg($0, n, i); continue
    }
    if (rest ~ /^-m([ \t]|$)/) {
      result = result "-m"; i += 2
      while (i <= n && substr($0,i,1) ~ /[ \t]/) { result = result substr($0,i,1); i++ }
      i = handle_msg($0, n, i); continue
    }
    result = result c; i++
  }
  printf "%s", result
}
