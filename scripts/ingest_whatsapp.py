"""
Turn a WhatsApp group export (_chat.txt + media) into a knowledge base for the
Sales Assistant: tagged photo library + text Q&A, with phone numbers, people's
names and prices removed.

Usage: python3 ingest_whatsapp.py <export_dir> <out_dir>
Writes <out_dir>/wa_kb.json and copies kept photos/videos to <out_dir>/wa_media/.
"""
import json, os, re, shutil, sys, collections
from datetime import datetime

# ---------- vocab ----------
# canonical shade -> regex (case-insensitive). Order matters: specific first.
SHADES = [
    ("Hado Travertino Silver Rain", r"ha?r?do\s*trav[ae]?r?t[ie]no\s*silver\s*rain|hado\s*silver\s*rain"),
    ("Hado Travertino Beige Rain", r"hado\s*trav[ae]?r?t[ie]no\s*be?ige?\s*rain|beige\s*rain|biege\s*rain"),
    ("Hado Travertino Bianco", r"hado\s*trav[ae]?n?t[ie]no\s*bianco"),
    ("Hado Beige", r"hado\s*beige(?!\s*rain)"),
    ("Travertino Grigio Venato", r"trav[ae]?r?t[ie]n[oe]\s*grigio\s*ven[a]?to|\btg\s*venato"),
    ("Travertino Avorio", r"tra[vb]?[ae]?r?t[ie]no\s*avorio|traventino\s*avorio"),
    ("Legno Venezia Noce", r"legno\s*venezia\s*noce|\bnoce\b"),
    ("Legno Venezia Pine", r"legno\s*venezia\s*pine|wood\s*pine"),
    ("Pietra di Savoia Grigia (PDS Grigia)", r"pds\s*grigi[ao]|pietra\s*di\s*savoia\s*grigi[ao]"),
    ("Pietra di Savoia Antracite (PDS Antracite)", r"pds\s*an?th?racite|pietra[-\s]*(di\s*)?savoia[-\s]*antracite"),
    ("Pietra di Savoia Avorio (PDS Avorio)", r"pds\s*avorio"),
    ("Pietra di Savoia Perla (PDS Perla)", r"pds\s*perla|pietra\s*di\s*savoia\s*perla"),
    ("PDS Rosa", r"pds\s*rosa"),
    ("Pietra Grey", r"pietra\s*grey"),
    ("Pietra di Cardoso Nero Fiammato", r"pietra\s*di\s*c[ua]r?doso?e?\s*nero"),
    ("Pietra Piasentina Grigio Fiammato", r"piasentina"),
    ("Oxide Nero", r"ox[iy]de?\s*nero"),
    ("Oxide Avorio", r"ox[iy]de?\s*av[oa]rio"),
    ("Oxide Moro", r"ox[iy]de?\s*moro"),
    ("Ossido Bruno", r"ossido\s*bruno"),
    ("Ossido Verderame", r"ossido\s*verderame"),
    ("Ossidiana Vena Chiara", r"oss?idi?a?n?a?\s*(vena\s*)?ch?aira|ossidiaba\s*chiara|ossidiana\s*vena|ossido\s*vena|^vena chiara$|\bvena\s*chiara\b(?!.*basalto)"),
    ("Basalto Vena Chiara", r"basalto\s*vena\s*chiara"),
    ("Basalto Vena Scura", r"basalto\s*vena\s*scura"),
    ("Blend Grigio", r"blend\s*gr[ie]g?gio"),
    ("Blend Nero", r"blend\s*nero"),
    ("Fokos Rena", r"fokos\s*rena"),
    ("Fokos Terra", r"fokos\s*terr?a"),
    ("Fokos Roccia", r"fokos\s*roccia"),
    ("Fokos Grafite", r"fokos\s*grafite"),
    ("Rigato Graphite", r"rigato\s*graphite"),
    ("Rigato Neve", r"rigato\s*neve"),
    ("Collection Neve", r"collection\s*neve"),
    ("Diamond Cream", r"diamond\s*cream"),
    ("Diamond Cristallo Macchia Vecchia", r"cristallo\s*macchia"),
    ("Calce Terracotta", r"calce[-\s]*terracotta"),
    ("Nero Greco", r"nero\s*greco"),
    ("Marfil Spazzolato", r"marfil"),
    ("Terra di Pompei Fiammato", r"pompei"),
    ("Terra di Matera Fiammato", r"matera"),
    ("Terra di Saturnia Fiammato", r"saturnia"),
    ("Ardesia Nero a Spacco", r"ardesia\s*nero"),
    ("Ardesia Bianco a Spacco", r"ardesia\s*bianco"),
    ("Bianco Statuario Venato", r"statuario|saturio"),
    ("Bianco Assoluto", r"bianco\s*assoluto"),
    ("Porfido Marrone Fiammato", r"porfido\s*marrone"),
    ("Slate Alaska", r"slate\s*alaska"),
    ("Slate Vulcano", r"slate\s*vulcano"),
    ("Grigio Fiammato", r"(?<!piasentina )grigio\s*fiammato"),
    ("Urban Beige", r"urban\s*beige"),
]
SHADES = [(n, re.compile(p, re.I | re.M)) for n, p in SHADES]

