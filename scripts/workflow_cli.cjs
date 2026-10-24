#!/usr/bin/env node
'use strict'
// The CLI uses the exact desktop service and durable scheduler, without Electron.
const path = require('node:path')
const fs = require('node:fs')
const { installWorkflow } = require('../apps/bioinformatics-hub-desktop/workflow/service.cjs')
const basePaths = require('../apps/bioinformatics-hub-desktop/paths.cjs')
const root = path.resolve(__dirname, '..')
const handlers = new Map()
let last
const currentRuns = new Map()
const paths = { ...basePaths, engineRoot: () => root, siteCatalogPath: () => path.join(root, 'apps/bioinformatics-hub/public/site-catalog.json') }
const service = installWorkflow({
  app: { getPath: () => path.join(root, 'runs', '.workflow-cli') },
  ipcMain: { handle: (name, fn) => handlers.set(name.replace('workflow:', ''), args => fn(null, args)) },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  shell: { showItemInFolder: () => {} },
  getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, session) => {
    last = session
    currentRuns.set(session.id, session)
    if (!process.argv.includes('--quiet')) console.log(JSON.stringify({ id: session.id, status: session.status, nodes: session.nodes.map(n => ({ id: n.id, status: n.status, message: n.message })) }))
  } } }), paths,
})
async function main() {
  const [command, arg, nodeId] = process.argv.slice(2)
  if (command === 'resume-acceptance') {
    const selected = new Set((arg || '').split(','))
    const file = path.join(root, 'runs', 'site-acceptance.json')
    const records = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const record of records.filter(r => selected.has(r.siteId) && r.runId)) {
      try {
        const run = await handlers.get('load')({id:record.runId})
        const node = run.nodes[0]
        if (!node.submitted || node.uncertainSubmission) throw new Error('No unambiguous submitted receipt; this command never submits a fresh job')
        if (node.status === 'succeeded') { currentRuns.set(run.id,run); continue }
        const result = await handlers.get('control')({id:run.id,nodeId:node.id,action:node.status==='waiting_remote'?'resume':'retry'})
        currentRuns.set(result.id,result)
      } catch (error) { record.resumeNote = error.message }
    }
    await new Promise(resolve => {
      const timer=setInterval(()=>{if(![...currentRuns.values()].some(s=>s.nodes.some(n=>['ready','running','verifying'].includes(n.status)))) {clearInterval(timer);resolve()}},500)
    })
    for(const record of records) {
      const node=currentRuns.get(record.runId)?.nodes[0]
      if(node) Object.assign(record,{status:node.status,message:node.message,resultUrl:node.resultUrl,artifacts:node.artifacts,analysisVerified:node.status==='succeeded'})
    }
    fs.writeFileSync(file,JSON.stringify(records,null,2))
    console.log(JSON.stringify(records.filter(r=>selected.has(r.siteId)).map(({artifacts,...r})=>({...r,artifacts:artifacts?.length||0})),null,2))
  }
  else if (command === 'acceptance') {
    if (!process.argv.includes('--live')) throw new Error('Live acceptance submits public test data; pass --live explicitly')
    const { recipes } = await handlers.get('catalog')()
    const protein = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/protein-workflow.json'), 'utf8')).inputs.protein.value
    const plant = fs.readFileSync(path.join(root, 'tests/fixtures/plant-P10795.fasta'), 'utf8')
    const nucleotide = fs.readFileSync(path.join(root, 'tests/fixtures/HBA1-NM_000558.5.fasta'), 'utf8')
    const alignment = fs.readFileSync(path.join(root, 'tests/fixtures/hemoglobin-orthologs.fasta'), 'utf8')
    const values = { protein_fasta: protein, nucleotide_fasta: nucleotide, alignment_fasta: alignment, identifier: 'P69905', tree: '(human:0.1,mouse:0.2,rat:0.2,horse:0.15);' }
    const selected = arg ? new Set(arg.split(',')) : null
    let records = []
    try { records = JSON.parse(fs.readFileSync(path.join(root,'runs','site-acceptance.json'),'utf8')).filter(r=>selected&&!selected.has(r.siteId)) } catch { /* first acceptance run */ }
    for (const recipe of Object.values(recipes)) {
      if (selected && !selected.has(recipe.id)) continue
      const record = { siteId: recipe.id, entryUrl: recipe.entryUrl, checkedAt: new Date().toISOString() }
      records.push(record)
      const parameters = Object.fromEntries(recipe.parameters.filter(p => p.default != null).map(p => [p.id,p.default]))
      if (recipe.id === 'signalp') parameters.organism = 'Eukarya'
      if (recipe.id === 'cell_ploc') parameters.organism = 'Plant'
      if (recipe.id === 'string') parameters.organism = 'Homo sapiens'
      if (recipe.id === 'musite') parameters.modification = 'Phosphorylation'
      if (recipe.id === 'eggnog' && process.env.BIOHUB_ACCEPTANCE_EMAIL) Object.assign(parameters, {email:process.env.BIOHUB_ACCEPTANCE_EMAIL,emailConsent:'true'})
      const value = ['plant_mploc','cell_ploc'].includes(recipe.id) ? plant : values[recipe.input]
      if (!value) { Object.assign(record,{status:'requires_upstream_artifact',message:'Use the structure workflow fixture to produce this input'}); continue }
      try {
        const session = await handlers.get('start')({ executionMode:'web', name:`Public acceptance: ${recipe.id}`, workflow: {id:'site-acceptance',name:'Public site acceptance',version:1,nodes:[{id:recipe.id,kind:'site',siteId:recipe.id,input:{source:'input',key:'test'},dependsOn:[],parameters}]}, inputs:{test:{kind:recipe.input,value}} })
        record.runId = session.id; currentRuns.set(session.id, session)
      } catch(e) { Object.assign(record,{status:'configuration_blocked',message:e.message}) }
    }
    const output = path.join(root,'runs','site-acceptance.json')
    const snapshot = () => {
      const rows = records.map(r=> {
        const run = currentRuns.get(r.runId)?.nodes[0]
        return run ? {...r,status:run.status,message:run.message,resultUrl:run.resultUrl,analysisVerified:run.status==='succeeded',artifacts:run.artifacts} : {...r,analysisVerified:Boolean(r.analysisVerified)}
      })
      fs.writeFileSync(output, JSON.stringify(rows,null,2))
      return rows
    }
    await new Promise(resolve => {
      const deadline=Date.now()+15*60_000
      const timer=setInterval(()=>{
        const rows=snapshot()
        if(!rows.some(r=>['ready','running','verifying'].includes(r.status)) || Date.now()>deadline) {clearInterval(timer);resolve()}
      },1000)
    })
    console.log(JSON.stringify(snapshot().map(({artifacts,...row})=>({...row,artifacts:artifacts?.length||0})),null,2))
  }
  else if (['probe', 'browserCheck', 'modelCheck', 'catalog', 'list'].includes(command)) console.log(JSON.stringify(await handlers.get(command)(), null, 2))
  else if (command === 'settings') console.log(JSON.stringify(await handlers.get('saveSettings')(JSON.parse(fs.readFileSync(arg, 'utf8'))), null, 2))
  else if (command === 'export') console.log(JSON.stringify(await handlers.get('export')({id:arg})))
  else if (command === 'revalidate') console.log(JSON.stringify(await handlers.get('control')({id:arg,nodeId,action:'revalidate'})))
  else if (command === 'reconcile') {
    const notSubmitted = process.argv.includes('--not-submitted')
    console.log(JSON.stringify(await handlers.get('control')({id:arg,nodeId,action:'reconcile',resultUrl:notSubmitted ? undefined : process.argv[5],notSubmitted})))
  }
  else if (command === 'start' || command === 'resume' || command === 'retry') {
    last = command === 'start' ? await handlers.get('start')(JSON.parse(fs.readFileSync(arg, 'utf8'))) : await handlers.get('control')({ id: arg, action: command, nodeId })
    console.log(JSON.stringify(last.status === 'needs_choice' ? last : { id: last.id, status: last.status }))
    if (process.argv.includes('--wait') && last.id) {
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (['completed', 'partial', 'cancelled', 'needs_attention', 'needs_input', 'paused'].includes(last.status)) { clearInterval(timer); resolve() }
        }, 500)
      })
      console.log(JSON.stringify(process.argv.includes('--summary') ? { id: last.id, status: last.status, nodes: last.nodes.map(n => ({ id:n.id, status:n.status, message:n.message, resultUrl:n.resultUrl, artifacts:n.artifacts.length })) } : last, null, 2))
    }
  } else throw new Error('Usage: node scripts/workflow_cli.cjs probe|modelCheck|catalog|list|settings <json>|start <spec.json> --wait|resume <id> --wait|reconcile <id> <node> <result-url>|--not-submitted')
}
let stopping = false
process.on('SIGINT', async () => { if (stopping) return; stopping = true; await service.shutdown(); process.exit(130) })
main().catch(e => { console.error(e.message); process.exitCode = 1 }).finally(async () => { await service.shutdown() })
