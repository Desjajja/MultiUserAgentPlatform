# MUAP Observability Refactor (metadata final) - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Supersedes:** `docs/superpowers/plans/2026-06-07-muap-observability-phoenix17-route-taxonomy.md`. That earlier plan kept `muap.*` as flat OTel attribute keys. This plan replaces the flat-key filter carrier with the OpenInference **`metadata`** namespace, because Phoenix's graphical filter UI does **not** accept `attributes` as a first-class filter field, whereas `metadata` is a documented first-class filter field. Keep the old plan only as a diff reference.

**Goal:** Upgrade Phoenix from `8.0.0` to `17.2.0`; migrate business tags from flat `muap.*` attribute keys to the OpenInference `metadata` namespace; replace `route_type='a2a'` with `engage_mode='a2a'`, add `RouteType.ERP` (reserved); propagate container-side route context through `FRONTLANE_ROUTE_TYPE` + `FRONTLANE_SESSION_ID` so `agent.turn` reflects the real lane and real session id instead of hardcoded `worker` / `unknown`.

**Architecture:** Business filter dimensions live in OpenInference `metadata` (a single `metadata` JSON attribute on each span), not in flat `muap.*` keys. On the host, encode via `@arizeai/openinference-core`'s `getMetadataAttributes(tags)` (already installed at `2.2.0`). In the container (no `@arizeai` dependency), encode via a small local helper that emits the same `metadata` JSON-string attribute. Keep `applyBusinessTags(span, {...})` as the stable call-site API for all 15 host emitters; only swap its internals. Upgrade Phoenix first against a cloned staging database, then refactor span tagging against the upgraded filter behavior.

**Tech Stack:** TypeScript, OpenTelemetry/OpenInference, `@arizeai/openinference-core@2.2.0`, `@arizeai/openinference-semantic-conventions`, Arize Phoenix `17.2.0`, Docker Compose, PostgreSQL, Grafana, pnpm, Bun

---

## Overview

- Four coupled workstreams: Phoenix image/env upgrade, **flat→metadata migration**, `route_type` taxonomy cleanup + host→container route context propagation, and doc/ADR/test realignment.
- The decisive constraint discovered during research: in Phoenix's graphical filter UI, `attributes` (and therefore flat `muap.*` keys) is **not** a valid filter field, but `metadata` **is** a first-class filter field. Phoenix official docs show `metadata["topic"] == 'programming'` and state "Any expressions that work with the `.where()` method can also be used in the UI."
- `getMetadataAttributes(metadata)` produces a single `{ metadata: JSON.stringify(...) }` attribute. This is the OpenInference-blessed way to make business dimensions filterable as `metadata[...]`.
- `setMetadata` / `using_metadata` are **not** usable here: they only put data into the OTel context, expecting an `OITracer` / auto-instrumentation to read it at `startSpan` time. This project uses bare `@opentelemetry/api` `tracer.startSpan()` / `startActiveSpan()`, so context-based metadata never lands on the span. We must write the `metadata` attribute explicitly.
- Business-layer spans (`router.*`, `delivery.*`, `agent.turn`, `container.*`) are hand-written by design. Auto-instrumentation only covers third-party/technical layers and does **not** cover these. This hybrid (auto tech layer + hand-written business layer) is the OpenInference-recommended architecture; current rating: B, no rewrite required.
- No Node/Bun runtime dependency bump is required. Host already has `@arizeai/openinference-core@2.2.0` + `@arizeai/openinference-semantic-conventions`. Container intentionally stays `@arizeai`-free (local helper) to avoid image/dependency bloat.
- Line ranges are pinned to HEAD inspected `2026-06-07`; re-check after adjacent edits before applying patches.

## Prerequisites

1. Confirm architectural baseline still valid:
   - `docs/migration-from-v1.md`
   - `../openclaw/CLOSEOUT/migration-to-muap.md` v1.2
   - `docs/decisions/ADR-0007-observability-phoenix-grafana.md`
   - `docs/decisions/ADR-0009-observability-bootstrap-contract.md`
   - `docs/decisions/ADR-0014-observability-span-schema.md`
2. Snapshot observability data before any Phoenix upgrade:
   - Staging clone from prod backup/volume snapshot; never rehearse 17.2.0 against prod-in-place.
   - Prod: `pg_dump` + storage-level volume snapshot of `muap_phoenix_postgres_data` before Phoenix 17 migrations.
