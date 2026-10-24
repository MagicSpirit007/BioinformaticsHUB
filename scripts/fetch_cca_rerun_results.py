"""Retrieve results from existing receipts only; no analysis submission endpoints."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,hashlib,urllib.request,time,sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]/'runs/cca0737s0009-rerun-20261021'
JOB='iprscan6-R20261021-040143-0493-30971739-p2m'
URLS={
 'interpro-status.txt':f'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/{JOB}',
 'interpro-result-types.xml':f'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/resulttypes/{JOB}',
 'interpro-result.json':f'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/result/{JOB}/json',
 'hmmer-score.json':'https://www.ebi.ac.uk/Tools/hmmer/api/v1/result/7da54580-50de-4ee2-8518-9daa0d5f911a?page=1&page_size=50&with_domains=false',
 'hmmer-search.json':'https://www.ebi.ac.uk/Tools/hmmer/api/v1/search/7da54580-50de-4ee2-8518-9daa0d5f911a',
 'hmmer-download-status.json':'https://www.ebi.ac.uk/Tools/hmmer/api/v1/download/7da54580-50de-4ee2-8518-9daa0d5f911a',
 'blastn.xml':'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=DGAB2JGP016&FORMAT_TYPE=XML',
 'blastp.xml':'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=DGAD0TVP014&FORMAT_TYPE=XML',
 'quickgo-GO0003700.json':'https://www.ebi.ac.uk/QuickGO/services/ontology/go/terms/GO%3A0003700',
}
detail=ROOT/'prank-details.log'
if detail.exists():
 for line in detail.read_text(encoding='utf-8').splitlines():
  try:v=json.loads(line)
  except ValueError:continue
  for url in v.get('resources',[]):
   if '/public/prediction.json' in url:URLS['prankweb-prediction.json']=url
   elif '/public/structure.pdb' in url:URLS['prankweb-structure.pdb']=url
def retrieve(item):
 name,url=item;destination=ROOT/'official-results'/name
 if destination.exists():return {'name':name,'status':'already_downloaded','sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}
 for proxy in [None,'http://127.0.0.1:7890']:
  try:
   opener=urllib.request.build_opener(urllib.request.ProxyHandler({} if proxy is None else {'http':proxy,'https':proxy}))
   with opener.open(urllib.request.Request(url,headers={'Accept':'application/json, application/xml, text/plain','User-Agent':'BioinformaticsHUB/0.7'}),timeout=35) as response:
    data=response.read(32*1024*1024);ct=response.headers.get('Content-Type')
   if data.startswith(b'\x1f\x8b'):
    import gzip
    data=gzip.decompress(data)
   if name.endswith('.json'):json.loads(data)
   if name.endswith('.xml'):
    from xml.etree import ElementTree
    ElementTree.fromstring(data)
    if name.startswith('blast'):assert b'BlastOutput' in data,'Not a BLAST result'
   destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
   return {'name':name,'url':url,'status':'downloaded','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'contentType':ct,'retrievedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'temporaryProxyUsed':bool(proxy)}
  except Exception as e:error=repr(e)
 return {'name':name,'url':url,'status':'unavailable','error':error}
with ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(retrieve,URLS.items()))
(ROOT/'official-results').mkdir(exist_ok=True)
manifest=ROOT/'official-results/retrieval-manifest.json'
prior={r['name']:r for r in json.loads(manifest.read_text())} if manifest.exists() else {}
for r in results:
 if r['status']!='already_downloaded' or r['name'] not in prior:prior[r['name']]=r
manifest.write_text(json.dumps(list(prior.values()),ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
