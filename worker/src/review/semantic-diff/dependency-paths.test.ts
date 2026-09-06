import { describe, expect, it } from 'vitest';
import { dependencyPaths } from './dependency-paths.js';

describe('dependency paths', () => {
  it.each([
    ['src/routes/api.ts', "import { save } from '../service.js';", 'src/service.ts'],
    ['src/app/api.py', 'from app.service import save', 'src/app/service.py'],
    ['src/app/api.py', 'from .service import save', 'src/app/service.py'],
    ['pkg/api/api.go', 'import (\n "github.com/acme/app/pkg/service"\n)', 'pkg/service/service.go'],
    ['module/src/main/java/app/Api.java', 'import app.Service;', 'module/src/main/java/app/Service.java'],
  ])('resolves %s imports against the pinned tree', (file, source, dependency) => {
    expect(dependencyPaths('acme/app', file, source, [file, dependency, 'unrelated.ts'])).toEqual([dependency]);
  });
});