APPS = {
    "facade/exterior": r"facade|fa[cç]ade|exterior|elevation|cladding|outside|boundary|compound wall|high rise",
    "interior": r"interior|indoor|wall panel",
    "flooring": r"floor",
    "bathroom": r"bath|washroom|toilet",
    "staircase": r"stair",
    "lift wall": r"\blift\b",
    "countertop/kitchen": r"counter\s*top|countertop|kitchen",
    "door/gate": r"\bdoors?\b|\bgate\b|entrance door|door jamb",
    "soffit/ceiling": r"soffit|ceiling",
    "TV unit/furniture": r"tv unit|furniture|headboard",
    "CNC/waterjet/perforation": r"\bcnc\b|water ?jet|perforat",
    "curved surfaces": r"curve",
    "pooja room": r"pooja",
    "brick pattern": r"brick",
    "full slab view": r"full\s*(size|slab|sheet)|live\s*(full\s*)?slab|slab\s*(image|picture|pdf)|close up slab|hd image",
    "showroom/display": r"display|showroom|gallery|store|experience cent",
    "swimming pool": r"swimming|pool\b",
    "column/pillar": r"pillar|column",
    "tile-on-tile/overlay": r"existing (marble|tile|stone)|tile on tile",
}
SECTORS = {
    "hotel": r"hotel|resort|banquet|hyatt|radisson",
    "hospital": r"hospital|pharma",
    "jewellery store": r"jewel",
    "office/commercial": r"office|commercial|mall|tower|factory|industr",
    "residential": r"residen|bungalow|bunglow|villa|house",
    "education": r"college|educational|school",
    "religious": r"church|temple|pooja",
    "transport": r"airport|railway|station|metro|rail bhawan",
    "retail": r"store|shop|showroom",
}
THICK = r"\b0?(3|5|12)\s*mm"
APPS = {k: re.compile(v, re.I) for k, v in APPS.items()}
SECTORS = {k: re.compile(v, re.I) for k, v in SECTORS.items()}

REQUEST = re.compile(r"\b(share|anyone|anybody|any one|can someone|someone|does anyone|who is|need(ed)?|required|kindly|confirm|is this|is it possible|do we have|what'?s the shade|which is the shade|has stonelam)\b|\?", re.I)
NOISE = re.compile(r"decoding|session|workshop|training|press|publication|creative|birthday|congratulat|happy (new|holi|independence|diwali)|celebrat|core value|townhall|town hall|lunch|tickets?|secret santa|selling|upskilling|playbook|sales kit|store locator|youtube|instagram\.com|ad (may|jan|march)|architectural digest|future of fa|spam|inaugurat|event|p-\d+|join back|travel|frame handed|analytics", re.I)
REGION_Q = re.compile(r"who is (handling|looking|taking care)|person looking after|handling .* (region|market)|please contact me", re.I)

PHONE = re.compile(r"(\+?91[\s-]?)?\b\d{5}[\s-]?\d{5}\b")
MENTION = re.compile(r"@⁨[^⁩]*⁩|@~?\w+")
PRICE = re.compile(r"(₹|rs\.?|inr)\s*[\d,]+(\.\d+)?(\s*/-)?(\s*(per|/)\s*\w+)?", re.I)
CLIENT = re.compile(r"(client\s*(name)?\s*[-:]+\s*)([^\n/]+)", re.I)
HONORIFIC = re.compile(r"\b(Mr|Mrs|Ms|Miss)\.?\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?")


# places, firm words and common surnames that also appear in architect/firm names
NOT_NAMES = {"stonelam", "stonex", "laminates", "surfaces", "official", "rbm", "abm", "cbo", "chro", "team", "sales",
             "the", "south", "north", "east", "west", "delhi", "mumbai", "kolkata", "jammu", "dehradun", "surat",
             "singh", "kumar", "roy", "mohan", "mukesh"}
