import type { Rule } from '@parakh/shared';

export const REVIEW_PIPELINE_VERSION = '2c';

/**
 * Canonicalize rule metadata before hashing so property insertion order cannot
 * change incremental-review compatibility.
 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

/**
 * Hash every rule field that can change review behavior. Incremental review
 * reuses a parent ledger only when this identity and the pipeline version
 * still match.
 */
export async function hashActiveRules(rules: Rule[]): Promise<string> {
  const compatibleShape = [...rules]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((rule) => stableValue({
      id: rule.id,
      body: rule.body,
      kind: rule.kind ?? 'standard',
      priority: rule.priority,
      scope: rule.scope,
      status: rule.status,
    }));
  const bytes = new TextEncoder().encode(JSON.stringify(compatibleShape));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
