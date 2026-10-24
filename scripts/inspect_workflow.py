"""Inspect one owned node tab without clicking or mutating a remote service."""
import argparse
import json
import sys
from pathlib import Path
from workflow_worker import configure

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('run_id')
    parser.add_argument('node_id')
    parser.add_argument('--chrome-url', required=True)
    parser.add_argument('--bound-entry', action='store_true', help='Revisit this run\'s explicitly bound identifier URL')
    parser.add_argument('--observed-url', help='Revisit a URL already observed in this run, without altering its checkpoint')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / 'runs'
    run = (root / args.run_id).resolve()
    if not run.is_relative_to(root):
        raise ValueError('Run must be inside runs/')
    configure({'chromeUrl': args.chrome_url})
    from workflow.browser import WorkflowBrowser
    session = json.loads((run / 'session.json').read_text(encoding='utf-8'))
    node = next(n for n in session['nodes'] if n['id'] == args.node_id)
    recipe = session['recipeSnapshot'][args.node_id]
    if node.get('resultUrl') and not node['checkpoint'].get('resultUrl'):
        node['checkpoint']['resultUrl'] = node['resultUrl']
    browser = WorkflowBrowser(recipe['entryUrl'], node['checkpoint'], recipe['allowedHosts'], run / 'inspection-downloads')
    try:
        if args.observed_url:
            browser.revisit_result(args.observed_url)
            import time
            time.sleep(2)
        if args.bound_entry:
            import time
            browser.revisit_result(node['checkpoint']['boundIdentifierUrl'])
            time.sleep(3)
        page = browser.observe(False)
        observed = browser.document_evidence()
        observed['actions'] = [{k:v for k,v in a.items() if k in {'id','label','kind','role','value'}} for a in page['actions']]
        observed['invalidForms'] = [{'control':a['label'],'fields':browser.invalid_form_fields(a)} for a in page['actions'] if a.get('formSubmit')]
        observed['buttons'] = browser.evaluate("[...document.querySelectorAll('button,input[type=submit]')].map(e=>({text:e.innerText||e.value,type:e.type,form:Boolean(e.form)}))")
        observed['scrollContainers'] = browser.evaluate("[...document.querySelectorAll('*')].filter(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight+2).map(e=>({tag:e.tagName,id:e.id,overflow:getComputedStyle(e).overflowY,h:e.clientHeight,scrollH:e.scrollHeight,top:e.scrollTop,visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})})).slice(0,20)")
        observed['iconControls'] = browser.evaluate("[...document.querySelectorAll('svg')].filter(e=>getComputedStyle(e).cursor==='pointer').map(e=>e.parentElement.outerHTML.slice(0,2400)).slice(0,20)")
        observed['closeControl'] = browser.evaluate("(()=>{const e=document.querySelector('button[title=\"Close panel\"]');if(!e)return null;const r=e.getBoundingClientRect();return {rect:{x:r.x,y:r.y,w:r.width,h:r.height},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200),hidden:e.closest('[aria-hidden=\"true\"],[inert]')?.outerHTML.slice(0,300),visible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})}})()")
        observed['downloadControls'] = browser.evaluate("[...document.querySelectorAll('*')].filter(e=>e.textContent?.trim()==='Download files').map(e=>e.outerHTML.slice(0,2500))")
        observed['rendering'] = browser.evaluate("({canvases:[...document.querySelectorAll('canvas')].map(e=>({id:e.id,width:e.width,height:e.height})), treeKeys:Object.keys(window).filter(k=>/tree|leaf|label/i.test(k)), rows:[...document.querySelectorAll('tr')].filter(e=>/protein.fasta/.test(e.innerText)).map(e=>e.outerHTML.slice(0,10000))})")
        observed['treeData'] = browser.evaluate("typeof treeData==='undefined'?null:JSON.stringify(treeData).slice(0,30000)")
        (run / ('inspection-' + args.node_id + '.json')).write_text(json.dumps(observed, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.screenshot(run / ('inspection-' + args.node_id + '.png'))
        print(json.dumps({'url': observed['url'], 'actions': observed['actions'], 'invalidForms':observed['invalidForms'], 'svgText': observed.get('svgText')}, ensure_ascii=False))
    finally:
        browser.close()

if __name__ == '__main__':
    main()
