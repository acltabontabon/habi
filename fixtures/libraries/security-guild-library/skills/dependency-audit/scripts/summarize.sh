#!/bin/sh
# Prints the number of advisories per severity from `npm audit --json` on stdin.
grep -o '"severity": *"[a-z]*"' | sort | uniq -c
