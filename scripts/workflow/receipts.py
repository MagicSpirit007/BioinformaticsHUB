"""Submission intents and observed receipts, independent of browser lifetime."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import quote, urlparse


def now():
    return datetime.now(timezone.utc).isoformat()


def parameter_hash(parameters):
    return hashlib.sha256(json.dumps(parameters, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def prepare_submission(checkpoint, node, recipe, action, evidence):
    """Persist this value and await the controller ACK before sending any input."""
    if checkpoint.get("effectPending") or checkpoint.get("submitted"):
        raise ValueError("Existing submission must be reconciled before a new attempt")
    return {
        "effectPending": True,
        "intendedAction": action["label"],
        "preSubmitUrl": evidence["url"],
        "preSubmitTextHash": hashlib.sha256(evidence.get("text", "").encode()).hexdigest(),
        "submission": {
            "version": 1, "phase": "submitting", "attemptId": uuid.uuid4().hex,
            "nodeId": node["id"], "siteId": recipe.get("id"),
            "inputSha256": checkpoint["inputSha256"],
            "parametersSha256": parameter_hash(node.get("parameters", {})),
            "preparedAt": now(), "action": action["label"],
        },
    }


def observed_receipt(recipe, evidence, checkpoint, *, results_ready=False):
    """Accept only an observed job marker or independently validated final data."""
    url = evidence.get("url", "")
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or parsed.hostname not in recipe["allowedHosts"] or parsed.username or parsed.password:
        return {}
    text = evidence.get("text", "")
    match = re.search(recipe["jobPattern"], url + "\n" + text, re.I) if recipe.get("jobPattern") else None
    job_id = match.group(1) if match and match.lastindex else None
    if recipe.get("id") in {"blastn", "blastp", "psi_blast"}:
        rid = re.search(r"\bRID[\s:=-]+([A-Z0-9]{8,20})\b", text, re.I)
        job_id = rid.group(1) if rid else job_id
        if job_id:
            url = "https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID=" + quote(job_id)
    if not job_id and not results_ready:
        return {}
    # A form URL alone cannot restore a POST result in a new browser. Keep the
    # job ID, but do not turn the entry URL into a purported recoverable receipt.
    result_url = url if url != recipe["entryUrl"] else None
    submission = dict(checkpoint.get("submission") or {})
    submission.update(phase="results_ready" if results_ready else "receipt_known", receiptAt=now(), jobId=job_id or checkpoint.get("jobId"), resultUrl=result_url)
    return {"effectPending": False, "submitted": True, "jobId": job_id or checkpoint.get("jobId"),
            "resultUrl": result_url, "submission": submission}


def needs_reconciliation(checkpoint):
    submission = dict(checkpoint.get("submission") or {})
    submission.update(phase="needs_reconciliation", interruptedAt=now())
    return {"effectPending": True, "submission": submission}
