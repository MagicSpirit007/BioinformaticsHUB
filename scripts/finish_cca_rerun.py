"""Resume known result pages, inspect receipts and collect original outputs."""
from continue_cca_rerun import *
from workflow.archive import archive_page
from urllib.parse import urlparse

def save_archive(browser,node):
    folder=ROOT/'observations'/node;folder.mkdir(parents=True,exist_ok=True)
    result=archive_page(browser,TASK,TASK/'continuation'/node/'webpage',node)
    (folder/'archive-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'node':node,'archive':result['archive']['status'],'errors':result['archive'].get('errors')},ensure_ascii=False),flush=True)

op,node=sys.argv[1:3]
b,run,recipe=owned(node)
try:
 if op=='details':
    e=inspect(b,node)
    print(json.dumps({'links':[l for l in e['links'] if node=='prankweb' or '/result/InterProScan/' in l['url'] or l.get('download')],'resources':b.evaluate("performance.getEntriesByType('resource').map(e=>e.name).filter(x=>/prediction|iprscan|json|result|download/i.test(x))")},ensure_ascii=False))
 elif op=='interpro-download':
    e=b.document_evidence();out=ROOT/'attachments/interpro';out.mkdir(parents=True,exist_ok=True)
    records=[]
    for l in e['links']:
      if l.get('download') and '/iprscan6/result/' in l['url']:
        dest=out/Path(l['download']).name;b.download_observed_link(l,dest)
        records.append({'path':str(dest),'url':l['url'],'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size})
    (out/'manifest.json').write_text(json.dumps(records,indent=2))
    target=next(l for l in e['links'] if l['label'].strip()=='CCA0737S0009')
    b.revisit_result(target['url']);time.sleep(3);inspect(b,node);save_archive(b,node)
 elif op=='espript-restore':
    # Recover the already uploaded alignment from its recorded server session.
    frames=json.loads((ROOT/'observations/espript/frames.json').read_text())
    main=next(f for f in frames if 'alignment.aln' in f['text'])
    b.revisit_result('https://espript.ibcp.fr/ESPript/cgi-bin/ESPript.cgi');time.sleep(2)
    assert b.evaluate("!!frames.MAIN")
    b.evaluate('frames.MAIN.location.href='+json.dumps(main['url']));time.sleep(2)
    state=b.evaluate("({resultUrl:frames.MAIN.URL_RES,mainUrl:frames.MAIN.location.href,mainText:frames.MAIN.document.body.innerText,fields:[...frames.MAIN.document.querySelectorAll('input')].filter(e=>e.type==='hidden').map(e=>[e.name,e.value])})")
    (ROOT/'observations/espript/recovered-state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(state,ensure_ascii=False)[:6500]);inspect(b,node)
 elif op=='espript-run-uploaded':
    state=b.evaluate("({resultUrl:frames.MAIN.URL_RES,text:frames.MAIN.document.body.innerText})")
    assert 'alignment.aln' in state['text']
    assert not state.get('resultUrl'), 'Inspect existing result URL instead of repeating execution'
    page=b.observe();main=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame MAIN');b.act(main,page)
    set_field(b,'input[name=colnb0]','77');set_field(b,'input[name=glosco0]','0.2');set_field(b,'input[name=fsize0]','7')
    config=b.evaluate("(()=>{for(const [n,v] of [['homomatrix0','B'],['colopt0','C'],['orientation0','L'],['psize0','A3']]){const e=[...document.querySelectorAll('input')].find(e=>e.name===n&&e.value===v);if(!e)throw Error('Missing option');e.click()}for(const e of document.querySelectorAll('input[name=outfiles]'))if(!e.disabled)e.checked=['pdf','300.png'].includes(e.value);return [...document.querySelectorAll('input:checked')].map(e=>[e.name,e.value])})()")
    event(node,'uploaded_alignment_ready',inputSha256=hashlib.sha256((ROOT/'alignment/alignment.aln').read_bytes()).hexdigest(),parameters=config,columns=77,score=.2)
    b.context_id=None;b.session=b.top_session;b.frame_offset=(0,0)
    page=b.observe();banner=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame BANNER');b.act(banner,page)
    click(b,node,r'^Execute ESPript$','espript-render-already-uploaded-alignment')
    time.sleep(3);b.context_id=None;b.session=b.top_session;b.frame_offset=(0,0);inspect(b,node)
 elif op=='espript-renew-upload':
    expired=json.loads((ROOT/'observations/espript/recovered-state.json').read_text())
    assert not expired.get('fields') and 'report this error' in expired['mainText']
    event(node,'remote_upload_expired',url=expired['mainUrl'],note='Saved upload session no longer exists; no rendering receipt was issued. Restore the same new-round alignment and parameters.')
    b.revisit_result('https://espript.ibcp.fr/ESPript/cgi-bin/ESPript.cgi');time.sleep(2)
    page=b.observe();main=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame MAIN');b.act(main,page)
    page=b.observe();upload=next(a for a in page['actions'] if a['kind']=='upload');source=ROOT/'alignment/alignment.aln';b.act(upload,page,str(source))
    assert b.field_value(upload)[0]['size']==source.stat().st_size
    set_field(b,'input[name=colnb0]','77');set_field(b,'input[name=glosco0]','0.2');set_field(b,'input[name=fsize0]','7')
    b.evaluate("(()=>{for(const [n,v] of [['homomatrix0','B'],['colopt0','C'],['orientation0','L'],['psize0','A3']]){const e=[...document.querySelectorAll('input')].find(e=>e.name===n&&e.value===v);if(!e)throw Error('Missing option');e.click()}for(const e of document.querySelectorAll('input[name=outfiles]'))if(!e.disabled)e.checked=['pdf','300.png'].includes(e.value)})()")
    event(node,'upload_recovery_input_verified',inputSha256=hashlib.sha256(source.read_bytes()).hexdigest())
    b.context_id=None;b.session=b.top_session;b.frame_offset=(0,0)
    page=b.observe();banner=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame BANNER');b.act(banner,page)
    click(b,node,r'^Execute ESPript$','espript-upload-recovery-after-expiry')
    time.sleep(3);b.context_id=None;b.session=b.top_session;b.frame_offset=(0,0);inspect(b,node)
 elif op=='espript-state':
    print(json.dumps(b.evaluate("({resultUrl:frames.MAIN.URL_RES,mainUrl:frames.MAIN.location.href,mainText:frames.MAIN.document.body.innerText,message:frames.WWWMOTD.document.body.innerText,links:[...frames.WWWMOTD.document.querySelectorAll('a')].map(e=>({url:e.href,label:e.innerText}))})"),ensure_ascii=False)[:9000])
 elif op=='espript-result':
    from urllib.parse import urljoin
    result_url=b.evaluate('frames.MAIN.URL_RES');assert result_url
    url=urljoin('https://espript.ibcp.fr',result_url)
    event(node,'existing_result_launcher',url=url)
    result=WorkflowBrowser(url,{},recipe['allowedHosts'],TASK/'continuation/espript/downloads')
    try:
      time.sleep(2);e=result.document_evidence()
      (ROOT/'observations/espript/result-launcher.json').write_text(json.dumps(e,ensure_ascii=False,indent=2),encoding='utf-8')
      print(json.dumps(e,ensure_ascii=False)[:7500])
      print('SCRIPTS',result.evaluate("[...document.scripts].map(s=>s.textContent).join('\\n')")[:7000])
      (ROOT/'contexts/espript_result.json').write_text(json.dumps({**result.checkpoint(),'resultUrl':e['url']},indent=2))
    finally:result.close()
 elif op=='espript-collect':
    saved=json.loads((ROOT/'contexts/espript_result.json').read_text())
    result=WorkflowBrowser(saved['resultUrl'],saved,recipe['allowedHosts'],TASK/'continuation/espript/downloads')
    try:
      records=[];page=result.observe();frames=[a for a in page['actions'] if a.get('kind')=='frame']
      print('FRAMES',frames)
      for frame in frames:
        page=result.observe();action=next(a for a in page['actions'] if a.get('frame')==frame['frame']);result.act(action,page)
        e=result.document_evidence();print(json.dumps(e,ensure_ascii=False)[:8000])
        records.append(e)
        out=ROOT/'attachments/espript';out.mkdir(parents=True,exist_ok=True)
        for l in e['links']:
          if re.search(r'\.(pdf|png|ps|log|txt|aln)$',l['url'],re.I):
            destination=out/Path(urlparse(l['url']).path).name;result.download_observed_link(l,destination)
            print('DOWNLOADED',destination.name,destination.stat().st_size)
        result.context_id=None;result.session=result.top_session;result.frame_offset=(0,0)
      (ROOT/'observations/espript/output-frames.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:result.close()
 elif op=='hmmer-menu':
    page=b.observe();print(json.dumps([a for a in page['actions'] if 'download' in a['label'].lower()],ensure_ascii=False))
    print(json.dumps(b.evaluate("[...document.querySelectorAll('a,span,button')].filter(e=>e.textContent.trim()==='Download').map(e=>({tag:e.tagName,html:e.outerHTML}))"),ensure_ascii=False))
 elif op=='hmmer-download-tab':
    click(b,node,r'^Download$','hmmer-download-tab',submit=False);time.sleep(1);e=inspect(b,node);print(json.dumps(e['links'],ensure_ascii=False))
 elif op=='hmmer-export':
    state=b.evaluate("[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()==='Generate').map(e=>({html:e.parentElement.outerHTML,text:e.parentElement.parentElement.innerText}))")
    print(json.dumps(state,ensure_ascii=False)[:6500])
    assert state and 'Text' in state[0]['text']
    b.evaluate("[...document.querySelectorAll('button')].filter(e=>e.innerText.trim()==='Generate').slice(0,2).forEach(e=>e.click())")
    event(node,'export_requested',formats=['Text','Tab Delimited'],note='Export existing results only; no new search')
    time.sleep(3);e=inspect(b,node);print(json.dumps(e['links'],ensure_ascii=False)[:8000])
 elif op=='hmmer-export-status':
    print(json.dumps(b.evaluate("({buttons:[...document.querySelectorAll('button')].map(e=>({text:e.innerText,parent:e.parentElement.parentElement.innerText})),resources:performance.getEntriesByType('resource').map(e=>e.name)})"),ensure_ascii=False)[:14000])
    e=inspect(b,node)
 elif op=='espript-input':
    frames=json.loads((ROOT/'observations/espript/output-frames.json').read_text())
    frame=next(e for e in frames if any(l['url'].endswith('.aln') for l in e['links']))
    source=WorkflowBrowser(frame['url'],{},recipe['allowedHosts'],TASK/'continuation/espript/downloads')
    try:
      link=next(l for l in source.document_evidence()['links'] if l['url'].endswith('.aln'))
      source.download_observed_link(link,ROOT/'attachments/espript/server-input.aln')
    finally:source.close()
 elif op=='quickgo-result':
    terms=json.loads((ROOT/'analysis/go-annotation.json').read_text())['terms'];assert any(t['id']=='GO:0003700' for t in terms)
    b.revisit_result('https://www.ebi.ac.uk/QuickGO/term/GO:0003700');time.sleep(3);e=inspect(b,node)
    assert 'DNA-binding transcription factor activity' in e['text'];save_archive(b,node)
 elif op=='espript-logframes':
    saved=json.loads((ROOT/'contexts/espript_result.json').read_text())
    result=WorkflowBrowser(saved['resultUrl'],saved,recipe['allowedHosts'],TASK/'continuation/espript/downloads')
    try:
      records=[]
      for index,label in [(0,'RESULTS'),(1,'Server logs'),(2,'Input files'),(3,'Tracing files')]:
        result.evaluate('document.querySelectorAll("input[type=radio]")['+str(index)+'].click()');time.sleep(.3)
        page=result.observe();frame=next(a for a in page['actions'] if a.get('kind')=='frame' and (['/results-','/F_OUTPUT-','/ALL_INPUT-','/tracefile-'][index] in a['label']));result.act(frame,page)
        e=result.document_evidence();records.append(e);print(json.dumps({'tab':label,'text':e['text'][:6500],'links':e['links']},ensure_ascii=False))
        if index==0:save_archive(result,node)
        result.context_id=None;result.session=result.top_session;result.frame_offset=(0,0)
      (ROOT/'observations/espript/output-frames.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:result.close()
 elif op=='archive':inspect(b,node);save_archive(b,node)
 else:raise ValueError(op)
finally:b.close()
