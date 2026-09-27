'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadConfig, required } = require('./lib/config');

const execFileAsync = promisify(execFile);
const config = loadConfig();
const port = Number(config.PORT || 3000);
const host = config.HOST || '0.0.0.0';
const stopPath = required(config, 'STOP_PATH');
const restartToken = config.RESTART_TOKEN || '';
const stopScript = path.join(__dirname, 'restart-ec.sh');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (!stopPath.startsWith('/') || stopPath.includes('?')) {
  throw new Error('STOP_PATH must begin with / and must not contain a query string');
}
if (!restartToken) {
  console.warn('WARNING: RESTART_TOKEN is empty; anyone who discovers the stop URL can stop this instance.');
}

function tokensMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(request, url) {
  if (!restartToken) return true;

  const authorization = request.headers.authorization || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return tokensMatch(bearerToken || url.searchParams.get('token') || '', restartToken);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function stopInstance() {
  await execFileAsync(stopScript, [], {
    timeout: 15_000,
    env: process.env,
    maxBuffer: 16 * 1024
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method !== 'GET' || url.pathname !== stopPath) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!isAuthorized(request, url)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  try {
    await stopInstance();
    console.info(`Instance stop requested by ${request.socket.remoteAddress || 'unknown client'}`);
    sendJson(response, 202, {
      message: 'Instance stop has been requested. An email with its public IP will be sent whenever the instance next starts.'
    });
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    console.error(`Unable to stop instance: ${output}`);
    sendJson(response, 409, { error: 'The instance stop could not be requested.' });
  }
});

server.listen(port, host, () => {
  console.info(`EC2 stop service listening on ${host}:${port}`);
});

function stopServer() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);
