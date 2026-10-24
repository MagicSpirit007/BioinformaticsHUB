"""Jev site execution, exact input binding, receipts and independent verification."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse, quote

from .artifacts import descriptor, scoped, validate_content, write_json


class RemoteServiceError(Exception):
    pass


def check_service_error(evidence):
    text = evidence.get("text", "")
    match = re.search(r"(?:502\s+Bad Gateway|500\s+Internal Server Error|503\s+Service Unavailable|504\s+Gateway Time(?:out| Out))", text, re.I)
    if match:
        raise RemoteServiceError("Original website returned " + match.group(0))
    if re.search(r'CPU usage limit was exceeded|There was a problem with the search|Error:\s*Search.*failed', text, re.I):
        raise RemoteServiceError('Original BLAST job failed; inspect its RID and error receipt before any new submission')


class PauseRequested(Exception):
    pass


def matches(pattern, value):
    return bool(pattern and re.search(pattern, value or "", re.I | re.S))


def normal(value):
    return re.sub(r"\s+", " ", str(value).strip()).casefold()


def task_download_directory(root, node_id, checkpoint):
    """Keep in-flight and completed downloads in the same directory across polls."""
    node_root = scoped(root, f'nodes/{node_id}')
    if checkpoint.get('downloadPath'):
        directory = scoped(root, checkpoint['downloadPath'])
        if not directory.is_relative_to(node_root):
            raise ValueError('Download directory belongs to another node')
    else:
        # Retain an already-started download from pre-checkpoint versions.
        previous = [p for p in node_root.glob('attempt-*/downloads.tmp') if any(p.iterdir())]
        if len(previous) > 1:
            raise ValueError('Multiple previous download directories require reconciliation')
        directory = previous[0] if previous else node_root / 'downloads.tmp'
        directory = scoped(root, directory.relative_to(root).as_posix())
        checkpoint['downloadPath'] = directory.relative_to(root).as_posix()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def alignment_matches_input(data, input_value):
    def sequences(text):
        records = re.split(r'(?m)^>[^\n]*\n', text.strip() + '\n')[1:]
        return Counter(re.sub(r'[\s.-]', '', record).upper() for record in records)
    return bool(sequences(input_value)) and sequences(data.decode('utf-8-sig')) == sequences(input_value)


def email_field(label):
    return bool(re.search(r'\be-?mail\b|邮箱', str(label), re.I))


def email_form_issue(fields, parameters, notification):
    """An autofilled address must not override a declined/unconfigured choice."""
    addresses = [f for f in fields if email_field(str(f.get('label', '')) + ' ' + str(f.get('name', ''))) and not f.get('type') == 'checkbox']
    expected = parameters.get('email', '') if notification.get('choice') == 'send' else ''
    if any(str(f.get('value') or '').strip() and str(f.get('value')).strip() != expected for f in addresses):
        return 'Email form value differs from the confirmed notification choice; clear or correct it before submission'
    return None


def resolve_exact_value(action, page, recipe, parameters, input_value, source):
    if action['kind'] == 'upload':
        return str(source)
    if email_field(action.get('label', '') + ' ' + action.get('fieldName', '')):
        return str(parameters.get('email', ''))
    # NCBI exposes QUERY_FROM/QUERY_TO and ENTREZ_QUERY beside QUERY. A
    # substring match on "query" must never bind the biological sequence there.
    for field in recipe.get('parameters', []):
        key = field['id']
        keywords = [key, re.sub(r'([a-z])([A-Z])', r'\1 \2', key), field['label'].split(' / ')[-1]]
        names = {normal(action['label']), normal(action.get('fieldName', ''))}
        if parameters.get(key) is not None and (any(normal(word) in names for word in keywords) or matches(field.get('fieldPattern'), action['label'] + ' ' + action.get('fieldName', ''))):
            return str(parameters[key])
    field = action['label'] + ' ' + action.get('fieldName', '')
    if re.search(r'query[_ ](?:from|to)|subrange|entrez|organism|taxonomy|taxid|job.?title', field, re.I):
        return None
    from .custom_sites import supported_id
    if supported_id(recipe) in {'protparam', 'protscale'}:
        return input_value if action.get('fieldName') == 'sequence' else None
    if matches(recipe['inputPattern'], action['label'] + ' ' + action.get('fieldName', '')):
        return input_value
    fills = [a for a in page['actions'] if a['kind'] == 'fill']
    if action.get('role') == 'textbox' and len(fills) == 1 and recipe['input'] != 'identifier':
        return input_value
    return None


def parameter_verified(parameter, expected, fields, action_label=""):
    if parameter.get("executionPolicy"):
        return str(expected) in parameter.get("options", [])
    if parameter.get("actionPatterns"):
        return matches(parameter["actionPatterns"].get(str(expected)), action_label)
    expected_values = [normal(expected), *[normal(v) for v in parameter.get("aliases", {}).get(str(expected), [])]]
    for field in fields:
        if parameter.get("fieldPattern") and not matches(parameter["fieldPattern"], field.get("label", "")):
            continue
        if parameter.get("checkbox"):
            if field.get("type") == "checkbox" and str(bool(field.get("checked"))).lower() == str(expected).lower():
                return True
        elif field.get("active", True) and any(normal(field.get(key, "")) in expected_values for key in ("value", "label")):
            return True
    return False


def structured_facts(recipe, evidence):
    if recipe.get('id') == 'interpro':
        entries = sorted(set(re.findall(r'\bIPR\d{6}\b', evidence['text'])))
        signatures = sorted(set(re.findall(r'\bPF\d{5}\b', evidence['text'])))
        if entries or signatures:
            return {'interproEntries':entries,'pfamSignatures':signatures,'tables':evidence.get('tables',[])}
    if recipe.get('id') == 'itol_web' and (evidence.get('tree') or {}).get('rendered') and evidence['tree'].get('nodeCount', 0) > 2:
        return evidence['tree']
    if recipe.get('id') == 'orf_finder':
        found = re.search(r'ORFs found:\s*(\d+)', evidence['text'])
        if found and int(found.group(1)) > 0 and matches('Strand.*Frame.*Start.*Stop.*Length', evidence['text']):
            return {'orfs': int(found.group(1)), 'tables': evidence.get('tables', [])}
    if recipe.get('id') == 'cdd':
        found = re.search(r'Total domains found:\s*(\d+)', evidence['text'])
        if found and matches('Search completed successfully', evidence['text']) and matches(r'Valid queries:\s*1', evidence['text']):
            return {'domains': int(found.group(1)), 'tables': evidence.get('tables', [])}
    if recipe.get("id") == "prankweb":
        for table in evidence.get("tables", []):
            if not table or not all(word in normal(" ".join(table[0])) for word in ("rank", "score", "probability")):
                continue
            pockets = []
            for row in table[1:]:
                cells = [cell.strip() for cell in row if cell.strip()]
                try:
                    rank, score, probability, residues = int(cells[0]), float(cells[1]), float(cells[2]), int(cells[3])
                    if rank < 1 or score < 0 or not 0 <= probability <= 1 or residues < 1:
                        return None
                    pockets.append({"rank": rank, "score": score, "probability": probability, "residues": residues})
                except (ValueError, IndexError):
                    continue
            if pockets and "/viewer?id=" in evidence["url"]:
                return {"pockets": pockets}
    if recipe.get("id") in {"plant_mploc", "cell_ploc"}:
        if matches("Computation Result", evidence["text"]) and matches("Predicted location", evidence["text"]):
            locations = re.findall(r"chloroplast|cytoplasm|nucleus|mitochondri\w*|cell membrane|extracellular|vacuole|golgi|peroxisome|endoplasmic reticulum", evidence["text"].split("Predicted location")[-1], re.I)
            if locations:
                return {"locations": sorted(set(normal(location) for location in locations))}
    return None


def verify_result(recipe, evidence, checkpoint, input_value):
    from .custom_sites import supported_id, verify_custom
    custom = supported_id(recipe) if recipe.get('experimental') else None
    if recipe.get("experimental") and not custom:
        return False, "Custom site outcome needs a configured verifier"
    if urlparse(evidence["url"]).hostname not in recipe["allowedHosts"]:
        return False, "Result host does not match recipe"
    if not checkpoint.get("inputVerified") and not checkpoint.get("reconciled"):
        return False, "No verified input binding or reconciled remote job"
    if not checkpoint.get("submitted") and not recipe.get("lookup"):
        return False, "No recorded submission"
    if checkpoint.get("preSubmitTextHash") == hashlib.sha256(evidence["text"].encode()).hexdigest():
        return False, "The page still shows the original submission form"
    if custom:
        return verify_custom(recipe, evidence, input_value)
    if recipe.get('id') in {'blastn', 'blastp', 'psi_blast'}:
        if re.search(r'CPU usage limit was exceeded|There was a problem with the search|Error:\s*Search.*failed', evidence['text'], re.I):
            return False, 'BLAST error receipt is not a valid negative search result'
        expected = ''.join(line.strip() for line in input_value.splitlines() if not line.startswith('>'))
        length = re.search(r'Query Length\s+(\d+)', evidence['text'])
        if not length or int(length[1]) != len(expected):
            return False, 'BLAST query length does not match the bound sequence'
    if recipe.get("id") == "interpro":
        if not re.search(r'/result/InterProScan/[^/?#]+', evidence['url']) or not re.search(r"\b(?:IPR\d{6}|PF\d{5})\b|No matches found", evidence["text"]):
            return False, "InterPro requires a specific sequence-analysis job; search examples and job lists are not annotations"
    if recipe.get('id') == 'uniprot':
        if not matches(r'/blast/[^/?#]+', evidence['url']) or not any(matches(r'Identity', ' '.join(table[0])) and matches(r'Score|E.?value', ' '.join(table[0])) and len(table)>1 for table in evidence.get('tables',[]) if table):
            return False, 'UniProt requires a specific BLAST job and populated hit table; help text is not a result'
    if recipe.get('id') == 'jpred':
        if urlparse(evidence['url']).path.endswith('/LOG') or not matches(r'Jnet(?:pred|conf)|JPred prediction', evidence['text']):
            return False, 'JPred execution log or example page is not a verified secondary-structure result'
        sequence = ''.join(line.strip() for line in input_value.splitlines() if not line.startswith('>'))
        if sequence not in re.sub(r'\s+', '', evidence['text']):
            return False, 'JPred result does not expose the submitted sequence for association checking'
    if recipe.get('id') == 'itol_web':
        expected = validate_content('tree', input_value.encode())['leaves']
        actual = (evidence.get('tree') or {}).get('leaves', [])
        normalized = lambda labels: sorted(normal(label.strip("'").replace('_', ' ')) for label in labels)
        if not matches(r'/tree/[A-Za-z0-9]+', evidence['url']) or normalized(actual) != normalized(expected):
            return False, 'Rendered iTOL leaf labels do not match the bound Newick tree'
    if recipe.get("lookup") and not re.search(r"(?<![A-Za-z0-9])" + re.escape(input_value.strip()) + r"(?![A-Za-z0-9])", evidence["text"], re.I):
        return False, "Result does not contain the requested accession"
    if recipe.get("resultUrlPattern") and not matches(recipe["resultUrlPattern"].replace("{identifier}", re.escape(input_value.strip())), evidence["url"]):
        return False, "Result URL does not uniquely identify the configured accession/source"
    patterns = recipe.get("resultPatterns", [])
    if structured_facts(recipe, evidence) is None and (len(patterns) < 2 or not all(matches(pattern, evidence["text"]) for pattern in patterns)):
        return False, "Independent result markers are missing"
    pending_text = "\n".join("\n".join("\t".join(row) for row in table) for table in evidence.get("tables", [])) if recipe.get("pendingInTables") or recipe.get("id") == "interpro" else evidence["text"]
    if matches(recipe.get("pendingPattern"), pending_text):
        return False, "Remote job has not finished"
    return True, "Official result markers and input provenance verified"


def collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value):
    try:
        return _collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value)
    except Exception as error:
        return {'status': 'needs_review', 'message': type(error).__name__ + ': ' + str(error)[:1200],
                'checkpoint': checkpoint, 'resultUrl': evidence.get('url'),
                'failure': {'stage': 'download', 'category': 'browser_timeout' if 'timeout' in type(error).__name__.lower() or 'timed out' in str(error).lower() else 'download', 'recoverable': True}}


def _collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value):
    ok, reason = verify_result(recipe, evidence, checkpoint, input_value)
    if not ok:
        return {"status": "needs_review", "message": reason, "checkpoint": checkpoint, "resultUrl": evidence["url"]}
    output = work / "results"
    output.mkdir(parents=True, exist_ok=True)
    artifacts = []
    if any(file.suffix.lower() in {'.crdownload', '.part', '.tmp'} for file in browser.downloads.iterdir()):
        return {'status': 'waiting_remote', 'message': 'Download has not completed', 'checkpoint': checkpoint, 'resultUrl': evidence['url']}
    tracker = getattr(browser, "download_tracker", None)
    if tracker:
        downloads = tracker.snapshot()
        checkpoint["downloads"] = downloads
        if any(row["state"] == "inProgress" for row in downloads):
            return {"status": "waiting_remote", "message": "Download is still transferring", "checkpoint": checkpoint, "resultUrl": evidence["url"]}
        if any(row["state"] == "canceled" and not any(other["state"] == "completed" and other.get("url") == row.get("url") for other in downloads) for row in downloads):
            return {"status": "needs_review", "message": "A result download was canceled; retry the original download, not the analysis", "checkpoint": checkpoint, "resultUrl": evidence["url"]}
        for row in downloads:
            if row.get('state') == 'completed' and row.get('name'):
                downloaded = browser.downloads / Path(row['name']).name
                # Browser progress counters can describe transferred compressed
                # bytes. Content parsing and hashes validate decoded disk bytes.
                if not downloaded.is_file() or downloaded.stat().st_size == 0:
                    return {'status': 'needs_review', 'message': 'Completed download bytes do not match the saved file', 'checkpoint': checkpoint, 'resultUrl': evidence['url']}
                row['fileBytes'] = downloaded.stat().st_size
                row['sha256'] = hashlib.sha256(downloaded.read_bytes()).hexdigest()
    required = [kind for kind in recipe["outputs"] if kind != "report"]
    # Prefer a single explicit structural/alignment file over ambiguous candidates.
    extensions = {"structure": (".pdb", ".cif"), "alignment_fasta": (".fasta", ".fa", ".aln", ".aln-fasta"), "tree": (".nwk", ".treefile")}
    for kind in required:
        candidates = []
        for file in sorted(browser.downloads.iterdir()):
            if not file.is_file() or file.suffix.lower() not in extensions[kind]:
                continue
            try:
                validate_content(kind, file.read_bytes(), aligned=kind == "alignment_fasta")
                candidates.append(file)
            except (ValueError, UnicodeError):
                pass
        if not candidates:
            links = [link for link in evidence["links"] if urlparse(link["url"]).hostname in recipe["allowedHosts"] and any(ext in urlparse(link["url"]).path.lower() for ext in extensions[kind])]
            if not links and kind == 'alignment_fasta':
                links = [link for link in evidence['links'] if urlparse(link['url']).hostname in recipe['allowedHosts'] and matches(r'aln-fasta|aligned.*fasta|alignment.*fasta', link['url'] + ' ' + str(link.get('label', '')))]
            for ext in extensions[kind]:
                preferred = [link for link in links if ext in urlparse(link["url"]).path.lower()]
                if preferred:
                    links = preferred
                    break
            unique = {link["url"]: link for link in links}
            if len(unique) == 1:
                link = next(iter(unique.values()))
                suffix = next((ext for ext in extensions[kind] if ext in urlparse(link["url"]).path.lower()), extensions[kind][0])
                pending = browser.downloads / (kind + suffix)
                browser.download_observed_link(link, pending)
                validate_content(kind, pending.read_bytes(), aligned=kind == "alignment_fasta")
                candidates = [pending]
        if len(candidates) != 1:
            return {"status": "needs_review", "missingDownloads": len(candidates) == 0, "message": f"Expected exactly one validated {kind} download; found {len(candidates)}", "checkpoint": checkpoint, "resultUrl": evidence["url"]}
        if kind == 'alignment_fasta' and not alignment_matches_input(candidates[0].read_bytes(), input_value):
            return {'status':'needs_review','message':'Downloaded alignment sequences do not match the bound input','checkpoint':checkpoint,'resultUrl':evidence['url']}
        destination = output / candidates[0].name
        shutil.copyfile(candidates[0], destination)
        artifacts.append(descriptor(root, destination, kind, node["id"], evidence["url"], aligned=kind == "alignment_fasta"))
    # Raw result text and parsed HTML tables retain source values without AI interpretation.
    raw = output / "official-result.txt"
    raw.write_text(evidence["text"], encoding="utf-8")
    facts = output / "result.json"
    write_json(facts, {"siteId": recipe.get("id"), "recipeVersion": recipe.get("version"), "url": evidence["url"], "title": evidence["title"], "tables": evidence["tables"], "data": structured_facts(recipe, evidence), "parameters": node.get("parameters", {}), "inputSha256": checkpoint.get("inputSha256"), "jobId": checkpoint.get("jobId"), "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    artifacts.extend([descriptor(root, raw, "report", node["id"], evidence["url"]), descriptor(root, facts, "report", node["id"], evidence["url"])])
    for file in sorted(browser.downloads.iterdir()):
        if file.is_file() and file.suffix.lower() not in {".crdownload", ".tmp", ".part"} and file.stat().st_size and not (output / file.name).exists():
            destination = output / file.name
            shutil.copyfile(file, destination)
            artifacts.append(descriptor(root, destination, "report", node["id"], evidence["url"]))
    from .archive import archive_page
    try:
        saved = archive_page(browser, root, output / "webpage", node["id"])
        artifacts.extend(saved["artifacts"])
        archive = saved["archive"]
    except Exception as error:
        archive = {"status": "failed", "errors": [str(error)[:300]]}
    from .downloads import verify_files
    from .custom_sites import supported_id
    download_check = verify_files([{'path': str(f)} for f in browser.downloads.iterdir() if f.is_file()])
    manifests = json.loads((Path(__file__).parent / 'attachment-manifests.json').read_text(encoding='utf-8'))
    expected = manifests['sites'].get(recipe.get('id'))
    inventory = []
    if expected is None:
        download_check['status'] = 'unverified'
        download_check['issues'].append('Expected attachment inventory is not declared for this site')
    else:
        for item in expected:
            found = [f.name for f in browser.downloads.iterdir() if f.is_file() and re.search(item['pattern'], f.name, re.I)]
            inventory.append({'id': item['id'], 'required': item['required'], 'state': 'parsed' if found and download_check['status'] == 'complete' else 'downloaded' if found else 'missing', 'files': found})
            if item['required'] and not found:
                download_check['status'] = 'partial'
                download_check['issues'].append('Required attachment missing: ' + item['id'])
    checkpoint['attachmentInventory'] = inventory
    return {"status": "succeeded", "message": reason, "resultUrl": evidence["url"], "checkpoint": checkpoint, "artifacts": artifacts, "archive": archive, "completeness": {"visual": archive.get("visual", {}).get("status", "unverified"), "downloads": download_check['status'], 'downloadIssues': download_check['issues']}, "evidence": {"verified": True, "method": "site-markers-input-binding-and-file-parsers", "customVerifier": supported_id(recipe), "recipeVersion": recipe.get("version"), "url": evidence["url"], "inputSha256": checkpoint.get("inputSha256")}}


def run_site(payload, emit, control):
    from vendor.jev_ultrafast import Agent
    from .browser import WorkflowBrowser, HumanRequired

    node, root = payload["node"], Path(payload["runDir"]).resolve()
    recipe = dict(payload["recipe"])
    recipe.setdefault("entryUrl", node.get("entryUrl"))
    recipe.setdefault("inputPattern", "sequence|fasta|identifier|accession|query|file|structure|tree")
    recipe.setdefault("submitPattern", "submit|run|search|predict|upload|start")
    recipe.setdefault("outputs", [])
    from .custom_sites import supported_id
    if supported_id(recipe) == 'quickgo':
        recipe.update(lookup=True, identifierUrl='https://www.ebi.ac.uk/QuickGO/term/{identifier}')
    work = root / "nodes" / node["id"] / f"attempt-{payload['run']['attempts']}"
    work.mkdir(parents=True, exist_ok=True)
    source = scoped(root, payload["input"]["path"])
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != payload["input"]["sha256"]:
        raise ValueError("Bound input changed after its checkpoint")
    validate_content(payload["input"]["kind"], data)
    # Textareas normalize line endings; uploads preserve the original bytes.
    input_value = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    if supported_id(recipe) in {'protparam', 'protscale'}:
        # These official fields accept residues; the accession field must stay
        # empty. Preserve the original FASTA fingerprint and every residue.
        input_value = ''.join(line.strip() for line in input_value.splitlines() if not line.startswith('>'))
    if recipe.get("identifierUrl") and payload["input"]["kind"] == "identifier":
        recipe["entryUrl"] = recipe["identifierUrl"].replace("{identifier}", quote(input_value.strip(), safe=""))
    checkpoint = dict(payload["run"].get("checkpoint") or {})
    # Older checkpoints may have the receipt on NodeRun, before it was copied
    # into the browser checkpoint. Never fall back to the submission entry.
    receipt = checkpoint.get('resultUrl') or payload['run'].get('resultUrl')
    if receipt and receipt != recipe['entryUrl'] and urlparse(receipt).hostname in recipe['allowedHosts']:
        checkpoint['resultUrl'] = receipt
    input_hash = hashlib.sha256(data).hexdigest()
    from .receipts import parameter_hash
    if (checkpoint.get('submitted') or checkpoint.get('effectPending')) and (
        checkpoint.get('inputSha256', input_hash) != input_hash or
        checkpoint.get('submission', {}).get('parametersSha256', parameter_hash(node.get('parameters', {}))) != parameter_hash(node.get('parameters', {}))
    ):
        return {'status': 'needs_review', 'message': 'Stored submission input or parameters changed; reconcile the original job', 'checkpoint': checkpoint}
    checkpoint["inputSha256"] = input_hash
    browser = None
    phase = "input"
    feedback = []

    def reconsider(message):
        from vendor.jev_ultrafast.browser import StalePage
        feedback.append(message)
        if len(feedback) > 4:
            raise HumanRequired(message)
        raise StalePage(message)

    def save(**values):
        checkpoint.update(values)
        if browser:
            checkpoint.update(browser.checkpoint())
        reply = emit({"type": "checkpoint", "checkpoint": checkpoint})
        if reply and (reply.get("pause") or reply.get("cancel")):
            control["pause"] = True

    def capture_receipt(evidence):
        from .receipts import observed_receipt
        if not checkpoint.get('submitted') and not checkpoint.get('effectPending'):
            return
        ready = verify_result(recipe, evidence, checkpoint, input_value)[0]
        receipt = observed_receipt(recipe, evidence, checkpoint, results_ready=ready)
        if receipt:
            save(**receipt)

    def stop_if_requested():
        if control.get("pause") or control.get("cancel"):
            raise PauseRequested()

    def resolve(action, page):
        return resolve_exact_value(action, page, recipe, node.get('parameters', {}), input_value, source)

    def before(action, page, value):
        nonlocal phase
        phase = "waiting" if checkpoint.get("submitted") else "input"
        stop_if_requested()
        if checkpoint.get('effectPending'):
            raise HumanRequired('Submission receipt is still uncertain; reconcile the original job before further actions')
        if checkpoint.get('inputVerified') and action['kind'] == 'click' and matches(r'^(?:clear|reset)(?:\s+(?:form|file|sequence|input))?$', action['label']):
            raise HumanRequired('Reset would invalidate the verified input binding')
        submit_control = matches(recipe['submitPattern'], action['label']) or (action.get('formSubmit') and not recipe.get('strictSubmitPattern'))
        possible_submit = action["kind"] == "click" and action.get("role") in {"button", "link"} and not action["label"].startswith("Open ") and submit_control and checkpoint.get("inputVerified")
        if possible_submit:
            owner = (checkpoint.get('boundField') or {}).get('formNode')
            if owner and action.get('formNode') and owner != action['formNode']:
                reconsider('This submit belongs to a different form. Use the analysis form containing the bound input.')
            invalid = browser.invalid_form_fields(action)
            if invalid:
                reconsider('Before submitting, satisfy required form controls: ' + ', '.join(field['label'][:180] for field in invalid))
            if checkpoint.get("submitted") and not recipe.get("lookup"):
                raise HumanRequired("A job was already submitted; do not submit it again")
            if checkpoint.get("effectPending"):
                raise HumanRequired("An earlier submit may have executed; reconcile the job first")
            bound = checkpoint.get('boundField')
            if bound and bound.get('kind') == 'fill':
                actual = browser.field_value(bound)
                from .input_check import compare_input
                mismatch = compare_input(input_value, actual, bound)
                if mismatch:
                    save(inputMismatch=mismatch)
                    raise HumanRequired(f"Bound input changed: expected {mismatch['expectedSequenceLength']} residues/bases, got {mismatch['actualSequenceLength']}; first difference {mismatch['firstDifference']}")
            evidence = browser.document_evidence()
            issue = email_form_issue(evidence['fields'], node.get('parameters', {}), node.get('emailNotification', {}))
            if issue:
                reconsider(issue)
            missing = []
            for parameter in recipe.get("parameters", []):
                expected = node.get("parameters", {}).get(parameter["id"])
                if expected is None or str(expected).strip() == "":
                    continue
                if not parameter_verified(parameter, expected, evidence["fields"], action["label"]):
                    missing.append(parameter["id"])
            if missing:
                reconsider("Before submitting, set these configured parameters on the form: " + ", ".join(missing))
            phase = "submit"
            from .receipts import prepare_submission
            save(**prepare_submission(checkpoint, node, recipe, action, evidence))
            stop_if_requested()
        elif action["kind"] == "click" and submit_control and not checkpoint.get("inputVerified"):
            # Navigation links can mention Search; form-submit buttons require a binding.
            if action.get("role") == "button":
                reconsider("Input has NOT been entered. Choose TYPE_TEXT on the sequence field or UPLOAD before submitting. The runtime supplies the full exact input.")

    def after(action, page, value):
        if action["kind"] == "fill" and value == input_value:
            actual = browser.field_value(action)
            # contenteditable.innerText omits the final newline. No biological
            # character, header or internal whitespace may otherwise change.
            from .input_check import compare_input
            mismatch = compare_input(input_value, actual, action)
            if mismatch:
                save(inputMismatch=mismatch)
                raise HumanRequired(f"Website input mismatch in {action.get('label', action.get('node'))}: expected {mismatch['expectedSequenceLength']} residues/bases, got {mismatch['actualSequenceLength']}; first difference {mismatch['firstDifference']}")
            save(inputVerified=True, boundField={'node':action['node'],'kind':'fill','formNode':action.get('formNode')}, boundBrowserContextId=browser.browser_context)
        elif action["kind"] == "upload":
            actual = browser.field_value(action)
            if not actual or len(actual) != 1 or actual[0]["size"] != len(data) or actual[0]["name"] != source.name:
                raise HumanRequired("File input could not be verified")
            save(inputVerified=True, boundField={'node':action['node'],'kind':'upload','formNode':action.get('formNode')}, boundBrowserContextId=browser.browser_context)
        if checkpoint.get("effectPending"):
            # A returned click is not a receipt. Read the existing result only;
            # leave uncertainty durable until a job ID or final data is observed.
            save(submitted=True)
            capture_receipt(browser.document_evidence())

    def rejected(_action, _page, _value):
        if checkpoint.get("effectPending"):
            submission = {**checkpoint.get('submission', {}), 'phase': 'prepared'}
            save(effectPending=False, intendedAction=None, submission=submission)

    try:
        downloads = task_download_directory(root, node['id'], checkpoint)
        browser = WorkflowBrowser(recipe["entryUrl"], checkpoint, recipe["allowedHosts"], downloads)
        if not recipe.get('experimental') or supported_id(recipe):
            # Built-in scientific fields have explicit bindings. Unconfigured
            # taxonomy/search/name fields must not invite model-generated values.
            def available_action(action, page):
                owner = (checkpoint.get('boundField') or {}).get('formNode')
                if action.get('formSubmit') and owner and action.get('formNode') != owner:
                    return False
                if recipe.get('id') == 'uniprot' and checkpoint.get('inputVerified') and not checkpoint.get('submitted') and action['kind']=='click' and normal(action['label'])=='blast':
                    return False  # Global navigation/help; the observed form control is Run BLAST.
                if action['kind'] == 'upload' and checkpoint.get('inputVerified'):
                    return False
                if action['kind'] == 'fill':
                    expected = resolve(action, page)
                    return expected is not None and str(action.get('value','')).rstrip('\n') != expected.rstrip('\n')
                return True
            browser.action_filter = available_action
        if not browser.restored_tab and checkpoint.get('submitted') and recipe.get('id') == 'string':
            raise HumanRequired('STRING browser session was lost; recover the original network and explicitly confirm any accession matches before resuming')
        if checkpoint.get('submitted') and recipe.get('id') == 'deeptmhmm' and not matches(r'/results/[a-f0-9-]{36}', checkpoint.get('resultUrl','')):
            raise HumanRequired('DeepTMHMM has no confirmed task result URL in this checkpoint; reconcile the original job before resuming')
        if not checkpoint.get('submitted') and (not browser.restored_tab or checkpoint.get('boundBrowserContextId') != browser.browser_context):
            checkpoint.update(inputVerified=False, boundField=None)
        save()
        if recipe.get("identifierUrl"):
            save(inputVerified=True, boundIdentifierUrl=recipe["entryUrl"])
        stop_if_requested()
        phase = "result" if checkpoint.get("submitted") else "input"
        browser._follow_owned_popup()
        evidence = browser.document_evidence()
        check_service_error(evidence)
        if recipe.get('id') == 'eggnog' and matches(r'Check your email to start your job', evidence['text']):
            save(resultUrl=evidence['url'], emailActivationRequired=True)
            raise HumanRequired('eggNOG sent a private start link to the configured email; open that link and reconcile this node before resuming')
        if recipe.get('id') == 'string' and matches(r'several matches for|Please select one from the list', evidence['text']):
            save(resultUrl=evidence['url'])
            raise HumanRequired('STRING returned multiple proteins for the accession; explicitly select the intended protein in the browser before resuming')
        if recipe.get('id') == 'deeptmhmm' and matches(r'Page not found', evidence['text']):
            save(resultUrl=evidence['url'])
            raise HumanRequired('DeepTMHMM file viewer returned Page not found for the submitted job; inspect the original result before resuming')
        if recipe.get('id') == 'jpred' and matches(r'Error\s*-\s*cluster error|Slurm status check failed', evidence['text']):
            save(resultUrl=evidence['url'])
            raise HumanRequired('JPred remote cluster failed: its Slurm job status API returned an error; no resubmission performed')
        if recipe.get("readyPattern") and not checkpoint.get("submitted"):
            deadline = time.monotonic() + 20
            while not matches(recipe["readyPattern"], evidence["text"]) and time.monotonic() < deadline:
                stop_if_requested()
                time.sleep(0.5)
                evidence = browser.document_evidence()
            if not matches(recipe["readyPattern"], evidence["text"]):
                raise HumanRequired("The configured entry did not expose its expected form/result; inspect the page before continuing")
        write_json(work / "initial-observation.json", {"url": evidence["url"], "title": evidence["title"], "text": evidence["text"][:100000]})
        if checkpoint.get("effectPending"):
            capture_receipt(evidence)
            if checkpoint.get("effectPending"):
                from .receipts import needs_reconciliation
                save(**needs_reconciliation(checkpoint))
                raise HumanRequired("Interrupted submission: inspect this tab and reconcile the remote job")
        if checkpoint.get("submitted"):
            # Navigate by GET only to recognized job URLs; never replay a POST.
            if checkpoint.get("resultUrl") and matches(recipe.get("pollUrlPattern"), checkpoint["resultUrl"]):
                browser.revisit_result(checkpoint["resultUrl"])
                evidence = browser.document_evidence()
            ok, _ = verify_result(recipe, evidence, checkpoint, input_value)
            if ok:
                collected = collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value)
                if not collected.get("missingDownloads"):
                    return collected
            if matches(recipe.get("blockPattern"), evidence["text"]):
                raise HumanRequired("Remote job requires login, verification, or service recovery")
            completed_list = recipe.get("id") == "interpro" and (any("Completed" in row for table in evidence.get("tables", []) for row in table) or matches(r'Status\s+Finished|Entries\s+\d+', evidence['text']))
            completed_list = completed_list or recipe.get('id') == 'mafft_web' and matches(r'mafft-[IR]\d{8}-', evidence['text'])
            completed_list = completed_list or recipe.get('id') == 'deeptmhmm' and matches(r'Result\s+Logs\s+Notes\s+Share\s+Download', evidence['text'])
            if not ok and not completed_list and not matches(recipe.get("completePattern"), evidence["text"]):
                return {"status": "waiting_remote", "message": "Rechecking the original remote job", "checkpoint": checkpoint, "resultUrl": evidence["url"]}
        goal = recipe["goal"] + "\nThe input is READY: " + payload["input"]["kind"] + f" ({len(data)} bytes). Select TYPE_TEXT on the sequence/accession field or UPLOAD on the file input. The runtime supplies the exact bound input automatically, even though the biological sequence is omitted from this goal. You have all input needed; do not choose BLOCKED for missing sequence content. Never generate a biological sequence. Confirmed parameters: " + json.dumps(node.get("parameters", {}), ensure_ascii=False) + "\nStop after one submission when the remote job is queued. On final results, obtain downloads, especially: " + ", ".join(recipe["outputs"]) + ". Do not change unspecified scientific options, log in, purchase, or send messages."
        if recipe["input"] == "identifier":
            goal += "\nRequested identifier: " + input_value.strip()
        base_goal = recipe["goal"] + "\nConfirmed parameters: " + json.dumps(node.get("parameters", {}), ensure_ascii=False)
        def phase_goal(evidence):
            correction = '\nRequired correction: ' + feedback[-1] if feedback else ''
            if verify_result(recipe, evidence, checkpoint, input_value)[0]:
                return base_goal + "\nThe correct final result is ALREADY OPEN and independently verified. Only collect its individual output files now. Do not type into search or leave this result page. Open the entry's Download files menu and select PDB/mmCIF if a structure is required. Required outputs: " + ", ".join(recipe["outputs"])
            if checkpoint.get("submitted"):
                hint = '\nThe job is finished when Status says Finished. Open its sequence-row link, then the Entries tab to view actual IPR/PF annotations. The Sequence tab only shows input. Scroll to the row if necessary.' if recipe.get('id') == 'interpro' else ''
                if recipe.get('id') == 'mafft_web': hint = '\nOpen the exact mafft job link from Recent Jobs, then download the Pearson/FASTA alignment.'
                if recipe.get('id') == 'deeptmhmm': hint = '\nOpen Result or View files to inspect predicted topology. Download the actual prediction files. Generic application descriptions are not prediction results.'
                return base_goal + "\nThe task is ALREADY SUBMITTED. Observe the job status or open its results. Never resubmit or change the input." + hint
            if checkpoint.get("inputVerified"):
                outstanding = [f"{p['id']}={node.get('parameters',{}).get(p['id'])}" for p in recipe.get('parameters',[]) if node.get('parameters',{}).get(p['id']) not in (None,'') and not parameter_verified(p,node['parameters'][p['id']],evidence.get('fields',[]))]
                if not outstanding:
                    return f"Submit the already-filled {recipe.get('name',recipe.get('id','analysis'))} form exactly once. The input and ALL configured parameters are verified. Do not type or alter fields. Find the submission control matching {recipe['submitPattern']}. If it is below the viewport, scroll DOWN inside the form panel; dismiss cookie banners that cover it. The global navigation and help links do not submit. A usable scroll control means you can still progress; do not stop before inspecting below the fold." + correction
                return base_goal + "\nThe biological sequence/file is ALREADY VERIFIED; preserve it. Other parameter fields must still be filled or selected. Outstanding configured fields: " + ', '.join(outstanding) + ". Use TYPE_TEXT for empty configured fields (the runtime provides exact values), CLICK for configured checkbox choices. Scroll to locate missing fields and Submit. Submit once all fields are satisfied. Global navigation search does not run the analysis." + correction
            return goal + correction
        limits = node.get("limits", {})
        agent = Agent(recipe["entryUrl"], phase_goal(evidence), browser=browser, text_resolver=resolve, before_action=before, after_action=after, rejected_action=rejected,
                      max_actions=limits.get("maxActions", 60), max_decisions=limits.get("maxDecisions", 120))
        for state in agent.run():
            stop_if_requested()
            with (work / "decisions.jsonl").open("a", encoding="utf-8") as trace:
                trace.write(json.dumps({"status": state["status"], "url": state["page"]["url"], "decisions": len(state["decisions"]), "lastDecision": state["decisions"][-1].get("choice") if state["decisions"] else None, "lastAction": state["history"][-1]["action"] if state["history"] else None, "available": [{"kind": a["kind"], "label": a["label"]} for a in state["page"]["actions"]]}, ensure_ascii=False) + "\n")
            emit({"type": "progress", "message": state["history"][-1]["action"] if state["history"] else state["status"], "actions": len(state["history"]), "decisions": len(state["decisions"])})
            evidence = browser.document_evidence()
            capture_receipt(evidence)
            check_service_error(evidence)
            if recipe.get('id') == 'eggnog' and matches(r'Check your email to start your job', evidence['text']):
                save(resultUrl=evidence['url'], emailActivationRequired=True)
                raise HumanRequired('eggNOG sent a private start link to the configured email; open that link and reconcile this node before resuming')
            if recipe.get('id') == 'string' and matches(r'several matches for|Please select one from the list', evidence['text']):
                save(resultUrl=evidence['url'])
                raise HumanRequired('STRING returned multiple proteins for the accession; explicitly select the intended protein in the browser before resuming')
            agent.state["goal"] = phase_goal(evidence)
            browser.assert_url(evidence["url"])
            result_url = evidence["url"] if evidence["url"] != recipe["entryUrl"] else None
            job = re.search(recipe["jobPattern"], evidence["url"] + "\n" + evidence["text"], re.I) if recipe.get("jobPattern") else None
            if recipe.get('id') in {'blastn', 'blastp', 'psi_blast'}:
                job = re.search(r'\bRID[\s:=-]+([A-Z0-9]{8,20})\b', evidence['text'], re.I) or job
                if job:
                    # RID is an observed submission receipt, not a model-generated ID.
                    result_url = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=' + quote(job.group(1))
            if checkpoint.get("submitted"):
                save(resultUrl=result_url or checkpoint.get("resultUrl"), jobId=job.group(1) if job else checkpoint.get("jobId"))
                pending_text = "\n".join("\n".join("\t".join(row) for row in table) for table in evidence.get("tables", [])) if recipe.get("pendingInTables") else evidence["text"]
                if matches(recipe.get("pendingPattern"), pending_text):
                    return {"status": "waiting_remote", "message": "Remote job submitted; browser worker released", "checkpoint": checkpoint, "resultUrl": result_url}
                if job and not verify_result(recipe, evidence, checkpoint, input_value)[0]:
                    return {'status':'waiting_remote','message':'Remote receipt saved; awaiting verified results','checkpoint':checkpoint,'resultUrl':result_url}
            if matches(recipe.get("blockPattern"), evidence["text"]):
                raise HumanRequired("Website requires login/verification or is unavailable")
            ok, _ = verify_result(recipe, evidence, checkpoint, input_value)
            if ok:
                collected = collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value)
                if not collected.get("missingDownloads"):
                    return collected
        write_json(work / "final-observation.json", {"url": evidence["url"], "title": evidence["title"], "text": evidence["text"][:100000], "tables": evidence["tables"]})
        if verify_result(recipe, evidence, checkpoint, input_value)[0]:
            return collect_result(browser, root, work, node, recipe, evidence, checkpoint, input_value)
        return {"status": "needs_review", "message": verify_result(recipe, evidence, checkpoint, input_value)[1], "checkpoint": checkpoint, "resultUrl": evidence["url"], "failure": {"stage": "result", "category": "verification", "recoverable": True}}
    except RemoteServiceError as exc:
        return {"status": "needs_review" if checkpoint.get("submitted") else "failed", "message": str(exc), "checkpoint": checkpoint, "failure": {"stage": "waiting" if checkpoint.get("submitted") else "navigation", "category": "remote_service", "recoverable": True}}
    except PauseRequested:
        return {"status": "paused", "message": "Paused at an action boundary", "checkpoint": checkpoint}
    except HumanRequired as exc:
        if browser:
            browser.activate()
        return {"status": "needs_review" if checkpoint.get("effectPending") else "waiting_human", "message": str(exc), "checkpoint": checkpoint, "failure": {"stage": "submit" if checkpoint.get("effectPending") else phase, "category": "input_mismatch" if checkpoint.get("inputMismatch") else "needs_action", "details": checkpoint.get("inputMismatch")}}
    except Exception as exc:
        # A timed-out click can still have created a job. Inspect once, without
        # replaying any input, and persist any observable receipt before exit.
        if checkpoint.get('effectPending'):
            if browser:
                try:
                    capture_receipt(browser.document_evidence())
                except Exception:
                    pass
            if checkpoint.get('effectPending'):
                from .receipts import needs_reconciliation
                save(**needs_reconciliation(checkpoint))
        uncertain = bool(checkpoint.get("effectPending"))
        return {"status": "needs_review" if uncertain else "failed", "message": type(exc).__name__ + ": " + str(exc)[:1600], "checkpoint": checkpoint,
                "failure": {"stage": "submit" if uncertain else phase, "category": "browser_timeout" if "timeout" in type(exc).__name__.lower() or "timed out" in str(exc).lower() else "executor", "recoverable": True}}
    finally:
        if browser:
            browser.close()
