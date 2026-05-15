export default {
  id: 'test-cli',
  displayName: 'Test CLI',
  description: 'Fixture provider for the auto-discovery test.',
  source: 'builtin',
  async detect() { return { available: true, binary: 'fake', version: '0.0.0' }; },
  async spawnSession() { throw new Error('fixture — not implemented'); },
};
