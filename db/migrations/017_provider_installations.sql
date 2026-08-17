-- Parakh: provider-agnostic repo connections (GitHub first, GitLab/Bitbucket later).
-- One row per provider account (owner/org or user) with the repos the app can see.

CREATE TABLE IF NOT EXISTS provider_installations (
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  repos JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  installed_by TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, owner)
);

CREATE INDEX IF NOT EXISTS idx_provider_installations_status
  ON provider_installations(provider, status);