3. Freeze current contract for comparison:
   - Save current `pnpm obs:config` output.
   - Export a small sample of recent spans from Phoenix 8.x for before/after filter verification.
4. Treat two already-discovered hidden issues as part of the same rollout:
   - `container/agent-runner/src/index.ts:47` and `:105` read `FRONTLANE_SESSION_ID`, but `src/container-runner.ts` never injects it today (verified: only `OTEL_TRACEPARENT` injected at `container-runner.ts:217-222`). Result: `agent.turn` emits `session.id='unknown'`.
   - `RouteType.ERP` is a taxonomy addition first; no existing ERP OTel emission point. Do not fake `erp` onto worker spans.

## Phase 1: Phoenix Upgrade

### Steps

1. Update compose image pins and environment defaults.
   - `infra/observability/docker-compose.prod.yml`: `arizephoenix/phoenix:version-8.0.0` → `version-17.2.0`; add 17.x hardening env under `phoenix.environment`:
     - `PHOENIX_AGENTS_DISABLE_WEB_ACCESS=true`
     - `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`
     - `PHOENIX_TELEMETRY_ENABLED=false`
     - `PHOENIX_ALLOWED_PROVIDERS=NONE`
   - `infra/observability/docker-compose.sim.yml`: same image bump + same env hardening.
   - `infra/observability/.env.example`: commented guidance for new flags if configurable outside compose.
2. Update `infra/observability/README.md`: pinned version row → `17.2.0`; add Phoenix 17 staging→prod migration section; replace 8.x filter caveats with 17.x smoke-test steps incl. `metadata[...]` filter verification + env-flag verification.
3. Stage the DB migration before production (restore prod-like backup → bring up observability stack only → let Phoenix run internal migrations → capture startup logs + schema diff). Prod: stop Phoenix only, keep DB snapshot, deploy, watch migration logs to completion.
4. Record as ADR-0017 (see Phase 4). Decide whether ADR-0009 is superseded or kept historical with image-pin supersession noted in ADR-0017.

### Verification

- `pnpm obs:config` → both compose files render with Phoenix `17.2.0`.
- `pnpm obs:up` (staging) → Phoenix starts clean, no migration crash loop.
- `curl -fsS http://localhost:6006 >/dev/null` → UI responds.
- `docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml logs phoenix` → no unknown-env / migration-failure error.
- `docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml exec phoenix env` → new env flags present.

## Phase 2: Business Tag Migration (flat → metadata)

### `src/observability/business-tags.ts`

- [ ] Change `BusinessTagKeys` values from flat `muap.*` to plain metadata-internal keys:
  - `LAYER: 'layer'`, `ROUTE_TYPE: 'route_type'`, `LANE: 'lane'`, `CHANNEL: 'channel'`, `INTENT: 'intent'`, `AGENT_GROUP: 'agent_group'`, `SESSION_MODE: 'session_mode'`, `ENGAGE_MODE: 'engage_mode'`, `PROVIDER: 'provider'`.
- [ ] `RouteType`: delete `A2A`, add `ERP`. Final set: `frontdesk | worker | erp | system`.
- [ ] Keep `ENGAGE_MODE` typed as `'direct' | 'a2a'` — the sole A2A marker.
- [ ] Rewrite `applyBusinessTags` internals: instead of looping `span.setAttribute(muap.key, val)`, build the metadata record and emit via `getMetadataAttributes` from `@arizeai/openinference-core`, then `span.setAttributes(...)`. Keep the **call-site signature unchanged** (`applyBusinessTags(span, { [BusinessTagKeys.X]: ... })`) so all 15 host emitters need zero changes.
  - Note: because metadata is a single JSON attribute, repeated `applyBusinessTags` calls on the same span must **merge**, not overwrite. Either accumulate all tags before one emit, or read-merge-rewrite. Verify Phoenix-side that the final span carries the union.
- [ ] `createBusinessTags` may stay as the pure record builder feeding `getMetadataAttributes`.

### Collapse bare `setAttribute` tech debt into the metadata path

- [ ] `src/router.ts:541-545`: `session.id` / `agent.group.id` stay as real OTel attributes (they are OpenInference semantic fields, not business filters). But `muap.agent_group`, `muap.session_mode`, `muap.engage_mode` must move into the `applyBusinessTags` metadata call (use `BusinessTagKeys.AGENT_GROUP/SESSION_MODE/ENGAGE_MODE`), not raw `rootSpan.setAttribute('muap.*', ...)`.
- [ ] `src/router.ts:522-528`: already uses `applyBusinessTags`; confirm it now routes through metadata after the internals swap. Derive `ROUTE_TYPE` from the target lane rather than hardcoding `frontdesk` if the deliver target is a worker (see Phase 3 derivation rule).
- [ ] `src/observability/context-bridge.ts:60-62`: `output.value` / `output.mime_type` are OpenInference semantic output fields — **keep as real attributes** (do NOT move into metadata). Just confirm they are not mistaken for business tags.

