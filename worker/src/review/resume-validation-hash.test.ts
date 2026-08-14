import { describe, expect, it } from 'vitest';
import { hashResumeValidationDiff } from './resume-validation-hash.js';

describe('hashResumeValidationDiff', () => {
  it('returns the known SHA-256 value for an empty payload', async () => {
    await expect(hashResumeValidationDiff('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('is stable for identical UTF-8 input, including Unicode', async () => {
    const diff = 'diff --git a/नमस्ते.ts b/नमस्ते.ts\n+const animal = "🐍";\n';
    const [first, second] = await Promise.all([
      hashResumeValidationDiff(diff),
      hashResumeValidationDiff(diff),
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['changed code', 'diff --git a/a.ts b/a.ts\n+one\n', 'diff --git a/a.ts b/a.ts\n+two\n'],
    ['changed whitespace', '+const x=1\n', '+const x = 1\n'],
    ['changed trailing newline', '+line', '+line\n'],
    ['changed file order', 'diff --git a/a b/a\ndiff --git a/b b/b\n', 'diff --git a/b b/b\ndiff --git a/a b/a\n'],
  ])('changes when %s changes', async (_name, left, right) => {
    expect(await hashResumeValidationDiff(left)).not.toBe(
      await hashResumeValidationDiff(right)
    );
  });

  it('hashes a large payload without truncating it', async () => {
    const prefix = 'diff --git a/generated.js b/generated.js\n';
    const large = `${prefix}${Array.from({ length: 5_000 }, (_, i) => `+line-${i}`).join('\n')}\n`;
    const changedAtEnd = `${large}+last-line\n`;

    expect(await hashResumeValidationDiff(large)).not.toBe(
      await hashResumeValidationDiff(changedAtEnd)
    );
  });
});
