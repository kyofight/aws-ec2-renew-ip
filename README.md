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

2. Create the root-only environment file and fill in every placeholder. Generate values with `openssl rand -hex 32`. Run `command -v node` on the EC2 instance, then set `NODE_BIN` to that exact absolute path. This is required because systemd does not inherit your interactive shell or nvm configuration.

   ```sh
   command -v node
   # Example output: /home/ec2-user/.nvm/versions/node/v24.9.0/bin/node
   sudo cp /opt/aws-vpn-restart/.env.example /etc/aws-vpn-restart.env
   sudo chmod 0600 /etc/aws-vpn-restart.env
   sudoedit /etc/aws-vpn-restart.env
   ```

3. Install and enable the services:

   ```sh
   sudo install -m 0644 /home/ubuntu/aws-ec2-renew-ip/systemd/aws-vpn-restart.service /etc/systemd/system/aws-vpn-restart.service
   sudo install -m 0644 /home/ubuntu/aws-ec2-renew-ip/systemd/aws-vpn-restart-notify.service /etc/systemd/system/aws-vpn-restart-notify.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now aws-vpn-restart.service aws-vpn-restart-notify.service
   ```

4. Allow the configured `PORT` only from trusted source addresses in the EC2 security group. If the port is directly exposed, use HTTPS via a reverse proxy.

## Service management (systemd)

The native `aws-vpn-restart.service` is the production process manager. It invokes the configured `NODE_BIN` **directly** with `server.js` in the foreground; it does not invoke npm or PM2. Systemd owns the process, starts it automatically on every EC2 boot, and restarts genuine crashes.

### Fix the high-CPU boot loop

Earlier versions of the unit ran npm through an NVM `PATH` entry that incorrectly pointed to the `npm` executable instead of its containing `bin` directory. On boot, that could select a missing or incompatible Node executable, cause startup to exit, and—because `Restart=always` was set—repeat the launch indefinitely. The updated unit removes npm/PATH resolution, uses `NODE_BIN` directly, and stops retrying after three failed starts in one minute.

Deploy the updated project to the service path `/opt/aws-vpn-restart` (or adjust both `WorkingDirectory` and `ExecStart` in the unit to match your chosen path). Then use this recovery procedure:

```sh
# Stop the unhealthy native process and remove the old PM2 boot manager.
sudo systemctl stop aws-vpn-restart.service
sudo systemctl disable --now pm2-ubuntu.service || true
sudo rm -f /etc/systemd/system/pm2-ubuntu.service

# Confirm the Node executable used by systemd, then set NODE_BIN in the env file.
command -v node
sudoedit /etc/aws-vpn-restart.env
# Example: NODE_BIN=/home/ubuntu/.nvm/versions/node/v22.23.3/bin/node

# Install the updated native unit and start it cleanly.
sudo install -m 0644 /home/ubuntu/aws-ec2-renew-ip/systemd/aws-vpn-restart.service /etc/systemd/system/aws-vpn-restart.service
sudo systemctl daemon-reload
sudo systemctl reset-failed aws-vpn-restart.service
sudo systemctl enable --now aws-vpn-restart.service aws-vpn-restart-notify.service
sudo systemctl status aws-vpn-restart.service --no-pager -l
```

If the service fails instead of running, it will no longer consume a CPU core in a retry loop. Inspect the precise cause:

```sh
sudo journalctl -b -u aws-vpn-restart.service --no-pager -n 100
sudo systemctl show aws-vpn-restart.service -p NRestarts -p ExecMainStatus
sudo ss -ltnp '( sport = :3000 )'
```

An `EADDRINUSE` error means another process owns the configured port, usually a residual PM2 process. As the `ubuntu` user, stop it before enabling the native service:

```sh
sudo -iu ubuntu
cd /home/ubuntu/aws-ec2-renew-ip
./node_modules/.bin/pm2 delete aws-vpn-restart || true
exit
```

### Fixed one-minute delayed Node start

The main systemd unit always waits 60 seconds before launching Node, allowing EC2 networking and boot work to settle. The delay applies to every service start, including manual restarts after a failure. It is fixed in `aws-vpn-restart.service`; no environment setting is required.

Deploy the updated unit and restart it; it will remain `activating` for about one minute before Node begins listening:

```sh
sudo install -m 0644 /home/ubuntu/aws-ec2-renew-ip/systemd/aws-vpn-restart.service /etc/systemd/system/aws-vpn-restart.service
sudo systemctl daemon-reload
sudo systemctl restart aws-vpn-restart.service
sudo systemctl status aws-vpn-restart.service --no-pager -l
```

This is a diagnostic mitigation, not proof that the Node process or notifier caused the boot freeze. If it improves reliability, retain the persistent-journal and cgroup diagnostics described below to identify the underlying boot-time dependency.

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

The notifier runs after the HTTP service and retries only a bounded number of failed starts. It uses short IMDS requests, bounded SMTP connection/greeting/socket timeouts, low scheduling priority, and a 20% CPU cap. These safeguards ensure notification delivery cannot consume all CPU or indefinitely hold the boot environment. They do not replace host diagnostics for kernel, disk, memory, port-collision, or stale-unit failures.

### Investigating an intermittent boot freeze

Enable persistent journaling before reproducing the issue so a forced EC2 stop does not erase the evidence:

```sh
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal
sudo systemctl restart systemd-journald
```

After a problematic boot—or while it is slow through EC2 Serial Console/SSM—collect these non-secret diagnostics before restarting either service:

```sh
sudo systemctl show aws-vpn-restart.service aws-vpn-restart-notify.service \
  -p MainPID -p NRestarts -p Result -p ExecMainStatus -p TimeoutStartUSec
sudo journalctl -b -o short-monotonic \
  -u aws-vpn-restart.service -u aws-vpn-restart-notify.service --no-pager
sudo journalctl -k -b --no-pager | grep -Ei 'oom|killed process|hung task|I/O error|nvme|ext4|xfs'
sudo ss -ltnp '( sport = :3000 )'
sudo ps -eo pid,ppid,stat,etime,%cpu,%mem,wchan:32,cmd --forest
cat /proc/pressure/cpu /proc/pressure/io /proc/pressure/memory
```

A notifier/main-service race is not expected: they do not share a port or writable state. Evidence of `EADDRINUSE` indicates a competing Node/PM2 process; an OOM, hung-task, or I/O log indicates a host-level condition rather than the notification flow.

