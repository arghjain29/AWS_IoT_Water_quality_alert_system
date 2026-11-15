# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.35"]
# ///
"""
Undo provision_certs.py: detach, deactivate and delete the station certificates
that this project created (identified by certs/<deviceId>/certificate-id.txt),
then delete the local files.

Needed before `terraform destroy`, because AWS won't delete a thing that still
has a certificate attached. Only touches certificates listed in certs/.

    uv run scripts/remove_certs.py --yes
"""

import argparse
import shutil
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
CERTS = ROOT / "certs"


def main():
    parser = argparse.ArgumentParser(description="Remove this project's IoT device certificates")
    parser.add_argument("--region", default="ap-south-1")
    parser.add_argument("--policy", default="wq-dev-device-policy")
    parser.add_argument("--yes", action="store_true", help="actually do it")
    args = parser.parse_args()

    folders = sorted(p for p in CERTS.glob("WATER_STATION_*") if (p / "certificate-id.txt").is_file())
    if not folders:
        print("no provisioned certificates found in certs/")
        return
    if not args.yes:
        print("Would remove certificates for: " + ", ".join(p.name for p in folders))
        print("Re-run with --yes to proceed.")
        return

    iot = boto3.client("iot", region_name=args.region)
    for folder in folders:
        thing, cert_id = folder.name, (folder / "certificate-id.txt").read_text().strip()
        try:
            arn = iot.describe_certificate(certificateId=cert_id)["certificateDescription"]["certificateArn"]
            iot.detach_thing_principal(thingName=thing, principal=arn)
            iot.detach_policy(policyName=args.policy, target=arn)
            iot.update_certificate(certificateId=cert_id, newStatus="INACTIVE")
            iot.delete_certificate(certificateId=cert_id)
            print(f"{thing}: certificate {cert_id[:12]}... deleted")
        except ClientError as error:
            print(f"{thing}: {error.response['Error']['Message']}")
            continue
        shutil.rmtree(folder)


if __name__ == "__main__":
    main()
