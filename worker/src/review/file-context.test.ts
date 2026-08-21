import { describe, expect, it, vi } from 'vitest';
import { REVIEW_FILE_CONTEXT_MAX_CHARS, buildFileContext } from './file-context.js';

describe('buildFileContext', () => {
  it('returns the content untouched when within the cap', () => {
    const context = buildFileContext('const x = 1;\n');
    expect(context).toEqual({ full: 'const x = 1;\n', bounded: 'const x = 1;\n', truncated: false });
  });

  it('never exceeds the cap for oversized content', () => {
    const content = 'a'.repeat(REVIEW_FILE_CONTEXT_MAX_CHARS + 500);
    const context = buildFileContext(content);
    expect(context.truncated).toBe(true);
    expect(context.bounded.length).toBeLessThanOrEqual(REVIEW_FILE_CONTEXT_MAX_CHARS);
    expect(context.full).toBe(content);
  });

  it('keeps surrogate pairs intact at the boundary', () => {
    const prefix = 'a'.repeat(REVIEW_FILE_CONTEXT_MAX_CHARS - 1);
    const content = `${prefix}🐍rest-of-file`;
    const context = buildFileContext(content);

    expect(context.bounded.length).toBe(REVIEW_FILE_CONTEXT_MAX_CHARS - 1);
    expect(Array.from(context.bounded).at(-1)).toBe('a');
    expect(context.full).toBe(content);
    expect(context.truncated).toBe(true);
  });

  it('decodes multibyte UTF-8 content without corruption (via api decode path)', async () => {
    const { getFileContent } = await import('../github/api.js');
    const source = 'const emoji = "🐍";\nconst cjk = "漢字";\nconst accent = "café";\n';
    const base64 = Buffer.from(source, 'utf8').toString('base64');
    const wrapped = base64.match(/.{1,60}/g)!.join('\n');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ content: wrapped, encoding: 'base64' }), { status: 200 }));

    expect(await getFileContent('acme', 'app', 'src/x.ts', 'head', 'token')).toBe(source);
    vi.unstubAllGlobals();
  });
});
