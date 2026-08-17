import type { Finding } from '@parakh/shared';

/**
 * Bounded v1 verification of a finding against the full reference content of
 * the reviewed file. Three outcomes:
 *
 * - verified: the finding's cited line exists within the file's line range and
 *   every identifier it references is present in the file. Verified findings
 *   are returned intact and unmodified.
 * - unverified: no factual claim could be checked (no reference content, no
 *   line anchors, no cited identifiers). Unverified findings are KEPT — we
 *   never drop a finding without grounds.
 * - contradicted: a flat factual assertion is demonstrably false (file
 *   mismatch, line out of range, or referenced identifier absent). These are
 *   dropped as fabrication artifacts.
 */

export type FindingVerificationStatus = 'verified' | 'unverified' | 'contradicted';

export interface FindingVerification {
  finding: Finding;
  status: FindingVerificationStatus;
  reason: string;
}

export interface VerificationSummary {
  verified: Finding[];
  unverifiedCount: number;
  contradictedCount: number;
}

const IDENTIFIER_REFERENCE =
  /(?:`([^`]+)`)|(?:"([A-Za-z_$][A-Za-z0-9_$.]{1,})")|(?:'([A-Za-z_$][A-Za-z0-9_$.]{1,})')/g;
const MISSING_PROP = /lacks (?:a |an |the )?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+prop)?\b/gi;
const UNDECLARED_PROP = /([A-Za-z_$][A-Za-z0-9_$]*)\s+prop\s+(?:is|was)?\s*(?:missing|undeclared|not (?:declared|defined))\b/gi;

interface ReferencedIdentifiers {
  /** Symbol references the finding claims to be present (backticks/quotes). */
  presenceClaims: string[];
  /** Symbols the finding claims to be ABSENT ("lacks a X prop"). */
  absenceClaims: string[];
}

/** Identifiers a finding body explicitly references, workspace symbols preferred over prose. */
export function extractReferencedIdentifiers(body: string): string[] {
  return extractIdentifierClaims(body).presenceClaims;
}

export function extractIdentifierClaims(body: string): ReferencedIdentifiers {
  const presenceClaims = new Set<string>();
  const absenceClaims = new Set<string>();
  for (const match of body.matchAll(IDENTIFIER_REFERENCE)) {
    const token = (match[1] ?? match[2] ?? match[3]).trim();
    if (token && !/\s/.test(token) && token.length >= 2) presenceClaims.add(token);
  }
  for (const match of body.matchAll(MISSING_PROP)) {
    absenceClaims.add(match[1]);
  }
  for (const match of body.matchAll(UNDECLARED_PROP)) {
    absenceClaims.add(match[1]);
  }
  return { presenceClaims: [...presenceClaims], absenceClaims: [...absenceClaims] };
}

export function verifyFinding(
  finding: Finding,
  referenceFileContent: string | null,
  fileName: string
): FindingVerification {
  if (!referenceFileContent) {
    return { finding, status: 'unverified', reason: 'no_reference_content' };
  }

  const findingFile = finding.file?.trim();
  if (findingFile && findingFile !== fileName) {
    return { finding, status: 'contradicted', reason: 'file_mismatch' };
  }

  const lineCount = referenceFileContent.split('\n').length;
  if (finding.line != null && finding.line > 0 && finding.line > lineCount) {
    return { finding, status: 'contradicted', reason: 'line_out_of_range' };
  }

  const { presenceClaims, absenceClaims } = extractIdentifierClaims(finding.body);
  if (presenceClaims.length > 0) {
    const missingIdentifiers = presenceClaims.filter(
      (identifier) => !referenceFileContent.includes(identifier)
    );
    if (missingIdentifiers.length > 0) {
      return {
        finding,
        status: 'contradicted',
        reason: `identifier_absent: ${missingIdentifiers.join(', ')}`,
      };
    }
  }
  if (absenceClaims.length > 0) {
    const presentIdentifiers = absenceClaims.filter((identifier) =>
      referenceFileContent.includes(identifier)
    );
    if (presentIdentifiers.length > 0) {
      return {
        finding,
        status: 'contradicted',
        reason: `identifier_present: ${presentIdentifiers.join(', ')}`,
      };
    }
  }

  if (referenceFileContent.trim().length === 0) {
    return { finding, status: 'unverified', reason: 'empty_reference' };
  }

  return { finding, status: 'verified', reason: 'cited_lines_present' };
}

export function verifyFindings(
  findings: Finding[],
  referenceFileContent: string | null,
  fileName: string
): VerificationSummary {
  const verified: Finding[] = [];
  let unverifiedCount = 0;
  let contradictedCount = 0;

  for (const finding of findings) {
    const outcome = verifyFinding(finding, referenceFileContent, fileName);
    if (outcome.status === 'verified') {
      verified.push(outcome.finding);
    } else if (outcome.status === 'unverified') {
      unverifiedCount++;
      verified.push(outcome.finding);
    } else {
      contradictedCount++;
    }
  }

  return { verified, unverifiedCount, contradictedCount };
}