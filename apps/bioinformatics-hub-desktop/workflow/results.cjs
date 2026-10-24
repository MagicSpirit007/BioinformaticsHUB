'use strict'
const { inside } = require('./model.cjs')
const { verifiedFile } = require('./integrity.cjs')

function openLocal(file) { return require('./system-open.cjs').openSystem(file) }
function resultRows(session) {
  return session.nodes.map(run => {
    const node = session.workflow.nodes.find(n => n.id === run.id)
    return { nodeId: run.id, name: session.recipeSnapshot?.[run.id]?.name || node?.tool || run.id,
      kind: node?.kind, status: run.status, resultUrl: run.resultUrl, canActivate: Boolean(run.checkpoint?.targetId),
      archive: run.archive || { status: 'not_saved' }, artifacts: run.artifacts || [], message: run.message }
  })
}
async function checkedFile(core, session, artifactPath) {
  const artifact = session.nodes.flatMap(n => n.artifacts || []).find(a => a.path === artifactPath)
  if (!artifact || !artifact.verified) throw new Error('File is not registered in this task')
  const file = inside(core.runDir(session.id), artifact.path)
  await verifiedFile(file, artifact.sha256)
  return file
}
module.exports = { resultRows, openLocal, checkedFile }
