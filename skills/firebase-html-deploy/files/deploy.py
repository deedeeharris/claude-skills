#!/usr/bin/env python3
"""Deploy an HTML file to Firebase Hosting (token-gated GCS-backed).

Usage:
  python deploy.py --config config.json --namespace myproject --html page.html
  python deploy.py --config config.json --namespace myproject --html page.html --title "My Dashboard"

Config file format (config.json):
  {
    "project_id": "my-firebase-project",
    "storage_bucket": "my-firebase-project.firebasestorage.app",
    "token_salt": "<64-char hex string from: openssl rand -hex 32>",
    "service_account_json": { ...full SA key JSON... }
  }

Output (JSON):
  {"unique_url": "https://...", "latest_url": "https://..."}
"""
import argparse
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timezone

try:
    from google.cloud import storage
    from google.oauth2 import service_account
except ImportError:
    print("ERROR: Missing dependencies. Run:\n  pip install google-cloud-storage google-auth", file=sys.stderr)
    sys.exit(1)

_GCS_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _namespace_token(namespace: str, salt: str) -> str:
    """Stable 12-char hex path component. Never changes for a given namespace."""
    return hashlib.sha256(f"{namespace}{salt}".encode()).hexdigest()[:12]


def _access_token(namespace_token: str, salt: str) -> str:
    """16-char HMAC token. Must match the Cloud Function's derivation logic."""
    return hmac.new(salt.encode(), namespace_token.encode(), hashlib.sha256).hexdigest()[:16]


def _make_deploy_id() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(3).hex()


def deploy_html(namespace: str, html: str, project_id: str, sa_json: dict, salt: str, storage_bucket: str) -> dict:
    ns_token = _namespace_token(namespace, salt)
    acc_token = _access_token(ns_token, salt)
    deploy_id = _make_deploy_id()

    credentials = service_account.Credentials.from_service_account_info(sa_json, scopes=_GCS_SCOPES)
    client = storage.Client(credentials=credentials, project=project_id)
    bucket = client.bucket(storage_bucket)

    html_bytes = html.encode("utf-8")
    unique_path = f"pages/{ns_token}/{deploy_id}/index.html"
    latest_path = f"pages/{ns_token}/latest/index.html"

    unique_blob = bucket.blob(unique_path)
    unique_blob.upload_from_string(html_bytes, content_type="text/html; charset=utf-8")
    print(f"Uploaded: gs://{storage_bucket}/{unique_path}", file=sys.stderr)

    try:
        bucket.blob(latest_path).upload_from_string(html_bytes, content_type="text/html; charset=utf-8")
        print(f"Uploaded: gs://{storage_bucket}/{latest_path}", file=sys.stderr)
    except Exception as e:
        try:
            unique_blob.delete()
            print("Rolled back unique upload after latest upload failed.", file=sys.stderr)
        except Exception:
            pass
        raise e

    base = f"https://{project_id}.web.app/pages/{ns_token}"
    token_param = f"?t={acc_token}"
    return {
        "unique_url": f"{base}/{deploy_id}/{token_param}",
        "latest_url": f"{base}/latest/{token_param}",
    }


def main():
    parser = argparse.ArgumentParser(description="Deploy HTML to Firebase Hosting")
    parser.add_argument("--config", required=True, help="Path to config.json")
    parser.add_argument("--namespace", required=True, help="Namespace label (e.g. 'myproject', 'john')")
    parser.add_argument("--html", required=True, help="Path to HTML file to deploy")
    parser.add_argument("--title", default="", help="Human-readable title (logged only)")
    args = parser.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    with open(args.html, encoding="utf-8") as f:
        html = f.read()

    result = deploy_html(
        namespace=args.namespace,
        html=html,
        project_id=cfg["project_id"],
        sa_json=cfg["service_account_json"],
        salt=cfg["token_salt"],
        storage_bucket=cfg["storage_bucket"],
    )

    if args.title:
        print(f"Deployed: {args.title}", file=sys.stderr)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
