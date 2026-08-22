import type { ConventionRule, ConventionSourceFile } from '@parakh/shared';
import { isInstructionRule } from '../../jobs/rule-quality.js';

/** Repo convention files, in precedence order. Nothing else is ever parsed. */
export const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.parakh/rules.md'] as const;

/**
 * Total convention-body characters injected into one review prompt before
 * deterministic truncation. Whole rules are kept until the budget would be
 * exceeded — never split mid-rule.
 */
export const MAX_CONVENTION_CHARS = 4000;

/** Auto-generated agent-rule blocks (e.g. next dev's `nextjs-agent-rules`) are machine-written, not developer conventions. */
const GENERATED_AGENT_BLOCK =
  /<!--\s*BEGIN:[^>]*agent-rules\s*-->[\s\S]*?<!--\s*END:[^>]*agent-rules\s*-->/g;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const SOURCE_SLUGS: Record<ConventionSourceFile, string> = {
  'AGENTS.md': 'agents-md',
  'CLAUDE.md': 'claude-md',
  '.parakh/rules.md': 'parakh-rules',
};

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const MIN_BODY_LENGTH = 4;

/**
 * Parse one convention file into discrete rules. Deterministic: identical
 * input always yields identical output (stable ids, stable order), which the
 * compatibility hash relies on.
 *
 * Rule sources, per file:
 * - every top-level or nested bullet / checkbox item → one rule
 * - a heading with no bullets under it → its prose paragraphs become rules
 * - fenced code blocks are skipped (examples, not conventions)
 *
 * Optional front-matter keys apply to every rule in the file:
 * `priority: high|normal`, `scope:` comma-separated glob patterns
 * (same `{ include: [...] }` shape `matchesScope` consumes).
 */
export function parseConventionRules(
  sourceFile: ConventionSourceFile,
  raw: string
): ConventionRule[] {
  const { meta, body } = splitFrontMatter(stripGeneratedBlocks(raw));
  const priority = meta['priority'] === 'high' ? 'high' : 'normal';
  const globs = (meta['scope'] ?? '')
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean);
  const scope: Record<string, unknown> = globs.length > 0 ? { include: globs } : {};

  const rules: ConventionRule[] = [];
  let sectionTitle = '';
  let paragraph: string[] = [];

  const push = (text: string): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < MIN_BODY_LENGTH) return;
    const fullBody = sectionTitle ? `${sectionTitle}: ${cleaned}` : cleaned;
    rules.push({
      id: `conv:${SOURCE_SLUGS[sourceFile]}:${rules.length + 1}`,
      body: fullBody,
      priority,
      kind: isInstructionRule(fullBody) ? 'instruction' : 'standard',
      scope,
      sourceFile,
    });
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    push(paragraph.join(' '));
    paragraph = [];
  };

  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      flushParagraph();
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      sectionTitle = heading[1].replace(/\s+/g, ' ').trim();
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      push(bullet[1]);
      continue;
    }

    // Blank lines end a paragraph; anything else accumulates prose that is
    // flushed as one rule when a heading, bullet, fence, or EOF interrupts it.
    if (line.trim() === '') flushParagraph();
    else paragraph.push(line.trim());
  }
  flushParagraph();

  return rules;
}

/** Keep whole rules until the character budget would be exceeded; drop the rest deterministically. */
export function capConventionRules(rules: ConventionRule[]): { kept: ConventionRule[]; truncated: boolean } {
  let used = 0;
  const kept: ConventionRule[] = [];
  for (const rule of rules) {
    if (used + rule.body.length > MAX_CONVENTION_CHARS) break;
    kept.push(rule);
    used += rule.body.length;
  }
  return { kept, truncated: kept.length < rules.length };
}

function stripGeneratedBlocks(markdown: string): string {
  return markdown.replace(GENERATED_AGENT_BLOCK, '');
}

function splitFrontMatter(markdown: string): { meta: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(markdown);
  if (!match) return { meta: {}, body: markdown };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) meta[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { meta, body: markdown.slice(match[0].length) };
}