GREETING = re.compile(r"\b(Hi|Hello|Dear|Thanks|Thank you|Kudos to you|Very good)\s+(?!(?:Team|Everyone|All|Good|Can|Any|Anyone|Guys|Sir|Mam|There|Kindly|Please|Pls|Share|Request|Does|Is|Colleagues|Stonelam)\b)[A-Z][a-z]+\b")
NAMES = set()  # filled from group members' display names in main()
PRIVATE_HOME = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(Bunglow|Bungalow|Residence|House)\b")


def scrub(t):
    t = GREETING.sub(lambda m: m.group(1) + " [name]", t)
    t = PRIVATE_HOME.sub(lambda m: "[private client] " + m.group(1), t)
    if NAMES:
        t = re.sub(r"\b(" + "|".join(map(re.escape, NAMES)) + r")\b", "[name]", t)
    t = PHONE.sub("[number removed]", t)
    t = MENTION.sub("", t)
    t = PRICE.sub("[price removed]", t)
    t = CLIENT.sub(lambda m: m.group(1) + "[private client]", t)
    t = HONORIFIC.sub("[private client]", t)
    t = t.replace("<This message was edited>", "")
    t = re.sub(r"[ \t]+", " ", t)
    return t.strip()


def tags_for(text):
    shades = sorted({n for n, rx in SHADES if rx.search(text)})
    apps = sorted({k for k, rx in APPS.items() if rx.search(text)})
    sectors = sorted({k for k, rx in SECTORS.items() if rx.search(text)})
    thick = sorted({m + "mm" for m in re.findall(THICK, text, re.I)})
    return dict(shades=shades, applications=apps, sectors=sectors, thickness=thick)


def merge(a, b):
    return {k: sorted(set(a.get(k, [])) | set(b.get(k, []))) for k in set(a) | set(b)}


# ---------- parse ----------
LINE = re.compile(r"^(\d{2}/\d{2}/\d{4}), (\d{2}:\d{2}) - (.*)$")


def parse(path):
    msgs = []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        m = LINE.match(line)
        if m:
            rest = m.group(3)
            author, text = (rest.split(": ", 1) + [""])[:2] if ": " in rest else (None, rest)
            msgs.append(dict(ts=datetime.strptime(m.group(1) + " " + m.group(2), "%d/%m/%Y %H:%M"),
                             author=author, text=text))
        elif msgs:
            msgs[-1]["text"] += "\n" + line
    for x in msgs:
        f = re.match(r"^(\S+\.\w+) \(file attached\)\n?(.*)$", x["text"], re.S)
        x["file"] = f.group(1) if f else None
        if f:
            x["text"] = f.group(2).strip()
        x["text"] = x["text"].replace("<Media omitted>", "").strip()
    return [x for x in msgs if x["author"] and "This message was deleted" not in x["text"]]


CHATTER = re.compile(r"^\W*(thanks?|thank\s*you|thankyou|ty|ok(ay)?|sure|wow|nice|superb|excellent|amazing|great|beautiful|awesome|perfect|yes i m|start|anytime|v nice|gud|fantastic|well done|always welcome|mesmeri[sz]ing)\b", re.I)


def informative(t):
    if not t or NOISE.search(t) or CHATTER.match(t):
        return False
    words = re.findall(r"[A-Za-z]{2,}", t)
    return len(words) >= 2 or bool(re.search(r"\byes\b|\bno\b|\d\s*mm", t, re.I))


def is_request(x):
    t = x["text"]
    return bool(t) and len(t) < 500 and REQUEST.search(t) and not NOISE.search(t)


