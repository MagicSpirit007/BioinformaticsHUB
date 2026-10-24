"""Independent parsing and input association for this study's fresh results."""
from pathlib import Path
from collections import Counter
from xml.etree import ElementTree as ET
import json,hashlib,zipfile,csv,io,shutil,re,sys
from Bio import SeqIO,Phylo
from Bio.Seq import Seq
sys.stdout.reconfigure(encoding='utf-8')
REPO=Path(__file__).resolve().parents[1]
ROOT=REPO/'runs/cca0737s0009-rerun-20261021'
TASK=REPO/'runs/cca0737s0009-26items-20261019/tasks/wf-1792549945863-fd7989'
OUT=ROOT/'analysis';OUT.mkdir(exist_ok=True)
spec=json.loads((ROOT/'primary-spec.json').read_text(encoding='utf-8'))
seq={k:''.join(v['value'].splitlines()[1:]).strip() for k,v in spec['inputs'].items()}
assert len(seq['protein'])==260 and len(seq['nucleotide'])==783
assert str(Seq(seq['nucleotide']).translate()).rstrip('*')==seq['protein']
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
save=lambda n,v:(OUT/n).write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
checks={}

# InterProScan includes the complete submitted sequence and MD5, unlike a screenshot.
source=ROOT/'official-results/interpro-result.json';j=json.loads(source.read_text());assert len(j['results'])==1
p=j['results'][0];assert p['sequence']==seq['protein'];assert p['md5'].lower()==hashlib.md5(seq['protein'].encode()).hexdigest()
domains=[];go={}
for m in p['matches']:
 s=m['signature'];entry=s.get('entry') or {}
 locations=[{'start':v['start'],'end':v['end']} for v in m['locations']]
 assert all(1<=v['start']<=v['end']<=260 for v in locations)
 domains.append({'signature':s['accession'],'library':s['signatureLibraryRelease']['library'],'name':s.get('description') or s.get('name'),'interpro':entry.get('accession'),'locations':locations})
 for term in entry.get('goXRefs',[]):
  go.setdefault(term['id'],{**term,'supportingInterPro':[]})['supportingInterPro'].append(entry['accession'])
save('interpro.json',{'jobId':'iprscan6-R20261021-040143-0493-30971739-p2m','sourceSha256':sha(source),'sequenceMatches':True,'interproVersion':j['interpro-version'],'interproscanVersion':j['interproscan-version'],'matches':domains})
assert go
save('go-annotation.json',{'source':'This run InterProScan 6; computational annotation, not experimental validation','sourceSha256':sha(source),'sequenceMatches':True,'terms':list(go.values())})
with (OUT/'go-annotation.tsv').open('w',encoding='utf-8',newline='') as f:
 w=csv.writer(f,delimiter='\t');w.writerow(['gene','GO','name','category','supporting_InterPro','evidence'])
 for t in go.values():w.writerow(['CCA0737S0009',t['id'],t['name'],t['category'],','.join(t['supportingInterPro']),'InterProScan computational inference'])
checks['interpro']={'verified':True,'matches':len(domains),'sequenceLength':260,'sourceSha256':sha(source)}
checks['go_annotation']={'verified':True,'terms':list(go),'derivedFromThisRun':True}
q=json.loads((ROOT/'official-results/quickgo-GO0003700.json').read_text());term=q['results'][0]
assert term['id']=='GO:0003700' and term['id'] in go and not term.get('isObsolete')
assert term['name']==go[term['id']]['name']
save('quickgo.json',{'id':term['id'],'name':term['name'],'aspect':term['aspect'],'definition':term['definition'],'sourceSha256':sha(ROOT/'official-results/quickgo-GO0003700.json'),'annotationSource':'go-annotation.json'})
checks['quickgo']={'verified':True,'termMatchesThisRun':True}

# BLAST IDs, database, query length and every returned HSP query segment.
for node,key,db in [('blastn','nucleotide','core_nt'),('blastp','protein','clustered_nr')]:
 source=ROOT/'official-results'/f'{node}.xml';root=ET.parse(source).getroot()
 assert root.findtext('BlastOutput_program')==node
 assert root.findtext('BlastOutput_query-def')=='CCA0737S0009'
 assert int(root.findtext('BlastOutput_query-len'))==len(seq[key])
 assert root.findtext('BlastOutput_db')==db
 rows=[];segments=0
 for hit in root.findall('.//Hit'):
  hsps=hit.findall('./Hit_hsps/Hsp');best=min(hsps,key=lambda h:float(h.findtext('Hsp_evalue')))
  for h in hsps:
   a,z=int(h.findtext('Hsp_query-from')),int(h.findtext('Hsp_query-to'))
   expected=seq[key][min(a,z)-1:max(a,z)]
   if a>z:expected=str(Seq(expected).reverse_complement())
   actual=h.findtext('Hsp_qseq').replace('-','').upper()
   assert len(actual)==len(expected)
   assert all(x==y or x in ('XN' if key=='nucleotide' else 'X') for x,y in zip(actual,expected))
   segments+=1
  rows.append({'accession':hit.findtext('Hit_accession'),'description':hit.findtext('Hit_def'),'length':int(hit.findtext('Hit_len')),'evalue':float(best.findtext('Hsp_evalue')),'bitScore':float(best.findtext('Hsp_bit-score')),'identities':int(best.findtext('Hsp_identity')),'alignmentLength':int(best.findtext('Hsp_align-len'))})
 assert rows
 save(node+'.json',{'database':db,'queryLength':len(seq[key]),'sourceSha256':sha(source),'querySegmentsChecked':segments,'hits':rows})
 checks[node]={'verified':True,'hits':len(rows),'querySegmentsChecked':segments,'sourceSha256':sha(source)}

