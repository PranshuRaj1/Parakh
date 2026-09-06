function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function dependencyPaths(repository: string, file: string, source: string, paths?: readonly string[]): string[] {
  const directory = file.slice(0, Math.max(0, file.lastIndexOf('/') + 1));
  const imports = [...source.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(\s*|dofile\s*\(\s*)['"]([^'"]+)['"]/g)]
    .map(match => match[1]);
  const candidates: string[] = [];
  for (const imported of imports) {
    if (!imported.startsWith('.')) continue;
    const base = normalize(`${directory}${imported}`);
    const stem = base.replace(/\.(?:js|jsx)$/, '');
    candidates.push(base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${base}/index.ts`, `${base}/index.js`);
  }
  const suffixes: string[] = [];
  if (file.endsWith('.py')) {
    for (const match of source.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm)) {
      const imported = match[1] ?? match[2];
      const dots = imported.match(/^\.+/)?.[0].length ?? 0;
      const module = imported.slice(dots).replace(/\./g, '/');
      const base = dots ? normalize(`${directory}${'../'.repeat(dots - 1)}${module}`) : module;
      if (dots) candidates.push(`${base}.py`, `${base}/__init__.py`);
      else suffixes.push(`${base}.py`, `${base}/__init__.py`);
    }
  }
  if (file.endsWith('.java')) {
    for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+);/gm)) {
      suffixes.push(`${match[1].replace(/\./g, '/')}.java`);
    }
  }
  if (file.endsWith('.go') && paths) {
    for (const block of source.matchAll(/\bimport\s*(?:\([\s\S]*?\)|(?:\w+\s+)?"[^"]+")/g)) {
      for (const match of block[0].matchAll(/"([^"]+)"/g)) {
        const prefix = `github.com/${repository}/`;
        if (!match[1].startsWith(prefix)) continue;
        const packagePath = match[1].slice(prefix.length);
        candidates.push(...paths.filter(path => path.startsWith(`${packagePath}/`)
          && !path.slice(packagePath.length + 1).includes('/') && path.endsWith('.go') && !path.endsWith('_test.go')));
      }
    }
  }
  for (const suffix of suffixes) {
    candidates.push(...(paths?.filter(path => path === suffix || path.endsWith(`/${suffix}`)) ?? [suffix]));
  }
  const available = paths ? new Set(paths) : null;
  return [...new Set(candidates)].filter(path => path !== file && (!available || available.has(path)));
}
