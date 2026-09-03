import { describe, expect, it } from 'vitest';
import { parseSourceFile } from './parser.js';

describe('language parser adapters', () => {
  it.each([
    ['py', 'class User:\n    def save(self):\n        return True\n', ['User', 'save']],
    ['go', 'package users\n\n type User struct {}\n func Save(user User) error { return nil }\n', ['User', 'Save']],
    ['java', 'public class User {\n  public void save() {}\n}\n', ['User', 'save']],
    ['lua', 'function User.save(user)\n  return user\nend\n', ['User_save']],
  ])('extracts bounded symbols from %s', (extension, source, names) => {
    const symbols = parseSourceFile('acme/app', 'head', `src/user.${extension}`, source);
    expect(symbols.map((symbol) => symbol.qualifiedName.split('#')[1])).toEqual(names);
    expect(symbols.every((symbol) => symbol.endLine >= symbol.startLine)).toBe(true);
  });

  it('keeps unsupported files on the hunk fallback path', () => {
    expect(parseSourceFile('acme/app', 'head', 'config.yaml', 'timeout: 20')).toEqual([]);
  });
});
