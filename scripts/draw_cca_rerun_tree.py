"""Render this rerun's original IQ-TREE topology without rerooting."""
from pathlib import Path
import json,hashlib
from Bio import Phylo
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
REPO=Path(__file__).resolve().parents[1]
ROOT=REPO/'runs/cca0737s0009-rerun-20261021'
iq=REPO/'runs/cca0737s0009-26items-20261019/tasks/wf-1792551888413-1b3965/nodes/iqtree/attempt-2/08_tree'
source=iq/'iqtree_work/tree.treefile';digest=hashlib.sha256(source.read_bytes()).hexdigest()
tree=Phylo.read(source,'newick');tips=tree.get_terminals();assert len(tips)==20
height={tip:len(tips)-i-1 for i,tip in enumerate(tips)}
def heights(c):
 if c not in height:height[c]=sum(heights(x) for x in c.clades)/len(c.clades)
 return height[c]
heights(tree.root);depths=tree.depths()
plt.rcParams.update({'font.family':'DejaVu Sans','svg.fonttype':'none','font.size':10})
fig,ax=plt.subplots(figsize=(12.5,8.4))
def draw(c,parent):
 x,y=depths[c],height[c];ax.plot([parent,x],[y,y],color='#3f4c59',lw=1.1)
 if c.is_terminal():
  if c.name=='CCA0737S0009':label='Carya cathayensis  (CCA0737S0009)';color='#a61b29'
  else:
   species,accession=c.name.rsplit('_',1);label=species.replace('_',' ')+'  ('+accession+')';color='#116466' if accession=='A0A8T1PWH2' else '#202a35'
  ax.text(x+.008,y,label,va='center',fontsize=9.3,color=color,fontweight='bold' if c.name=='CCA0737S0009' else 'normal')
 else:
  yy=[height[v] for v in c.clades];ax.plot([x,x],[min(yy),max(yy)],color='#3f4c59',lw=1.1)
  if c.confidence is not None:ax.text((parent+x)/2,y+.17,str(int(c.confidence)),ha='center',va='bottom',fontsize=7.5,color='#374151',bbox={'facecolor':'white','edgecolor':'none','pad':.1})
  for child in c.clades:draw(child,x)
draw(tree.root,0)
ax.set_xlim(-.008,max(depths[t] for t in tips)+.54);ax.set_ylim(-1.5,len(tips)+.4);ax.axis('off')
ax.plot([.02,.12],[-.8,-.8],color='#273444',lw=1.7)
ax.text(.07,-1.06,'0.1 substitutions/site',ha='center',va='top',fontsize=8.4)
model=json.loads((iq/'iqtree.json').read_text())['model']['best_fit_model'].split(': ',1)[1]
fig.suptitle('CCA0737S0009 and plant C2H2 zinc-finger homologs',x=.06,y=.977,ha='left',fontsize=15,fontweight='bold')
fig.text(.06,.942,f'IQ-TREE 2.3.6 | {model} | 1,000 UFBoot replicates | 20 proteins / 308 sites',fontsize=9.7,color='#435466')
fig.text(.06,.018,'Unrooted gene tree with its original arbitrary display root. Numbers: UFBoot support. Fresh run: 2026-10-21.',fontsize=8.5,color='#435466')
fig.subplots_adjust(top=.91,left=.06,right=.985,bottom=.07)
out=ROOT/'figures';out.mkdir(exist_ok=True)
for suffix in ['png','svg']:fig.savefig(out/('phylogeny.'+suffix),dpi=300)
plt.close(fig)
assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
(out/'phylogeny-metadata.json').write_text(json.dumps({'sourceTree':str(source),'sourceSha256':digest,'layout':'Matplotlib','tips':20,'rerooted':False,'topologyChanged':False,'branchLengthsChanged':False,'supportValuesChanged':False,'model':model},indent=2))
print('Tree figure saved; original topology, branches and supports retained.')