### Notes

- `RouteType.ERP` reserved; do not force onto current spans.
- `src/types.ts` has no agent-group role field; do not add a DB migration. Use stable folder conventions (`*-frontdesk` → frontdesk, else worker) for derivation; reserve `erp` for explicit future override.

## Phase 3: Container-side Route Context Propagation

### Steps

1. Host env injection (`src/container-runner.ts`, in `spawnContainer` near `:217-222` where `OTEL_TRACEPARENT` is pushed, `session` in scope):
   - [ ] Inject `FRONTLANE_SESSION_ID=<session.id>` (closes the `session.id='unknown'` bug).
   - [ ] Inject `FRONTLANE_ROUTE_TYPE=<derived-route-type>`.
   - [ ] Optional: `FRONTLANE_AGENT_GROUP_ID=<agentGroup.id>`.
2. Host derivation rule (pure helper, tested):
   - `*-frontdesk` folder → `frontdesk`; explicit future override → `erp`; otherwise → `worker`. No fuzzy substring inference for `erp`.
   - Reuse the same rule for the `container.spawn` / `container.wake` business tags so host span and injected env agree per session.
3. Container config (`container/agent-runner/src/config.ts`): add typed `routeType?: 'frontdesk' | 'worker' | 'erp' | 'system'`; add env parser (mirror `resolveIdleExitMs` style); load `FRONTLANE_ROUTE_TYPE` into cached config.
4. `agent.turn` consumes propagated context:
   - `container/agent-runner/src/index.ts`: pass resolved route type into the `startAgentTurn` path.
   - `container/agent-runner/src/poll-loop.ts`: thread route type to `startAgentTurn()`.
   - `container/agent-runner/src/observability/turn-span.ts:22-38`: **remove flat `muap.*`**; replace with the container-local metadata helper emitting a `metadata` JSON-string attribute (`{ layer:'ai', route_type:<derived>, lane:<derived>, provider }`). Keep `openinference.span.kind='CHAIN'` and `session.id` as real attributes. Stop hardcoding `route_type='worker'`.
5. Container-local metadata helper:
   - [ ] Add a tiny helper (e.g. `container/agent-runner/src/observability/metadata.ts`) that takes a record and returns `{ metadata: JSON.stringify(record) }`, matching host `getMetadataAttributes` output shape. No `@arizeai` import.

### Verification

- `container/agent-runner/src/integration.test.ts`: assert `agent.turn` carries `session.id !== 'unknown'` and a `metadata` attribute whose decoded JSON `route_type` matches injected env; parameterize frontdesk vs worker.
- Manual smoke: frontdesk session → `agent.turn` metadata `route_type=frontdesk`; worker → `worker`.
- Phoenix UI/REST after replay: frontdesk container spans excluded from `metadata["route_type"] == "worker"` filter.

## Phase 4: Documentation Updates

### `docs/observability-business-tags.md` + `.html`

- [ ] Route-type registry → `frontdesk / worker / erp / system`; remove `a2a` from `route_type`; keep `engage_mode = direct | a2a`.
- [ ] Rewrite tag model: business dimensions live in `metadata`, not flat `muap.*`. Describe `getMetadataAttributes` (host) and the container-local helper.
- [ ] Filtering examples (metadata final):
  - UI DSL: `metadata["route_type"] == "frontdesk"`
  - REST: `attribute=metadata.route_type:frontdesk`
  - SQL/Grafana: `attributes->'metadata'->>'route_type' = 'frontdesk'`
- [ ] `agent.turn` described as env/config-driven (frontdesk and worker both possible), not permanently worker.
- [ ] HTML mirrors all enum/table/filter changes (human-reading copy only; MD is LLM source of truth).

### `docs/observability-span-schema.md`

- [ ] Container OTel section: `agent.turn` no longer claims `route_type='worker'` unconditionally; route type from `FRONTLANE_ROUTE_TYPE`; `a2a` is `engage_mode`, not `route_type`; add reserved `erp`.

### `docs/observability-instrumentation-methodology.md`

