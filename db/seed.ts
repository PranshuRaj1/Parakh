/**
 * Parakh DB Seed Script
 *
 * Populates the database with demo data for the dashboard:
 * - Active rules
 * - A superseded rule (contradiction)
 * - A duplicate relationship
 * - A refinement relationship
 * - Recent review history
 *
 * Usage:
 *   DATABASE_URL=<neon_connection_string> npx tsx db/seed.ts
 */

import pg from 'pg';

const REPO = 'PranshuRaj1/Parakh';

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log('Connected to database. Seeding...');

    // Helper to generate a random 768-dim vector for text-embedding-004 simulation
    const randVec = () => `[${Array.from({ length: 768 }, () => Math.random() - 0.5).join(',')}]`;

    await client.query('BEGIN');

    // ─── 1. Core Rules ────────────────────────────────────────────────────────

    // Rule 1: High priority security rule
    const { rows: [rule1] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, evidence_count)
      VALUES ($1, 'Always validate JWT tokens before processing requests.', $2::vector, 'ACTIVE', 'high', 4)
      RETURNING id
    `, [REPO, randVec()]);

    // Rule 2: Normal style rule
    const { rows: [rule2] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, evidence_count)
      VALUES ($1, 'Use camelCase for variable names.', $2::vector, 'ACTIVE', 'normal', 12)
      RETURNING id
    `, [REPO, randVec()]);

    // ─── 2. Supersession Chain (Contradiction) ────────────────────────────────

    // Old rule (superseded)
    const { rows: [oldRule] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, evidence_count, created_at, superseded_at)
      VALUES ($1, 'Use Redux for all state management.', $2::vector, 'SUPERSEDED', 'normal', 2, now() - interval '30 days', now() - interval '5 days')
      RETURNING id
    `, [REPO, randVec()]);

    // New rule (active, supersedes old)
    const { rows: [newRule] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, supersedes, created_at)
      VALUES ($1, 'Use Zustand instead of Redux for state management. It is lighter.', $2::vector, 'ACTIVE', 'normal', $3, now() - interval '5 days')
      RETURNING id
    `, [REPO, randVec(), oldRule.id]);

    // Update old rule to point to new rule
    await client.query(`
      UPDATE rules SET superseded_by = $1 WHERE id = $2
    `, [newRule.id, oldRule.id]);

    // ─── 3. Refinement Relationship ───────────────────────────────────────────

    // Base rule
    const { rows: [baseRule] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, created_at)
      VALUES ($1, 'All file names should be in kebab-case.', $2::vector, 'ACTIVE', 'normal', now() - interval '20 days')
      RETURNING id
    `, [REPO, randVec()]);

    // Refinement rule
    const { rows: [refinementRule] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, created_at)
      VALUES ($1, 'Exception: React component files must use PascalCase.', $2::vector, 'ACTIVE', 'normal', now() - interval '2 days')
      RETURNING id
    `, [REPO, randVec()]);

    await client.query(`
      INSERT INTO rule_relationships (from_rule_id, to_rule_id, relationship)
      VALUES ($1, $2, 'REFINEMENT')
    `, [refinementRule.id, baseRule.id]);

    // ─── 4. Duplicate (Deactivated) ───────────────────────────────────────────

    const { rows: [duplicateRule] } = await client.query(`
      INSERT INTO rules (repo, body, embedding, status, priority, created_at)
      VALUES ($1, 'Tokens must be validated on every request.', $2::vector, 'INACTIVE', 'high', now() - interval '1 day')
      RETURNING id
    `, [REPO, randVec()]);

    await client.query(`
      INSERT INTO rule_relationships (from_rule_id, to_rule_id, relationship)
      VALUES ($1, $2, 'DUPLICATE')
    `, [duplicateRule.id, rule1.id]);

    // Reinforce the original rule
    await client.query(`
      UPDATE rules SET reinforcement_count = 1 WHERE id = $1
    `, [rule1.id]);

    // ─── 5. Review History ────────────────────────────────────────────────────

    // Review 1: Clean
    await client.query(`
      INSERT INTO reviews (repo, pr_number, status, score, findings, created_at)
      VALUES ($1, 101, 'COMPLETED', 5.0, '[]'::jsonb, now() - interval '2 days')
    `, [REPO]);

    // Review 2: Mixed (rule violation)
    await client.query(`
      INSERT INTO reviews (repo, pr_number, status, score, findings, created_at)
      VALUES ($1, 102, 'COMPLETED', 4.5, $2::jsonb, now() - interval '1 day')
    `, [REPO, JSON.stringify([
      { severity: 'MEDIUM', file: 'src/app.tsx', line: 42, body: 'Use camelCase for variable names.', rule_id: rule2.id }
    ])]);

    // Review 3: Critical failure
    await client.query(`
      INSERT INTO reviews (repo, pr_number, status, score, findings, created_at)
      VALUES ($1, 103, 'COMPLETED', 2.0, $2::jsonb, now() - interval '12 hours')
    `, [REPO, JSON.stringify([
      { severity: 'CRITICAL', file: 'src/auth.ts', line: 15, body: 'Missing auth check on core route.', rule_id: null },
      { severity: 'HIGH', file: 'src/auth.ts', line: 18, body: 'Always validate JWT tokens before processing requests.', rule_id: rule1.id }
    ])]);

    // Review 4: Currently Reviewing
    await client.query(`
      INSERT INTO reviews (repo, pr_number, status, created_at)
      VALUES ($1, 104, 'REVIEWING', now())
    `, [REPO]);


    await client.query('COMMIT');
    console.log('Successfully seeded database with demo data.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to seed database:', err);
  } finally {
    await client.end();
  }
}

seed().catch(console.error);
