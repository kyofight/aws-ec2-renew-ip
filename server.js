'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadConfig, required } = require('./lib/config');

const config = loadConfig();
const port = Number(config.PORT || 3000);
const host = config.HOST || '0.0.0.0';
const stopPath = required(config, 'STOP_PATH');
const restartToken = config.RESTART_TOKEN || '';
const stopDelaySeconds = Number(config.STOP_REQUEST_DELAY_SECONDS || 3);
const stopScript = path.join(__dirname, 'restart-ec.sh');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (!stopPath.startsWith('/') || stopPath.includes('?')) {
  throw new Error('STOP_PATH must begin with / and must not contain a query string');
}
if (!Number.isInteger(stopDelaySeconds) || stopDelaySeconds < 1 || stopDelaySeconds > 60) {
  throw new Error('STOP_REQUEST_DELAY_SECONDS must be an integer from 1 to 60');
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

function launchStopRequest() {
  const child = spawn(stopScript, [], {
    detached: true,
    env: process.env,
    stdio: 'ignore'
  });
  child.unref();
  child.once('error', (error) => {
    console.error(`Could not launch scheduled stop request: ${error.message}`);
  });
}

function scheduleStopRequest() {
  const delayMilliseconds = stopDelaySeconds * 1_000;
  setTimeout(() => {
    console.info('Launching scheduled EC2 stop request.');
    launchStopRequest();
  }, delayMilliseconds).unref();
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method !== 'GET' || url.pathname !== stopPath) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!isAuthorized(request, url)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  response.once('finish', () => {
    console.info(
      `Instance stop scheduled by ${request.socket.remoteAddress || 'unknown client'}; launching in ${stopDelaySeconds} seconds.`
    );
    scheduleStopRequest();
  });
  sendJson(response, 202, {
    message: `Instance stop has been scheduled. It will be requested in ${stopDelaySeconds} seconds; a public-IP email will be sent whenever the instance next starts.`
  });
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
