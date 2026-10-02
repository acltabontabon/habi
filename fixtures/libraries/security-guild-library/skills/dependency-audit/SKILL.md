---
name: dependency-audit
description: Audit JavaScript/TypeScript dependencies for known vulnerabilities and summarize what to upgrade. Use before releases or when the lockfile changes.
---

# Dependency audit

1. Run the audit check from Habi, or `npm audit --omit=dev` yourself.
2. Summarize findings with `scripts/summarize.sh` (expects audit JSON on stdin).
3. Propose upgrades, smallest safe version first.
