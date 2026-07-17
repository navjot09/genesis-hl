#!/bin/bash
# Day 2 integration test: HighLevel OAuth + locked rotating refresh + allowlisted proxy.
# Prereqs: emulator suite running (auth/firestore/functions), scripts/mock-hl.mjs running,
#          functions/.env pointing HL_API_BASE + HL_AUTHORIZE_BASE at the mock.
set -u
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'
MOCK=http://127.0.0.1:8788
PASS=0; FAIL=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  (want: $2, got: $3)"; fi
}

echo "== setup: sign up a fresh user =="
EMAIL="day2-$RANDOM@test.dev"
RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
LOCALID=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
echo "  user: $EMAIL ($LOCALID)"

echo "== 1. OAuth start requires auth =="
check "unauthenticated → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlOauthStart")"

echo "== 2. OAuth start returns authorize URL + state =="
START=$(curl -s -X POST "$FN/hlOauthStart" -H "Authorization: Bearer $IDTOKEN")
URL=$(printf '%s' "$START" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
STATE=$(printf '%s' "$START" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
check "authorize URL host is mock" "yes" "$([[ "$URL" == http://127.0.0.1:8788/oauth/chooselocation* ]] && echo yes || echo no)"
check "state minted (48 hex chars)" 48 "${#STATE}"

echo "== 3. Callback bounces code+state to SPA (no exchange/link here) =="
LOCC=$(curl -s -o /dev/null -w '%{redirect_url}' "$FN/oauthCallback?code=goodcode&state=$STATE")
check "callback → hl=callback with state+code" "yes" "$([[ "$LOCC" == *hl=callback* && "$LOCC" == *code=goodcode* ]] && echo yes || echo "no: $LOCC")"
LOCE=$(curl -s -o /dev/null -w '%{redirect_url}' "$FN/oauthCallback?error=access_denied")
check "callback with ?error → hl=error" "yes" "$([[ "$LOCE" == *hl=error* ]] && echo yes || echo "no: $LOCE")"

echo "== 3b. Complete requires auth + initiator identity (account-linking CSRF defense) =="
check "complete unauthenticated → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlOauthComplete" -H 'Content-Type: application/json' -d "{\"state\":\"$STATE\",\"code\":\"goodcode\"}")"
ATTACKER=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"attacker-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
check "different user completing initiator's state → 403 (CSRF blocked)" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlOauthComplete" -H "Authorization: Bearer $ATTACKER" -H 'Content-Type: application/json' -d "{\"state\":\"$STATE\",\"code\":\"goodcode\"}")"
# That attempt consumed the state (single-use); mint a fresh one for the happy path.
STATE=$(curl -s -X POST "$FN/hlOauthStart" -H "Authorization: Bearer $IDTOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')
COMPLETE=$(curl -s -X POST "$FN/hlOauthComplete" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"state\":\"$STATE\",\"code\":\"goodcode\"}")
check "initiator completes → connected" "True" "$(printf '%s' "$COMPLETE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("connected"))' 2>/dev/null)"
check "state single-use (replay complete → 400)" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlOauthComplete" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"state\":\"$STATE\",\"code\":\"goodcode\"}")"

echo "== 4. Token storage + rules isolation =="
ADMIN_DOC=$(curl -s "$FS/hlTokens/$LOCALID" -H "Authorization: Bearer owner")
check "hlTokens doc exists (admin)" "at-1" "$(printf '%s' "$ADMIN_DOC" | python3 -c 'import sys,json;print(json.load(sys.stdin)["fields"]["accessToken"]["stringValue"])' 2>/dev/null)"
check "client CANNOT read hlTokens (rules)" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$FS/hlTokens/$LOCALID" -H "Authorization: Bearer $IDTOKEN")"
USER_DOC=$(curl -s "$FS/users/$LOCALID" -H "Authorization: Bearer $IDTOKEN")
check "client CAN read own users doc" "Mock Dental Co" "$(printf '%s' "$USER_DOC" | python3 -c 'import sys,json;print(json.load(sys.stdin)["fields"]["hl"]["mapValue"]["fields"]["locationName"]["stringValue"])' 2>/dev/null)"

