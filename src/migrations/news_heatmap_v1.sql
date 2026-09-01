-- Migration: news_heatmap daily aggregate tables (TZ 11.11 v2.16)
-- Run manually or via /migrate-news-heatmap endpoint.

CREATE TABLE IF NOT EXISTS news_tag_daily (
  tag_id    TEXT NOT NULL,
  day_msk   DATE NOT NULL,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, day_msk)
);

CREATE TABLE IF NOT EXISTS user_portfolio_daily (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_msk   DATE NOT NULL,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_msk)
);

CREATE TABLE IF NOT EXISTS user_portfolio_daily_meta (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tags_hash  TEXT NOT NULL,
  rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_all_daily (
  day_msk   DATE PRIMARY KEY,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0
);
