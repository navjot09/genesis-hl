#!/bin/bash
# Verify fast incremental edits: a small follow-up should use op="edit" with far fewer output tokens.
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'

RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"edit-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
UIDV=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
PID="editproj$RANDOM"
curl -s -o /dev/null -X POST "$FS/projects?documentId=$PID" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"fields\":{\"ownerUid\":{\"stringValue\":\"$UIDV\"},\"name\":{\"stringValue\":\"E\"},\"deletedAt\":{\"nullValue\":null}}}"
echo "project=$PID"

run_gen() {
  local body; body=$(python3 -c 'import json,sys;print(json.dumps({"projectId":sys.argv[1],"prompt":sys.argv[2]}))' "$PID" "$1")
  curl -N -s -X POST "$FN/generate" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "$body" | python3 -u -c '
import sys,json
ev=""; ops=[]; out=None
for line in sys.stdin:
    if line.startswith("event: "): ev=line[7:].strip()
    elif line.startswith("data: "):
        d=line[6:]
        if ev=="file_open": ops.append(json.loads(d))
        elif ev=="done": out=json.loads(d).get("usage",{}).get("outputTokens")
        elif ev=="error": print("   ERROR:",d.strip()[:160])
print("   ops:",[(o["path"],o.get("op")) for o in ops]," outputTokens:",out)
'
}
getfile() { curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;p=sys.argv[1]
for d in json.load(sys.stdin).get("documents",[]):
    f=d["fields"]
    if f["path"]["stringValue"]==p: print(f["content"]["stringValue"])' "$1"; }

echo "=== GEN 1 (create) ==="
run_gen "Build a small app in two files. index.html: a heading <h1 id=\"title\">Contacts</h1> and a div. app.js: a function loadData() that console.logs 'loading'. Keep both minimal."
APP1=$(getfile app.js)

echo "=== GEN 2 (tiny follow-up — should use op=edit) ==="
run_gen "Change the heading text from 'Contacts' to 'My Contacts'. Nothing else."
APP2=$(getfile app.js)

echo
echo "=== VERDICT ==="
getfile index.html | grep -q "My Contacts" && echo "  ✓ heading updated to 'My Contacts'" || echo "  ✗ heading NOT updated"
getfile index.html | grep -q ">Contacts<" && echo "  ~ old 'Contacts' still present" || echo "  ✓ old heading text replaced"
if [ -n "$APP1" ] && [ "$APP1" = "$APP2" ]; then echo "  ✓ app.js untouched (byte-identical)"; else echo "  ✗ app.js changed unexpectedly"; fi
