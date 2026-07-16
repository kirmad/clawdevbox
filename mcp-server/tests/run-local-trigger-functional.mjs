import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  '--import',
  'tsx',
  '--test',
  '--test-force-exit',
  '--test-concurrency=1',
  'tests/local-trigger-functional.test.mjs',
], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    CDB_REQUIRE_LOCAL_TRIGGER_SOURCES: '1',
  },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
