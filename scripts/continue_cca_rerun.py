"""Explicit study continuation; no old-round output is read or reused."""
from pathlib import Path
import sys, os, json, time, hashlib, re
sys.stdout.reconfigure(encoding='utf-8')
REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'runs/cca0737s0009-rerun-20261021'
RUN = json.loads((ROOT/'run.json').read_text())
TASK = Path(RUN['runDirectory'])
from workflow_worker import configure
configure({'chromeUrl':RUN['chromeUrl']})
from workflow.browser import WorkflowBrowser
from browser_harness.helpers import cdp
LEDGER = ROOT/'continuation.jsonl'

def event(node, kind, **data):
    with LEDGER.open('a',encoding='utf-8') as f:
        f.write(json.dumps({'at':time.time(),'node':node,'kind':kind,**data},ensure_ascii=False)+'\n');f.flush();os.fsync(f.fileno())

def owned(node):
    session=json.loads((TASK/'session.json').read_text())
    if node not in {n['id'] for n in session['nodes']}:
        urls={'mafft':'https://mafft.cbrc.jp/alignment/server/','espript':'https://espript.ibcp.fr/ESPript/ESPript/index.php','weblogo':'https://weblogo.threeplusone.com/create.cgi','prankweb':'https://prankweb.cz/','quickgo':'https://www.ebi.ac.uk/QuickGO/'}
        from urllib.parse import urlparse
        url=urls[node];hosts=[urlparse(url).hostname]
        record=ROOT/'contexts'/f'{node}.json';record.parent.mkdir(exist_ok=True)
        checkpoint=json.loads(record.read_text()) if record.exists() else {}
        browser=WorkflowBrowser(url,checkpoint,hosts,TASK/'continuation'/node/'downloads')
        record.write_text(json.dumps(browser.checkpoint(),indent=2))
        return browser,{'status':'paused','checkpoint':checkpoint},{'entryUrl':url,'allowedHosts':hosts}
    run=next(n for n in session['nodes'] if n['id']==node)
    assert run['status'] not in {'running','verifying','ready','waiting_remote'},'Native worker owns active node'
    recipe=session['recipeSnapshot'][node]
    definition=next(n for n in session['workflow']['nodes'] if n['id']==node)
    recipe={**recipe,'entryUrl':recipe.get('entryUrl') or definition.get('entryUrl')}
    checkpoint=dict(run['checkpoint'])
    recovered=ROOT/'observations'/node/'checkpoint.json'
    if recovered.exists() and not checkpoint.get('effectPending'):
        checkpoint.update(json.loads(recovered.read_text()))
    browser=WorkflowBrowser(recipe['entryUrl'],checkpoint,recipe['allowedHosts'],TASK/'nodes'/node/'downloads.tmp')
    return browser,run,recipe

