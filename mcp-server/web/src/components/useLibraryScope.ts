/**
 * useLibraryScope — tiny helpers to render a memory/template scope string
 * (project | global | plugin:<id> | vault:<id> | personal | team) as a
 * short human label + a PrimeVue Tag severity, consistently across every
 * Library section.
 */

export function scopeLabel(scope: string): string {
  if (scope === 'project') return 'project';
  if (scope === 'global') return 'global';
  if (scope === 'personal') return 'personal';
  if (scope === 'team') return 'team';
  if (scope.startsWith('plugin:')) return scope.slice('plugin:'.length);
  if (scope.startsWith('vault:')) return scope.slice('vault:'.length);
  if (scope.startsWith('dir:')) return scope.slice('dir:'.length);
  return scope;
}

export type TagSeverity = 'secondary' | 'success' | 'info' | 'warn' | 'danger' | 'contrast';

export function scopeSeverity(scope: string): TagSeverity {
  if (scope === 'project') return 'success';
  if (scope === 'global') return 'info';
  if (scope.startsWith('plugin:')) return 'warn';
  if (scope.startsWith('vault:') || scope === 'team') return 'contrast';
  if (scope === 'personal') return 'secondary';
  return 'secondary';
}
