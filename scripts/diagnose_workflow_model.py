"""Read-only model-decision diagnostic on a public acceptance tab. Never acts."""
import json
import os
from pathlib import Path
from workflow_worker import configure, ALLOWED_ENV

root = Path(__file__).resolve().parents[1]
configure({'envFile':str(Path.home()/'jev-ultrafast/.env'),'chromeUrl':os.environ.get('BU_CDP_URL','')})
from workflow.browser import WorkflowBrowser
from vendor.jev_ultrafast import model
records = json.loads((root/'runs/site-acceptance.json').read_text(encoding='utf-8'))
record = next(r for r in records if r['siteId']=='deeptmhmm')
session = json.loads((root/'runs'/record['runId']/'session.json').read_text(encoding='utf-8'))
node = session['nodes'][0]
recipe = session['recipeSnapshot'][node['id']]
browser = WorkflowBrowser(recipe['entryUrl'],node['checkpoint'],recipe['allowedHosts'],root/'runs/model-diagnostic-downloads')
original = model.CLIENT.post
def post(*args, **kwargs):
    response = original(*args, **kwargs)
    if response.is_error:
        try:
            body = response.json(); error = body.get('error',body)
            data = error if isinstance(error,(dict,list,str)) else {'errorType':type(error).__name__}
            text = json.dumps(data,ensure_ascii=False)
            for key in ALLOWED_ENV:
                if 'KEY' in key and os.environ.get(key): text=text.replace(os.environ[key],'[redacted]')
            print(text[:800])
        except ValueError: print(json.dumps({'status':response.status_code,'body':'not JSON'}))
    return response
model.CLIENT.post = post
try:
    page = browser.observe(False)
    print(json.dumps({'actions':len(page['actions']),'operations':{k:len(v) for k,v in model.action_space(page['actions'])[1].items()}}))
    print(json.dumps({'textChars':len(page['text']), 'largestFields':sorted([{'kind':a['kind'],'labelChars':len(a.get('label','')),'valueChars':len(str(a.get('value','')))} for a in page['actions']],key=lambda a:a['labelChars']+a['valueChars'],reverse=True)[:4]}))
    decision = model.choose(page,'Fill the exact runtime-bound protein input, then run DeepTMHMM. Input is available from the runtime; do not generate sequence text.',[])
    print(json.dumps({'decision':decision['operation']}))
finally:
    browser.close()