def inspect(browser,node):
    browser.observe()
    evidence=browser.document_evidence()
    evidence['controls']=browser.evaluate("[...document.querySelectorAll('input,textarea,select,button')].filter(e=>!['hidden','password'].includes(e.type)).map(e=>({tag:e.tagName,name:e.name,id:e.id,type:e.type,value:e.value,text:(e.innerText||'').slice(0,120),options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:o.text,selected:o.selected})):undefined}))")
    folder=ROOT/'observations'/node;folder.mkdir(parents=True,exist_ok=True)
    (folder/'current.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    checkpoint={**browser.checkpoint(),'resultUrl':evidence['url']}
    (folder/'checkpoint.json').write_text(json.dumps(checkpoint,indent=2))
    record=ROOT/'contexts'/f'{node}.json'
    if record.exists():record.write_text(json.dumps(checkpoint,indent=2))
    print(json.dumps({'node':node,'url':evidence['url'],'text':evidence['text'][:4500],'controls':evidence['controls'][:35]},ensure_ascii=False),flush=True)
    return evidence

def set_field(browser,selector,value):
    actual=browser.evaluate("((s,v)=>{const e=document.querySelector(s);if(!e)throw Error('Missing observed field');const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})("+json.dumps(selector)+','+json.dumps(value)+')')
    assert actual==value

def click(browser,node,pattern,key,submit=True):
    if submit:
        prior=[json.loads(l) for l in LEDGER.read_text().splitlines()] if LEDGER.exists() else []
        matching=[x for x in prior if x.get('key')==key]
        assert not matching or matching[-1]['kind']=='submit_rejected_before_input','Inspect existing receipt; do not repeat submission'
    browser.evaluate("(p=>{let e=[...document.querySelectorAll('button,input[type=submit],input[type=button],a')].find(e=>new RegExp(p,'i').test((e.innerText||e.value||'').trim()));if(e)e.scrollIntoView({block:'center',behavior:'instant'})})("+json.dumps(pattern)+')')
    time.sleep(.6)
    page=browser.observe();choices=[a for a in page['actions'] if a['kind']=='click' and re.search(pattern,a['label'],re.I)]
    if node=='weblogo' and len(choices)>1 and all(a.get('fieldName')=='cmd_create' for a in choices):choices=choices[:1]
    assert len(choices)==1,[(a['label'],a['id']) for a in page['actions'] if a['kind']=='click']
    event(node,'submit_intent' if submit else 'navigation',key=key,url=page['url'],action=choices[0]['label'])
    try:browser.act(choices[0],page)
    except Exception as error:
        if type(error).__name__=='StalePage' and str(error)=='Page changed since this decision. Observe again.':
            event(node,'submit_rejected_before_input',key=key)
        raise
    event(node,'submit_returned' if submit else 'navigation_returned',key=key)

def main():
    operation=sys.argv[1]
    for node in sys.argv[2:]:
        browser=None
        try:
            browser,run,recipe=owned(node)
            if operation=='inspect':inspect(browser,node)
            elif operation=='interpro-prepare':
                assert node=='interpro'
                ids=browser.evaluate("[...Object.keys(localStorage),...Object.keys(sessionStorage)].flatMap(k=>((localStorage.getItem(k)||sessionStorage.getItem(k)||'').match(/iprscan[0-9]-[A-Za-z0-9-]+/g)||[]))")
                event(node,'existing_job_ids',ids=ids)
                print(json.dumps({'recordedJobs':ids}))
                browser.revisit_result('https://www.ebi.ac.uk/interpro/search/sequence/')
                inspect(browser,node)
                print(json.dumps(browser.observe()['actions'],ensure_ascii=False))
            elif operation=='interpro-submit':
                assert node=='interpro'
                assert browser.evaluate('location.pathname')=='/interpro/search/sequence/'
                page=browser.observe()
                banner=[a for a in page['actions'] if a.get('label')=='I agree, dismiss this banner']
                if banner:browser.act(banner[0],page)
                page=browser.observe();upload=next(a for a in page['actions'] if a['kind']=='upload')
                source=TASK/json.loads((TASK/'session.json').read_text())['input']['protein']['path']
                assert source.is_file()
                browser.act(upload,page,str(source))
                assert browser.field_value(upload)[0]['size']==source.stat().st_size
                event(node,'input_verified',inputSha256=hashlib.sha256(source.read_bytes()).hexdigest(),formNode=upload['formNode'])
                browser.evaluate("[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='Search'&&e.closest('form'))?.scrollIntoView({block:'center'})")
                page=browser.observe();choices=[a for a in page['actions'] if a['kind']=='click' and a['label']=='Search' and a.get('formNode')==upload['formNode']]
                assert len(choices)==1,[(a['label'],a.get('formNode')) for a in page['actions'] if a['kind']=='click']
                event(node,'submit_intent',key='interpro-sequence-analysis',url=page['url'])
                browser.act(choices[0],page);event(node,'submit_returned',key='interpro-sequence-analysis')
                time.sleep(3);inspect(browser,node)
            elif operation=='clear-subrange':
                assert not run['checkpoint'].get('submitted')
                for name in ['QUERY_FROM','QUERY_TO']:set_field(browser,'input[name="'+name+'"]','')
                event(node,'corrected_nonsequence_fields',fields=['QUERY_FROM','QUERY_TO'])
                inspect(browser,node)
            elif operation=='blast-submit':
                assert not run['checkpoint'].get('submitted') and not run['checkpoint'].get('effectPending')
                e=inspect(browser,node)
                key='nucleotide' if node=='blastn' else 'protein'
                fasta=json.loads((ROOT/'primary-spec.json').read_text())['inputs'][key]['value']
                set_field(browser,'textarea[name=QUERY]',fasta)
                for name in ['QUERY_FROM','QUERY_TO']:set_field(browser,'input[name='+name+']','')
                selected=next(c for c in e['controls'] if c['name']=='DATABASE')
                assert selected['value'] in (['core_nt'] if node=='blastn' else ['nr_cluster_seq','clustered_nr']),selected
                set_field(browser,'input[name=EXPECT]','1e-5')
                event(node,'parameters_verified',inputSha256=hashlib.sha256(fasta.encode()).hexdigest(),database=selected['value'],expect=1e-5)
                click(browser,node,r'^BLAST$','new-'+node+'-submission')
                time.sleep(3);inspect(browser,node)
            elif operation=='mafft-submit':
                fasta=(ROOT/'homologs/homologs.fasta').read_text();assert fasta.count('>')==20
                inspect(browser,node)
                set_field(browser,'textarea[name=senddata]',fasta)
                set_field(browser,'input[name=namelength]','80')
                set_field(browser,'input[name=mailaddress]','')
                options=browser.evaluate("(()=>{for(const [n,v] of [['strategy','L-INS-i'],['outorder','input'],['originalsequence','originalseqonly'],['case','inputcase']]){const e=[...document.querySelectorAll('input')].find(e=>e.name===n&&e.value===v);if(!e)throw Error('Missing MAFFT option');e.click()}for(const n of ['dashstr','usestr','treeout','mafftE','mafftE_fullout']){const e=document.querySelector('input[name='+n+']');if(e){e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}))}}return [...document.querySelectorAll('input[type=radio]:checked')].map(e=>[e.name,e.value])})()")
                event(node,'parameters_verified',inputSha256=hashlib.sha256(fasta.encode()).hexdigest(),strategy='L-INS-i',matrix='BLOSUM62',gapOpen=1.53,offset=0,options=options)
                click(browser,node,r'^Submit$','mafft-new-20-sequences')
                time.sleep(3);inspect(browser,node)
            elif operation=='mafft-download':
                page=browser.observe();frame=next(a for a in page['actions'] if a.get('kind')=='frame' and a.get('frame'))
                browser.act(frame,page);e=browser.document_evidence()
                assert 'MAFFT-L-INS-i Result' in e['text']
                folder=ROOT/'alignment';folder.mkdir(exist_ok=True)
                for label,name in [('Fasta format','alignment.fasta'),('Clustal format','alignment.aln')]:
                    link=next(l for l in e['links'] if l['label']==label)
                    browser.download_observed_link(link,folder/name)
                from workflow.site import alignment_matches_input
                fasta=(folder/'alignment.fasta').read_bytes()
                assert alignment_matches_input(fasta,(ROOT/'homologs/homologs.fasta').read_text())
                records=re.split(r'(?m)^>[^\n]*\n',fasta.decode().strip()+'\n')[1:]
                lengths={len(re.sub(r'\s','',x)) for x in records}
                assert len(records)==20 and len(lengths)==1
                validation={'verified':True,'url':e['url'],'sequences':20,'columns':next(iter(lengths)),'ungappedSequencesMatch':True,'inputSha256':hashlib.sha256((ROOT/'homologs/homologs.fasta').read_bytes()).hexdigest(),'alignmentSha256':hashlib.sha256(fasta).hexdigest(),'strategy':'L-INS-i','version':'7.511'}
                (folder/'validation.json').write_text(json.dumps(validation,indent=2));print(json.dumps(validation))
                from workflow.archive import archive_page
                browser.context_id=None;browser.session=browser.top_session;browser.frame_offset=(0,0)
                saved=archive_page(browser,TASK,TASK/'continuation'/node/'webpage',node)
                (ROOT/'observations'/node/'archive-result.json').write_text(json.dumps(saved,ensure_ascii=False,indent=2),encoding='utf-8')
            elif operation=='weblogo-submit':
                fasta=(ROOT/'alignment/alignment.fasta').read_text();assert fasta.count('>')==20
                set_field(browser,'textarea[name=sequences]',fasta)
                set_field(browser,'input[name=logo_title]','CCA0737S0009 homologs (20 species)')
                for name,value in [('format','svg'),('alphabet','alphabet_protein'),('unit_name','bits'),('composition','comp_equiprobable'),('color_scheme','color_chemistry')]:set_field(browser,'select[name='+name+']',value)
                set_field(browser,'input[name=stacks_per_line]','60')
                browser.evaluate("(()=>{const e=document.querySelector('input[name=download]');e.value='true';e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}))})()")
                event(node,'parameters_verified',inputSha256=hashlib.sha256(fasta.encode()).hexdigest(),records=20,columns=308,units='bits',background='equiprobable',colors='chemistry')
                click(browser,node,r'^Create WebLogo$','weblogo-new-alignment')
                time.sleep(3);inspect(browser,node)
                print(json.dumps({'downloads':[{'name':p.name,'bytes':p.stat().st_size} for p in browser.downloads.glob('*') if p.is_file()]}))
            elif operation=='prank-submit':
                validation=json.loads((ROOT/'structure-validation.json').read_text());assert validation['chains'][0]['sequenceMatchesTarget']
                source=ROOT/'attachments/swiss_model/01.pdb';assert hashlib.sha256(source.read_bytes()).hexdigest()==validation['sha256']
                page=browser.observe();reject=[a for a in page['actions'] if a.get('label')=='Reject all']
                if reject:browser.act(reject[0],page)
                browser.evaluate("document.querySelector('#input-user-file').click()")
                page=browser.observe();upload=next(a for a in page['actions'] if a['kind']=='upload');browser.act(upload,page,str(source))
                assert browser.field_value(upload)[0]['size']==source.stat().st_size
                browser.evaluate("document.querySelector('input[name=user-input-model][value=default]').click()")
                event(node,'parameters_verified',inputSha256=validation['sha256'],model='Default',conservation=False,source='SWISS-MODEL rtRcny model 01')
                click(browser,node,r'^Submit$','prank-new-structure')
                time.sleep(3);inspect(browser,node)
            elif operation=='espript-open':
                browser.revisit_result('https://espript.ibcp.fr/ESPript/cgi-bin/ESPript.cgi')
                time.sleep(2);inspect(browser,node)
            elif operation=='espript-submit':
                page=browser.observe();main=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame MAIN')
                browser.act(main,page);page=browser.observe();upload=next(a for a in page['actions'] if a['kind']=='upload')
                source=ROOT/'alignment/alignment.aln';browser.act(upload,page,str(source))
                assert browser.field_value(upload)[0]['size']==source.stat().st_size
                set_field(browser,'input[name=colnb0]','77');set_field(browser,'input[name=fsize0]','7');set_field(browser,'input[name=glosco0]','0.2')
                options=browser.evaluate("(()=>{for(const [n,v] of [['homomatrix0','B'],['colopt0','C'],['orientation0','L'],['psize0','A3']]){const e=[...document.querySelectorAll('input')].find(e=>e.name===n&&e.value===v);if(!e)throw Error('Missing observed ESPript option');e.click()}for(const e of document.querySelectorAll('input[name=outfiles]'))if(!e.disabled)e.checked=['pdf','300.png'].includes(e.value);return [...document.querySelectorAll('input[type=radio]:checked')].map(e=>[e.name,e.value])})()")
                event(node,'parameters_verified',inputSha256=hashlib.sha256(source.read_bytes()).hexdigest(),score=.2,columns=77,matrix='BLOSUM62',formats=['pdf','300.png'],options=options)
                browser.context_id=None;browser.session=browser.top_session;browser.frame_offset=(0,0)
                page=browser.observe();banner=next(a for a in page['actions'] if a.get('kind')=='frame' and a['label']=='Inspect embedded frame BANNER');browser.act(banner,page)
                click(browser,node,r'^Execute ESPript$','espript-new-alignment')
                time.sleep(3);browser.context_id=None;browser.session=browser.top_session;browser.frame_offset=(0,0);inspect(browser,node)
            elif operation=='musite-download':
                e=inspect(browser,node)
                assert 'CCA0737S0009' in e['text'] and 'Results for JobID:' in e['text']
                click(browser,node,r'^Save the prediction results to a file$','musite-download',submit=False)
                time.sleep(2)
                print(json.dumps({'downloads':[{'name':f.name,'bytes':f.stat().st_size} for f in browser.downloads.glob('*') if f.is_file()]}))
            elif operation=='download-attachments':
                from urllib.parse import urlparse
                from workflow.downloads import verify_files
                e=browser.document_evidence()
                patterns={'tmhmm':r'\.eps$', 'signalp':r'\.(?:zip|txt|gff3|png|eps)$','swiss_model':r'/models/\d+\.pdb$|/models/\d+/report\.zip$','protscale':r'Numerical format|Image in', 'hmmer':r'(?!)'}
                links={l['url']:l for l in e['links'] if re.search(patterns[node],l['url']+' '+l['label']) or re.search(patterns[node],l['url'])}
                out=ROOT/'attachments'/node;out.mkdir(parents=True,exist_ok=True)
                records=[]
                for link in links.values():
                    name=Path(urlparse(link['url']).path).name
                    if node=='swiss_model' and name=='report.zip':name=Path(urlparse(link['url']).path).parent.name+'-report.zip'
                    path=out/name
                    browser.download_observed_link(link,path)
                    records.append({'path':str(path),'url':link['url'],'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
                check=verify_files(records)
                (out/'manifest.json').write_text(json.dumps({'files':records,'verification':check},ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps({'node':node,'files':len(records),'status':check['status'],'issues':check['issues']},ensure_ascii=False))
            elif operation=='swiss-build':
                assert not run['checkpoint'].get('submitted')
                fasta=json.loads((ROOT/'primary-spec.json').read_text())['inputs']['protein']['value']
                assert browser.evaluate('document.querySelector("textarea[name=target]").value').rstrip()==fasta.rstrip()
                click(browser,node,r'^Validate(?: Input)?','swiss-validate',submit=False)
                time.sleep(2)
                inspect(browser,node)
                click(browser,node,r'^Build Model$','swiss-new-model')
                time.sleep(2);inspect(browser,node)
            elif operation=='musite-submit':
                assert not run['checkpoint'].get('submitted')
                fasta=json.loads((ROOT/'primary-spec.json').read_text())['inputs']['protein']['value']
                set_field(browser,'textarea',fasta)
                browser.call('Input.dispatchKeyEvent',type='keyDown',key='Escape',code='Escape')
                browser.call('Input.dispatchKeyEvent',type='keyUp',key='Escape',code='Escape')
                e=inspect(browser,node)
                assert all(x in e['text'] for x in ['Phosphorylation (S,T)','Phosphorylation (Y)','Hydroxylysine (K)'])
                event(node,'input_verified',sha256=hashlib.sha256(fasta.encode()).hexdigest(),modifications='All 13 types as in original report',threshold=.5)
                click(browser,node,r'^Start prediction$','musite-new-all-types')
                time.sleep(2);inspect(browser,node)
            elif operation=='protparam-repair':
                e=inspect(browser,node)
                assert 'Your sequence should be at least 5 residues' in e['text']
                browser.revisit_result(recipe['entryUrl'])
                fasta=json.loads((ROOT/'primary-spec.json').read_text())['inputs']['protein']['value']
                sequence=''.join(fasta.splitlines()[1:]);assert len(sequence)==260
                set_field(browser,'textarea[name=sequence]',sequence)
                set_field(browser,'input[name=mandatory]','')
                event(node,'input_verified',sequenceSha256=hashlib.sha256(sequence.encode()).hexdigest(),normalization='FASTA header removed; all 260 residues retained; previous request returned explicit empty-sequence error')
                click(browser,node,r'^Compute parameters$','protparam-corrected-sequence')
                time.sleep(2);inspect(browser,node)
            elif operation=='archive':
                from workflow.archive import archive_page
                inspect(browser,node)
                result=archive_page(browser,TASK,TASK/'continuation'/node/'webpage',node)
                (ROOT/'observations'/node/'archive-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps({'node':node,'archive':result['archive']},ensure_ascii=False)[:2500],flush=True)
            elif operation=='frames':
                page=browser.observe()
                frames=[a for a in page['actions'] if a.get('kind')=='frame' and a.get('frame')]
                results=[]
                for a in frames:
                    page=browser.observe();actual=next(x for x in page['actions'] if x.get('frame')==a['frame'])
                    browser.act(actual,page);e=browser.document_evidence();results.append(e)
                    print(json.dumps({'url':e['url'],'text':e['text'][:2200],'links':e['links'][-20:]},ensure_ascii=False))
                    browser.context_id=None;browser.session=browser.top_session;browser.frame_offset=(0,0)
                folder=ROOT/'observations'/node;folder.mkdir(parents=True,exist_ok=True)
                (folder/'frames.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
            else:raise ValueError(operation)
        except Exception as e:
            print(json.dumps({'node':node,'error':repr(e)},ensure_ascii=False),flush=True)
        finally:
            if browser:browser.close()

if __name__=='__main__':main()
