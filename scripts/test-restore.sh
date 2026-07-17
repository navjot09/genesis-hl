#!/bin/bash
# Verify snapshot restore: generate v1, edit to v2, restore v1, confirm revert + new chained snapshot.
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'

RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"rs-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
UIDV=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
PID="rs$RANDOM"
curl -s -o /dev/null -X POST "$FS/projects?documentId=$PID" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"fields\":{\"ownerUid\":{\"stringValue\":\"$UIDV\"},\"name\":{\"stringValue\":\"R\"},\"deletedAt\":{\"nullValue\":null}}}"
echo "project=$PID"

gen() { local body; body=$(python3 -c 'import json,sys;print(json.dumps({"projectId":sys.argv[1],"prompt":sys.argv[2]}))' "$PID" "$1")
  curl -N -s -X POST "$FN/generate" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "$body" >/dev/null; }
getfile() { curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;p=sys.argv[1]
for d in json.load(sys.stdin).get("documents",[]):
    f=d["fields"]
    if f["path"]["stringValue"]==p: print(f["content"]["stringValue"])' "$1"; }

echo "gen v1..."; gen "Create index.html containing exactly <h1>Version One</h1> and nothing else complex. One file only."
echo "gen v2 (edit)..."; gen "Change the h1 text to 'Version Two'."
echo "current heading: $(getfile index.html | grep -oE 'Version (One|Two)' | head -1)"

# earliest snapshot (v1)
GEN1=$(curl -s "$FS/projects/$PID/snapshots" -H "Authorization: Bearer owner" | python3 -c '
import sys,json
docs=json.load(sys.stdin)["documents"]
rows=[(d["fields"].get("createdAt",{}).get("timestampValue",""), d["name"].split("/")[-1]) for d in docs]
rows.sort(); print(rows[0][1])')
echo "restoring to earliest snapshot: $GEN1"
curl -s -X POST "$FN/restoreSnapshot" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"snapshotId\":\"$GEN1\"}" | python3 -c 'import sys,json;j=json.load(sys.stdin);print("  restore response:",{k:j.get(k) for k in ("ok","fileCount")})'

echo
echo "=== VERDICT ==="
H=$(getfile index.html | grep -oE 'Version (One|Two)' | head -1)
[ "$H" = "Version One" ] && echo "  ✓ heading reverted to 'Version One'" || echo "  ✗ heading is '$H' (expected Version One)"
echo -n "  snapshot chain (each generation + restore = a snapshot): "
curl -s "$FS/projects/$PID/snapshots" -H "Authorization: Bearer owner" | python3 -c '
import sys,json
docs=json.load(sys.stdin)["documents"]
rows=[]
for d in docs:
    f=d["fields"]
    rows.append((f.get("createdAt",{}).get("timestampValue",""), f.get("prompt",{}).get("stringValue","")[:38], "restoredFrom" in f))
rows.sort()
print(len(rows),"snapshots")
for i,(ts,p,r) in enumerate(rows,1): print(f"     {i}. {p!r}{\"  [RESTORE]\" if r else \"\"}")'