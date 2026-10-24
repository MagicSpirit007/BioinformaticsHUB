"""Fresh UniProt downloads selected only from this rerun's HMMER table."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json,sys,hashlib
from workflow.resolver import resolve_sequence
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]/'runs/cca0737s0009-rerun-20261021'
source=root/'observations/hmmer/current.json'
rows=json.loads(source.read_text(encoding='utf-8'))['tables'][0][1:]
genera=['Carya','Juglans','Morella','Carpinus','Castanea','Quercus','Ziziphus','Rhamnella','Durio','Quillaja','Acer','Dipteronia','Parasponia','Populus','Trema','Theobroma','Corchorus','Cannabis','Salix']
out=root/'homologs';out.mkdir(exist_ok=True)
chosen=[]
for genus in genera:
    hits=[r for r in rows if len(r)>=5 and r[3].split()[0]==genus and ' x ' not in r[3] and float(r[4])<1e-20]
    if hits:
        r=min(hits,key=lambda r:float(r[4]));chosen.append({'identifier':r[1],'description':r[2],'species':r[3],'hmmerEvalue':r[4]})
def fetch(hit):
    result=resolve_sequence({**hit,'provider':'uniprot','kind':'protein_fasta'},str(out/'cache'))
    (out/(hit['identifier']+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    if result.get('status')!='resolved':return {**hit,'status':result.get('status'),'detail':result}
    fasta=result['fasta'];sequence=''.join(fasta.splitlines()[1:]).rstrip('*')
    (out/(hit['identifier']+'.fasta')).write_text(fasta,encoding='utf-8')
    return {**hit,'status':'resolved','length':len(sequence),'QALGGHmotifs':sequence.count('QALGGH'),'sha256':hashlib.sha256(fasta.encode()).hexdigest(),'provenance':result['provenance']}
with ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(fetch,chosen))
(out/'retrieval-summary.json').write_text(json.dumps({'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'selection':'Original 19 genera; lowest displayed HMMER E-value <1e-20 per genus; 150-400 aa; two QALGGH motifs','results':results},ensure_ascii=False,indent=2),encoding='utf-8')
valid=[r for r in results if r['status']=='resolved' and 150<=r['length']<=400 and r['QALGGHmotifs']==2]
fasta=json.loads((root/'primary-spec.json').read_text(encoding='utf-8'))['inputs']['protein']['value']
for r in valid:
    sequence=''.join((out/(r['identifier']+'.fasta')).read_text().splitlines()[1:]).rstrip('*')
    fasta+='>'+r['species'].replace(' ','_')+'_'+r['identifier']+'\n'+sequence+'\n'
(out/'homologs.fasta').write_text(fasta,encoding='utf-8')
print(json.dumps({'selected':len(chosen),'downloaded':sum(r['status']=='resolved' for r in results),'included':len(valid)+1,'output':str(out)},ensure_ascii=False))
