import type { ConventionRule, ConventionSourceFile } from '@parakh/shared';
import { isInstructionRule } from '../../jobs/rule-quality.js';

/** Repo convention files, in precedence order. Nothing else is ever parsed. */
export const CONVENTION_FILES = ['.parakh/rules.md', 'AGENTS.md', 'CLAUDE.md'] as const;

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
const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;
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
  let lastRuleWasBullet = false;

  const push = (text: string): boolean => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < MIN_BODY_LENGTH) return false;
    const fullBody = sectionTitle ? `${sectionTitle}: ${cleaned}` : cleaned;
    rules.push({
      id: `conv:${SOURCE_SLUGS[sourceFile]}:${rules.length + 1}`,
      body: fullBody,
      priority,
      kind: isInstructionRule(fullBody) ? 'instruction' : 'standard',
      scope,
      sourceFile,
    });
    return true;
  };

  /** An indented line directly under a bullet continues that bullet's rule. */
  const appendToLastBullet = (text: string): void => {
    const last = rules[rules.length - 1];
    if (!last) return;
    last.body = `${last.body} ${text}`;
    last.kind = isInstructionRule(last.body) ? 'instruction' : 'standard';
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
      lastRuleWasBullet = false;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      lastRuleWasBullet = push(bullet[1]);
      continue;
    }

    // Blank lines end a paragraph and a bullet item; anything else accumulates
    // prose that is flushed as one rule when a heading, bullet, fence, or EOF
    // interrupts it. An indented line right after a bullet is that bullet's
    // continuation (CommonMark list-item semantics), never a new rule.
    if (line.trim() === '') {
      flushParagraph();
      lastRuleWasBullet = false;
    } else if (lastRuleWasBullet && /^\s/.test(line)) {
      appendToLastBullet(line.trim());
    } else {
      paragraph.push(line.trim());
      lastRuleWasBullet = false;
    }
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
  // stripGeneratedBlocks can leave leading blank lines when a generated block
  // sits at the top of the file; front matter is still front matter after them.
  const content = markdown.replace(/^\s+/, '');
  const match = FRONT_MATTER.exec(content);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) meta[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { meta, body: content.slice(match[0].length) };
}