# Musite: CRC, all predicted residue identities, supported residues, score ranges, cutoff.
source=TASK/'nodes/musite/downloads.tmp/MusiteDeepResult.zip'
with zipfile.ZipFile(source) as z:
 assert z.testzip() is None
 text=z.read('Prediction_results.txt').decode('utf-8')
assert text.splitlines()[1]=='>CCA0737S0009'
rows=list(csv.DictReader([l for l in text.splitlines() if not l.startswith('>')],delimiter='\t'))
counts=Counter();above=[];positions=set();types=set()
for row in rows:
 pos=int(row['Position']);assert row['ID']=='CCA0737S0009' and seq['protein'][pos-1]==row['Residue'];assert pos not in positions;positions.add(pos)
 scores={n:float(s) for n,s in (v.split(':') for v in row['PTMscores'].split(';'))}
 assert all(0<=s<=1 for s in scores.values());types.update(scores)
 accepted={} if row['Cutoff=0.5']=='None' else {n:float(s) for n,s in (v.split(':') for v in row['Cutoff=0.5'].split('|'))}
 assert accepted=={n:s for n,s in scores.items() if s>.5}
 for name,score in accepted.items():counts[name]+=1;above.append({'position':pos,'residue':row['Residue'],'type':name,'score':score})
assert positions=={i+1 for i,a in enumerate(seq['protein']) if a in 'STYNKRCQP'}
(OUT/'musite-predictions.txt').write_text(text,encoding='utf-8')
save('musite.json',{'jobId':'2026-10-21T02:50:08.524Z','sourceSha256':sha(source),'positionsValidated':len(positions),'types':sorted(types),'cutoff':.5,'aboveThresholdCounts':dict(counts),'predictions':above,'note':'Predicted PTM sites; not experimental observations.'})
checks['musite']={'verified':True,'positionsValidated':len(positions),'predictedEventsAboveCutoff':len(above),'sourceSha256':sha(source)}

# PrankWeb: returned model must be byte-identical to this run's selected SWISS model.
source=ROOT/'official-results/prankweb-prediction.json';j=json.loads(source.read_text())
assert ''.join(j['structure']['sequence'])==seq['protein']
assert sha(ROOT/'official-results/prankweb-structure.pdb')==sha(ROOT/'attachments/swiss_model/01.pdb')
for pocket in j['pockets']:
 assert 0<=float(pocket['probability'])<=1
 assert all(p in j['structure']['indices'] for p in pocket['residues'])
save('prankweb.json',{'sequenceMatches':True,'modelSha256':sha(ROOT/'attachments/swiss_model/01.pdb'),'sourceSha256':sha(source),'pockets':j['pockets'],'note':'Candidate pockets from predicted structure; low probabilities do not establish ligand binding.'})
checks['prankweb']={'verified':True,'pockets':len(j['pockets']),'modelMatchesThisRun':True}

# Alignment/tree link: compare every sequence, terminal ID and support range.
aligned=list(SeqIO.parse(ROOT/'alignment/alignment.fasta','fasta'));homologs=list(SeqIO.parse(ROOT/'homologs/homologs.fasta','fasta'))
assert Counter(str(r.seq).replace('-','') for r in aligned)==Counter(str(r.seq) for r in homologs)
assert len(aligned)==20 and {len(r.seq) for r in aligned}=={308}
iq=REPO/'runs/cca0737s0009-26items-20261019/tasks/wf-1792551888413-1b3965/nodes/iqtree/attempt-2/08_tree'
clean=list(SeqIO.parse(iq/'iqtree_work/alignment_iqtree.fasta','fasta'))
assert Counter(str(r.seq) for r in clean)==Counter(str(r.seq) for r in aligned)
tree=Phylo.read(iq/'iqtree_work/tree.treefile','newick')
assert {x.name for x in tree.get_terminals()}=={r.id for r in clean}
assert all(c.confidence is None or 0<=c.confidence<=100 for c in tree.find_clades())
assert '-seed 36491' in (iq/'iqtree_work/run_log.txt').read_text()
checks['homologs']={'verified':True,'sequences':20,'source':'Fresh HMMER hits and fresh UniProt retrieval','sha256':sha(ROOT/'homologs/homologs.fasta')}
search=json.loads((ROOT/'official-results/hmmer-search.json').read_text())
assert search['task']['status']=='SUCCESS' and search['database']['id']=='refprot'
assert ''.join(search['input'].splitlines()[1:])==seq['protein']
hits=json.loads((ROOT/'official-results/hmmer-score.json').read_text())['result']['hits']
by_acc={h['metadata']['accession']:h for h in hits}
selected=json.loads((ROOT/'homologs/retrieval-summary.json').read_text())['results']
for s in selected:
 h=by_acc[s['identifier']];assert h['metadata']['species']==s['species'] and h['evalue']<1e-20
 genus=s['species'].split()[0]
 candidates=[v for v in hits if v['metadata']['species'].split()[0]==genus and ' x ' not in v['metadata']['species']]
 assert h['evalue']==min(v['evalue'] for v in candidates)
