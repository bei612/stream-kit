'use strict';

// Disposable guest diagnostic. Leave credential payloads outside command lines and reports.
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const [renderer, config] = process.argv.slice(2);
const password = randomBytes(32).toString('base64url');
const input = JSON.stringify({ name: 'stream-kit', password });
const directory = path.dirname(config);
const sanitize = value => String(value ?? '').replaceAll(password, '[redacted]').slice(-3500);
function probe(args, stdin) {
  const result = spawnSync(renderer, args, {
    cwd: path.dirname(directory), input: stdin, encoding: 'utf8', windowsHide: true,
    timeout: 25000, maxBuffer: 256 * 1024,
  });
  return {
    exit: result.status, error: result.error?.code, signal: result.signal,
    stdout: sanitize(result.stdout), stderr: sanitize(result.stderr),
  };
}
const credentials = path.join(directory, 'credentials.json');
const before = fs.existsSync(credentials);
const version = probe(['--version']);
const bootstrap = probe([config, '--creds-stdin'], input);
console.log(JSON.stringify({
  version, bootstrap, credential_file_before: before, credential_file_after: fs.existsSync(credentials),
}));
