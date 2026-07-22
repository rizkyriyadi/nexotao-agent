# Staged Rollout & Rollback Decision — Public Beta

This document records the rollout plan and the explicit go/rollback decision for the `nexotao` 0.2.0
public beta. It defines the phases, the success and abort criteria for each, and the rollback trigger
and procedure.

## Decision

**Recommendation: GO to the limited beta phase.** Publish 0.2.0 under the npm `beta` dist-tag (not
`latest`) so only users who opt in with `nexotao@beta` receive it. Promotion to General Availability
(GA / the `latest` tag) is gated on the Phase 2 success criteria below.

Rationale: the release-safety CI gate passes (lint, tests, build, packaged
install/launch/health/shutdown smoke test), the production dependency audit gate
(`npm audit --omit=dev --audit-level=high`) passes, and the only outstanding advisories are moderate,
build-time-only findings with a documented risk acceptance in [`SECURITY.md`](../SECURITY.md). The
application is local and single-user, which bounds blast radius: a beta published under a dedicated
dist-tag reaches no existing `latest` user unless they explicitly install it.

## Phases

### Phase 0 — Internal validation
- **Audience:** maintainers and internal testers, installing from a locally packed tarball.
- **Gate to proceed:** CI green on the release branch; the smoke test installs, launches, reports
  healthy, and shuts down cleanly; a manual pass of onboarding, chat, a run, and per-project
  export/delete on Linux, macOS, and Windows.

### Phase 1 — Limited npm `beta` dist-tag
- **Action:** `npm publish --tag beta`. Users opt in with `npm install -g nexotao@beta`.
- **Audience:** early adopters who choose the beta channel. `latest` is unaffected.
- **Duration:** a minimum soak period (suggested 1–2 weeks) before considering promotion.

### Phase 2 — General Availability
- **Action:** promote the validated build to `latest`
  (`npm dist-tag add nexotao@<version> latest`).
- **Audience:** all users of `npm install -g nexotao`.

## Success criteria (to advance a phase)

- CI (lint, tests, build, dependency audit, packaged smoke test) is green for the candidate build.
- No unresolved high or critical production dependency advisory.
- No open report of: a secret leaking into storage/exports/logs, a project-root confinement escape, or
  an authentication/host/origin bypass.
- Update and rollback verified per [update-rollback.md](update-rollback.md), including that the data
  directory is untouched by install/uninstall.
- No unresolved data-loss or failed-migration report from the current phase's audience.

## Abort / rollback criteria (trigger a rollback)

Roll back if any of the following is observed in the active phase:

- A confirmed secret leak, authentication/host/origin bypass, or file-tool confinement escape.
- A new high or critical production dependency advisory with no available fix.
- A forward migration that corrupts or loses user data, or that prevents startup on a supported
  platform.
- The packaged smoke test (install → launch → health → shutdown) fails on a supported platform.

## Rollback procedure

1. **Stop promotion.** Do not advance to the next phase.
2. **Repoint the dist-tag.** If a bad build is on `beta`, move the tag back to the last known-good
   version: `npm dist-tag add nexotao@<last-good> beta`. If a bad build reached `latest`, move
   `latest` back to the last known-good version the same way.
3. **Deprecate the bad version** so new installs are warned:
   `npm deprecate nexotao@<bad-version> "Withdrawn: use nexotao@<last-good>"`.
   (A published version cannot be safely unpublished once others depend on it; deprecation is the
   supported path.)
4. **Advise affected users** to reinstall the last-good version
   (`npm install -g nexotao@<last-good>`) and, if a forward migration was involved, to restore from
   their backup per [update-rollback.md](update-rollback.md#restoring-data-from-a-backup).
5. **Publish a fixed patch** and restart at Phase 0 for that change.

## Ownership

The release maintainer owns the go/rollback decision at each phase boundary and is responsible for
executing the rollback procedure if a trigger fires.
