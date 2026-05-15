export default {
  id: 'test-cli',
  displayName: 'Test CLI Provider',
  description: 'Returns a fake handle.',
  source: 'builtin', // overwritten to 'plugin:test-cli' by the loader
  async detect() {
    return { available: true, binary: 'test-cli', version: '0.1.0' };
  },
  async spawnSession(_ctx, _opts) {
    throw new Error('fixture provider — spawnSession not implemented');
  },
};