- [ ] Add metadata model + SQL/REST/UI filter syntax. State hand-written business spans are the official OpenInference architecture; record why `setMetadata`/`OITracer` is future work, not current.

### `infra/observability/README.md`

- [ ] Pinned Phoenix `17.2.0`; replace 8.x "REST attribute not supported" guidance with 17.x smoke tests; add staging/prod migration + env-hardening verification + `metadata[...]` filter check.

### `docs/decisions/ADR-0017-observability-phoenix17-route-type-taxonomy.md` (new) + `docs/decisions/README.md` index

- [ ] Record together: Phoenix baseline → `17.2.0`; business dimensions → OpenInference `metadata` (not flat `muap.*`); `route_type='a2a'` deprecated for `engage_mode='a2a'`; container route context propagated by env. Future work: Tier 3 official `withSpan`/`traceChain`, Tier 4 `OITracer` masking/redaction, LLM auto-instrumentation `@arizeai/openinference-instrumentation-openai`.

### Deliberately Not Updated

- `reports/human/*`, `docs/superpowers/plans/2026-06-02-observability-refactor.md` (historical).

## Phase 5: Testing & Verification

### Unit / Contract Tests

1. `scripts/observability-bootstrap.test.ts`: image-pin assertions `8.0.0` → `17.2.0`; assert new compose env flags present.
2. `src/container-runner.test.ts`: cover route-type derivation helper + env-emission builder.
3. `container/agent-runner/src/integration.test.ts`: `agent.turn` exporter test asserts `session.id !== 'unknown'` and decoded `metadata.route_type` matches injected env; parameterize frontdesk/worker.
4. `scripts/observability-span-schema.test.ts`: update only if doc string-checks invalidated.
5. `scripts/observability-coverage.test.ts`: keep real-repo coverage scan green.

### Full verification gate

- `pnpm typecheck`
- `pnpm test`
- `pnpm container:build`
- `cd container/agent-runner && bun run typecheck`
- `cd container/agent-runner && bun test`

### Integration / Manual QA

1. `pnpm obs:config` + `pnpm obs:up` → Phoenix/Grafana/Postgres healthy.
2. `pnpm typecheck` + `pnpm test` + `pnpm dev` → host clean.
3. Frontdesk path: send deterministic message → `router.route`, `router.deliver_to_agent`, `agent.turn` all carry metadata `route_type=frontdesk`.
4. Worker path: frontdesk→worker delegation → worker span metadata `route_type=worker`, `engage_mode=a2a` where delegation occurred, no `route_type=a2a`.
5. REST filter: `attribute=metadata.route_type:frontdesk` returns frontdesk, excludes worker.
6. UI DSL: `metadata["route_type"] == "frontdesk"` works in 17.2.0.
7. SQL/Grafana: `attributes->'metadata'->>'route_type'` examples run against upgraded Postgres; no example assumes flat `muap.*` or `route_type='a2a'`.

### Expected Outcomes

1. `RouteType.A2A` gone from production code.
2. `engage_mode='a2a'` is the only A2A marker.
3. `agent.turn` route type + session id reflect reality.
4. Business filtering works via `metadata[...]` in UI, REST, and SQL on Phoenix 17.2.0.
5. Docs/ADRs/runtime examples consistently describe the `metadata` model.

## Rollback Plan

