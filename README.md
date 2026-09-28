# EC2 self-stop endpoint

This project exposes one configurable, protected HTTP path. Visiting that path requests an **EC2 stop** for the instance hosting the server. Every time the instance boots—whether started manually in the AWS console, by the CLI, or through automation—a systemd service reads its current public IPv4 address from EC2 IMDSv2 and emails it through SMTP.

Stopping the instance ends the Node process immediately after AWS accepts the request. It cannot start itself again; start it through the AWS Console, CLI, Auto Scaling, EventBridge, Lambda, Systems Manager, or another external AWS control plane. If the instance uses an auto-assigned public IPv4 rather than an Elastic IP, AWS may assign a different address on the next start.

## Security

A hidden path is **not** access control. Set a strong `RESTART_TOKEN`, restrict inbound traffic in the EC2 security group, and preferably expose this through an HTTPS reverse proxy or VPN. The server returns `404` for an invalid token so it does not reveal the endpoint.

The service runs as root and its instance profile may stop the instance. Do not expose this endpoint to untrusted networks or leave the token empty.

## Requirements

- EC2 Linux instance with systemd, `curl`, AWS CLI v2, Node.js 20+, and outbound SMTP access.
- EC2 Instance Metadata Service reachable from the instance. Both scripts use IMDSv2; no static AWS keys are stored in this project.
- An IAM instance profile allowing the host instance to call `ec2:StopInstances`. Scope the permission to the specific instance whenever your IAM policy design permits it.
- A public IPv4 assigned to the instance. Instances without one cannot send the requested IP notification.

Attach an IAM role to the EC2 instance with a policy equivalent to this example. Replace the account, region, and instance ID before use:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "ec2:StopInstances",
    "Resource": "arn:aws:ec2:REGION:ACCOUNT_ID:instance/INSTANCE_ID"
  }]
}
```

## Install on the EC2 instance

1. Copy or clone this project to `/opt/aws-vpn-restart`, then install the pinned Node dependency:

   ```sh
   sudo mkdir -p /opt/aws-vpn-restart
   sudo cp -R . /opt/aws-vpn-restart/
   sudo npm --prefix /opt/aws-vpn-restart ci --omit=dev
   sudo chmod 0755 /opt/aws-vpn-restart/restart-ec.sh /opt/aws-vpn-restart/notify-public-ip.sh
   ```

2. Create the root-only environment file and fill in every placeholder. Generate values with `openssl rand -hex 32`. Run both `command -v node` and `command -v npm` on the EC2 instance, then set `NODE_BIN` and `NPM_BIN` to those exact absolute paths. This is required because systemd does not inherit your interactive shell or nvm configuration.

   ```sh
   command -v node
   command -v npm
   # Example Node output: /home/ec2-user/.nvm/versions/node/v24.9.0/bin/node
   # Example npm output:  /home/ec2-user/.nvm/versions/node/v24.9.0/bin/npm
   sudo cp /opt/aws-vpn-restart/.env.example /etc/aws-vpn-restart.env
   sudo chmod 0600 /etc/aws-vpn-restart.env
   sudoedit /etc/aws-vpn-restart.env
   ```

3. Install and enable the services:

   ```sh
   sudo install -m 0644 /opt/aws-vpn-restart/systemd/aws-vpn-restart.service /etc/systemd/system/aws-vpn-restart.service
   sudo install -m 0644 /opt/aws-vpn-restart/systemd/aws-vpn-restart-notify.service /etc/systemd/system/aws-vpn-restart-notify.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now aws-vpn-restart.service aws-vpn-restart-notify.service
   ```

4. Allow the configured `PORT` only from trusted source addresses in the EC2 security group. If the port is directly exposed, use HTTPS via a reverse proxy.

## Service management (systemd)

The native `aws-vpn-restart.service` is the production process manager. It runs `npm run start:service`, which starts `server.js` in the foreground. Systemd owns the process, restarts it after a crash, and starts it automatically on every EC2 boot—PM2 is not required for this deployment.

If you previously configured the failed `pm2-ubuntu` service, disable it before enabling the native service. Keep the notifier enabled so every boot emails the public IP:

```sh
sudo systemctl disable --now pm2-ubuntu.service || true
sudo install -m 0644 /opt/aws-vpn-restart/systemd/aws-vpn-restart.service /etc/systemd/system/aws-vpn-restart.service
sudo install -m 0644 /opt/aws-vpn-restart/systemd/aws-vpn-restart-notify.service /etc/systemd/system/aws-vpn-restart-notify.service
sudo systemctl daemon-reload
sudo systemctl enable --now aws-vpn-restart.service aws-vpn-restart-notify.service
sudo systemctl status aws-vpn-restart.service aws-vpn-restart-notify.service --no-pager
```

Manage the server with systemd:

```sh
sudo systemctl restart aws-vpn-restart.service
sudo systemctl stop aws-vpn-restart.service
sudo journalctl -u aws-vpn-restart.service -f
```

### Optional manual PM2 use

PM2 remains available only for manual, non-systemd use: `npm start`, `npm stop`, `npm run restart`, and `npm run logs`. Do not configure PM2 to start at boot or run it while `aws-vpn-restart.service` is enabled, because both managers would bind the same port. For PM2, `dotenv` loads a user-readable project `.env` file (or `ENV_FILE`); systemd instead reads `/etc/aws-vpn-restart.env`.

## Fix `node: command not found` in the boot notifier

Set `NODE_BIN` in `/etc/aws-vpn-restart.env` to the exact output of `command -v node`. After deploying the updated project files to `/opt/aws-vpn-restart`, install the updated unit and restart only the notifier service:

```sh
command -v node
sudoedit /etc/aws-vpn-restart.env
# Add, for example: NODE_BIN=/home/ec2-user/.nvm/versions/node/v24.9.0/bin/node
sudo install -m 0644 /opt/aws-vpn-restart/systemd/aws-vpn-restart-notify.service /etc/systemd/system/aws-vpn-restart-notify.service
sudo systemctl daemon-reload
sudo systemctl restart aws-vpn-restart-notify.service
sudo journalctl -u aws-vpn-restart-notify.service -n 50 --no-pager
```

## Trigger an instance stop

Use the exact configured path. The authorization header keeps the token out of browser history, access logs, and referrer headers:

```sh
curl -i \
  -H 'Authorization: Bearer REPLACE_WITH_A_LONG_RANDOM_TOKEN' \
  http://EC2_PUBLIC_IP:3000/stop-REPLACE_WITH_A_LONG_RANDOM_VALUE
```

For a browser-only hidden link, use `http://EC2_PUBLIC_IP:3000/<STOP_PATH>?token=<RESTART_TOKEN>`. The server returns `202 Accepted` **before** it runs the AWS command, then launches the stop request after `STOP_REQUEST_DELAY_SECONDS` (default: 3). This avoids a shutdown race where EC2 kills the local AWS CLI after accepting the stop request. A `202` confirms that the stop was scheduled locally, not that AWS has completed it. Once you start the instance again, the notification service emails `NOTIFICATION_EMAIL` with its then-current public IP.

## Operations

```sh
sudo systemctl status aws-vpn-restart.service aws-vpn-restart-notify.service
sudo journalctl -u aws-vpn-restart.service -u aws-vpn-restart-notify.service --since today
```

The notifier runs once at every boot and retries every 30 seconds if IMDSv2, the public IPv4, or SMTP delivery is not yet available. It needs no restart marker, so manual and automated instance starts are notified too.
