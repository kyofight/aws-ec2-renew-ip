'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

function loadConfig() {
  const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  const result = dotenv.config({ path: envPath, quiet: true });

  // A project .env file is optional because systemd supplies variables through
  // EnvironmentFile=. Surface malformed or inaccessible configured files.
  if (result.error && result.error.code !== 'ENOENT') {
    throw result.error;
  }

  return process.env;
}

function required(config, key) {
  const value = config[key];
  if (!value) throw new Error(`${key} must be configured`);
  return value;
}

module.exports = { loadConfig, required };
