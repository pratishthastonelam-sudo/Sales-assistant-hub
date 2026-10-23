"""
Load the WhatsApp knowledge base (output of ingest_whatsapp.py) into Supabase.

Stages (run any subset, in order):
  schema  apply supabase/migrations/*.sql via the Management API (needs SUPABASE_ACCESS_TOKEN)
  embed   build kb rows + Gemini embeddings, cached in knowledge/wa_embeddings.json (no Supabase needed)
  upload  upload wa_media/* to storage bucket 'kb-media'
  load    upsert rows into public.kb_items

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, SUPABASE_ACCESS_TOKEN (schema only)

Usage: python scripts/load_kb.py <knowledge_dir> embed upload load
"""
import glob, hashlib, io, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests


def env(name):
    # Values pasted into env settings sometimes keep wrapping <> or quotes
    return os.environ.get(name, "").strip().strip("<>\"' ")


SUPABASE_URL = env("SUPABASE_URL").rstrip("/")
SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY")
GEMINI_KEY = env("GEMINI_API_KEY")
ACCESS_TOKEN = env("SUPABASE_ACCESS_TOKEN")
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
BUCKET = "kb-media"
MAX_IMAGE_BYTES = 4_500_000  # WhatsApp image limit is 5 MB
HERE = os.path.dirname(os.path.abspath(__file__))

SB_HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}


# ── rows ──────────────────────────────────────────────────

def build_items(kb_dir):
    facts = json.load(open(os.path.join(kb_dir, "wa_facts.json")))
    kb = json.load(open(os.path.join(kb_dir, "wa_kb.json")))
    cap_path = os.path.join(kb_dir, "wa_captions.json")
    captions = json.load(open(cap_path)) if os.path.exists(cap_path) else {}
    items = []

    for i, f in enumerate(facts["facts"]):
        items.append(dict(source_id=f"fact:{i}:{f['topic']}", kind="fact", title=f["topic"],
                          body=f"{f['q']}\n{f['a']}", source="whatsapp-curated"))

    for p in facts["notable_projects"]:
        body = f"Notable Stonelam project: {p['project']}. Shades: {', '.join(p.get('shades', []))}."
        if p.get("area"):
            body += f" Area: {p['area']}."
        items.append(dict(source_id=f"project:{p['project']}", kind="project", title=p["project"],
                          body=body, shades=p.get("shades", []), source="whatsapp-curated"))

    for q in kb["qa"]:
        items.append(dict(source_id="qa:" + hashlib.sha1((q["date"] + q["question"]).encode()).hexdigest()[:16],
                          kind="qa", title=q["question"][:200],
                          body="Q: " + q["question"] + "\nA: " + "\nA: ".join(q["answers"]),
                          shades=q["shades"], applications=q["applications"], sectors=q["sectors"],
                          thickness=q["thickness"], item_date=q["date"]))

    for p in kb["photos"]:
        ai = captions.get(p["file"], {})
        apps = sorted(set(p["applications"]) | set(ai.get("application", []) or []))
        parts = [ai.get("description") or "",
                 "Shades: " + ", ".join(p["shades"]) if p["shades"] else "",
                 "Applications: " + ", ".join(apps) if apps else "",
                 "Setting: " + ai["setting"] if ai.get("setting") not in (None, "unknown") else "",
                 "Building: " + ai["building_type"] if ai.get("building_type") not in (None, "unknown") else "",
                 "Look: " + ", ".join(ai.get("look", [])) if ai.get("look") else "",
                 "Caption: " + p["caption"] if p.get("caption") else "",
                 "Shared in reply to: " + p["answers_request"][:300] if p.get("answers_request") else ""]
        body = "\n".join(x for x in parts if x) or f"{p['type']} from sales WhatsApp group"
        name = os.path.basename(p["file"])
        items.append(dict(source_id="media:" + p["file"], kind="media",
                          title=(ai.get("description") or name)[:200], body=body,
                          shades=p["shades"], applications=apps, sectors=p["sectors"],
                          thickness=p["thickness"], media_path=storage_name(name), media_type=p["type"],
                          item_date=p["date"],
                          meta={"file": p["file"], "ai": ai} if ai else {"file": p["file"]}))
    return items


def storage_name(name):
    # Oversized PNG/JPG are re-encoded as JPEG on upload
    return os.path.splitext(name)[0] + ".jpg" if name.lower().endswith(".png") else name


# ── embeddings ────────────────────────────────────────────

def embed_batch(texts):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:batchEmbedContents"
    body = {"requests": [{"model": f"models/{EMBED_MODEL}", "content": {"parts": [{"text": t[:8000]}]},
                          "taskType": "RETRIEVAL_DOCUMENT", "outputDimensionality": EMBED_DIM} for t in texts]}
    for attempt in range(8):
        r = requests.post(url, json=body, headers={"x-goog-api-key": GEMINI_KEY}, timeout=120)
        if r.status_code == 200:
            out = []
            for e in r.json()["embeddings"]:
                v = e["values"]
                n = sum(x * x for x in v) ** 0.5  # truncated dims are not unit length
                out.append([round(x / n, 6) for x in v])
            return out
        if r.status_code == 429 and "PerDay" in r.text:
            raise RuntimeError("daily embedding quota exhausted")
        if r.status_code in (429, 500, 503):
            time.sleep(20 * (attempt + 1))
            continue
        raise RuntimeError(f"embed {r.status_code}: {r.text[:300]}")
    raise RuntimeError("embed retries exhausted")


