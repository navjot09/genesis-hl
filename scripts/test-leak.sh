#!/bin/bash
# Verify no file content leaks into the chat prose across continuation retries.
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'
PROMPT="${1:-Build a polished contact dashboard with search, a card grid, and pagination. Use THREE files: index.html, styles.css, and app.js. Put all JS logic (proxy fetch, search, pagination) in app.js.}"

RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"leak-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
UIDV=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
PID="leakproj$RANDOM"
curl -s -o /dev/null -X POST "$FS/projects?documentId=$PID" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"fields\":{\"ownerUid\":{\"stringValue\":\"$UIDV\"},\"name\":{\"stringValue\":\"L\"},\"deletedAt\":{\"nullValue\":null}}}"
echo "project=$PID"

BODY=$(python3 -c 'import json,sys;print(json.dumps({"projectId":sys.argv[1],"prompt":sys.argv[2]}))' "$PID" "$PROMPT")
echo "=== generating (watch for re-opens = continuations) ==="
curl -N -s -X POST "$FN/generate" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "$BODY" | python3 -u -c '
import sys,json
ev=""; opens=[]
for line in sys.stdin:
    if line.startswith("event: "): ev=line[7:].strip()
    elif line.startswith("data: "):
        if ev=="file_open": p=json.loads(line[6:])["path"]; opens.append(p); print("   file_open ",p)
        elif ev in ("snapshot","done","error"): print("  ",ev.upper(),line[6:].strip()[:140])
print("   (opens:",opens,")")
'

echo
echo "=== VERDICT ==="
FILES=$(curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;print(",".join(sorted(d["fields"]["path"]["stringValue"] for d in json.load(sys.stdin).get("documents",[]))))')
echo "  saved files: $FILES"
echo "$FILES" | grep -q '\.js' && echo "  ✓ a .js file was saved as a FILE" || echo "  ✗ no .js file saved (leaked?)"
curl -s "$FS/projects/$PID/messages" -H "Authorization: Bearer owner" | python3 -c '
import sys,json,re
for d in json.load(sys.stdin).get("documents",[]):
    f=d["fields"]
    if f["role"]["stringValue"]=="assistant":
        c=f["content"]["stringValue"]
        markers=[m for m in ["getElementById","addEventListener",":root {",".css\">","</file>","<file","function "] if m in c]
        print(f"  assistant chat message: {len(c)} chars")
        if markers: print("  ✗ CHAT LEAK — contains:",markers)
        else: print("  ✓ chat message is clean prose (no code leaked)")
        print("  message preview:",repr(c[:200]))
'
