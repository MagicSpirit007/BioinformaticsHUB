"""Exact input comparison with useful diagnostics, without biological rewriting."""
import hashlib


def normalized(value):
    return value.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n') if isinstance(value, str) else None


def compare_input(expected, actual, field=None):
    left, right = normalized(expected), normalized(actual)
    if left == right:
        return None
    def sequence(value):
        return ''.join(line.strip() for line in (value or '').splitlines() if not line.startswith('>'))
    at = next((i for i, pair in enumerate(zip(left or '', right or '')) if pair[0] != pair[1]), min(len(left or ''), len(right or '')))
    return {'field': {k: v for k, v in (field or {}).items() if k in ('node', 'label', 'formNode', 'kind')},
            'expectedCharacters': len(left or ''), 'actualCharacters': len(right or ''),
            'expectedSequenceLength': len(sequence(left)), 'actualSequenceLength': len(sequence(right)),
            'firstDifference': at, 'expectedExcerpt': (left or '')[max(0, at-12):at+12],
            'actualExcerpt': (right or '')[max(0, at-12):at+12],
            'expectedSha256': hashlib.sha256((left or '').encode()).hexdigest(),
            'actualSha256': hashlib.sha256((right or '').encode()).hexdigest()}