def stage_embed(kb_dir):
    items = build_items(kb_dir)
    cache_path = os.path.join(kb_dir, "wa_embeddings.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    key = lambda it: hashlib.sha1(((it["title"] or "") + "\n" + it["body"]).encode()).hexdigest()
    todo = [it for it in items if cache.get(it["source_id"], {}).get("hash") != key(it)]
    print(f"embed: {len(items)} items, {len(todo)} need embedding")
    for i in range(0, len(todo), 20):
        chunk = todo[i:i + 20]
        try:
            vecs = embed_batch([(it["title"] or "") + "\n" + it["body"] for it in chunk])
        except RuntimeError as e:
            # Daily free-tier cap: keep going with older cached vectors; rerun embed+load later
            print(f"embed: stopped early ({e}); {len(todo) - i} items keep stale or no vectors")
            break
        for it, v in zip(chunk, vecs):
            cache[it["source_id"]] = {"hash": key(it), "v": v}
        json.dump(cache, open(cache_path, "w"))
        print(f"  {min(i + 20, len(todo))}/{len(todo)}")
    return items, cache


# ── schema ────────────────────────────────────────────────

def stage_schema():
    ref = SUPABASE_URL.split("//")[1].split(".")[0]
    for path in sorted(glob.glob(os.path.join(HERE, "..", "supabase", "migrations", "*.sql"))):
        sql = open(path).read()
        r = requests.post(f"https://api.supabase.com/v1/projects/{ref}/database/query",
                          headers={"Authorization": f"Bearer {ACCESS_TOKEN}"}, json={"query": sql}, timeout=120)
        ok = r.status_code in (200, 201)
        # 001 creates policies without IF NOT EXISTS; a rerun fails harmlessly on "already exists"
        print(f"schema {os.path.basename(path)}: {r.status_code} {'' if ok else r.text[:300]}")


# ── storage ───────────────────────────────────────────────

def upload_one(kb_dir, rel):
    from PIL import Image
    src = os.path.join(kb_dir, rel)
    name = os.path.basename(rel)
    data = open(src, "rb").read()
    ctype = "video/mp4" if name.lower().endswith(".mp4") else "image/jpeg"
    if ctype == "image/jpeg" and (len(data) > MAX_IMAGE_BYTES or name.lower().endswith(".png")):
        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.thumbnail((3000, 3000))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        data = buf.getvalue()
    r = requests.post(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{storage_name(name)}", data=data,
                      headers={**SB_HEADERS, "Content-Type": ctype, "x-upsert": "true"}, timeout=300)
    return rel, r.status_code, r.text[:200]


def stage_upload(kb_dir):
    requests.post(f"{SUPABASE_URL}/storage/v1/bucket", headers=SB_HEADERS,
                  json={"id": BUCKET, "name": BUCKET, "public": False}, timeout=30)
    existing = set()
    offset = 0
    while True:
        r = requests.post(f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}", headers=SB_HEADERS,
                          json={"prefix": "", "limit": 1000, "offset": offset}, timeout=60)
        batch = r.json() if r.ok else []
        existing |= {o["name"] for o in batch}
        if len(batch) < 1000:
            break
        offset += 1000
    files = [os.path.join("wa_media", f) for f in sorted(os.listdir(os.path.join(kb_dir, "wa_media")))]
    todo = [f for f in files if storage_name(os.path.basename(f)) not in existing]
    print(f"upload: {len(files)} files, {len(existing)} already in bucket, {len(todo)} to upload")
    fails = 0
    with ThreadPoolExecutor(6) as ex:
        for rel, code, txt in ex.map(lambda f: upload_one(kb_dir, f), todo):
            if code not in (200, 201):
                fails += 1
                print(f"  FAIL {rel}: {code} {txt}")
    print(f"upload: done, {fails} failures")


# ── rows → DB ─────────────────────────────────────────────

def stage_load(items, cache):
    cols = ["shades", "applications", "sectors", "thickness"]
    rows = []
    for it in items:
        row = {"title": None, "media_path": None, "media_type": None, "item_date": None,
               "meta": {}, "source": "whatsapp", **{c: [] for c in cols}, **it}
        row["embedding"] = cache.get(it["source_id"], {}).get("v")
        rows.append(row)
    for i in range(0, len(rows), 100):
        r = requests.post(f"{SUPABASE_URL}/rest/v1/kb_items?on_conflict=source_id", json=rows[i:i + 100],
                          headers={**SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
                          timeout=120)
        if r.status_code not in (200, 201, 204):
            raise RuntimeError(f"load {r.status_code}: {r.text[:500]}")
    print(f"load: upserted {len(rows)} rows")


def main():
    kb_dir, stages = sys.argv[1], sys.argv[2:]
    if "schema" in stages:
        stage_schema()
    items = cache = None
    if "embed" in stages or "load" in stages:
        items, cache = stage_embed(kb_dir)
    if "upload" in stages:
        stage_upload(kb_dir)
    if "load" in stages:
        stage_load(items, cache)


if __name__ == "__main__":
    main()
