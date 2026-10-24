"""Deterministic checks for the original public tools in the 26-item study."""
from collections import Counter
from urllib.parse import urlparse
import re


def supported_id(recipe):
    url = urlparse(recipe.get('entryUrl', ''))
    if url.hostname == 'www.ebi.ac.uk' and re.fullmatch(r'/QuickGO/term/GO(?::|%3A)\d{7}', url.path, re.I):
        return 'quickgo'
    return {
        ('www.bioinformatics.org', '/sms2/dna_stats.html'): 'dna_stats',
        ('www.bioinformatics.org', '/sms2/codon_usage.html'): 'codon_usage',
        ('web.expasy.org', '/protparam/'): 'protparam',
        ('web.expasy.org', '/protscale/'): 'protscale',
        ('www.ebi.ac.uk', '/QuickGO/'): 'quickgo',
    }.get((url.hostname, url.path))


def verify_custom(recipe, evidence, input_value):
    site = supported_id(recipe)
    text = evidence['text']
    sequence = ''.join(line.strip() for line in input_value.splitlines() if not line.startswith('>')).upper()
    if site == 'dna_stats':
        counts = {base.upper(): int(count) for base, count in re.findall(r'(?m)^([acgt])\s+(\d+)\s+[\d.]+', text)}
        ok = 'DNA Stats results' in text and f'{len(sequence)} residue sequence' in text and counts == dict(Counter(sequence))
    elif site == 'codon_usage':
        counts = {codon: int(float(count)) for codon, count in re.findall(r'(?m)^\w+\s+([ACGT]{3})\s+(\d+\.\d+)', text)}
        expected = Counter(sequence[i:i+3] for i in range(0, len(sequence), 3))
        ok = 'Codon Usage results' in text and len(counts) == 64 and all(counts[k] == expected[k] for k in counts)
    elif site in {'protparam', 'protscale'}:
        block = text.split('User-provided sequence:')[-1].split('[Documentation')[0].split('Sequence length:')[0]
        shown = ''.join(re.findall(r'(?m)^[A-Z ]+$', block)).replace(' ', '')
        ok = shown == sequence and (bool(re.search(r'Number of amino acids:\s*' + str(len(sequence)) + r'\b', text)) and all(x in text for x in ['Molecular weight:', 'Theoretical pI:', 'Amino acid composition:']) if site == 'protparam' else all(x in text for x in ['ProtScale - Results', 'Kyte & Doolittle', 'Numerical format']))
    elif site == 'quickgo':
        ok = input_value.strip() in text and all(x in text.lower() for x in ['definition', 'molecular function'])
    else:
        return False, 'Custom site outcome needs a configured verifier'
    return ok, 'Official result and bound input independently verified' if ok else 'Official result content does not match the bound input'
