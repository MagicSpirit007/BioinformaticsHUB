'use strict'
const fs = require('node:fs')
const path = require('node:path')

function loadRecipes(catalogPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const definitions = JSON.parse(fs.readFileSync(path.join(path.dirname(catalogPath), 'workflow-recipes.json'), 'utf8'))
  let acceptance = []
  try { acceptance = JSON.parse(fs.readFileSync(path.join(path.dirname(catalogPath), 'site-acceptance.json'), 'utf8')) } catch { /* no published live evidence yet */ }
  const recipes = {}
  for (const site of catalog.sites) {
    const recipe = definitions.recipes[site.id]
    if (!recipe) throw new Error(`Missing workflow recipe: ${site.id}`)
    recipes[site.id] = {
      ...recipe, id: site.id, name: site.name, group: site.group, version: definitions.version,
      resultReopen: recipe.resultReopen || (recipe.lookup || ['blastp', 'blastn', 'psi_blast', 'cdd', 'interpro', 'prankweb', 'itol_web', 'jpred', 'hmmer'].includes(site.id) ? 'url' : 'session'),
      entryUrl: recipe.entryUrl || site.entryUrl, allowedHosts: [...new Set([new URL(recipe.entryUrl || site.entryUrl).hostname, ...(recipe.allowedHosts || [])])],
      goal: `Run ${site.name} with the exact bound input and the confirmed parameters. Obtain the official final results and downloadable outputs. Dismiss cookie banners when necessary to access controls. Do not choose unconfigured research parameters or a different research object. ${recipe.taskHint || ''}`,
      pendingPattern: recipe.pendingPattern || 'job (?:is )?(?:queued|running|pending)|in (?:the )?queue|please wait|processing your|prediction is running|status: running',
      blockPattern: [recipe.blockPattern, 'captcha|verify you are human|sign in to continue|log in to continue|access denied|service unavailable|maintenance|temporarily unavailable'].filter(Boolean).join('|'),
      liveValidation: acceptance.find(row => row.siteId === site.id)?.passed ? 'verified' : 'unverified',
      validationNote: acceptance.find(row => row.siteId === site.id)?.reason || 'No verified live result has been recorded',
    }
  }
  return recipes
}

function defaultParameters(recipe) {
  return Object.fromEntries((recipe.parameters || []).filter(p => p.default != null).map(p => [p.id, p.default]))
}

function templates(recipes) {
  const { LOCAL } = require('./model.cjs')
  const local = (id, tool, input, deps = []) => ({ id, kind: 'local', tool, input, dependsOn: deps, parameters: defaultParameters(LOCAL[tool]) })
  const site = (id, siteId, input, deps = []) => ({ id, kind: 'site', siteId, input, dependsOn: deps, parameters: defaultParameters(recipes[siteId]) })
  const external = key => ({ source: 'input', key })
  const upstream = (nodeId, kind) => ({ source: 'node', nodeId, kind })
  return [
    { id: 'protein', name: '蛋白表征与注释 / Protein characterization', version: 1, nodes: [local('prepare', 'prepare', external('sequence')), local('physchem', 'physchem', upstream('prepare', 'protein_fasta'), ['prepare']), local('hydrophobicity', 'hydrophobicity', upstream('prepare', 'protein_fasta'), ['prepare']), site('interpro', 'interpro', upstream('prepare', 'protein_fasta'), ['prepare'])] },
    { id: 'evolution', name: '比对与系统发育 / Alignment and phylogeny', version: 1, nodes: [local('mafft', 'mafft', external('alignment')), local('iqtree', 'iqtree', upstream('mafft', 'alignment_fasta'), ['mafft']), site('itol', 'itol_web', upstream('iqtree', 'tree'), ['iqtree'])] },
    { id: 'structure', name: '结构与口袋 / Structure and pockets', version: 1, nodes: [site('alphafold', 'alphafold_db', external('identifier')), site('prankweb', 'prankweb', upstream('alphafold', 'structure'), ['alphafold'])] },
  ]
}
module.exports = { loadRecipes, defaultParameters, templates }