def main(src, out):
    chat = next(os.path.join(src, f) for f in os.listdir(src) if f.endswith(".txt"))
    msgs = parse(chat)
    vocab = {w.lower() for n, _ in SHADES for w in re.findall(r"[A-Za-z]+", n)}
    for a in {x["author"] for x in msgs}:
        for w in re.findall(r"[A-Za-z]{3,}", a):
            if w.lower() not in vocab | NOT_NAMES:
                NAMES.add(w)
    for m in re.findall(r"@\u2068~?([^\u2069]*)\u2069", "\n".join(x["text"] for x in msgs)):
        NAMES.update(w for w in re.findall(r"[A-Za-z]{3,}", m) if w.lower() not in vocab | NOT_NAMES)
    os.makedirs(os.path.join(out, "wa_media"), exist_ok=True)

    # group consecutive messages by same author within 15 min into "posts"
    posts = []
    for x in msgs:
        p = posts[-1] if posts else None
        if p and p["author"] == x["author"] and (x["ts"] - p["end"]).total_seconds() < 900 \
                and not (is_request(x) and p["texts"]):
            p["texts"].append(x["text"]) if x["text"] else None
            p["files"].append(x["file"]) if x["file"] else None
            p["end"] = x["ts"]
        else:
            posts.append(dict(author=x["author"], start=x["ts"], end=x["ts"],
                              texts=[x["text"]] if x["text"] else [], files=[x["file"]] if x["file"] else []))

    photos, qa, skipped = [], [], collections.Counter()
    open_req = None
    for p in posts:
        text = "\n".join(p["texts"])
        own = tags_for(text)
        req_like = text and REQUEST.search(text) and len(text) < 500 and not NOISE.search(text) \
            and not (p["files"] and tags_for(text)["shades"] and "?" not in text and not re.search(r"share|anyone", text, re.I))
        if req_like and REGION_Q.search(text):
            skipped["region-contact questions (personal numbers)"] += 1
            open_req = None
            continue
        if req_like:
            open_req = dict(post=p, text=text, tags=own, answers=[])
            qa.append(open_req)
            if p["files"]:
                skipped["reference images attached to questions"] += len(p["files"])
            continue
        if NOISE.search(text):
            skipped["event/press/greeting posts"] += 1
            skipped["media from event posts"] += len(p["files"])
            continue
        in_reply = open_req and p["author"] != open_req["post"]["author"] \
            and (p["start"] - open_req["post"]["end"]).total_seconds() <= 2 * 86400
        tags = own
        context = None
        if in_reply:
            base = dict(open_req["tags"])
            if own["shades"]:  # answerer named the shade: trust it over the request
                base["shades"] = own["shades"]
            tags = merge(base, {k: v for k, v in own.items() if k != "shades"})
            context = scrub(open_req["text"])
            if informative(text):
                open_req["answers"].append(scrub(text))
        if not p["files"]:
            continue
        if not any(tags.values()) and not text:
            skipped["unlabelled media (no caption, not a reply)"] += len(p["files"])
            continue
        for f in p["files"]:
            fp = os.path.join(src, f)
            if not os.path.exists(fp):
                skipped["referenced but missing from zip"] += 1
                continue
            if f.lower().endswith((".vcf", ".pdf")):
                skipped["contact cards/pdfs"] += 1
                continue
            shutil.copy2(fp, os.path.join(out, "wa_media", f))
            photos.append(dict(
                file="wa_media/" + f,
                type="video" if f.lower().endswith(".mp4") else "image",
                date=p["start"].strftime("%Y-%m-%d"),
                caption=scrub(text) or None,
                answers_request=context,
                **tags))

    by_file = {}
    for x in photos:
        if x["file"] in by_file:
            y = by_file[x["file"]]
            for k in ("shades", "applications", "sectors", "thickness"):
                y[k] = sorted(set(y[k]) | set(x[k]))
            y["caption"] = y["caption"] or x["caption"]
            y["answers_request"] = y["answers_request"] or x["answers_request"]
        else:
            by_file[x["file"]] = x
    photos = list(by_file.values())

    qa_out = []
    for r in qa:
        if not r["answers"] or len(re.findall(r"[A-Za-z]{2,}", r["text"])) < 3:
            continue  # photo-only answers already live in the photo library
        qa_out.append(dict(question=scrub(r["text"]), answers=r["answers"],
                           date=r["post"]["start"].strftime("%Y-%m-%d"), **r["tags"]))

    kb = dict(source="WhatsApp group export", generated=datetime.now().isoformat(timespec="seconds"),
              photos=photos, qa=qa_out)
    json.dump(kb, open(os.path.join(out, "wa_kb.json"), "w"), ensure_ascii=False, indent=1)

    c = collections.Counter(s for x in photos for s in x["shades"])
    a = collections.Counter(s for x in photos for s in x["applications"])
    print(json.dumps(dict(
        messages=len(msgs), posts=len(posts), requests=len(qa),
        photos=sum(x["type"] == "image" for x in photos), videos=sum(x["type"] == "video" for x in photos),
        photos_with_shade=sum(bool(x["shades"]) for x in photos), text_qa=len(qa_out),
        shades=len(c), top_shades=c.most_common(12), top_apps=a.most_common(10), skipped=skipped), indent=1, default=str))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