1. Phoenix image: revert both compose files to `version-8.0.0`; drop new env flags if startup rejects them.
2. DB: discard staging clone and rebuild from snapshot; in prod restore from `pg_dump`/volume snapshot — never downgrade in place.
3. Runtime: revert metadata/route patch set in `src/observability/business-tags.ts`, `src/router.ts`, `src/observability/context-bridge.ts`, `src/container-runner.ts`, `container/agent-runner/src/config.ts`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/observability/turn-span.ts`, `container/agent-runner/src/observability/metadata.ts`, `container/agent-runner/src/poll-loop.ts`.
4. Retention overlap: old traces keep flat `muap.route_type='a2a'` until retention expires (`PHOENIX_DEFAULT_RETENTION_POLICY_DAYS=7`). During overlap, query old data by legacy flat keys and new data by metadata; do not assume one schema across the boundary.
5. Query rollback: if metadata SQL assumptions are wrong on real 17.2.0 storage, revert doc/dashboard examples to verified staging syntax and keep runtime refactor separate from query-shape cleanup.

## Risk Mitigation

1. Phoenix auto-migrates DB on startup → always rehearse on cloned staging + keep prod snapshots.
2. `erp` enum exists before ERP spans → document as reserved, never assign to current spans.
3. No agent-group role field in `src/types.ts` → use folder conventions; add explicit override later for first-class `erp`.
4. Container already expects `FRONTLANE_SESSION_ID` → ship `FRONTLANE_SESSION_ID` + `FRONTLANE_ROUTE_TYPE` injection together.
5. metadata merge hazard: multiple `applyBusinessTags` calls must union, not clobber, the single `metadata` attribute → verify on a real span in staging.
6. Docs still describe nested/flat JSON → verify every SQL/REST/UI example against staging before promoting.

## Timeline Estimate

- Phase 1 Phoenix upgrade rehearsal: `0.5-1.0` day
- Phase 2 metadata migration + tech-debt collapse: `0.75-1.25` day
- Phase 3 container env propagation + tests: `0.5-0.75` day
- Phase 4 docs + ADR: `0.5` day
- Phase 5 staging/prod verification + rollback rehearsal: `0.5-0.75` day
- Total: `2.75-4.25` engineer days

## Post-Implementation Oracle Review (2026-06-07)

Oracle read-only architecture review classified the implementation as **Block**, with 1 Critical / 2 Important / 1 Nit. All issues fixed in the same change set.

| Severity | Issue | Fix |
|---|---|---|
| Critical | `agent.turn` did not parent under host trace; `OTEL_TRACEPARENT` was extracted in `init.ts` but never passed to `tracer.startSpan` in `turn-span.ts`. Host→container trace tree silently broken. | `init.ts` exports `getParentContext()`; `turn-span.ts` calls `tracer.startSpan(name, opts, ctx)` with that context. New `turn-span.test.ts` asserts `traceId` + `parentSpanId` match an explicit traceparent. |
| Important | `container.wake/spawn/kill` host platform spans hardcoded `route_type='worker'`, mislabeling frontdesk container lifecycle. | `src/container-runner.ts` adds `laneForSession(agentGroupId)` to derive lane from `agentGroup.folder`; falls back to `'system'` when the group is gone. |
| Important | Container `routeType` was unvalidated `string`, so manual `docker run -e FRONTLANE_ROUTE_TYPE=a2a` would still emit `metadata.route_type='a2a'`. | `metadata.ts` adds `validateRouteType()` allowlist; `index.ts` calls it on env read. Unknown values collapse to `'worker'` with stderr warning. |
| Nit | `FRONTLANE_SESSION_ID` missing falls back to `'unknown'` silently, masking host injection regressions. | `index.ts` logs a stderr `WARNING:` when env is missing before falling back. |

Test deltas: `container/agent-runner/src/observability/turn-span.test.ts` (new, 4 tests covering parent context + route validation). All 372 host + 186 container tests pass after fixes.

## QA-Discovered Latent Bug — Docker Env Splice (2026-06-08)

Manual QA exposed an unrelated, longer-lived defect that defeated the Oracle Critical fix at runtime: `src/container-runner.ts` injected `-e OTEL_TRACEPARENT=...`, `-e FRONTLANE_ROUTE_TYPE=...`, `-e FRONTLANE_SESSION_ID=...` *after* `buildContainerArgs(...)` had already terminated the docker run command line with `--entrypoint bash <image> -c "exec bun run /app/src/index.ts"`. In docker's positional grammar, anything past `<image>` is entrypoint argv, not container env. Verified empirically via `docker inspect ... .Config.Env` (no FRONTLANE_*) and `docker inspect ... .Args` (`-e` flags appearing alongside `-c`).

Symptoms (already attributed to other root causes):
- `agent.turn` span landed without host parent (looked identical to the Oracle Critical case but the underlying cause was env never reaching the container).
- `FRONTLANE_ROUTE_TYPE` resolved to `'worker'` via the new fallback (looked like correct behavior).
- `FRONTLANE_SESSION_ID` triggered the new stderr warning + `'unknown'` fallback.

Fix: collect injection flags into `envFlags: string[]` and `args.splice(args.indexOf('--entrypoint'), 0, ...envFlags)` so they precede `--entrypoint`/image. Throw if the `--entrypoint` anchor is missing, to prevent silent regressions if the build function changes. Verified `docker inspect ... .Args = ["-c","exec bun run /app/src/index.ts"]` and `docker exec ... env` shows all three vars; Phoenix REST `attribute=metadata.route_type:worker` returns `agent.turn` under the same trace tree as `router.deliver_to_agent`.
