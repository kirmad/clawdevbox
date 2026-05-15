#!/usr/bin/env node
/* eslint-disable */
// Fake claude/copilot-shaped CLI for `cliPluginSync` / `cliPluginDiscover` tests.
// Configure via env:
//   FAKE_CLI_STATE                 directory where calls.jsonl is appended
//   FAKE_CLI_INSTALLED_PLUGINS     JSON array of {name, marketplace, version?}
//   FAKE_CLI_MARKETPLACES          JSON array of marketplace id strings
//   FAKE_CLI_ANSI                  when '1', wraps output lines in ANSI codes
//   FAKE_CLI_FAIL_PLUGIN_LIST      when '1', `plugin list` exits 2
//   FAKE_CLI_FAIL_MP_LIST          when '1', `plugin marketplace list` exits 2
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_CLI_STATE || path.join(__dirname, '.fake-cli-state');
fs.mkdirSync(stateDir, { recursive: true });

const installed = JSON.parse(process.env.FAKE_CLI_INSTALLED_PLUGINS || '[]');
const marketplaces = JSON.parse(process.env.FAKE_CLI_MARKETPLACES || '[]');
const ansi = process.env.FAKE_CLI_ANSI === '1';

function wrap(s) {
  return ansi ? `\u001b[32m${s}\u001b[0m` : s;
}

function recordCall(action, args) {
  fs.appendFileSync(
    path.join(stateDir, 'calls.jsonl'),
    JSON.stringify({ action, args, ts: Date.now() }) + '\n',
  );
}

if (argv[0] === '--version') {
  process.stdout.write('fake-cli 1.0.0\n');
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'list') {
  if (process.env.FAKE_CLI_FAIL_MP_LIST === '1') {
    process.stderr.write('mock marketplace list failure\n');
    process.exit(2);
  }
  process.stdout.write('Registered marketplaces:\n');
  for (const m of marketplaces) {
    process.stdout.write(`  ${wrap('•')} ${m} (Mock)\n`);
  }
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'list') {
  if (process.env.FAKE_CLI_FAIL_PLUGIN_LIST === '1') {
    process.stderr.write('mock plugin list failure\n');
    process.exit(2);
  }
  process.stdout.write('Installed plugins:\n');
  for (const p of installed) {
    process.stdout.write(`  ${wrap('•')} ${p.name}@${p.marketplace} (v${p.version || '1.0.0'})\n`);
  }
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'install') {
  recordCall('install', argv.slice(2));
  if (argv[2] === 'fail-install' || argv[2] === 'fail@market') {
    process.stderr.write('mock plugin install failure\n');
    process.exit(1);
  }
  process.stdout.write(`installed ${argv[2]}\n`);
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'uninstall') {
  recordCall('uninstall', argv.slice(2));
  process.stdout.write(`uninstalled ${argv[2]}\n`);
  process.exit(0);
}

if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add') {
  recordCall('marketplace-add', argv.slice(3));
  if (argv[3] === 'fail-source') {
    process.stderr.write('mock marketplace add failure\n');
    process.exit(1);
  }
  process.stdout.write(`added marketplace from ${argv[3]}\n`);
  process.exit(0);
}

process.stderr.write(`fake-cli: unknown args ${argv.join(' ')}\n`);
process.exit(2);
