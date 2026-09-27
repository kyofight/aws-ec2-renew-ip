#!/usr/bin/env bash
# Runs at every system boot, reads EC2 IMDSv2, and emails the current public IP.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METADATA_URL="http://169.254.169.254/latest"

: "${NODE_BIN:?NODE_BIN must be set to the absolute path returned by 'command -v node'}"
if [[ ! -x "$NODE_BIN" ]]; then
    echo "NODE_BIN is not an executable Node.js binary: $NODE_BIN" >&2
    exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required to query EC2 instance metadata." >&2; exit 1; }

for attempt in $(seq 1 24); do
    token="$(curl --silent --show-error --fail --max-time 3 -X PUT \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
        "$METADATA_URL/api/token" 2>/dev/null || true)"
    public_ip=""
    if [[ -n "$token" ]]; then
        public_ip="$(curl --silent --show-error --fail --max-time 3 \
            -H "X-aws-ec2-metadata-token: $token" \
            "$METADATA_URL/meta-data/public-ipv4" 2>/dev/null || true)"
    fi

    if [[ "$public_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        "$NODE_BIN" "$SCRIPT_DIR/send-ip-email.js" "$public_ip"
        echo "Public-IP notification completed for $public_ip"
        exit 0
    fi

    echo "Public IPv4 unavailable (attempt $attempt/24); retrying in 5 seconds." >&2
    sleep 5
done

echo "Could not obtain a public IPv4 address from EC2 instance metadata." >&2
exit 1
