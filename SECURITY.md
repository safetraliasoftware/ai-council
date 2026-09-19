# Security policy

Please report security issues **privately**. Do not open a public GitHub issue for secrets, remote-code paths, or anything that could be used against other installs.

## How to report

1. Preferred: GitHub private advisory — on this repository open **Security → Advisories → Report a vulnerability**.
2. Or email [info@safetralia.de](mailto:info@safetralia.de?subject=AI%20Council%20security) with enough detail to reproduce.

We aim to acknowledge reports within a few days.

## Scope

In scope: the AI Council desktop app, its GitHub Releases/auto-update path, and this repository.

Out of scope: third-party CLIs (Claude Code, Codex, Antigravity, Grok Build) and provider APIs — report those to the respective vendor.

API keys and local agent logins stay on the user's machine (`safeStorage` / the vendor CLI). They are not part of this repository and must never be committed here.
