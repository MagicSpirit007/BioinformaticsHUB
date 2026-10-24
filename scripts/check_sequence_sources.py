"""Read-only public database probes; no model calls or analysis submissions."""
import json
import sys
from pathlib import Path
from workflow.resolver import resolve_sequence

root = Path(__file__).resolve().parents[1] / 'runs' / 'sequence-source-check'
root.mkdir(parents=True, exist_ok=True)
results = []
for args in [
    # Explicit dataset probes, not evidence for the source of a user's identifier.
    {'identifier': 'CCA0737S009', 'provider': 'gigadb'},
    {'identifier': 'CCA0737S0090', 'provider': 'gigadb'},
    {'identifier': 'P69905', 'provider': 'uniprot'},
    {'identifier': 'NP_000549.1', 'provider': 'ncbi'},
]:
    result = resolve_sequence(args, str(root / 'cache'))
    summary = {key: value for key, value in result.items() if key != 'fasta'}
    if result.get('fasta'):
        (root / (args['identifier'] + '.fasta')).write_text(result['fasta'], encoding='utf-8')
        summary['fastaBytes'] = len(result['fasta'].encode())
    results.append({'request': args, 'result': summary})
    print(json.dumps(results[-1]), flush=True)
(root / 'validation.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
if results[0]['result']['status'] != 'ambiguous' or any(row['result']['status'] != 'resolved' for row in results[1:]):
    raise SystemExit(1)
