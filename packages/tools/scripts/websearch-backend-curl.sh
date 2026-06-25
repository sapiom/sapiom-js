#!/usr/bin/env bash
#
# Backend probe for the web.search capability dispatch endpoint
# (`POST {BASE}/v1/capabilities/web.search`), driven purely with curl so it can
# run anywhere without the SDK.
#
# Usage:
#   bash websearch-backend-curl.sh <BASE_URL> <API_KEY_ENV_VAR_NAME>
#
# Example:
#   bash websearch-backend-curl.sh https://api.sapiom.dev SAPIOM_DEV_API_KEY
#   bash websearch-backend-curl.sh https://api.sapiom.ai  SAPIOM_API_KEY
#
# The key is read from the NAMED env var (second arg) and never echoed.
#
# Probes:
#   1. valid {query} + x-api-key            → 200, body normalized {query,results} w/ NO `servedBy`
#   2. unknown capability id                → 404
#   3. missing auth                         → 401
#   4. bad / non-`sk_` Bearer               → 401
#   5. empty query                          → 4xx (never 5xx)
#   6. malformed JSON body                  → 4xx (never 5xx)
#   7. charge-on-reject                     → a 4xx must not settle a transaction
#
# Prints each probe's status + a PASS/FAIL summary; exits non-zero on any FAIL.
# Tolerant of macOS bash 3.2 (no associative arrays, no mapfile).
#
# NOTE: probe #1 makes a live, billable web.search call; #7 fires a (free) 4xx.
# The orchestrator runs this; it is not run automatically.

set -uo pipefail

BASE="${1:-}"
KEY_VAR="${2:-}"

if [ -z "$BASE" ] || [ -z "$KEY_VAR" ]; then
  echo "usage: bash websearch-backend-curl.sh <BASE_URL> <API_KEY_ENV_VAR_NAME>" >&2
  exit 2
fi

# Indirect-expand the named env var (bash 3.2 compatible).
API_KEY="$(eval "printf '%s' \"\${$KEY_VAR:-}\"")"
if [ -z "$API_KEY" ]; then
  echo "Missing \$$KEY_VAR — cannot run." >&2
  exit 2
fi

echo "base: $BASE"
echo "key resolved: yes (from \$$KEY_VAR)"
echo

CAP_URL="$BASE/v1/capabilities/web.search"
UNKNOWN_URL="$BASE/v1/capabilities/does.not.exist"
TX_URL="$BASE/v1/transactions"

FAILS=0
PASSES=0

pass() { echo "  [PASS ] $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  [FAIL ] $1"; FAILS=$((FAILS + 1)); }

# Run a curl, print only the HTTP status code on the last line. Body captured to
# the file named by $4 (optional).
http_status() {
  # $1=method $2=url $3=extra-curl-args (string) $4=body-out-file (optional)
  local method="$1" url="$2" extra="$3" outfile="${4:-/dev/null}"
  # shellcheck disable=SC2086
  curl -sS -o "$outfile" -w '%{http_code}' -X "$method" $extra "$url" 2>/dev/null
}

# True when status is a 4xx (>=400 and <500).
is_4xx() { [ "$1" -ge 400 ] 2>/dev/null && [ "$1" -lt 500 ] 2>/dev/null; }
# True when status is a 5xx.
is_5xx() { [ "$1" -ge 500 ] 2>/dev/null; }

