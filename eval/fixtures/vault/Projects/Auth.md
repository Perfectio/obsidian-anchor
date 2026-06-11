---
title: Auth Rewrite
tags: [project, auth]
---
# Auth Rewrite

## Timeline

The auth rewrite slipped to Q3 2026. March only covered the design phase — no code shipped in March. ^k93a

## Decisions

Decision: use Postgres as the primary data store, chosen over MySQL for its JSONB support and stronger constraints. ^d4e1

Sessions use short-lived JWT access tokens, with refresh tokens stored server-side. ^s5f2