echo "== 5. Preview capability token =="
PVT=$(curl -s -X POST "$FN/mintPreviewToken" -H "Authorization: Bearer $IDTOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
check "preview token minted (JWT, 3 parts)" 3 "$(printf '%s' "$PVT" | awk -F. '{print NF}')"

echo "== 6. Proxy: allowed endpoints work with preview token =="
CT=$(curl -s -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $PVT" -H 'Content-Type: application/json' -d '{}')
check "POST /contacts/search → 2 contacts" 2 "$(printf '%s' "$CT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])' 2>/dev/null)"
CAL=$(curl -s "$FN/hlProxy/calendars/" -H "Authorization: Bearer $PVT")
check "GET /calendars/ (Version 2021-04-15 verified by mock)" "Demo Calendar" "$(printf '%s' "$CAL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["calendars"][0]["name"])' 2>/dev/null)"
CONV=$(curl -s "$FN/hlProxy/conversations/search" -H "Authorization: Bearer $PVT")
check "GET /conversations/search" 1 "$(printf '%s' "$CONV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])' 2>/dev/null)"
check "proxy also accepts Firebase ID token" 2 "$(curl -s -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])' 2>/dev/null)"

echo "== 7. Proxy: security gates =="
check "DELETE /contacts/c1 → 403 (allowlist)" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$FN/hlProxy/contacts/c1" -H "Authorization: Bearer $PVT")"
check "GET /oauth/token via proxy → 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$FN/hlProxy/oauth/token" -H "Authorization: Bearer $PVT")"
check "foreign locationId in body → 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $PVT" -H 'Content-Type: application/json' -d '{"locationId":"someone-elses-location"}')"
check "garbage bearer → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer nonsense" -H 'Content-Type: application/json' -d '{}')"
check "no bearer → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/hlProxy/contacts/search" -H 'Content-Type: application/json' -d '{}')"

expire_token() {
  curl -s -o /dev/null -X PATCH "$FS/hlTokens/$LOCALID?updateMask.fieldPaths=expiresAt" \
    -H "Authorization: Bearer owner" -H 'Content-Type: application/json' \
    -d '{"fields":{"expiresAt":{"integerValue":"1"}}}'
}
mock_state() { curl -s "$MOCK/__state" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"$1\"])"; }

echo "== 8. Refresh: rotation persisted across consecutive refreshes =="
expire_token
R1=$(curl -s -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $PVT" -H 'Content-Type: application/json' -d '{}')
check "call after expiry still succeeds (auto-refresh)" 2 "$(printf '%s' "$R1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])' 2>/dev/null)"
check "mock saw exactly 1 refresh" 1 "$(mock_state refreshCount)"
check "rotated refresh token persisted (rt-2)" "rt-2" "$(curl -s "$FS/hlTokens/$LOCALID" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;print(json.load(sys.stdin)["fields"]["refreshToken"]["stringValue"])')"
expire_token
curl -s -o /dev/null -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $PVT" -H 'Content-Type: application/json' -d '{}'
check "second rotation works (rt-3 persisted ⇒ rt-2 was saved correctly)" "rt-3" "$(curl -s "$FS/hlTokens/$LOCALID" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;print(json.load(sys.stdin)["fields"]["refreshToken"]["stringValue"])')"
check "no invalid_grant so far" 0 "$(mock_state invalidGrantCount)"

echo "== 9. Refresh: concurrent calls serialize to ONE refresh =="
expire_token
BEFORE=$(mock_state refreshCount)
for i in 1 2 3 4 5 6; do
  curl -s -o "/tmp/day2-par-$i.json" -X POST "$FN/hlProxy/contacts/search" -H "Authorization: Bearer $PVT" -H 'Content-Type: application/json' -d '{}' &
done
wait
OK=0
for i in 1 2 3 4 5 6; do
  T=$(python3 -c "import json;print(json.load(open('/tmp/day2-par-$i.json'))['total'])" 2>/dev/null)
  [ "$T" = "2" ] && OK=$((OK+1))
done
AFTER=$(mock_state refreshCount)
check "all 6 concurrent calls succeeded" 6 "$OK"
check "exactly 1 refresh performed (lock serializes)" 1 "$((AFTER-BEFORE))"
check "still no invalid_grant (no token was burned)" 0 "$(mock_state invalidGrantCount)"

echo
echo "======================================"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
