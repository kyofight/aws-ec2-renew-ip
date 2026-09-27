'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseEnvFile(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }

  return values;
}

function loadConfig() {
  const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  let fileValues = {};

  try {
    fileValues = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { ...fileValues, ...process.env };
}

function required(config, key) {
  const value = config[key];
  if (!value) throw new Error(`${key} must be configured`);
  return value;
}

module.exports = { loadConfig, required };
