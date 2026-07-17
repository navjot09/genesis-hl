#!/bin/bash
# Verify iterative refinement: a 2nd prompt modifies the EXISTING code, preserving unchanged files.
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'

RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"fu-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
UIDV=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
PID="fuproj$RANDOM"
curl -s -o /dev/null -X POST "$FS/projects?documentId=$PID" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "{\"fields\":{\"ownerUid\":{\"stringValue\":\"$UIDV\"},\"name\":{\"stringValue\":\"FU\"},\"deletedAt\":{\"nullValue\":null}}}"
echo "project=$PID"

run_gen() {
  local body; body=$(python3 -c 'import json,sys;print(json.dumps({"projectId":sys.argv[1],"prompt":sys.argv[2]}))' "$PID" "$1")
  curl -N -s -X POST "$FN/generate" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "$body" | python3 -u -c '
import sys
ev=""
for line in sys.stdin:
    if line.startswith("event: "): ev=line[7:].strip()
    elif line.startswith("data: ") and ev in ("snapshot","done","error"): print("   ",ev.upper(),line[6:].strip()[:160])
'
}
getfile() { curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;p=sys.argv[1]
for d in json.load(sys.stdin).get("documents",[]):
    f=d["fields"]
    if f["path"]["stringValue"]==p: print(f["content"]["stringValue"])' "$1"; }
listfiles() { curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;print(sorted(d["fields"]["path"]["stringValue"] for d in json.load(sys.stdin).get("documents",[])))'; }

echo "=== GEN 1 (create two files) ==="
run_gen "Create exactly two files, BOTH required: index.html containing <h1>My Contacts</h1> and linking styles.css; and styles.css that sets body { background: lightblue }. Output BOTH files in full."
echo "files after gen1: $(listfiles)"
CSS_BEFORE=$(getfile styles.css)

echo "=== GEN 2 (follow-up: modify ONLY index.html) ==="
run_gen "Only change index.html: make the h1 text 'Contact Directory' instead of 'My Contacts'. Do NOT touch styles.css at all."
echo "files after gen2: $(listfiles)"
CSS_AFTER=$(getfile styles.css)

echo
echo "=== VERDICT ==="
getfile index.html | grep -q "Contact Directory" && echo "  ✓ index.html updated (has 'Contact Directory')" || echo "  ✗ index.html NOT updated"
if [ -n "$CSS_BEFORE" ] && [ "$CSS_BEFORE" = "$CSS_AFTER" ]; then echo "  ✓ styles.css preserved byte-identical (untouched file survived the follow-up)";
elif [ -n "$CSS_AFTER" ]; then echo "  ~ styles.css still present but re-emitted (content changed) — still preserved in project"; else echo "  ✗ styles.css LOST"; fi
echo "  snapshot chain:"
curl -s "$FS/projects/$PID/snapshots" -H "Authorization: Bearer owner" | python3 -c '
import sys,json
docs=json.load(sys.stdin).get("documents",[])
print("   ",len(docs),"snapshots (each generation = 1 snapshot)")
for d in docs:
    f=d["fields"]; pid=d["name"].split("/")[-1][:8]
    par=f.get("parentSnapshotId",{}); parent=par.get("stringValue") or ("null" if "nullValue" in par else "?")
    man=[x["stringValue"] for x in f.get("manifest",{}).get("arrayValue",{}).get("values",[])]
    print(f"     {pid}  parent={str(parent)[:8]}  files={man}")
'
