# Parakh Worker

Cloudflare Worker that reviews pull requests against learned rules and posts
findings back to the PR. See the repo-root README and `.github/workflows/`
for deployment.

Deploys automatically on pushes to `main` that touch this directory.