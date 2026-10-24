#!/usr/bin/env node
'use strict'
// Recover delivery records from the existing evidence only. No website execution,
// no rewritten execution history, no generated substitute for an original page.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { configuration, runtimePaths } = require('../apps/bioinformatics-hub-desktop/workflow/runtime.cjs')
const { createWorkflowCore } = require('../apps/bioinformatics-hub-desktop/workflow/core.cjs')
const { extendCore } = require('../apps/bioinformatics-hub-desktop/workflow/operations.cjs')
const { roleOf } = require('../apps/bioinformatics-hub-desktop/workflow/delivery.cjs')
const repo = path.resolve(__dirname, '..')
const root = path.join(repo, 'runs/cca0737s0009-26items-20261019')
const task = 'wf-1792415681013-f2bb07'
const config = configuration({ ...process.env, BIOHUB_HOME: path.join(repo, 'runs/.biohub'), BIOINFORMATICS_HUB_RUNS: path.join(root, 'tasks') })
const core = createWorkflowCore({ paths: runtimePaths(config), dataDir: config.dataDir }); extendCore(core)
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sessionBefore = digest(path.join(root, 'tasks', task, 'session.json'))
const protein = core.read(task).input.protein.sha256, nucleotide = core.read(task).input.nucleotide.sha256
const expected = [
 ['orf_finder','NCBI ORF Finder'], ['dna_stats','SMS DNA Stats'], ['codon_usage','SMS Codon Usage'], ['blastn','NCBI BLASTn'],
 ['protparam','ExPASy ProtParam'], ['protscale','ExPASy ProtScale'], ['tmhmm','DTU TMHMM 2.0'], ['signalp','DTU SignalP 6.0'],
 ['interpro','InterProScan'], ['psipred','PSIPRED'], ['swiss_model','SWISS-MODEL'], ['plant_mploc','Plant-mPLoc'], ['musite','MusiteDeep'],
 ['string','STRING'], ['go_annotation','InterPro / PANTHER GO'], ['quickgo','QuickGO'], ['prankweb','PrankWeb / P2Rank'],
 ['blastp','NCBI BLASTp'], ['psi_blast','PSI-BLAST'], ['hmmer','HMMER phmmer'], ['homologs','同源筛选与 FASTA 整理'],
 ['mafft','MAFFT'], ['espript','ESPript'], ['weblogo','WebLogo'], ['iqtree','IQ-TREE 2.3.6'], ['tree_layout','树图排版与美化'],
].map(([id,name],i)=>({id,name:`${String(i+1).padStart(2,'0')} · ${name}`}))
const read = file => JSON.parse(fs.readFileSync(path.join(root,file),'utf8'))
function files(names) {
 return names.filter(name=>fs.existsSync(path.join(root,name))).map(name=>({path:path.join(root,name),relativePath:name.startsWith('manual-results/')?name.split('/').slice(2).join('/'):name,sha256:digest(path.join(root,name))}))
}
function folder(dir) { const base=path.join(root,dir);return fs.existsSync(base)?fs.readdirSync(base,{withFileTypes:true}).flatMap(d=>d.isDirectory()?folder(dir+'/'+d.name):[dir+'/'+d.name]):[] }
function recovered(id) { try { return read('recovered-pages/'+id+'/verification.json').status==='saved'?folder('recovered-pages/'+id+'/webpage'):[] } catch { return [] } }
async function add(id,names,url,message,extra={}) {
 return core.call('resultsRegister',{id:task,itemId:id,name:expected.find(e=>e.id===id)?.name||id,kind:['homologs','iqtree','tree_layout'].includes(id)?'local':'website',
  sourceUrl:url,inputSha256:id==='quickgo'?core.read(task).input.go.sha256:['dna_stats','codon_usage','blastn'].includes(id)?nucleotide:protein,files:files(names),message,...extra})
}
async function main() {
 const page=(id,name)=>`manual-results/${id}/${name}.html`
 const meta=(id,name)=>{try{return read(`manual-results/${id}/${name}.json`).url}catch{return undefined}}
 await add('dna_stats',[page('dna_stats','popup-1')],meta('dna_stats','popup-1'),'原站 POST 结果弹窗已保存；历史归档完整性待复核。')
 await add('codon_usage',[page('codon_usage','popup-1')],meta('codon_usage','popup-1'),'原站 POST 结果弹窗已保存；历史归档完整性待复核。')
 await add('blastn',[page('blastn_clean','current'),'manual-results/blastn_clean/current.png','output/results-package/evidence/blastn_clean/results.xml'],'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=DC7RS3XF014','保留已确认的 BLASTn 结果；错误输入尝试未登记为成果。')
 await add('protparam',[page('protparam','result'),'manual-results/protparam/result.png'],meta('protparam','result'),'补登记原站结果页面及截图。')
 await add('protscale',[page('protscale','result'),...folder('manual-results/protscale').filter(f=>/\.(gif|ps|txt|png)$/.test(f)&&!f.includes('before-submit')&&!f.includes('/form.'))],meta('protscale','result'),'原站曲线和原始坐标保留；未以派生图替换网页。')
 await add('tmhmm',['output/results-package/evidence/tmhmm/result.txt',...recovered('tmhmm')],'https://services.healthtech.dtu.dk/cgi-bin/webface2.cgi?jobid=6AD61864001EE2284D0CC522&wait=20',recovered('tmhmm').length?'通过已有作业 URL 只读补存原站 HTML、资源和截图；未重新提交。':'历史证据只有文字结果，缺少原始 HTML；未重新提交网站任务。')
 await add('signalp',[page('signalp','current'),'manual-results/signalp/current.png'],meta('signalp','current'),'补登记原站结果页面；原生节点的导航失败记录保留。')
 const prior = read('support/reused-interpro-verification.json')
 const priorFiles=prior.artifacts.map(a=>{const p=process.platform==='win32'?require('../apps/bioinformatics-hub-desktop/workflow/windows.cjs').windowsPath(a.path):a.path;return {path:p,sha256:a.sha256,relativePath:a.path.split('/results/')[1]}})
 await add('interpro',[],prior.resultUrl,'复用同序列历史任务的原站网页与资源；逐文件复核哈希，保留核验来源。',{files:priorFiles})
 await add('psipred',[],undefined,'原提交状态不确定，未取得可核实作业编号与结果；未重复提交。')
 await add('swiss_model',[page('swiss_model','validated'),'manual-results/swiss_model/validated.png','structure/01.pdb','structure/01.cif','structure/01-report.html'],meta('swiss_model','validated'),'补登记原站模型页面、官方质量报告和结构文件。')
 await add('plant_mploc',['output/results-package/evidence/plant_mploc/result.txt'],'http://www.csbio.sjtu.edu.cn/cgi-bin/PlantmPLoc.cgi','历史证据只有文字结果，缺少原始 POST HTML；未重复提交。')
 await add('musite',[page('musite','completed'),'manual-results/musite/completed.png','output/results-package/evidence/musite/MusiteDeepResult.zip','output/results-package/evidence/musite/Prediction_results.txt'],meta('musite','completed'),'补登记原站页面与预测下载；页面图表仍须独立核验。')
 await add('string',['output/results-package/evidence/string/result.txt'],'https://string-db.org/','目标物种未被网站支持；没有该物种的有效网络网页，代理结果不得冒充目标物种结果。')
 await add('go_annotation',['support/interpro-domains.tsv'],prior.resultUrl,'GO 来源为已有 InterPro 注释；没有独立的 PANTHER 原站 HTML。')
 await add('quickgo',recovered('quickgo'),'https://www.ebi.ac.uk/QuickGO/term/GO:0003700',recovered('quickgo').length?'通过原站术语 URL 只读补存 HTML、资源和截图；原始历史 JSON 仍在内部保留。':'历史只保存官方 JSON，未保存术语页面；内部 JSON 未当作网页交付。')
 await add('prankweb',[page('prankweb','current'),'manual-results/prankweb/current.png','pockets/structure.pdb'],meta('prankweb','current'),'补登记原站口袋结果页面；WebGL 离线交互仍受限制。')
 await add('blastp',[page('blastp','current'),'manual-results/blastp/current.png','output/results-package/evidence/blastp/results.xml'],'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=DC6JZNJC016','补登记原站 BLASTp 结果与原始 XML。')
 await add('psi_blast',[page('psi_blast','round1-complete'),'manual-results/psi_blast/round1-complete.png','output/results-package/evidence/psi_blast/round1.xml'],'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=DC73C8YT014','仅第 1 轮有结果；第 2 轮网站 HTTP 500，未验证收敛。')
 await add('homologs',folder('homologs').filter(f=>/\.(fasta|tsv)$/.test(f)),undefined,'本地序列整理，无独立网页。')
 await add('mafft',[page('mafft','current'),'manual-results/mafft/current.png','alignment/alignment.fasta','alignment/alignment.aln'],meta('mafft','current'),'保留原服务器页面与比对文件。')
 await add('espript',[page('espript','results'),'figures/alignment-espript.pdf','figures/alignment-espript-300dpi.png'],'https://espript.ibcp.fr/ESPript/temp/1382498940/results-1792418395.html','保留原站结果页及官方图件。')
 await add('weblogo',[page('weblogo','current'),'manual-downloads/weblogo/logo.svg'],'https://weblogo.threeplusone.com/create.cgi','官方 SVG 已保存；历史页面可能仍为输入表单，不能据此认定原站结果页面完整。')
 const treeTask='wf-1792417240569-9dfd3c',tree=core.read(treeTask),node=tree.nodes[0]
 await add('iqtree',[],undefined,'独立本地 IQ-TREE 原生任务已完成；通过原始输入指纹和文件哈希关联。',{
  inputSha256:tree.input.alignment.sha256,sourceTaskId:treeTask,sourceNodeId:node.id,
  files:node.artifacts.map(a=>({path:path.join(core.runDir(treeTask),a.path),relativePath:a.path,sha256:a.sha256,role:roleOf(a)}))})
 await add('tree_layout',['figures/phylogeny.svg','figures/phylogeny.pdf','figures/phylogeny.png'],undefined,'本地 Matplotlib 排版图，保留为本地产物，不标为分析网站原页面。')
 const reportFiles=files(['output/CCA0737S0009-analysis-report.docx',...folder('output/pdf').filter(f=>f.endsWith('.pdf'))])
 if(reportFiles.length) await core.call('resultsRegister',{id:task,itemId:'report',name:'外部报告附件',kind:'attachment',files:reportFiles,message:'既有外部报告，应用未生成或改写科学解读。'})
 const result=await core.call('resultsFinalize',{id:task,expected,open:process.argv.includes('--open')})
 const exported=await core.call('export',{id:task})
 if(sessionBefore!==digest(path.join(root,'tasks',task,'session.json')))throw new Error('Original execution state changed')
 console.log(JSON.stringify({id:task,recorded:result.delivery.recorded,expected:result.delivery.expected,status:result.delivery.status,originalExecutionUnchanged:true,
  savedHtml:result.results.flatMap(r=>r.artifacts).filter(a=>a.role==='page'&&/\.html?$/.test(a.path)).length,opened:result.opened,exported:exported.path}))
}
main().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>core.shutdown())
