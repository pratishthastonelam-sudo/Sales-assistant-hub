# Chunk Drive document text (pdftotext / pptx / Gemini OCR), embed, upsert into kb_items as kind='document'.
import urllib.error, json, os, re, sys, time, urllib.request
S=os.path.dirname(os.path.abspath(__file__))
KEY=os.environ['GEMINI_API_KEY'].strip('<> "\'')
URL=os.environ['SUPABASE_URL'].strip('<> "\'').rstrip('/')
SR=os.environ['SUPABASE_SERVICE_ROLE_KEY'].strip('<> "\'')
d=json.load(open(f'{S}/doc_text.json')); ocr=json.load(open(f'{S}/ocr.json')) if os.path.exists(f'{S}/ocr.json') else {}
SKIP=re.compile(r'^(Logo/|Nature is Above All Entities$|Nature is Above All Entities/Email)')
PRICE=re.compile(r'(₹|rs\.?|inr|mrp)\s*[:\-]?\s*[\d,]+(\.\d+)?(\s*/-)?|[\d,]+(\.\d+)?\s*(/-|rs\b|inr\b)', re.I)
PHONE=re.compile(r'(\+?\d[\d \-]{8,}\d)'); EMAIL=re.compile(r'\S+@\S+\.\w+')
def clean(t): t=t.replace('\x00',''); return re.sub(r'\n{3,}','\n\n',EMAIL.sub('',PHONE.sub('',PRICE.sub('',t)))).strip()
chunks=[]
for x in d:
    if SKIP.match(x['path'] or ''): continue
    pages=x['pages']
    if x['id'] in ocr:
        pages=[p for p in re.split(r'=== ?Page \d+ ?===', ocr[x['id']]) if p.strip()]
    cur=''; start=1; n=0
    for i,p in enumerate(pages,1):
        p=clean(p)
        if not p: continue
        if cur and len(cur)+len(p)>2200:
            chunks.append((x,start,i-1,cur)); cur=''; start=i
        cur+=('\n' if cur else '')+p
        while len(cur)>3000:
            chunks.append((x,start,i,cur[:2500])); cur=cur[2300:]
    if cur.strip(): chunks.append((x,start,len(pages),cur))
rows=[]; seen={}
for x,a,b,t in chunks:
    sid=f"drive:{x['id']}:{a}-{b}"; seen[sid]=seen.get(sid,0)+1
    if seen[sid]>1: sid+=f"#{seen[sid]}"
    where=(x['path']+'/' if x['path'] else '')+x['name']
    rows.append({'source_id':sid, 'kind':'document', 'title':f"{x['name']} (p.{a}-{b})" if b>a else f"{x['name']} (p.{a})",
                 'body':f"Document: {where}\n{t}", 'source':'drive',
                 'meta':{'drive':{'id':x['id'],'name':x['name'],'path':x['path'],'mime_type':x['mime_type']},'pages':[a,b]}})
print(len(rows),'chunks', sum(len(r['body']) for r in rows),'chars', flush=True)
emb=json.load(open(f'{S}/doc_emb.json')) if os.path.exists(f'{S}/doc_emb.json') else {}
def post(url,body,h):
    r=urllib.request.Request(url,json.dumps(body).encode(),{'Content-Type':'application/json',**h}); return json.load(urllib.request.urlopen(r,timeout=120))
todo=[r for r in rows if r['source_id'] not in emb]
for i in range(0,len(todo),20):
    batch=todo[i:i+20]
    for attempt in range(6):
        try:
            j=post(f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key={KEY}",
                {'requests':[{'model':'models/gemini-embedding-001','content':{'parts':[{'text':r['title']+'\n'+r['body'][:6000]}]},'taskType':'RETRIEVAL_DOCUMENT','outputDimensionality':768} for r in batch]},{})
            for r,e in zip(batch,j['embeddings']): emb[r['source_id']]=e['values']
            json.dump(emb,open(f'{S}/doc_emb.json','w')); break
        except Exception as e:
            print('embed failed',e,flush=True)
            if getattr(e,'code',0)==429: break
            time.sleep(30*(attempt+1))
    if batch[0]['source_id'] not in emb:
        print('embedding quota used up; loading the rest without vectors (drive_sync fills them later)'); break
    time.sleep(4)
print('embedded',sum(r['source_id'] in emb for r in rows),'/',len(rows),flush=True)
for r in rows:
    r['embedding']=None
    if r['source_id'] in emb: r['embedding']='['+','.join(f'{v:.6f}' for v in emb[r['source_id']])+']'
# replace old document rows, then insert
h={'apikey':SR,'Authorization':f'Bearer {SR}'}
urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/kb_items?kind=eq.document",headers=h,method='DELETE'))
for i in range(0,len(rows),50):
    req=urllib.request.Request(f"{URL}/rest/v1/kb_items?on_conflict=source_id",json.dumps(rows[i:i+50]).encode(),
        {**h,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'})
    try: urllib.request.urlopen(req,timeout=120)
    except urllib.error.HTTPError as e: print('load error', e.read()[:500]); raise
print('loaded',len(rows),flush=True)
