"""Code-owned scientific checks for imported official outputs. No model flags."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

from .artifacts import fasta_records, validate_content


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sequence(data):
    records = fasta_records(data.decode('utf-8-sig'))
    require(len(records) == 1, 'Expected exactly one bound input sequence')
    return records[0][0].split()[0], records[0][1]


def interpro(files, data, parameters, context):
    _, seq = sequence(data)
    payload = json.loads(one(files, lambda p: p.suffix.lower() == '.json').read_text(encoding='utf-8-sig'))
    require(len(payload.get('results', [])) == 1, 'InterPro must contain one result sequence')
    record = payload['results'][0]
    require(record.get('sequence', '').upper() == seq, 'InterPro sequence differs from bound input')
    require(record.get('md5', '').lower() == hashlib.md5(seq.encode()).hexdigest(), 'InterPro MD5 differs from bound sequence')
    require(isinstance(record.get('matches'), list), 'InterPro matches are missing')
    for match in record['matches']:
        require(bool(match.get('signature', {}).get('accession')), 'InterPro signature is missing')
        for loc in match.get('locations', []):
            require(1 <= loc['start'] <= loc['end'] <= len(seq), 'InterPro domain lies outside the input')
    return {'sequenceMatches': True, 'matches': len(record['matches']), 'toolVersion': payload.get('interproscan-version')}


def one(files, predicate):
    candidates = [p for p in files if predicate(p)]
    require(len(candidates) == 1, 'Required scientific file is missing or ambiguous')
    return candidates[0]


def blast(files, data, parameters, context):
    name, seq = sequence(data)
    root = ET.parse(one(files, lambda p: p.suffix.lower() == '.xml')).getroot()
    program = context['executor']
    require(root.findtext('BlastOutput_program') == program, 'BLAST program mismatch')
    require((root.findtext('BlastOutput_query-def') or '').split()[0] == name, 'BLAST query identifier mismatch')
    require(int(root.findtext('BlastOutput_query-len', '0')) == len(seq), 'BLAST query length mismatch')
    db = parameters.get('database')
    db = {'ClusteredNR': 'clustered_nr', 'nr': 'nr', 'core_nt': 'core_nt'}.get(db, db)
    require(bool(db) and root.findtext('BlastOutput_db') == db, 'BLAST database mismatch or missing configured database')
    coverage, count = set(), 0
    for hsp in root.findall('.//Hsp'):
        a, b = int(hsp.findtext('Hsp_query-from')), int(hsp.findtext('Hsp_query-to'))
        require(1 <= min(a, b) <= max(a, b) <= len(seq), 'BLAST coordinates outside input')
        expected = seq[min(a, b)-1:max(a, b)]
        if a > b:
            require(program == 'blastn', 'Reverse protein query coordinates')
            expected = expected.translate(str.maketrans('ACGTRYMKBDHVN', 'TGCAYRKMVHDBN'))[::-1]
        require(hsp.findtext('Hsp_qseq', '').replace('-', '').upper() == expected, 'BLAST query residues differ from bound input')
        require(math.isfinite(float(hsp.findtext('Hsp_evalue'))) and float(hsp.findtext('Hsp_evalue')) >= 0, 'Invalid BLAST expectation')
        coverage.update(range(min(a, b), max(a, b)+1)); count += 1
    # Length/name alone cannot establish identity for no-hit or partial queries.
    require(len(coverage) == len(seq), 'BLAST does not prove the complete query sequence; retain unverified')
    return {'querySegmentsChecked': count, 'queryResiduesChecked': len(coverage), 'database': db}


def musite(files, data, parameters, context):
    name, seq = sequence(data)
    source = one(files, lambda p: p.suffix.lower() == '.zip')
    with zipfile.ZipFile(source) as bundle:
        require(bundle.testzip() is None, 'Corrupt Musite ZIP')
        text = bundle.read('Prediction_results.txt').decode('utf-8-sig')
    require('>' + name in text.splitlines(), 'Musite query identifier mismatch')
    rows = list(csv.DictReader([line for line in text.splitlines() if not line.startswith('>')], delimiter='\t'))
    positions = set()
    for row in rows:
        pos = int(row['Position'])
        require(row['ID'] == name and 1 <= pos <= len(seq) and seq[pos-1] == row['Residue'], 'Musite predicted residue differs from input')
        require(pos not in positions, 'Duplicate Musite position'); positions.add(pos)
        scores = dict(value.split(':') for value in row['PTMscores'].split(';'))
        scores = {k: float(v) for k, v in scores.items()}
        require(all(math.isfinite(v) and 0 <= v <= 1 for v in scores.values()), 'Musite score outside probability range')
        cutoff_key = one_key(row, 'Cutoff=')
        cutoff = float(cutoff_key.split('=')[1])
        require(cutoff == float(parameters.get('threshold', cutoff)), 'Musite cutoff differs from configured threshold')
        accepted = {} if row[cutoff_key] == 'None' else {k: float(v) for k, v in (value.split(':') for value in row[cutoff_key].split('|'))}
        require(accepted == {k: v for k, v in scores.items() if v > cutoff}, 'Musite cutoff summary is inconsistent')
    require(positions == {i+1 for i, residue in enumerate(seq) if residue in 'STYNKRCQP'}, 'Musite candidate positions are incomplete')
    # Sparse PTM files omit other residues. Bind them additionally to the original
    # owned download and input checkpoint; never infer full identity from length.
    require(context.get('ownedDownloadMatches') and context.get('inputVerified'), 'Musite sparse output requires the original input-bound download')
    return {'positionsValidated': len(positions), 'association': 'original-input-bound-download-and-predicted-residues', 'scope': 'computational prediction'}


def one_key(row, prefix):
    keys = [key for key in row if key.startswith(prefix)]
    require(len(keys) == 1, 'Missing or ambiguous result column')
    return keys[0]


def hmmer(files, data, parameters, context):
    _, seq = sequence(data)
    payloads = [json.loads(p.read_text(encoding='utf-8-sig')) for p in files if p.suffix.lower() == '.json']
    payload = next((p for p in payloads if isinstance(p, dict) and 'input' in p and 'task' in p), None)
    require(payload is not None and payload['task'].get('status') == 'SUCCESS', 'HMMER successful search receipt missing')
    require(sequence(payload['input'].encode())[1] == seq, 'HMMER query sequence mismatch')
    expected = {'Reference Proteomes': 'refprot'}.get(parameters.get('database'), parameters.get('database'))
    require(bool(expected) and payload.get('database', {}).get('id') == expected, 'HMMER database mismatch')
    return {'inputSequenceMatches': True, 'reportedHits': payload.get('number_of_hits'), 'database': expected}


def alignment(files, data, parameters, context):
    source = fasta_records(data.decode('utf-8-sig'))
    output = one(files, lambda p: p.suffix.lower() in {'.fasta', '.fa', '.aln-fasta'})
    validate_content('alignment_fasta', output.read_bytes(), aligned=True)
    records = fasta_records(output.read_text(encoding='utf-8-sig'))
    canonical = lambda records: Counter((name.split()[0], seq.replace('-', '').replace('.', '')) for name, seq in records)
    require(canonical(source) == canonical(records), 'Alignment identifiers or ungapped sequences differ from input')
    return {'sequences': len(records), 'columns': len(records[0][1]), 'ungappedSequencesMatch': True}


VERIFIERS = {'interpro': interpro, 'blastp': blast, 'blastn': blast, 'musite': musite, 'hmmer': hmmer, 'mafft_web': alignment, 'mafft': alignment}


def verify_analysis(request):
    executor = request['executor']
    verifier = VERIFIERS.get(executor)
    if not verifier:
        return {'status': 'unverified', 'issues': ['No scientific verifier registered for ' + executor]}
    try:
        data = Path(request['input']['path']).read_bytes()
        require(hashlib.sha256(data).hexdigest() == request['input']['sha256'], 'Bound input bytes changed')
        files = []
        for record in request['files']:
            file = Path(record['path']); content = file.read_bytes()
            require(hashlib.sha256(content).hexdigest() == record['sha256'], 'Scientific file changed during verification')
            files.append(file)
        facts = verifier(files, data, request.get('parameters', {}), {**request.get('context', {}), 'executor': executor})
        return {'status': 'verified', 'validatorId': executor, 'facts': facts, 'issues': []}
    except (ValueError, KeyError, IndexError, TypeError, OSError, ET.ParseError, zipfile.BadZipFile) as error:
        return {'status': 'unverified', 'validatorId': executor, 'issues': [str(error)]}
