#!/usr/bin/env node
'use strict'
// Opt-in real Chrome/JSONL/DAG recovery test. The policy endpoint is a local
// deterministic fixture; it never contacts a model provider or a public site.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname,'..')
const engine = process.env.WORKFLOW_ENGINE_ROOT || root
const { createSession, hash } = require('../apps/bioinformatics-hub-desktop/workflow/model.cjs')
const { RunStore } = require('../apps/bioinformatics-hub-desktop/workflow/store.cjs')
const { WorkflowScheduler } = require('../apps/bioinformatics-hub-desktop/workflow/scheduler.cjs')
const { runWorker } = require('../apps/bioinformatics-hub-desktop/workflow/worker.cjs')
const sequence = '>exact_long_input\n'+'ACDEFGHIKLMNPQRSTVWY'.repeat(300)+'\n'
async function controller(phase,dir,url) {
  const store = new RunStore(dir); store.acquire()
  let session
  if(phase==='submit') {
    const workflow={id:'recovery-fixture',name:'Recovery fixture',version:1,nodes:[
      {id:'website',kind:'site',siteId:'fixture',input:{source:'input',key:'sequence'},dependsOn:[],parameters:{}},
      {id:'downstream',kind:'local',tool:'itol',input:{source:'node',nodeId:'website',kind:'tree'},dependsOn:['website'],parameters:{}}]}
    const recipe={id:'fixture',version:1,input:'protein_fasta',outputs:['tree','report'],entryUrl:url,allowedHosts:['127.0.0.1'],inputPattern:'Protein sequence',submitPattern:'^Submit$',goal:'Fill the bound sequence and submit once. Collect the verified tree result.',parameters:[],resultPatterns:['TEST_RESULT_COMPLETE','Validated fixture tree'],pendingPattern:'REMOTE_QUEUED',pollUrlPattern:'/result',jobPattern:'id=(fixture-1)'}
    session=createSession(path.basename(dir),workflow,{sequence:{kind:'protein_fasta',value:sequence}},{fixture:recipe})
    fs.writeFileSync(path.join(dir,'sequence.fasta'),sequence)
    session.input.sequence={kind:'protein_fasta',path:'sequence.fasta',sha256:hash(sequence)}
    store.save(session,'created')
  } else session=store.load()
  const scheduler=new WorkflowScheduler({session,store,launch:(payload,onEvent)=>runWorker({python:payload.node.kind==='local'?process.env.WORKFLOW_LOCAL_PYTHON:process.env.WORKFLOW_BROWSER_PYTHON,script:path.join(engine,'scripts/workflow_worker.py'),request:{command:'run',payload,settings:{chromeUrl:process.env.BU_CDP_URL}},cwd:dir,env:{...process.env,PYTHONUTF8:'1'},timeout:90000},onEvent)})
  if(phase==='resume') {scheduler.recover();scheduler.resume()} else scheduler.start()
  await new Promise((resolve,reject)=>{
    const deadline=Date.now()+90000
    const timer=setInterval(()=>{
      if(phase==='submit'&&session.nodes[0].status==='waiting_remote'||phase==='resume'&&session.status==='completed') {clearInterval(timer);resolve()}
      else if(Date.now()>deadline||['needs_attention','partial'].includes(session.status)) {clearInterval(timer);reject(new Error(JSON.stringify(session.nodes.map(n=>({id:n.id,status:n.status,message:n.message})))))}
    },100)
  }).finally(async()=>{await scheduler.shutdown();store.release()})
}
async function main() {
  if(process.argv[2]==='controller') return controller(...process.argv.slice(3))
  if(!process.env.WORKFLOW_BROWSER_PYTHON||!process.env.WORKFLOW_LOCAL_PYTHON||!process.env.BU_CDP_URL) throw new Error('Set WORKFLOW_BROWSER_PYTHON, WORKFLOW_LOCAL_PYTHON and BU_CDP_URL')
  let submissions=0, foreignSubmissions=0, ready=false, received=''
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk)
    const body=Buffer.concat(chunks).toString()
    if(req.url==='/evaluation-model') {
      const request=JSON.parse(body),elements=request.state.elements,questions=request.questions
      const submitted=request.state.recent_actions.some(a=>a.action==='Submit')
      const field=elements.find(e=>e.operations.includes('TYPE_TEXT'))
      const submit=elements.find(e=>e.operations.includes('CLICK')&&e.label==='Submit')
      const operation=request.state.page.url.includes('/result')?'WAIT':submitted?'WAIT':field&&!field.value?'TYPE_TEXT':submit?'CLICK':'WAIT'
      const answers={}
      for(const [name,q] of Object.entries(questions)) {
        const ids=Object.keys(q.criteria)
        const chosen=name==='operation'?(ids.includes(operation)?operation:'WAIT'):name==='click_target'?(ids.find(i=>q.criteria[i].element?.includes('Global Search'))||ids.find(i=>q.criteria[i].element?.includes('Submit'))||ids[0]):ids[0]
        answers[name]={choice:chosen,confidence:1,probabilities:Object.fromEntries(ids.map(id=>[id,id===chosen?1:0]))}
      }
      res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({answers}))
    }
    if(req.url==='/submit') {submissions++;received=new URLSearchParams(body).get('sequence');res.writeHead(303,{Location:'/result?id=fixture-1'});return res.end()}
    if(req.url==='/wrong-form') {foreignSubmissions++;res.writeHead(400);return res.end('Wrong form')}
    if(req.url==='/tree.nwk') {res.setHeader('Content-Type','text/plain');return res.end('(one:0.1,two:0.2,three:0.3);\n')}
    res.setHeader('Content-Type','text/html')
    if(req.url.startsWith('/result')) return res.end(ready?'<h1>TEST_RESULT_COMPLETE</h1><p>Validated fixture tree</p><a href="/tree.nwk" download>Download tree</a>':'<h1>REMOTE_QUEUED</h1><p>Job fixture-1</p>')
    res.end('<form method="POST" action="/submit"><label>Protein sequence<textarea name="sequence" rows="6" cols="60"></textarea></label><button type="submit">Submit</button></form><form method="POST" action="/wrong-form"><button type="submit">Global Search</button></form>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${server.address().port}`,dir=path.join(root,'runs',`recovery-fixture-${Date.now()}`)
  fs.mkdirSync(dir,{recursive:true})
  const child=phase=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[__filename,'controller',phase,dir,url],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TYPESAFE_BASE_URL:url,TYPESAFE_API_KEY:'local-fixture-only',TEXT_MODEL_API_KEY:'local-fixture-only'}})
    let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error(log)))
  })
  try {
    await child('submit');assert.equal(submissions,1);assert.equal(received.replace(/\r\n/g,'\n'),sequence)
    const checkpoint=JSON.parse(fs.readFileSync(path.join(dir,'session.json'),'utf8'));assert.equal(checkpoint.nodes[0].checkpoint.submitted,true);assert.equal(checkpoint.nodes[1].attempts,0)
    if (process.env.WORKFLOW_RESTART_CHROME_SCRIPT) await new Promise((resolve, reject) => {
      const child = spawn(process.env.WORKFLOW_BROWSER_PYTHON, [process.env.WORKFLOW_RESTART_CHROME_SCRIPT], { stdio: 'inherit', windowsHide: true, env: process.env })
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Dedicated browser restart failed')))
    })
    ready=true;await child('resume');assert.equal(submissions,1)
    const final=JSON.parse(fs.readFileSync(path.join(dir,'session.json'),'utf8'));assert.equal(final.status,'completed');assert.equal(final.nodes[0].attempts,2);assert.equal(final.nodes[1].status,'succeeded')
    assert.equal(foreignSubmissions,0)
    const result={ok:true,runId:final.id,submissions,foreignSubmissions,browserRestarted:Boolean(process.env.WORKFLOW_RESTART_CHROME_SCRIPT),checks:['6000-residue exact form input','unrelated global search form cannot become the analysis submission','durable submission receipt before controller exit','separate controller process restart','original remote job resumed without resubmission','validated downloaded Newick consumed by local iTOL node']}
    fs.writeFileSync(path.join(dir,'validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
  } finally {server.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
