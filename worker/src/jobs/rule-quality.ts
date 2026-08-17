/**
 * Deterministic rule-quality gate for correction intake.
 *
 * Every path that turns a developer's words into a stored rule (comment
 * corrections, the zero-rule fallback, dashboard rule creation) must run the
 * body through `assessRuleBody` FIRST. The gate is pure and intentionally
 * naive: rebuttals, chat text, pasted code, and bot-directed meta-instructions
 * must never become ACTIVE (or PENDING) standards — the memory bank only
 * grows with single, actionable, imperative coding standards.
 */

export type RuleAssessmentKind = 'standard' | 'instruction' | 'dismissal';

export interface RuleAssessment {
  ok: boolean;
  /** 'standard' | 'instruction' when accepted; 'dismissal' when rejected. */
  kind: RuleAssessmentKind;
  /** Trimmed body, with a leading @parakh command prefix stripped. */
  body: string;
  /** Present when rejected — the deterministic reason code. */
  reason?: string;
}

/** Phrasing that marks a correction as a SUPPRESSION directive instead of an enforceable standard. */
const INSTRUCTION_HINTS = [
  'stop flagging',
  'stop raising',
  'stop reporting',
  'stop flag',
  'never flag',
  'never raise',
  "don't flag",
  'dont flag',
  'do not flag',
  "don't raise",
  'dont raise',
  'do not raise',
  'in any future review',
  'in future reviews',
];

export function isInstructionRule(ruleBody: string): boolean {
  const lower = ruleBody.toLowerCase();
  return INSTRUCTION_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Rebuttal/chat framing — a developer telling the bot its finding was wrong,
 * or chatting, not stating a codebase practice. "we use hex coding so
 * remember that" is a chat one-liner, not a standard.
 */
const REBUTTAL_MARKERS: RegExp[] = [
  /\bremember\b/i,
  /\bnot true as stated\b/i,
  /\bthat'?s incorrect\b/i,
  /\bthat is incorrect\b/i,
  /\blook at the actual scope\b/i,
  /\bnot (?:a|an) (?:real|actual) (?:issue|finding|bug)\b/i,
];

/**
 * Instructions aimed at the BOT's own reporting behavior ("verify before
 * reporting", "ground your claims") rather than at the codebase. These are
 * meta-directions, never repository standards.
 */
const BOT_META_MARKERS: RegExp[] = [
  /\bverify before reporting\b/i,
  /\bverify your? (?:claims?|findings?)\b/i,
  /\bground your? claims?\b/i,
  /\bdon'?t hallucinate\b/i,
  /\bdo not hallucinate\b/i,
  /\bstop making (?:things|stuff) up\b/i,
  /\bcheck the (?:actual|real) (?:code|file)\b/i,
  /\buse the full file\b/i,
  /\bread the file\b/i,
];

/** Pasted code: backticks (inline or fenced), indented code lines. */
const CODE_BLOCK_MARKERS: RegExp[] = [
  /`/,
  /\n(?: {4}|\t)/,
];

/** `path/file.ts:12` or `path/file.ts:12-30` — a reference to concrete lines, not a general standard. */
const PATH_LINE_REFERENCE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}:\d+(?:-\d+)?\b/;

/** One standard = one short imperative. Anything longer is a rebuttal or a set of rules the extractor failed to split. */
const MAX_RULE_LENGTH = 140;
const MAX_RULE_WORDS = 32;
const MAX_SENTENCES = 2;

/** Comment command prefixes that should never end up inside a stored rule. */
const BOT_HANDLE_PREFIX = /^\s*@parakh\b(?:\s+(?:correction|verify)\b)?[\s:,-]*/i;

/** Polite filler that adds nothing to the standard itself. */
const FILLER_PREFIX = /^\s*please\b\s*/i;

function countSentenceTerminators(body: string): number {
  return (body.match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

/**
 * Assess whether a body is a single actionable coding standard.
 *
 * Accepted bodies return `ok: true` with a classification of
 * 'standard' (enforceable practice) or 'instruction' (suppression
 * directive — stored separately, never enforced as a violation).
 * Rejected bodies return `ok: false, kind: 'dismissal'` with a reason
 * code; callers route them to the reply's "skipped/ignored" bucket.
 */
export function assessRuleBody(rawBody: string): RuleAssessment {
  const body = rawBody.replace(BOT_HANDLE_PREFIX, '').replace(FILLER_PREFIX, '').trim();
  if (!body) {
    return { ok: false, kind: 'dismissal', body, reason: 'empty' };
  }

  if (REBUTTAL_MARKERS.some((re) => re.test(body))) {
    return { ok: false, kind: 'dismissal', body, reason: 'rebuttal_or_chat_text' };
  }
  if (BOT_META_MARKERS.some((re) => re.test(body))) {
    return { ok: false, kind: 'dismissal', body, reason: 'bot_directed_meta' };
  }
  if (CODE_BLOCK_MARKERS.some((re) => re.test(body))) {
    return { ok: false, kind: 'dismissal', body, reason: 'pasted_code' };
  }
  if (PATH_LINE_REFERENCE.test(body)) {
    return { ok: false, kind: 'dismissal', body, reason: 'line_reference_not_standard' };
  }
  if (body.length > MAX_RULE_LENGTH || body.split(/\s+/).length > MAX_RULE_WORDS) {
    return { ok: false, kind: 'dismissal', body, reason: 'not_a_single_standard' };
  }
  if (countSentenceTerminators(body) > MAX_SENTENCES) {
    return { ok: false, kind: 'dismissal', body, reason: 'multi_sentence' };
  }

  return {
    ok: true,
    kind: isInstructionRule(body) ? 'instruction' : 'standard',
    body,
  };
}