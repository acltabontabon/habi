---
name: react-component-review
description: Review React components for accessibility, state management and rendering cost. Use when .tsx/.jsx components change.
---

# React component review

1. Accessibility: semantic elements, labels, focus order, keyboard handling.
   See [the a11y notes](references/a11y.md).
2. State: derive instead of duplicating; keep effects for synchronization only.
3. Rendering: avoid creating components inside components; memoize only with evidence.
4. Tests: behaviour-focused tests with Testing Library queries by role.
