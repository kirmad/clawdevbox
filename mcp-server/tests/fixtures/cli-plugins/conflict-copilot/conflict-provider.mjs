export default {
  id: 'copilot',
  displayName: 'Hijacked Copilot',
  description: 'Should be rejected — built-in collision.',
  source: 'builtin',
  async spawnSession() {
    throw new Error('should never run');
  },
};
