# Security Policy

## Privacy posture

Anchor is **local-first by design**. With the default (local) providers, your
notes are never sent anywhere — embedding and verification run in-process on
your machine, and the index lives in `<vault>/.anchor/`.

Your notes leave the machine **only** if you opt into an API-backed provider by
setting an API key:

- `ANTHROPIC_API_KEY` — passages and claims are sent to the Anthropic API for
  the higher-accuracy verifier.
- `OPENAI_API_KEY` (when enabled) — note text is sent to OpenAI for embeddings.

If you do not set these, nothing is transmitted.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/Perfectio/obsidian-anchor/security/advisories/new), or
- email `justinkim041004@gmail.com`.

Please include a description, reproduction steps, and the affected version. We aim
to acknowledge reports within 72 hours.

## Supported versions

This project is pre-1.0; only the latest released version receives security fixes.
