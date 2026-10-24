"""Read observed form values from the owned tabs of the live acceptance runs."""
import json
from pathlib import Path
from workflow_worker import configure

def main():
    configure({})
    from workflow.browser import WorkflowBrowser
    root=Path(__file__).resolve().parents[1]/'runs'
    records=json.loads((root/'site-acceptance.json').read_text(encoding='utf-8'))
    output=[]
    for record in records:
        if not record.get('runId'):
            continue
        run=root/record['runId']
        state=json.loads((run/'session.json').read_text(encoding='utf-8'))
        node=state['nodes'][0]
        if not node.get('checkpoint',{}).get('targetId'):
            continue
        recipe=state['recipeSnapshot'][node['id']]
        browser=None
        try:
            browser=WorkflowBrowser(recipe['entryUrl'],node['checkpoint'],recipe['allowedHosts'],run/'inspection-downloads')
            evidence=browser.document_evidence()
            for field in evidence['fields']:
                if len(str(field['value']))>150:
                    field['value']='[long bound input]'
            (run/'inspection.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
            output.append({'siteId':record['siteId'],'runId':record['runId'],'url':evidence['url'],'fields':evidence['fields'],'text':evidence['text'][:2400]})
        except Exception as exc:
            output.append({'siteId':record['siteId'],'error':str(exc)})
        finally:
            if browser: browser.close()
    (root/'site-acceptance-inspection.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__': main()
