#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$CMD" ]] && exit 0

# Normalize all whitespace (tabs, newlines, multiple spaces) to single space
NORMALIZED_CMD=$(echo "$CMD" | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')

# === Layer 1: Exact pattern blocklist ===
BLOCKED=(
  "rm -rf /"
  "rm -rf /[*]"
  "rm -rf [~]"
  "rm -r -f /"
  "rm -r -f /[*]"
  "rm -r -f [~]"
  "git push.*--force"
  "git push.*--force-with-lease"
  "git reset --hard"
  "git clean -fd"
  "kubectl delete namespace"
  "kubectl delete -A"
  "DROP TABLE"
  "DROP DATABASE"
  "TRUNCATE TABLE"
  "> /dev/sd"
  "mkfs[.]"
  ":(){ :|:& };:"
  "chmod -R 777 /"
  "chmod 777 /etc"
  "chmod 777 /usr"
  "chmod 777 /var"
)

for p in "${BLOCKED[@]}"; do
  if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
    echo "BLOCKED: 위험 명령어 감지" >&2
    echo "  Pattern: $p" >&2
    echo "  Command: ${CMD:0:120}" >&2
    exit 2
  fi
done

# === Layer 2: Shell metacharacter / indirection detection ===
# These patterns detect attempts to bypass Layer 1 via shell features
INDIRECT_PATTERNS=(
  '^\s*eval\b'                   # eval "rm -rf /" (command-initial only)
  ';\s*eval\b'                   # ...; eval "rm -rf /"
  '&&\s*eval\b'                  # ... && eval "rm -rf /"
  '\|\|\s*eval\b'               # ... || eval "rm -rf /"
  '\bexec\b\s'                  # exec rm -rf /
  '\$\('                        # $(echo rm) -rf /
  '`[^`]+`'                     # `echo rm` -rf /
  '\bcurl\b.*\|\s*\b(ba)?sh\b' # curl ... | sh (pipe-to-shell)
  '\bwget\b.*\|\s*\b(ba)?sh\b' # wget ... | sh
  '\bcurl\b.*\|\s*\bsource\b'  # curl ... | source
  '\bdd\b\s+if=.*/dev/'        # dd if=/dev/zero of=/dev/sda (device only)
  '\bsudo\b\s+rm\b'            # sudo rm
  '\bsudo\b\s+chmod\b'         # sudo chmod
  '\bsudo\b\s+chown\b'         # sudo chown
  '\b:\s*>\s*/etc/'             # : > /etc/passwd (truncate system files)
  '\b:\s*>\s*/var/'             # : > /var/log/syslog
)

for p in "${INDIRECT_PATTERNS[@]}"; do
  if echo "$NORMALIZED_CMD" | grep -qiE "$p"; then
    echo "BLOCKED: 간접 실행 패턴 감지" >&2
    echo "  Pattern: $p" >&2
    echo "  Command: ${CMD:0:120}" >&2
    exit 2
  fi
done

exit 0
