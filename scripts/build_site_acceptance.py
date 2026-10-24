"""Build an honest, reproducible matrix from run evidence; never promote a page-open."""
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from workflow.site import verify_result


def public_copy(value):
    if isinstance(value, dict):
        return {key:('[redacted]' if re.search(r'email|token|password|secret|api.?key',key,re.I) else public_copy(item)) for key,item in value.items()}
    if isinstance(value, list):
        return [public_copy(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[notification email]', value)
        return re.sub(r'([?&](?:token|key|access_token|sessionId)=)[^&#\s"<>]+', r'\1[redacted]', value, flags=re.I)
    return value


def main():
    catalog = json.loads((ROOT / 'apps/bioinformatics-hub/public/site-catalog.json').read_text(encoding='utf-8'))['sites']
    rows = {r['siteId']: r for r in json.loads((ROOT / 'runs/site-acceptance.json').read_text(encoding='utf-8'))}
    # Concurrent isolated acceptance controllers can finish out of order. Recover
    # the most recent actual site run from its authoritative session, not a stale
    # CLI summary written by another controller.
    for file in sorted((ROOT / 'runs').glob('wf-*/session.json')):
        try:
            session = json.loads(file.read_text(encoding='utf-8'))
            if session.get('workflow', {}).get('id') != 'site-acceptance': continue
            node = session['workflow']['nodes'][0]
            key = node['siteId']
            if session['id'] > rows.get(key, {}).get('runId', ''):
                rows[key] = {'siteId':key,'runId':session['id']}
        except (ValueError, KeyError):
            continue
    for site, run, node in [('interpro','wf-1789901913427-4e0208','interpro'),('itol_web','wf-1789903371835-53218a','itol'),('alphafold_db','wf-1789902514175-5e01af','alphafold'),('prankweb','wf-1789902514175-5e01af','prankweb')]:
        rows[site] = {'siteId':site,'runId':run,'nodeId':node}
    out = ROOT / 'docs/acceptance'
    out.mkdir(parents=True, exist_ok=True)
    matrix = []
    for site in catalog:
        row = rows.get(site['id'], {'siteId':site['id'],'status':'not_tested','message':'No live run'})
        item = {'siteId':site['id'],'name':site['name'],'checkedAt':'2026-09-20','runId':row.get('runId'),'status':row.get('status'),'passed':False,'reason':row.get('message','')}
        if row.get('runId'):
            run = ROOT / 'runs' / row['runId']
            session = json.loads((run / 'session.json').read_text(encoding='utf-8'))
            node = next(n for n in session['nodes'] if n['id']==row.get('nodeId',site['id']))
            item.update(status=node['status'], reason=node.get('message',''), resultUrl=node.get('resultUrl'), attempts=node['attempts'], artifacts=[])
            item['checkedAt'] = session.get('updatedAt',session.get('createdAt',item['checkedAt']))
            for artifact in node['artifacts']:
                source = run / artifact['path']
                valid = source.is_file() and hashlib.sha256(source.read_bytes()).hexdigest() == artifact['sha256']
                item['artifacts'].append({'kind':artifact['kind'],'path':artifact['path'],'sha256':artifact['sha256'],'integrityVerified':valid})
            item['passed'] = node['status']=='succeeded' and bool(item['artifacts']) and all(a['integrityVerified'] for a in item['artifacts'])
            if item['passed'] and site['id']=='jpred':
                # Earlier test used overly broad markers; audit under the corrected verifier.
                raw = next((run / a['path'] for a in node['artifacts'] if a['name']=='official-result.txt'), None)
                recipe = session['recipeSnapshot'][node['id']]
                if raw:
                    ok, reason = verify_result(recipe,{'url':node.get('resultUrl',''),'text':raw.read_text(encoding='utf-8')},node['checkpoint'],'')
                    if not ok: item.update(passed=False,status='verification_rejected',reason=reason)
            # Save source evidence without browser capability IDs or environment settings.
            files = [run / 'inspection.json', run / f"inspection-{node['id']}.json", run / 'nodes' / node['id'] / f"attempt-{node['attempts']}" / 'final-observation.json']
            for file in files:
                if file.exists():
                    observation = json.loads(file.read_text(encoding='utf-8'))
                    cleaned = {k:v for k,v in observation.items() if k in ('url','title','text','tables','tree','svgText')}
                    (out / (site['id'] + '-observation.json')).write_text(json.dumps(public_copy(cleaned),ensure_ascii=False,indent=2),encoding='utf-8')
                    break
            if not item['passed'] and site['id']=='uniprot':
                item['reason']='No independently verified BLAST hit table; the earlier help-page result was revoked'
            if not item['passed'] and site['id']=='string':
                item['reason']='P69905 matched HBA1 and HBA2; an explicit protein selection and recovery of the original browser session are required'
                item['status']='waiting_human'
            for artifact in node['artifacts']:
                if artifact['name'] in ('result.json','official-result.txt'):
                    source = run / artifact['path']
                    value = json.loads(source.read_text(encoding='utf-8')) if source.suffix == '.json' else source.read_text(encoding='utf-8')
                    cleaned = public_copy(value)
                    (out / (site['id'] + '-' + artifact['name'])).write_text(json.dumps(cleaned,ensure_ascii=False,indent=2) if isinstance(cleaned,dict) else cleaned,encoding='utf-8')
        if item['passed']: item['category']='verified'
        elif item['status']=='waiting_remote': item['category']='remote_wait'
        elif site['id'] in ('musite','eggnog','jpred','psipred','espript'): item['category']='external_or_configuration_block'
        elif site['id'] == 'string' and item['status']=='waiting_human': item['category']='ambiguous_accession'
        else: item['category']='adapter_or_verification_incomplete'
        matrix.append(public_copy(item))
    (out / 'matrix.json').write_text(json.dumps(matrix,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    public = [{'siteId':r['siteId'],'passed':r['passed'],'status':r['status'],'reason':r['reason']} for r in matrix]
    (ROOT / 'apps/bioinformatics-hub/public/site-acceptance.json').write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    passed = sum(r['passed'] for r in matrix)
    generated = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    lines=['# 28 站验收矩阵','',f'更新：{generated}。', '',f'严格通过：**{passed}/28**。此版本尚未达到“全部 28 站验收通过”的发布条件。','',
           '仅当节点成功、产物非空且 SHA256 复核通过时计入通过；JPred 使用加严后的验证器复核。页面观察、任务排队、模型 DONE 和打开结果链接均不计通过。外部服务与适配问题分开记录，尚不能把所有失败归因于网站。','',
           '| 网站 | 分类 | 状态 | 证据 / 阻塞原因 |','|---|---|---|---|']
    for row in matrix:
        reason=str(row['reason']).replace('|','/').replace('\n',' ')
        lines.append(f"| {row['name']} | {row['category']} | {row['status']} | {reason} |")
    lines += ['', '完整节点编号、官方结果 URL、产物哈希和观察摘录见 [机器可读矩阵](acceptance/matrix.json)。原始完整运行记录在工作区 `runs/<runId>`；公开副本隐藏邮箱及 URL 中的访问令牌，矩阵哈希指向本地原始产物。个人配置与浏览器能力 ID 未复制到此报告。', '',
              '复现：先按 `docs/workflows.md` 配置环境，使用 `tests/fixtures` 的公开数据和 `workflow_cli.cjs acceptance ... --live`。本矩阵不代表账户登录、付费功能或全部参数组合都通过。', '']
    (ROOT / 'docs/site-acceptance.md').write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps({'passed':passed,'total':len(matrix)}))

if __name__=='__main__': main()
