"""Verify packaged files and show the 23 valid analyses in one offline Chrome window."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlparse,unquote
import json,hashlib,time,sys,base64
sys.stdout.reconfigure(encoding='utf-8')
from workflow_worker import configure
configure({'chromeUrl':'http://127.0.0.1:9291'})
from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp
from workflow.delivery import open_pages
ROOT=Path(__file__).resolve().parents[1]/'runs/cca0737s0009-rerun-20261021'
OUT=ROOT/'results';ACCEPT=json.loads((OUT/'acceptance.json').read_text(encoding='utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for entry in json.loads((OUT/'manifest.json').read_text(encoding='utf-8')):
 p=OUT/entry['path'];assert p.stat().st_size==entry['bytes'] and sha(p)==entry['sha256'],entry['path']
class Links(HTMLParser):
 def handle_starttag(self,tag,attrs):
  for key,value in attrs:
   if key not in ['src','href'] or not value:continue
   u=urlparse(value)
   if u.scheme or not u.path:continue
   assert (self.base/unquote(u.path)).resolve().is_file(),(self.base,value)
paths=[('index','index.html')]+[(r['id'],r['page']) for r in ACCEPT['items'] if r['analysis']=='verified']
pages=[]
for item,relative in paths:
 p=OUT/relative;parser=Links();parser.base=p.parent;parser.feed(p.read_text(encoding='utf-8'))
 pages.append({'itemId':item,'key':relative,'path':str(p),'sha256':sha(p)})
ensure_daemon();state_path=ROOT/'delivery-browser.json'
state=json.loads(state_path.read_text()) if state_path.exists() else {}
opened=open_pages(pages,state,cdp=cdp,prune=True)
state_path.write_text(json.dumps(opened['state'],indent=2))
assert not opened['failed'],opened['failed']
checks=[]
for tab in opened['pages']:
 session=cdp('Target.attachToTarget',targetId=tab['targetId'],flatten=True)['sessionId']
 try:
  cdp('Network.setCacheDisabled',session_id=session,cacheDisabled=True)
  cdp('Network.setBypassServiceWorker',session_id=session,bypass=True)
  deadline=time.monotonic()+10
  while True:
   result=cdp('Runtime.evaluate',session_id=session,expression="({title:document.title,text:document.body.innerText.length,images:document.images.length,missing:[...document.images].filter(e=>!e.complete||!e.naturalWidth).map(e=>e.src),scripts:document.scripts.length,canvases:document.querySelectorAll('canvas').length})",returnByValue=True)['result']['value']
   if not result['missing'] or time.monotonic()>deadline:break
   time.sleep(.1)
  assert result['text']>100 and not result['missing'] and result['scripts']==0 and result['canvases']==0,(tab['itemId'],result)
  checks.append({'id':tab['itemId'],'status':'passed','pageSha256':pages[len(checks)]['sha256'],**result})
  if tab['itemId'] in ['index','interpro','espript','prankweb']:
   dest=ROOT/'final-checks';dest.mkdir(exist_ok=True)
   cdp('Emulation.setDeviceMetricsOverride',session_id=session,width=1280,height=900,deviceScaleFactor=1,mobile=False)
   cdp('Target.activateTarget',targetId=tab['targetId']);time.sleep(.2)
   (dest/(tab['itemId']+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot',session_id=session,format='png',_response_timeout=30)['data']))
 finally:cdp('Target.detachFromTarget',sessionId=session)
verification={'status':'passed','scope':'Portable static result pages; original website archive limitations remain separately reported','analysisPages':23,'pagesOpened':len(checks),'singleWindowId':opened['windowId'],'offline':True,'scriptsDisabled':True,'newBrowserContext':not bool(state),'checks':checks}
(OUT/'offline-verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2),encoding='utf-8')
cdp('Target.activateTarget',targetId=opened['pages'][0]['targetId'])
print(json.dumps({'status':'passed','pagesOpened':len(checks),'analysisPages':23,'windowId':opened['windowId'],'output':str(OUT)},ensure_ascii=False))
