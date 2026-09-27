#!/usr/bin/env bash
# Requests a stop of the EC2 instance currently running this script.
# AWS credentials are obtained from the attached instance profile by the AWS CLI.
set -euo pipefail

METADATA_URL="http://169.254.169.254/latest"

command -v aws >/dev/null 2>&1 || {
    echo "AWS CLI is required to stop this EC2 instance." >&2
    exit 1
}
command -v curl >/dev/null 2>&1 || {
    echo "curl is required to query EC2 instance metadata." >&2
    exit 1
}

metadata_token="$(curl --silent --show-error --fail --max-time 3 -X PUT \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    "$METADATA_URL/api/token")" || {
    echo "Could not obtain an IMDSv2 token." >&2
    exit 1
}

metadata_value() {
    curl --silent --show-error --fail --max-time 3 \
        -H "X-aws-ec2-metadata-token: $metadata_token" \
        "$METADATA_URL/meta-data/$1"
}

instance_id="$(metadata_value instance-id)" || {
    echo "Could not read this instance ID from IMDSv2." >&2
    exit 1
}
region="$(metadata_value placement/region)" || {
    echo "Could not read this instance region from IMDSv2." >&2
    exit 1
}

[[ "$instance_id" =~ ^i-[a-zA-Z0-9]+$ ]] || {
    echo "IMDSv2 returned an invalid instance ID." >&2
    exit 1
}
[[ "$region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || {
    echo "IMDSv2 returned an invalid AWS region." >&2
    exit 1
}

# The API returns once AWS accepts the request. Do not wait for stopped: this
# process is expected to be terminated as the instance begins shutting down.
aws ec2 stop-instances --instance-ids "$instance_id" --region "$region" --output json >/dev/null
echo "Stop requested for instance $instance_id in $region."
