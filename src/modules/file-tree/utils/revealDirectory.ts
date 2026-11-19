/** Used by the Files panel to walk an in-project chat reference or search result one directory at a time. */
export function directoryRevealSegments(projectRoot: string, reference: string): string[] {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const root = normalize(projectRoot);
  const target = normalize(reference);
  const absolute = /^(\/|[A-Za-z]:\/)/.test(target);
  if (absolute && !target.startsWith(root + '/')) return [];
  const relative = absolute ? target.slice(root.length + 1) : target;
  const segments = relative.split('/').filter(Boolean);
  return segments.includes('..') ? [] : segments;
}
