# ADR-0019: Branch-Default Frontdesk Policy

- **Status**: Accepted
- **Date**: 2026-06-10
- **Decider(s)**: 用户（项目负责人），coding agent Hephaestus（执行 + 验证）
- **Tags**: `naming`, `governance`, `frontdesk`, `phase0a`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

ADR-0008 introduced `frontlane-lab-frontdesk` as an additive Phase 0a desk and explicitly avoided replacing the existing default. ADR-0010 then renamed the generic default to `frontlane-template-frontdesk` because it is a reference template, not the real lab-facing agent.

By June 2026, day-to-day development on `dxy-dev` needed CLI/local QA to enter the lab desk by default, while `main` still needed to remain a safe enterprise baseline whose primary provisioned desk is the template. The risky shortcut would be changing `DEFAULT_FRONTDESKS[0]` from template to lab, but that would make main merges silently promote lab behavior into the bootstrap primary desk.

Known constraints:

- `ENTERPRISE_FRONTDESK_FOLDER` remains the highest-precedence explicit runtime override.
- `DEFAULT_FRONTDESKS[0]` in `scripts/init-enterprise-topology.ts` remains the primary template desk.
- `dxy-dev` local/runtime QA should use `frontlane-lab-frontdesk` without requiring every run to edit `.env.local`.
- Unknown branches and detached/non-git environments must keep the template default.

## Options Considered

- **Option A — Branch-aware runtime default**: keep bootstrap primary as template, but let runtime default resolution map `dxy-dev` to `frontlane-lab-frontdesk` when no explicit env override exists. Clear separation between branch-local QA behavior and main bootstrap policy. Small code/test surface.
- **Option B — Swap `DEFAULT_FRONTDESKS[0]` to lab on `dxy-dev`**: easiest for local QA, but changes the meaning of primary frontdesk and risks merging the lab desk into main as the default bootstrap target. Rejected.
- **Option C — Require `ENTERPRISE_FRONTDESK_FOLDER=frontlane-lab-frontdesk` for every lab QA run**: preserves old behavior, but repeats a known manual setup step and makes Task 8 evidence easy to collect against the wrong template entrypoint. Rejected for `dxy-dev` workflow.

## Decision

> **拍板**：选 Option A — branch-aware runtime default.

Runtime frontdesk resolution now follows this precedence:

1. `ENTERPRISE_FRONTDESK_FOLDER` if set.
2. Current git branch default: `dxy-dev` → `frontlane-lab-frontdesk`.
3. Existing filesystem/template fallback: `main`, unknown branch, detached HEAD, or non-git runtime → `frontlane-template-frontdesk` with legacy folder fallback preserved.

`DEFAULT_FRONTDESKS[0]` remains `DEFAULT_FRONTDESK_FOLDER` / `DEFAULT_FRONTDESK_NAME`, so `pnpm init:enterprise` still treats `frontlane-template-frontdesk` as the primary bootstrap desk on main.

## Consequences

- **Positive**: Local `dxy-dev` QA uses the lab desk by default without hidden `.env.local` requirements; main stays conservative and template-first.
- **Positive**: `ENTERPRISE_FRONTDESK_FOLDER` still provides a deliberate override for production or one-off tests.
- **Positive**: `pnpm check:frontdesk-policy` and the PR template catch accidental changes to the template primary desk before merge.
- **Negative**: Runtime behavior now depends on the current git branch when no env override is present; non-git deployments intentionally fall back to template.
- **Neutral / Trade-offs**: If future policy makes lab the default for main, this ADR must be superseded instead of weakening the guard.

## Implementation Notes

- `src/branding.ts`: adds `LAB_FRONTDESK_FOLDER`, `LAB_FRONTDESK_NAME`, `resolveCurrentGitBranch()`, and `resolveBranchDefaultFrontdesk()`; integrates branch defaults after explicit env override and before filesystem fallback.
- `src/branding.test.ts`: locks env precedence, `dxy-dev` lab default, main/unknown template behavior, and legacy fallback.
- `scripts/generate-env-local-proposed.ts`: appends a MUAP-local note explaining that `dxy-dev` already defaults to lab and explicit env is only an override.
- `scripts/check-frontdesk-default-policy.ts`: local/CI guard for template constants, branch mapping, and `DEFAULT_FRONTDESKS[0]` source shape.
- `.github/pull_request_template.md`: adds reviewer checklist for frontdesk default policy.
- `README.md` and `docs/PLATFORM.md`: document branch default behavior and the guard command.

Verification:

- `pnpm exec vitest run src/branding.test.ts scripts/generate-env-local-proposed.test.ts scripts/check-frontdesk-default-policy.test.ts`
- `pnpm check:frontdesk-policy`
- `pnpm typecheck`

## References

- ADR-0008: `docs/decisions/ADR-0008-phase0a-lab-frontdesk-onboarding.md`
- ADR-0010: `docs/decisions/ADR-0010-rename-default-frontdesk-to-template.md`
- Runtime resolver: `src/branding.ts`
- Bootstrap primary desk: `scripts/init-enterprise-topology.ts`