with (ROOT/'attachments/hmmer/result.tsv').open(encoding='utf-8') as f:
 rows=list(csv.DictReader(f,delimiter='\t'))
assert all(r['Query Name']=='CCA0737S0009' and r['Query Length']=='260' for r in rows)
assert {s['identifier'] for s in selected}.issubset({r['Target Accession'] for r in rows})
checks['hmmer']={'verified':True,'database':search['database'],'inputSequenceMatches':True,'reportedHits':search['number_of_hits'],'officialTsvRows':len(rows),'sourceSha256':sha(ROOT/'official-results/hmmer-search.json')}
checks['homologs']['selectedHitsCheckedAgainstOfficialData']=19
checks['homologs']['officialSourceSha256']=sha(ROOT/'official-results/hmmer-score.json')
checks['mafft']={'verified':True,'sequences':20,'columns':308,'ungappedSequencesMatch':True,'sha256':sha(ROOT/'alignment/alignment.fasta')}
checks['iqtree']={'verified':True,'tips':20,'alignmentMatchesThisRun':True,'sourceTreeSha256':sha(iq/'iqtree_work/tree.treefile'),'seed':36491}

# The official WebLogo SVG must be complete, nonempty and self-contained.
source=TASK/'continuation/weblogo/downloads/logo.svg';svg=ET.parse(source).getroot()
assert svg.tag.endswith('svg') and len(svg.findall('.//{http://www.w3.org/2000/svg}path'))>100
assert not any(v.startswith(('https:','http:')) for e in svg.iter() for k,v in e.attrib.items() if k.endswith('href'))
out=ROOT/'figures';out.mkdir(exist_ok=True);shutil.copy2(source,out/'weblogo.svg')
checks['weblogo']={'verified':True,'format':'SVG','sha256':sha(source),'inputSha256':sha(ROOT/'alignment/alignment.fasta'),'association':'Recorded upload and download in the owned WebLogo context; original SVG is complete and self-contained.'}
# ESPript's exported server input, actual settings, image and PDF agree with this run.
from Bio import AlignIO
from PIL import Image
ep=ROOT/'attachments/espript'
es=AlignIO.read(ep/'server-input.aln','clustal')
assert Counter(str(r.seq) for r in es)==Counter(str(r.seq) for r in aligned)
frames=json.loads((ROOT/'observations/espript/output-frames.json').read_text(encoding='utf-8'))
log=next(f['text'] for f in frames if 'Total number of columns' in f['text'])
assert 'Total number of columns: 308' in log and 'Parameters: 0.20 0.50 B' in log and 'Parameters: 7 77 7 0 0 0 C L3' in log
for r in aligned:assert r.id in log
pdf=next(ep.glob('*.pdf'));data=pdf.read_bytes();assert data.startswith(b'%PDF-') and b'%%EOF' in data[-1024:]
png=next(ep.glob('*.png'))
with Image.open(png) as image: image.verify()
(OUT/'espript-log.txt').write_text(log,encoding='utf-8')
checks['espript']={'verified':True,'serverInputMatchesAlignment':True,'sequences':20,'columns':308,'parameters':{'matrix':'BLOSUM62','score':.2,'columnsPerLine':77,'fontSize':7,'paper':'A3 landscape'},'pdfSha256':sha(pdf),'pngSha256':sha(png),'serverInputSha256':sha(ep/'server-input.aln')}
tree_meta=ROOT/'figures/phylogeny-metadata.json'
if tree_meta.exists():
 meta=json.loads(tree_meta.read_text());assert meta['sourceSha256']==checks['iqtree']['sourceTreeSha256']
 assert all(meta[k] is False for k in ['rerooted','topologyChanged','branchLengthsChanged','supportValuesChanged'])
 checks['tree_layout']={'verified':True,'sourceTreeMatchesThisRun':True,'sourceTreeSha256':meta['sourceSha256'],'method':'Matplotlib; original topology, branches and supports retained'}
save('validation.json',checks)
print(json.dumps(checks,ensure_ascii=False))
