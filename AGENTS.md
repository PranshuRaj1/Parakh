# Parakh Conventions

Rules every contributor (and reviewer bot) should follow.

## Database

- Use `pnpm db:push` for schema changes — migrations are not used in this repo.

## Code style

- Never flag missing semicolons.
- Prefer small, single-purpose functions over utility classes.

## Scope example

<!-- front-matter-style scope is not supported in plain AGENTS.md; this section is prose only -->

Worker code lives in `worker/src`, dashboard code in `dashboard/src`.
