"""Portable analysis results and acceptance list. Does not create a Word/PDF report."""
from pathlib import Path
from html import escape
from urllib.parse import quote
import json,hashlib,shutil,csv,sys
sys.stdout.reconfigure(encoding='utf-8')
REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'runs/cca0737s0009-rerun-20261021'
TASK=REPO/'runs/cca0737s0009-26items-20261019/tasks/wf-1792549945863-fd7989'
IQ=REPO/'runs/cca0737s0009-26items-20261019/tasks/wf-1792551888413-1b3965/nodes/iqtree/attempt-2/08_tree'
OUT=ROOT/'results';OUT.mkdir(exist_ok=True)
read=lambda p:json.loads(p.read_text(encoding='utf-8'))
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
session=read(TASK/'session.json');nodes={n['id']:n for n in session['nodes']};validation=read(ROOT/'analysis/validation.json')
expected=read(ROOT/'run.json')['expected']
BLOCKED={
 'psi_blast':'原作业 DG95B23P016 返回 CPU usage limit exceeded；没有有效结果，不能解释为无命中，也未开展后续迭代。',
 'psipred':'提交点击发生超时，未取得作业编号；原临时标签页在 Chrome 关闭后丢失。无法确认提交是否成功，未盲目重复提交。',
 'string':'原站返回 Unknown organism: Carya cathayensis。未替换物种或使用代理物种冒充目标结果。',
}
for src,dest in [(ROOT/'analysis',OUT/'data'),(ROOT/'official-results',OUT/'official'),(ROOT/'attachments',OUT/'attachments'),(ROOT/'figures',OUT/'figures'),(ROOT/'alignment',OUT/'alignment'),(ROOT/'homologs',OUT/'homologs'),(IQ,OUT/'iqtree'),(TASK/'00_input',OUT/'input')]:
 shutil.copytree(src,dest,dirs_exist_ok=True)
shutil.copy2(ROOT/'input-verification.json',OUT/'input-verification.json')
shutil.copy2(ROOT/'continuation.jsonl',OUT/'continuation.jsonl')
musite=OUT/'attachments/musite';musite.mkdir(exist_ok=True);shutil.copy2(TASK/'nodes/musite/downloads.tmp/MusiteDeepResult.zip',musite/'MusiteDeepResult.zip')

CSS='''body{font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif;color:#172d38;background:#f4f7f8;margin:0}main{max-width:1220px;margin:24px auto;padding:28px;background:white;border-radius:12px}h1{font-size:26px}h2{font-size:20px;margin-top:32px}a{color:#087d80;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #cedadd;padding:9px;text-align:left;vertical-align:top}th{background:#eaf2f2}pre{white-space:pre-wrap;word-break:break-word;background:#f0f4f5;padding:16px;font-size:13px}img{max-width:100%;height:auto}.note{padding:12px 18px;background:#eef5f5;border-left:4px solid #087d80}.blocked{background:#fff2e1}.muted{color:#536873}nav{display:flex;gap:22px;flex-wrap:wrap}.wide{overflow:auto}.portrait-rotate{position:relative;width:100%;aspect-ratio:4958/3508;overflow:hidden}.portrait-rotate img{position:absolute;width:70.754%;max-width:none;top:0;left:0;transform:rotate(90deg) translateY(-100%);transform-origin:top left}details{margin:18px 0}code{word-break:break-all}'''
def page(title,body):
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><title>'+escape(title)+'</title><style>'+CSS+'</style><main>'+body+'</main></html>'
def table(headers,rows):
 return '<div class="wide"><table><thead><tr>'+''.join('<th>'+escape(str(x))+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+escape(str(x))+'</td>' for x in row)+'</tr>' for row in rows)+'</tbody></table></div>'
def link(path,label):return '<a href="'+quote(path,safe='/')+'">'+escape(label)+'</a>'
def figure(path,rotate=False):
 value='<img src="'+quote(path,safe='/')+'" alt="本轮分析图件">'
 return '<div class="portrait-rotate">'+value+'</div>' if rotate else value
