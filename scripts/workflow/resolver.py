"""Sequence retrieval from identified records. Models never supply sequence bytes."""
from __future__ import annotations

import difflib
import gzip
import hashlib
import io
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing
from pathlib import Path

from .artifacts import fasta_records, validate_content

GIGADB = "https://s3.ap-northeast-1.wasabisys.com/gigadb-datasets/live/pub/10.5524/100001_101000/100571/"
NCBI = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
MAX_DOWNLOAD = 128 * 1024 * 1024


class SourceError(RuntimeError):
    pass


def fetch(url: str, limit=MAX_DOWNLOAD) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise ValueError("Sequence source must be an HTTPS URL without credentials")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "BioinformaticsHUB/0.7 (sequence retrieval)"})
        with urllib.request.urlopen(request, timeout=45) as response:
            if urllib.parse.urlparse(response.url).scheme != "https":
                raise SourceError("Sequence source redirected outside HTTPS")
            data = response.read(limit + 1)
        if len(data) > limit:
            raise SourceError("Reference download exceeds 128 MiB; supply a smaller CDS/protein library")
        return data
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return b""
        raise SourceError(f"Source returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SourceError("Source connection failed; no sequence was selected") from None


def species_matches(expected, actual):
    if expected is None or str(expected).strip() == "":
        return True
    aliases = {"山核桃": "carya cathayensis", "拟南芥": "arabidopsis thaliana", "chinese hickory": "carya cathayensis"}
    expected = aliases.get(str(expected).strip().lower(), str(expected).strip().lower())
    return not expected or expected == str(actual).strip().lower()


def reference_index(cache: Path, url: str, kind: str):
    """Atomic SQLite index stores the downloaded library once, without a genome download."""
    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256((url + kind).encode()).hexdigest()
    target = cache / (key + ".sqlite")
    if target.exists():
        return target, True
    data = fetch(url)
    if not data:
        raise SourceError("Reference library was not found")
    checksum = hashlib.sha256(data).hexdigest()
    text = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
    if len(text) > 512 * 1024 * 1024:
        raise SourceError("Uncompressed reference exceeds 512 MiB")
    records = fasta_records(text.decode("utf-8-sig"))
    temp = cache / (key + "." + uuid.uuid4().hex + ".tmp")
    try:
        with closing(sqlite3.connect(temp)) as db:
            db.execute("CREATE TABLE records (id TEXT PRIMARY KEY, header TEXT, sequence TEXT)")
            db.execute("CREATE TABLE metadata (value TEXT)")
            db.execute("INSERT INTO metadata VALUES (?)", (json.dumps({"url": url, "sourceSha256": checksum, "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}),))
            for header, sequence in records:
                identifier = header.split()[0]
                if identifier.count("|") >= 2:
                    identifier = identifier.split("|")[1]
                db.execute("INSERT INTO records VALUES (?,?,?)", (identifier, header, sequence))
            db.commit()
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return target, False


def from_library(args, cache, url, provider, species=None, version=None):
    kind = args.get("kind", "protein_fasta")
    index, cached = reference_index(cache, url, kind)
    query = args["identifier"]
    with closing(sqlite3.connect(index)) as db:
        meta = json.loads(db.execute("SELECT value FROM metadata").fetchone()[0])
        matches = db.execute("SELECT id,header,sequence FROM records WHERE id = ?", (query,)).fetchall()
        if not matches:
            ids = [row[0] for row in db.execute("SELECT id FROM records")]
            close = difflib.get_close_matches(query, ids, n=20, cutoff=0.75)
            return {"status": "ambiguous" if close else "not_found", "query": query,
                    "candidates": [{"identifier": i, "species": species, "provider": provider, "sourceUrl": url} for i in close],
                    "searched": [url], "actionRequired": "confirm_identifier" if close else "discover_source",
                    "message": "No exact record. Confirm the complete identifier; similar identifiers are not selected automatically.", "cached": cached}
        identifier, header, sequence = matches[0]
    if species and not species_matches(args.get("species"), species):
        return {"status": "ambiguous", "actionRequired": "confirm_species", "message": "The source species differs from the requested species", "candidates": [{"identifier": identifier, "species": species, "provider": provider}], "searched": [url]}
    fasta = f">{header}\n{sequence}\n"
    validate_content(kind, fasta.encode())
    return {"status": "resolved", "identifier": identifier, "kind": kind, "fasta": fasta,
            "provenance": {**meta, "sourceUrl": url, "provider": provider, "species": species, "databaseVersion": version,
                           "requestedIdentifier": query, "identifier": identifier, "sha256": hashlib.sha256(fasta.encode()).hexdigest()}, "cached": cached}


def uniprot(args, cache):
    query = args["identifier"]
    term = f"accession:{query}" if re.fullmatch(r"[A-Z0-9]{6,10}(?:-\d+)?", query) else f"gene_exact:{query}"
    if args.get("species"):
        species = {"拟南芥": "Arabidopsis thaliana", "山核桃": "Carya cathayensis"}.get(args["species"], args["species"])
        term += f' AND organism_name:"{species}"'
    url = "https://rest.uniprot.org/uniprotkb/search?" + urllib.parse.urlencode({"query": term, "format": "json", "size": 25, "fields": "accession,organism_name,gene_names,sequence"})
    raw = fetch(url, 4 * 1024 * 1024)
    rows = json.loads(raw or b'{"results":[]}').get("results", [])
    if len(rows) != 1:
        return {"status": "ambiguous" if rows else "not_found", "searched": [url], "actionRequired": "select_record" if rows else "discover_source",
                "candidates": [{"identifier": r["primaryAccession"], "species": r["organism"]["scientificName"], "provider": "uniprot"} for r in rows]}
    row = rows[0]
    accession_query = bool(re.fullmatch(r"[A-Z0-9]{6,10}(?:-\d+)?", query))
    if accession_query and row["primaryAccession"] != query:
        return {"status": "ambiguous", "actionRequired": "confirm_accession_or_isoform", "candidates": [{"identifier": row["primaryAccession"], "species": row["organism"]["scientificName"], "provider": "uniprot"}], "searched": [url]}
    detail_url = "https://rest.uniprot.org/uniprotkb/" + urllib.parse.quote(row["primaryAccession"], safe="") + ".json"
    row = json.loads(fetch(detail_url, 4 * 1024 * 1024))
    actual_species = row["organism"]["scientificName"]
    if not species_matches(args.get("species"), actual_species):
        return {"status": "ambiguous", "actionRequired": "confirm_species", "candidates": [{"identifier": row["primaryAccession"], "species": actual_species}]}
    fasta = f'>{row["primaryAccession"]}\n{row["sequence"]["value"]}\n'
    validate_content("protein_fasta", fasta.encode())
    return {"status": "resolved", "identifier": row["primaryAccession"], "kind": "protein_fasta", "fasta": fasta,
            "provenance": {"provider": "uniprot", "species": actual_species, "sourceUrl": detail_url, "requestedIdentifier": query,
                           "identifier": row["primaryAccession"], "databaseVersion": row.get("entryAudit", {}).get("entryVersion"),
                           "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sha256": hashlib.sha256(fasta.encode()).hexdigest()}}


def ncbi(args, cache):
    query = args["identifier"]
    if query.isdecimal():
        return {"status": "ambiguous", "actionRequired": "confirm_identifier_namespace", "query": query,
                "candidates": [], "searched": [], "message": "A bare number may be a Gene ID or a sequence UID. Provide a versioned protein/transcript accession or an identified FASTA source; no numeric namespace is assumed."}
    db = "nuccore" if args.get("kind") == "nucleotide_fasta" else "protein"
    term = query
    if args.get("species"):
        species = {"拟南芥": "Arabidopsis thaliana", "山核桃": "Carya cathayensis"}.get(args["species"], args["species"])
        term = f'({query}) AND "{species}"[Organism]'
    search = NCBI + "esearch.fcgi?" + urllib.parse.urlencode({"db": db, "term": term, "retmode": "json", "retmax": 25, "tool": "BioinformaticsHUB"})
    result = json.loads(fetch(search, 2 * 1024 * 1024))["esearchresult"]
    ids = result.get("idlist", [])
    if not ids:
        return {"status": "not_found", "searched": [search], "actionRequired": "discover_source", "candidates": []}
    summary_url = NCBI + "esummary.fcgi?" + urllib.parse.urlencode({"db": db, "id": ",".join(ids), "retmode": "json"})
    rows = json.loads(fetch(summary_url, 4 * 1024 * 1024))["result"]
    candidates = [{"identifier": rows[i].get("accessionversion", rows[i].get("caption", i)), "title": rows[i].get("title"), "taxid": rows[i].get("taxid"), "provider": "ncbi", "uid": i} for i in ids]
    # A keyword search is discovery, never proof that the only returned hit is the intended gene.
    exact = [c for c in candidates if query in {c["uid"], c["identifier"], c["identifier"].split(".")[0]}]
    if int(result.get("count", len(ids))) != 1 or len(exact) != 1:
        return {"status": "ambiguous", "actionRequired": "select_record", "searched": [search], "candidates": candidates, "total": int(result.get("count", len(ids)))}
    item = exact[0]
    url = NCBI + "efetch.fcgi?" + urllib.parse.urlencode({"db": db, "id": item["identifier"], "rettype": "fasta", "retmode": "text"})
    fasta = fetch(url, 10 * 1024 * 1024).decode("utf-8").strip() + "\n"
    kind = "nucleotide_fasta" if db == "nuccore" else "protein_fasta"
    validate_content(kind, fasta.encode())
    if fasta_records(fasta)[0][0].split()[0] != item["identifier"]:
        raise SourceError("Fetched accession does not match the selected record")
    organism = re.search(r"\[([^\[\]]+)\]\s*$", fasta_records(fasta)[0][0])
    return {"status": "resolved", "identifier": item["identifier"], "kind": kind, "fasta": fasta,
            "provenance": {"provider": "ncbi", "sourceUrl": url, "taxid": item["taxid"], "species": organism[1] if organism else None, "speciesFilter": args.get("species"),
                           "databaseVersion": item["identifier"], "requestedIdentifier": query, "identifier": item["identifier"],
                           "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sha256": hashlib.sha256(fasta.encode()).hexdigest()}}


def resolve_sequence(args: dict, cache_dir: str) -> dict:
    query = str(args.get("identifier", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", query):
        raise ValueError("Provide one gene identifier or accession")
    kind = args.get("kind", "protein_fasta")
    if kind not in {"protein_fasta", "nucleotide_fasta"}:
        raise ValueError("Sequence kind must be protein_fasta or nucleotide_fasta")
    args = {**args, "identifier": query, "kind": kind}
    cache = Path(cache_dir)
    provider = args.get("provider", "auto")
    try:
        if args.get("sourceUrl"):
            return from_library(args, cache, args["sourceUrl"], "custom", args.get("sourceSpecies"), args.get("sourceVersion"))
        # A project-local identifier prefix is not evidence of a species or source.
        # This dataset is used only when the caller explicitly selects it.
        if provider == "gigadb":
            return from_library(args, cache, GIGADB + ("Cca.cds.fa.gz" if kind == "nucleotide_fasta" else "Cca.pep.fa.gz"), "gigadb", "Carya cathayensis", "10.5524/100571 (2019-02-28)")
        if provider == "uniprot" or provider == "auto" and re.fullmatch(r"(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?", query):
            if kind != "protein_fasta":
                return {"status": "not_found", "actionRequired": "select_nucleotide_accession", "message": "UniProt provides protein sequences; select a linked nucleotide accession", "searched": ["UniProt"]}
            return uniprot(args, cache)
        if provider in {"auto", "ncbi"}:
            return ncbi(args, cache)
        raise ValueError("Unknown sequence provider")
    except SourceError as error:
        return {"status": "error", "code": "SOURCE_UNAVAILABLE", "message": str(error), "actionRequired": "retry_source", "query": query}
