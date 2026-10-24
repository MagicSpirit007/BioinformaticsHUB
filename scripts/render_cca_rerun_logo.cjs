'use strict'
const path = require('node:path'), os = require('node:os'), fs = require('node:fs')
const sharp = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'))
const root = path.resolve(__dirname, '../runs/cca0737s0009-rerun-20261021/figures')
async function main() {
  const source = path.join(root, 'weblogo.svg'), destination = path.join(root, 'weblogo.png')
  await sharp(source, { density: 300 }).resize({ width: 3000 }).flatten({ background: '#ffffff' }).png().withMetadata({ density: 300 }).toFile(destination)
  const metadata = await sharp(destination).metadata()
  fs.writeFileSync(path.join(root, 'weblogo-rendering.json'), JSON.stringify({ source: 'Official SVG from this run WebLogo download', operation: 'Vector rendering to PNG; plot data and layout unchanged', width: metadata.width, height: metadata.height, density: metadata.density }, null, 2))
  console.log(JSON.stringify({ width: metadata.width, height: metadata.height }))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
