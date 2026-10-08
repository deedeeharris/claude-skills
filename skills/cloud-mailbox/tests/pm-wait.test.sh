#!/usr/bin/env bash
# Regression tests for scripts/pm-wait.sh with a fake `gh` on PATH. No network, no real mailbox.
# usage: bash tests/pm-wait.test.sh     exit: 0 all pass | 1 a test failed
set -u
here="$(cd "$(dirname "$0")" && pwd)"
waiter="$here/../scripts/pm-wait.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
# The fake gh answers the two calls pm-wait makes: the issue list and one issue's comments
# (already shaped as the TSV its --jq would print). FAKE_ROWS picks the rows.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
row() { printf '%s\t%s\t%s\t%s\n' "$1" 2026-10-08T00:00:0"$1"Z "https://x/$1" "$2"; }
case "$*" in
  *comments*)
    for r in $FAKE_ROWS; do
      case "$r" in
        lead) row 1 "$(printf '\n[cloud:w] ACK\nPlease send input' | base64 | tr -d '\n')" ;;
        long) row 2 "$(printf '[cloud:w] RESULT\nl2\nl3\nl4' | base64 | tr -d '\n')" ;;
        bad)  row 3 '!!not-base64!!' ;;
      esac
    done ;;
  *issues*) echo 7 ;;
esac
exit 0
EOF
chmod +x "$work/bin/gh"
fails=0
check() { if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
waitrun() { PATH="$work/bin:$PATH" FAKE_ROWS="$1" timeout 30 bash "$waiter" --repo o/r --author a --state "$work/state" --interval 1 --max-hours 1 "${@:2}"; }

rm -f "$work/state"; out=$(waitrun lead); rc=$?
[ $rc -eq 0 ] && grep -q '^MAILBOX #7 .* https://x/1 \[cloud:w\] ACK$' <<<"$out" && grep -q '^  | Please send input$' <<<"$out" \
  && grep -q '^o/r 7 1$' "$work/state" && r=ok || r=bad
check "$r" "a body that starts with a newline: header shows its first text line, every line is printed, cursor moves"

rm -f "$work/state"; out=$(waitrun long --max-lines 2); rc=$?
[ $rc -eq 0 ] && grep -q '^  | l2$' <<<"$out" && ! grep -q '^  | l3$' <<<"$out" && grep -q '^  | \.\.\. 2 more line(s): https://x/2$' <<<"$out" && r=ok || r=bad
check "$r" "a body over --max-lines is cut and points at the comment URL"

rm -f "$work/state"; out=$(waitrun "lead bad" 2>"$work/err"); rc=$?
[ $rc -eq 2 ] && grep -q 'cannot decode comment 3' "$work/err" && [ ! -s "$work/state" ] && r=ok || r=bad
check "$r" "a body that does not decode exits 2 and marks nothing as read"

out=$(waitrun lead --max-lines 08 2>"$work/err"); rc=$?
[ $rc -eq 2 ] && grep -q 'max-lines' "$work/err" && r=ok || r=bad
check "$r" "--max-lines with a leading zero is a usage error"

[ $fails -eq 0 ] && echo "PASS" || echo "FAIL ($fails)"
[ $fails -eq 0 ]