def raw_summary(data):return '<pre>'+escape(json.dumps(data,ensure_ascii=False,indent=2))+'</pre>'
results=[]
for exp in expected:
 node=exp['id'];name=exp['name'];native=nodes.get(node,{});issue=BLOCKED.get(node)
 verified=not issue and (validation.get(node,{}).get('verified') or native.get('status')=='succeeded' and native.get('evidence',{}).get('verified'))
 assert verified or issue,'Missing independent analysis verification: '+node
 itemdir=OUT/'items'/node;itemdir.mkdir(parents=True,exist_ok=True)
 body='<nav>'+link('../../index.html','全部结果')+link('../../acceptance.tsv','逐项清单')+'</nav><h1>'+escape(name)+'</h1>'
 body+='<p class="note'+(' blocked' if issue else '')+'">'+escape(issue or '本轮分析数据已核验。以下为静态存档；动态交互请打开原站入口。')+'</p>'
 provenance={'taskId':session['id'],'itemId':node,'analysis':'blocked' if issue else 'verified','evidence':validation.get(node) or native.get('evidence'),'nativeStatus':native.get('status')}
 source=native.get('resultUrl') or native.get('evidence',{}).get('url');archive_status='not_applicable';archive=None
 candidate=ROOT/'observations'/node/'archive-result.json'
 if candidate.exists():
  capture=read(candidate);archive_meta=capture['archive'];source=archive_meta.get('sourceUrl') or source
  arc=next((a for a in capture['artifacts'] if a['path'].endswith('/archive.json')),None)
  if arc:archive=TASK/Path(arc['path']).parent
 else:
  arc=next((a for a in native.get('artifacts',[]) if a['path'].endswith('/archive.json')),None)
  if arc:archive=TASK/Path(arc['path']).parent;archive_meta=read(archive/'archive.json')
 if archive:
  shutil.copytree(archive,itemdir/'original-page',dirs_exist_ok=True);archive_status=archive_meta['status'];provenance['originalArchive']=archive_meta
 if source:body+='<p><a href="'+escape(source,quote=True)+'" target="_blank" rel="noopener">原站入口／原作业</a></p>'
 native_result=next((a for a in native.get('artifacts',[]) if a['path'].endswith('/results/result.json')),None)
 if native_result:
  original=TASK/native_result['path'];assert digest(original)==native_result['sha256'];shutil.copy2(original,itemdir/'native-result.json');d=read(original)
  if d.get('tables'):
   for rows in d['tables']:
    if rows and len(rows)>1 and len(rows)<1000:body+=table(rows[0],rows[1:])
  elif d.get('data'):body+=raw_summary(d['data'])
 if node in ['blastp','blastn']:
  d=read(ROOT/'analysis'/f'{node}.json');body+='<h2>命中概览</h2><p>官方 XML 共 '+str(len(d['hits']))+' 条命中；下列展示前 20 条。</p>'+table(['登录号','描述','长度','E-value','Bit score'],[[h['accession'],h['description'],h['length'],h['evalue'],h['bitScore']] for h in d['hits'][:20]])
 elif node=='interpro':
  d=read(ROOT/'analysis/interpro.json');body+='<h2>结构域与家族匹配</h2>'+table(['数据库','签名','InterPro','位置（aa）'],[[m['library'],m['signature'],m['interpro'] or '',', '.join(str(l['start'])+'–'+str(l['end']) for l in m['locations'])] for m in d['matches']])
 elif node=='musite':
  d=read(ROOT/'analysis/musite.json');body+='<p>阈值 0.5；预测事件 '+str(len(d['predictions']))+' 个。预测不等同于实验确认。</p>'+table(['位点','残基','类型','分数'],[[v['position'],v['residue'],v['type'],v['score']] for v in d['predictions']])
 elif node=='prankweb':
  d=read(ROOT/'analysis/prankweb.json');body+='<p>候选口袋来自本轮 SWISS-MODEL 模型 01；概率较低，不能据此确认配体结合。</p>'+table(['口袋','分数','概率','残基'],[[p['name'],p['score'],p['probability'],', '.join(p['residues'])] for p in d['pockets']])
 elif node=='go_annotation':body+=raw_summary(read(ROOT/'analysis/go-annotation.json'))
 elif node=='quickgo':body+=raw_summary(read(ROOT/'analysis/quickgo.json'))
 elif node=='homologs':
  d=read(ROOT/'homologs/retrieval-summary.json');body+='<p>目标序列 + 19 个属各一条同源序列；全部来自本轮 HMMER 和新 UniProt 下载。</p>'+table(['物种','登录号','长度','E-value','QALGGH 数'],[[s['species'],s['identifier'],s['length'],s['hmmerEvalue'],s['QALGGHmotifs']] for s in d['results']])
 elif node=='mafft':body+='<p>L-INS-i；20 条序列，308 列；逐条去除 gap 后与本轮输入一致。</p><pre>'+escape((ROOT/'alignment/alignment.fasta').read_text())+'</pre>'
 elif node=='espript':body+=figure('../../attachments/espript/0-0-1792659708-esp.300.png',True)
 elif node=='weblogo':body+=figure('../../figures/weblogo.svg')
 elif node in ['iqtree','tree_layout']:body+=figure('../../figures/phylogeny.svg')
 if archive and node not in ['mafft','espript']:
  body+='<h2>原页面静态图像</h2>'
  for image in archive_meta.get('images',[]):
   if (archive/image['name']).is_file():body+=figure('original-page/'+image['name'])
  if (itemdir/'original-page/page.html').exists():body+='<p>'+link('original-page/page.html','打开原 HTML 归档'+('（完整性检查仍有缺口）' if archive_status!='complete' else ''))+'</p>'
 paths=[]
 mappings={'go_annotation':'go-annotation','tree_layout':'phylogeny'}
 data=OUT/'data'/(mappings.get(node,node)+'.json')
 if data.exists():paths.append(data)
 if (OUT/'attachments'/node).exists():paths.extend(p for p in (OUT/'attachments'/node).rglob('*') if p.is_file())
 if node in ['blastp','blastn']:paths.append(OUT/'official'/f'{node}.xml')
 if node=='interpro':paths.append(OUT/'official/interpro-result.json')
 if node=='prankweb':paths.extend([OUT/'official/prankweb-prediction.json',OUT/'official/prankweb-structure.pdb'])
 if node=='quickgo':paths.append(OUT/'official/quickgo-GO0003700.json')
 if node=='hmmer':paths.extend([OUT/'official/hmmer-search.json',OUT/'official/hmmer-score.json'])
 if node=='homologs':paths.extend([OUT/'homologs/homologs.fasta',OUT/'homologs/retrieval-summary.json'])
 if node in ['mafft','espript','weblogo']:paths.extend([OUT/'alignment/alignment.fasta',OUT/'alignment/alignment.aln'])
 if node=='weblogo':paths.extend([OUT/'figures/weblogo.svg',OUT/'figures/weblogo.png'])
 if node in ['iqtree','tree_layout']:paths.extend([OUT/'iqtree/iqtree_work/tree.treefile',OUT/'iqtree/iqtree_work/tree.iqtree',OUT/'iqtree/iqtree_work/run_log.txt',OUT/'figures/phylogeny.svg',OUT/'figures/phylogeny.png'])
 body+='<h2>数据与原始附件</h2><ul>'+''.join('<li>'+link('../../'+p.relative_to(OUT).as_posix(),p.name)+' · '+str(p.stat().st_size)+' bytes</li>' for p in paths if p.is_file())+'</ul>'
 body+='<details><summary>本轮校验证据</summary>'+raw_summary(provenance.get('evidence') or {'status':'blocked','reason':issue})+'</details>'
 (itemdir/'index.html').write_text(page(name,body),encoding='utf-8')
 (itemdir/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),encoding='utf-8')
 results.append({'id':node,'name':name,'analysis':'blocked' if issue else 'verified','originalArchive':archive_status,'presentation':'static','files':len(paths),'issue':issue or '', 'page':'items/'+node+'/index.html','sourceUrl':source})
