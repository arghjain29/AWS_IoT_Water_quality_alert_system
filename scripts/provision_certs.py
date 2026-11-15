# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.35"]
# ///
"""
Create one X.509 certificate per station and connect it to AWS IoT.

For each station this script:
  1. asks AWS IoT to create a certificate + private key
  2. saves them in certs/<deviceId>/ (git-ignored), readable only by you
  3. attaches the device policy (what the device is allowed to do)
  4. attaches the certificate to the station's IoT thing (who the device is)

Private keys never go into Terraform state, outputs or Git.
Safe to re-run: stations that already have a working certificate are skipped.

Run from the repo root after `terraform apply`:
    uv run scripts/provision_certs.py
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
CERTS = ROOT / "certs"
CA_URL = "https://www.amazontrust.com/repository/AmazonRootCA1.pem"


def restrict_to_current_user(path):
    """Make a file readable/writable only by the current user."""
    if os.name == "nt":
        user = os.environ["USERNAME"]
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(R,W)"],
                       check=True, capture_output=True)
    else:
        os.chmod(path, 0o600)


def has_working_certificate(iot, thing, folder):
    id_file = folder / "certificate-id.txt"
    files = [folder / "certificate.pem.crt", folder / "private.pem.key", id_file]
    if not all(f.is_file() for f in files):
        return False
    cert_id = id_file.read_text().strip()
    try:
        desc = iot.describe_certificate(certificateId=cert_id)["certificateDescription"]
    except ClientError:
        return False
    attached = iot.list_thing_principals(thingName=thing)["principals"]
    return desc["status"] == "ACTIVE" and desc["certificateArn"] in attached


def main():
    parser = argparse.ArgumentParser(description="Provision IoT device certificates")
    parser.add_argument("--region", default="ap-south-1")
    parser.add_argument("--policy", default="wq-dev-device-policy", help="IoT policy name (terraform output iot_policy_name)")
    args = parser.parse_args()

    iot = boto3.client("iot", region_name=args.region)
    stations = json.loads((ROOT / "config" / "stations.json").read_text(encoding="utf-8"))["stations"]
    CERTS.mkdir(exist_ok=True)

    ca = CERTS / "AmazonRootCA1.pem"
    if not ca.is_file():
        print(f"downloading Amazon Root CA 1 -> {ca}")
        with urllib.request.urlopen(CA_URL, timeout=30) as response:
            ca.write_bytes(response.read())

    iot.get_policy(policyName=args.policy)  # fails clearly if Terraform hasn't been applied

    for station in stations:
        thing = station["deviceId"]
        folder = CERTS / thing
        folder.mkdir(exist_ok=True)

        if has_working_certificate(iot, thing, folder):
            print(f"{thing}: certificate already active and attached, skipping")
            continue
        if (folder / "private.pem.key").exists():
            sys.exit(f"{thing}: {folder} has files but they don't match an active, attached certificate. "
                     "Inspect it (or run scripts/remove_certs.py) before re-provisioning.")

        iot.describe_thing(thingName=thing)  # the thing must exist (created by Terraform)
        cert = iot.create_keys_and_certificate(setAsActive=True)

        (folder / "certificate.pem.crt").write_text(cert["certificatePem"])
        key_file = folder / "private.pem.key"
        key_file.write_text(cert["keyPair"]["PrivateKey"])
        restrict_to_current_user(key_file)
        (folder / "certificate-id.txt").write_text(cert["certificateId"])

        iot.attach_policy(policyName=args.policy, target=cert["certificateArn"])
        iot.attach_thing_principal(thingName=thing, principal=cert["certificateArn"])
        print(f"{thing}: certificate {cert['certificateId'][:12]}... created and attached")

    endpoint = iot.describe_endpoint(endpointType="iot:Data-ATS")["endpointAddress"]
    print(f"\nDone. Certificates are in {CERTS} (git-ignored).")
    print(f"Set this in simulator/.env:  IOT_ENDPOINT={endpoint}")


if __name__ == "__main__":
    main()
