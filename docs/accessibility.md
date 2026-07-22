# Accessibility

This document records the accessibility threshold for the Nexotao Agents public beta, the automated
checks that gate the build, and how to run the audit.

## Target

**WCAG 2.1 Level AA** is the accessibility target for the web UI.

For the beta, the enforced bar is an **automated audit** that gates the build. Full manual AA
conformance review is **aspirational** for the beta period: manual review of screen-reader flows,
keyboard traps, and focus order is planned but is not a release blocker for the beta. The automated
gate is the enforced minimum.

## Enforced automated checks

The audit fails the build if any of the following is violated:

- **Accessible names.** Every interactive control — buttons, links, and form inputs — must expose an
  accessible name (visible text, `aria-label`, or an associated `<label>`). No unlabeled interactive
  control may ship.
- **No critical-path horizontal overflow at 390×844.** At a common small-phone viewport
  (390×844 CSS px), the primary/critical-path screens must not produce horizontal scrolling
  (content must not exceed the viewport width).
- **Document language.** The document must declare a language (`<html lang="…">`).
- **Color contrast (intent).** Text and essential UI must meet WCAG 2.1 AA contrast intent; the color
  system is chosen to satisfy AA contrast for text and interactive elements.

These checks encode the minimum the beta commits to and are the ones enforced by the gate.

## Running the audit

```bash
npm run audit:a11y
```

Run it against a built app. A non-zero exit indicates a failing check; the output identifies the
control or screen at fault. The same audit is intended to run in CI so a regression that removes an
accessible name or introduces small-viewport horizontal overflow blocks the release.

## Scope and known limitations

- The gate is automated and therefore covers what can be checked programmatically (accessible names,
  small-viewport overflow, document language, contrast intent). It does not, by itself, certify full
  WCAG 2.1 AA conformance.
- Manual assistive-technology testing (screen readers, keyboard-only navigation, focus management) is
  aspirational for beta and tracked for a subsequent milestone.
- Report accessibility issues through the project's issue tracker so they can be prioritized.
