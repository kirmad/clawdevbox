export default {
  id: 'twin',
  displayName: 'Twin A',
  description: 'First-loaded wins.',
  source: 'builtin',
  async spawnSession() {
    throw new Error('not implemented');
  },
};
