"""Download the two already generated HMMER exports with exact size checks."""
from pathlib import Path
import json,urllib.request,hashlib,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]/'runs/cca0737s0009-rerun-20261021'
out=root/'attachments/hmmer';out.mkdir(parents=True,exist_ok=True)
items=json.loads((root/'official-results/hmmer-download-status.json').read_text())
records=[]
for item in items:
 if item['format'] not in ['text','tsv']:continue
 assert item['status']=='AVAILABLE' and item['url'].startswith('https://www.ebi.ac.uk/Tools/hmmer/downloads/7da54580-50de-4ee2-8518-9daa0d5f911a-')
 destination=out/('result.txt' if item['format']=='text' else 'result.tsv')
 expected=int(item['size']);assert 0<expected<128*1024*1024
 if not destination.exists():
  for proxy in [None,'http://127.0.0.1:7890']:
   try:
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({} if proxy is None else {'http':proxy,'https':proxy}))
    temp=destination.with_suffix(destination.suffix+'.part');size=0
    with opener.open(item['url'],timeout=60) as response,temp.open('wb') as f:
     while chunk:=response.read(1024*1024):
      size+=len(chunk);assert size<=expected;f.write(chunk)
    assert size==expected,(size,expected)
    assert not temp.read_bytes()[:100].lower().lstrip().startswith((b'<!doctype html',b'<html'))
    temp.replace(destination);break
   except Exception as e:
    if proxy:raise
    print('Direct download failed; retrying through temporary local proxy:',type(e).__name__,flush=True)
 assert destination.stat().st_size==expected
 digest=hashlib.sha256(destination.read_bytes()).hexdigest()
 records.append({'url':item['url'],'path':str(destination),'bytes':expected,'sha256':digest,'expectedSizeMatches':True})
 print(json.dumps({'format':item['format'],'bytes':expected,'sha256':digest}),flush=True)
(out/'manifest.json').write_text(json.dumps(records,indent=2))