body='<h1>CCA0737S0009 · 本轮分析结果</h1><p>山核桃 Carya cathayensis · CDS 783 nt · 蛋白 260 aa · 2026-10-21 至 2026-10-22</p><p class="note">23 项取得有效分析结果并完成数据核验；3 项未取得有效结果。报告按要求暂缓。网页原始归档的显示完整性单列，不能用数据通过替代网页验收。</p>'
body+='<p>'+link('acceptance.tsv','下载逐项清单')+' · '+link('data/validation.json','独立数据验证')+' · '+link('input-verification.json','输入序列指纹')+'</p>'
body+='<table><thead><tr><th>项目</th><th>分析数据</th><th>原网页归档</th><th>缺口</th></tr></thead><tbody>'
for r in results:body+='<tr><td>'+link(r['page'],r['name'])+'</td><td>'+('通过' if r['analysis']=='verified' else '受阻')+'</td><td>'+escape(r['originalArchive'])+'</td><td>'+escape(r['issue'])+'</td></tr>'
body+='</tbody></table><p class="muted">结果页为静态展示，保留官方图件、结构及数据文件；动态交互通过各项目原站入口使用。所有新结果均保留本轮输入与提交记录。</p>'
(OUT/'index.html').write_text(page('CCA0737S0009 本轮分析结果',body),encoding='utf-8')
(OUT/'acceptance.json').write_text(json.dumps({'taskId':session['id'],'verifiedAnalyses':sum(r['analysis']=='verified' for r in results),'blockedAnalyses':sum(r['analysis']=='blocked' for r in results),'report':'deferred_by_user','items':results},ensure_ascii=False,indent=2),encoding='utf-8')
with (OUT/'acceptance.tsv').open('w',encoding='utf-8-sig',newline='') as f:
 writer=csv.DictWriter(f,fieldnames=list(results[0]),delimiter='\t');writer.writeheader();writer.writerows(results)
manifest=[{'path':p.relative_to(OUT).as_posix(),'bytes':p.stat().st_size,'sha256':digest(p)} for p in OUT.rglob('*') if p.is_file() and p.name!='manifest.json']
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
assert len(results)==26 and sum(r['analysis']=='verified' for r in results)==23
print(json.dumps({'output':str(OUT),'verified':23,'blocked':3,'files':len(manifest),'bytes':sum(r['bytes'] for r in manifest)},ensure_ascii=False))
