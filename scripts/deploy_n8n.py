#!/usr/bin/env python3
import urllib.request, json

N8N = "https://n8n.ofshore.dev/api/v1"
N8N_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJiYmMyN2JjYy1mZjNkLTRiMzUtODI4ZS0yZTg2NGNmMGVjNjEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYzU3NTMwOTYtOGI2MS00Y2M4LWE1OGMtZTkyZjM0OTQ3NGJmIiwiaWF0IjoxNzczMDExMTExfQ.mi1l-DWXZ97cVaL-26FaegH0lSR7rdWCzrZACKMgkf4"
UPS = "https://fresh-walleye-84119.upstash.io"
UPT = "gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk"

def n8n_api(method, path, data=None):
    url = f"{N8N}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method,
        headers={"X-N8N-API-KEY": N8N_KEY, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def uget(k):
    try:
        r = urllib.request.Request(f"{UPS}/get/{k}", headers={"Authorization": f"Bearer {UPT}"})
        v = json.loads(urllib.request.urlopen(r, timeout=5).read())["result"]
        try: return json.loads(v)
        except: return v
    except: return None

# List existing workflows
existing = n8n_api("GET", "/workflows")
existing_names = [w["name"] for w in existing.get("data", [])]
print(f"Existing: {len(existing_names)} workflows")

# Workflow keys in Upstash
wf_keys = ["wf_ai_chat", "wf_pacemaker", "wf_gpt", "wf_gemini", "wf_tg_alert",
            "wf_fleet", "wf_mesh_scan", "wf_coolify", "wf_t2_exercise", "wf_supabase"]

created = 0
for key in wf_keys:
    wf = uget(f"holon:n8n:{key}")
    if not wf or not isinstance(wf, dict):
        print(f"  Skip {key}: no data")
        continue
    name = wf.get("name", "?")
    if name in existing_names:
        print(f"  Skip {name}: exists")
        continue
    try:
        result = n8n_api("POST", "/workflows", wf)
        wf_id = result.get("id", "")
        print(f"  Created: {name} (id={wf_id})")
        # Activate
        try:
            n8n_api("PATCH", f"/workflows/{wf_id}", {"active": True})
            print(f"    -> ACTIVATED")
        except Exception as e:
            print(f"    -> Activate: {e}")
        created += 1
    except Exception as e:
        print(f"  Error {name}: {e}")

# Final count
final = n8n_api("GET", "/workflows")
active = sum(1 for w in final.get("data", []) if w.get("active"))
print(f"\nTotal: {len(final.get('data', []))} workflows, {active} active, {created} new")

# Send TG
TG = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg"
msg = f"n8n deploy: {created} new, {len(final.get('data',[]))} total, {active} active"
urllib.request.urlopen(urllib.request.Request(
    f"https://api.telegram.org/bot{TG}/sendMessage",
    data=json.dumps({"chat_id": "8149345223", "text": msg}).encode(),
    method="POST", headers={"Content-Type": "application/json"}), timeout=10)
