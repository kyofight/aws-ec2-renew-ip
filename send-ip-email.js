'use strict';

const nodemailer = require('nodemailer');
const { loadConfig, required } = require('./lib/config');

const publicIp = process.argv[2] || '';
if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(publicIp)) {
  throw new Error('A valid public IPv4 address must be supplied');
}

const config = loadConfig();
const port = Number(config.SMTP_PORT || 587);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('SMTP_PORT must be an integer between 1 and 65535');
}

function timeout(key, fallback) {
  const value = Number(config[key] || fallback);
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error(`${key} must be an integer from 1000 to 120000 milliseconds`);
  }
  return value;
}

const transport = nodemailer.createTransport({
  host: required(config, 'SMTP_HOST'),
  port,
  secure: String(config.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
  connectionTimeout: timeout('SMTP_CONNECTION_TIMEOUT_MS', 10_000),
  greetingTimeout: timeout('SMTP_GREETING_TIMEOUT_MS', 10_000),
  socketTimeout: timeout('SMTP_SOCKET_TIMEOUT_MS', 30_000),
  auth: {
    user: required(config, 'SMTP_USER'),
    pass: required(config, 'SMTP_PASS')
  }
});

const recipient = required(config, 'NOTIFICATION_EMAIL');
const from = required(config, 'SMTP_FROM');
const instanceName = config.INSTANCE_NAME || 'EC2 instance';

async function main() {
  const result = await transport.sendMail({
    from,
    to: recipient,
    subject: `${instanceName} restarted — public IP: ${publicIp}`,
    text: `${instanceName} has restarted successfully.\n\nPublic IPv4: ${publicIp}\n`
  });
  console.info(`Public-IP notification sent: ${result.messageId}`);
}

main().catch((error) => {
  console.error(`Could not send public-IP notification: ${error.message}`);
  process.exitCode = 1;
});
