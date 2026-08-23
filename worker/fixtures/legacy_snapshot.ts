/**
 * E2E fixture for the repo-conventions wiring (PR #47).
 *
 * Deliberately violates BOTH rules in .parakh/rules.md:
 * - the filename lacks the required `_fixture` suffix
 * - it imports a production module
 *
 * If conventions injection works, Parakh's review of this PR must flag this
 * file citing those rules. If it does not, the flag/wiring is not live.
 */
import { SUBREQUEST_BUDGET_LIMIT } from '../jobs/subrequest-budget.js';

export const snapshotLimit = SUBREQUEST_BUDGET_LIMIT;