BODY_FILE="$(mktemp 2>/dev/null || echo /tmp/websearch-curl-body.$$)"
cleanup() { rm -f "$BODY_FILE" 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Valid request → 200 + normalized body, NO servedBy.
# ---------------------------------------------------------------------------
echo "1) valid {query} + x-api-key → 200, normalized, no servedBy"
code="$(http_status POST "$CAP_URL" \
  "-H content-type:application/json -H x-api-key:$API_KEY --data {\"query\":\"what is an LLM agent?\"}" \
  "$BODY_FILE")"
if [ "$code" = "200" ]; then
  pass "status 200"
  if grep -qi '"servedby"' "$BODY_FILE"; then
    fail "response contains servedBy (must be stripped)"
  else
    pass "no servedBy in body"
  fi
  # Loose normalized-shape check: must have query + results (we don't parse JSON
  # strictly to stay dependency-free).
  if grep -q '"query"' "$BODY_FILE" && grep -q '"results"' "$BODY_FILE"; then
    pass "normalized {query,results} present"
  else
    fail "body missing query/results"
  fi
  # Provider names must never appear in the body.
  if grep -qiE '"(linkup|you\.com|youcom)"|linkup\.|you\.com' "$BODY_FILE"; then
    fail "response leaks a provider name"
  else
    pass "no provider name in body"
  fi
else
  fail "expected 200, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 2. Unknown capability id → 404.
# ---------------------------------------------------------------------------
echo "2) unknown capability id → 404"
code="$(http_status POST "$UNKNOWN_URL" \
  "-H content-type:application/json -H x-api-key:$API_KEY --data {\"query\":\"x\"}")"
if [ "$code" = "404" ]; then
  pass "status 404"
else
  fail "expected 404, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 3. Missing auth → 401.
# ---------------------------------------------------------------------------
echo "3) missing auth → 401"
code="$(http_status POST "$CAP_URL" \
  "-H content-type:application/json --data {\"query\":\"x\"}")"
if [ "$code" = "401" ]; then
  pass "status 401"
else
  fail "expected 401, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 4. Bad / non-`sk_` Bearer → 401.
# ---------------------------------------------------------------------------
echo "4) bad/non-sk_ Bearer → 401"
code="$(http_status POST "$CAP_URL" \
  "-H content-type:application/json -H Authorization:Bearer\ not-a-real-key --data {\"query\":\"x\"}")"
if [ "$code" = "401" ]; then
  pass "status 401"
else
  fail "expected 401, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 5. Empty query → 4xx (never 5xx).
# ---------------------------------------------------------------------------
echo "5) empty query → 4xx (never 5xx)"
code="$(http_status POST "$CAP_URL" \
  "-H content-type:application/json -H x-api-key:$API_KEY --data {\"query\":\"\"}")"
if is_5xx "$code"; then
  fail "5xx ($code) — a real hole"
elif is_4xx "$code"; then
  pass "4xx ($code)"
else
  fail "expected 4xx, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 6. Malformed JSON body → 4xx (never 5xx).
# ---------------------------------------------------------------------------
echo "6) malformed JSON body → 4xx (never 5xx)"
code="$(http_status POST "$CAP_URL" \
  "-H content-type:application/json -H x-api-key:$API_KEY --data {not-valid-json")"
if is_5xx "$code"; then
  fail "5xx ($code) — a real hole"
elif is_4xx "$code"; then
  pass "4xx ($code)"
else
  fail "expected 4xx, got $code"
fi
echo

# ---------------------------------------------------------------------------
# 7. Charge-on-reject: a 4xx must not settle a transaction.
#    Uses BARE GET /v1/transactions (the only form that 200s) and counts the
#    occurrences of transaction ids in the JSON:API data array.
# ---------------------------------------------------------------------------
echo "7) charge-on-reject: a 4xx must not settle"

# Count transactions from a bare GET. We count top-level objects in `data` by
# counting `"id"` occurrences inside the data array — robust without a JSON
# parser. (Both runs use the identical request, so the comparison is consistent.)
tx_count() {
  local f="$1"
  local code
  code="$(http_status GET "$TX_URL" "-H x-api-key:$API_KEY" "$f")"
  if [ "$code" != "200" ]; then
    echo "ERR:$code"
    return
  fi
  # Count "id" keys as a proxy for transaction rows. Falls back to 0.
  local n
  n="$(grep -o '"id"' "$f" | wc -l | tr -d ' ')"
  echo "${n:-0}"
}

BEFORE_FILE="$(mktemp 2>/dev/null || echo /tmp/websearch-tx-before.$$)"
AFTER_FILE="$(mktemp 2>/dev/null || echo /tmp/websearch-tx-after.$$)"
before="$(tx_count "$BEFORE_FILE")"
if [ "${before#ERR:}" != "$before" ]; then
  fail "GET /v1/transactions before failed (${before})"
else
  # Fire a deliberately-rejected (4xx) request — empty query.
  reject_code="$(http_status POST "$CAP_URL" \
    "-H content-type:application/json -H x-api-key:$API_KEY --data {\"query\":\"\"}")"
  if is_4xx "$reject_code"; then
    sleep 2
    after="$(tx_count "$AFTER_FILE")"
    if [ "${after#ERR:}" != "$after" ]; then
      fail "GET /v1/transactions after failed (${after})"
    elif [ "$after" -gt "$before" ] 2>/dev/null; then
      fail "transaction count rose $before→$after (rejected request settled!)"
    else
      pass "transaction count steady ($before) — reject did not settle"
    fi
  else
    fail "reject probe was not 4xx (got $reject_code) — inconclusive"
  fi
fi
rm -f "$BEFORE_FILE" "$AFTER_FILE" 2>/dev/null || true
echo

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo "=== summary ==="
echo "PASS: $PASSES  FAIL: $FAILS"
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
