# Parakh Review Rules

## Payments

- Never recommend automatic retries for payment capture.
- Flag monetary calculations using floating-point arithmetic.

## Architecture

- API handlers must not access the database directly.
- Database access belongs in repositories.

## Review priorities

1. Correctness
2. Security
3. Concurrency
4. Performance

Ignore formatting and naming preferences.
