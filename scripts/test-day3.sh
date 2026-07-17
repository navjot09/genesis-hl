#!/bin/bash
# Day 3 test: drive /generate against real Gemini and verify files + snapshot land in Firestore.
FN=http://127.0.0.1:5001/demo-genesis/us-central1
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
FS='http://127.0.0.1:8080/v1/projects/demo-genesis/databases/(default)/documents'
PROMPT="${1:-Build a contact dashboard that lists my HighLevel contacts with a search box, showing each contact name, email and phone in cards.}"

RESP=$(curl -s -X POST "$AUTH/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d "{\"email\":\"gen-$RANDOM@test.dev\",\"password\":\"password123\",\"returnSecureToken\":true}")
IDTOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["idToken"])')
UIDV=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["localId"])')
PID="genproj$RANDOM"
echo "user=$UIDV  project=$PID"

curl -s -o /dev/null -w 'create project: HTTP %{http_code}\n' -X POST "$FS/projects?documentId=$PID" \
  -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' \
  -d "{\"fields\":{\"ownerUid\":{\"stringValue\":\"$UIDV\"},\"name\":{\"stringValue\":\"Test\"},\"deletedAt\":{\"nullValue\":null}}}"

echo "=== streaming POST /generate (real Gemini) ==="
BODY=$(python3 -c 'import json,sys;print(json.dumps({"projectId":sys.argv[1],"prompt":sys.argv[2]}))' "$PID" "$PROMPT")
curl -N -s -X POST "$FN/generate" -H "Authorization: Bearer $IDTOKEN" -H 'Content-Type: application/json' -d "$BODY" | python3 -u -c '
import sys,json,time
t0=time.time(); ev=None; deltas={}; prose=0
for line in sys.stdin:
    line=line.rstrip("\n")
    if line.startswith("event: "):
        ev=line[7:]
    elif line.startswith("data: "):
        data=line[6:]; el=round(time.time()-t0,2)
        if ev=="assistant_delta":
            prose+=1
        elif ev=="file_open":
            print(el,"s  file_open ",data)
        elif ev=="file_delta":
            p=json.loads(data)["path"]; deltas[p]=deltas.get(p,0)+1
        elif ev=="file_close":
            p=json.loads(data)["path"]; print(el,"s  file_close",p,"  (deltas:",deltas.get(p,0),")")
        elif ev in ("snapshot","done","error"):
            print(el,"s ",ev.upper(),data)
print("assistant prose deltas:",prose)
'

echo "=== working files after generation ==="
curl -s "$FS/projects/$PID/files" -H "Authorization: Bearer owner" | python3 -c '
import sys,json
docs=json.load(sys.stdin).get("documents",[])
print(len(docs),"working file(s):")
for d in docs:
    f=d["fields"]; print("  -",f["path"]["stringValue"],"(",len(f["content"]["stringValue"]),"chars )")
'
echo "=== snapshots + messages ==="
curl -s "$FS/projects/$PID/snapshots" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("documents",[])),"snapshot(s)")'
curl -s "$FS/projects/$PID/messages" -H "Authorization: Bearer owner" | python3 -c 'import sys,json;docs=json.load(sys.stdin).get("documents",[]);print(len(docs),"message(s):",[d["fields"]["role"]["stringValue"] for d in docs])'
