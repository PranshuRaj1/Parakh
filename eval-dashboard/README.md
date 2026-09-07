# Parakh Eval Dashboard

Public Next.js dashboard for published eval summaries.

## Local development

Set `DATABASE_URL` to the Neon database containing migration `021_eval_dashboard.sql`, then run:

```sh
npm run eval-dashboard:dev
```

The dashboard has no login by design. It reads published summaries from Postgres and serves private report blobs through a server-side download route.

## Publishing a run

Set these variables in the shell that runs the eval:

```sh
DATABASE_URL=...
BLOB_READ_WRITE_TOKEN=...
```

Then run `npm run eval:latest`. The command saves the local report, uploads the full report to Vercel Blob, and writes the run and case metrics to Postgres.
