# mask-commit-message.awk — read by careful/bin/check-careful.sh (#1060).
# Prints the command with the quoted message argument of git commit
# (-m, -am, --message) replaced by an empty quoted string. The command is
# scanned as one string: newlines are kept, since bash runs each line as its
# own command, and quote state carries across lines.
#
# Only git commit's own arguments are masked: the scanner splits the command
# at unquoted ; & | ( ) and newlines, and masks a message flag only in a
# segment whose first word is git and that has a commit word after it. A
# commit piped into another command is printed unchanged, because git prints
# the message on stdout. Quotes and backslashes follow bash: a backslash
# escapes the next character outside single quotes, and nothing inside single
# quotes. An unterminated quote or escape prints the command unchanged.
function handle_msg(s, n, i,    j, c, safe) {
  if (i > n) return i
  if (substr(s, i, 1) == "'") {
    j = i + 1
    while (j <= n && substr(s, j, 1) != "'") j++
    if (j > n) return i
    result = result "''"
    return j + 1
  }
  if (substr(s, i, 1) == "\"") {
    j = i + 1; safe = 1
    while (j <= n && (c = substr(s, j, 1)) != "\"") {
      if (c == "$" || c == "`" || c == "\\") safe = 0
      j++
    }
    if (!safe || j > n) return i
    result = result "\"\""
    return j + 1
  }
  return i
}
# flag S I — length of the message flag (with its trailing blanks) at S[I], or 0
function flag(s, i,    rest, m) {
  rest = substr(s, i)
  if (rest ~ /^--message=/) return 10
  if (match(rest, /^(--message|-am|-m)[ \t]+/)) return RLENGTH
  return 0
}
{ cmd = (NR > 1) ? cmd "\n" $0 : $0 }
END {
  s = cmd
  n = length(s); sq = 0; dq = 0; bs = 0; i = 1
  atword = 1; words = 0; git = 0; commit = 0; piped = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (bs) { result = result c; bs = 0; i++; continue }
    if (sq) { if (c == "'") sq = 0; result = result c; i++; continue }
    if (dq) {
      if (c == "\\") bs = 1
      else if (c == "\"") dq = 0
      result = result c; i++; continue
    }
    if (c ~ /[;&|()\n]/) {
      if (c == "|" && commit && substr(s, i + 1, 1) != "|") piped = 1
      atword = 1; words = 0; git = 0; commit = 0
      result = result c; i++; continue
    }
    if (c == " " || c == "\t") { atword = 1; result = result c; i++; continue }
    if (atword) {
      atword = 0; words++
      rest = substr(s, i)
      if (words == 1 && rest ~ /^git([ \t\n;&|()]|$)/) git = 1
      else if (git && !commit && rest ~ /^commit([ \t\n;&|()]|$)/) commit = 1
      else if (commit && (len = flag(s, i)) > 0) {
        result = result substr(s, i, len); i += len
        j = handle_msg(s, n, i)
        atword = (j == i); i = j
        continue
      }
    }
    if (c == "\\") bs = 1
    else if (c == "'") sq = 1
    else if (c == "\"") dq = 1
    result = result c; i++
  }
  printf "%s", (sq || dq || bs || piped) ? s : result
}
