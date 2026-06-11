# MUAP Observability Refactor - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Phoenix from `8.0.0` to `17.2.0`, replace `route_type='a2a'` with `engage_mode='a2a'`, add `RouteType.ERP`, and propagate container-side route context through `FRONTLANE_ROUTE_TYPE` so `agent.turn` reflects the real lane instead of a hardcoded worker value.

**Architecture:** Keep `muap.*` as flat OpenTelemetry attribute keys, not a nested MUAP JSON contract. Treat `route_type` as the top-level business lane (`frontdesk` / `worker` / `erp` / `system`) and move cross-agent delegation semantics into `muap.engage_mode`. Upgrade Phoenix first on a cloned staging database, then refactor host/container span tagging against the upgraded query/filter behavior.

**Tech Stack:** TypeScript, OpenTelemetry/OpenInference, Arize Phoenix `17.2.0`, Docker Compose, PostgreSQL, Grafana, pnpm, Bun

---

## Overview

- This refactor has four coupled workstreams: Phoenix image/env upgrade, `route_type` taxonomy cleanup, host→container route context propagation, and doc/ADR/test realignment.
- The current code still hardcodes `RouteType.A2A` in `src/observability/business-tags.ts:22`, hardcodes `muap.route_type='worker'` in `container/agent-runner/src/observability/turn-span.ts:22`, and pins Phoenix `8.0.0` in both compose files.
- The current docs are internally inconsistent with runtime reality: `docs/observability-business-tags.md:125` and `docs/observability-business-tags.html:263` describe nested JSON access, while the code emits flat keys such as `muap.route_type`.
- No Node/Bun package dependency bump is required for this refactor. `package.json:36`, `container/agent-runner/package.json:11`, `pnpm-lock.yaml`, `bun.lock`, and `container/agent-runner/bun.lock` should stay untouched unless implementation introduces a brand-new helper dependency (not recommended).
- Line ranges below are pinned to the current HEAD inspected on `2026-06-07`; re-check after adjacent edits before applying patches.

## Prerequisites

1. Confirm the architectural baseline remains valid:
   - `docs/migration-from-v1.md:36`
   - `../openclaw/CLOSEOUT/migration-to-muap.md:32`
   - `../openclaw/CLOSEOUT/agent-observability-design.md:18`
   - `docs/decisions/ADR-0007-observability-phoenix-grafana.md:39`
   - `docs/decisions/ADR-0009-observability-bootstrap-contract.md:42`
   - `docs/decisions/ADR-0014-observability-span-schema.md:31`
2. Snapshot observability data before any Phoenix upgrade:
   - Staging clone: create a fresh Postgres copy from prod backup/volume snapshot; never rehearse 17.2.0 against prod-in-place.
   - Prod: take both a logical backup (`pg_dump`) and a storage-level volume snapshot of `muap_phoenix_postgres_data` before starting Phoenix 17 migrations.
3. Freeze the current observability contract for comparison:
   - Save current output of `pnpm obs:config`.
   - Export a small sample of recent spans from Phoenix 8.x for before/after filter verification.
4. Treat two already-discovered hidden issues as part of the same rollout:
   - `container/agent-runner/src/index.ts:47` and `container/agent-runner/src/index.ts:105` expect `FRONTLANE_SESSION_ID`, but `src/container-runner.ts:519-612` does not visibly inject it today.
   - `RouteType.ERP` is a taxonomy addition first; there is no existing ERP OTel emission point in `container/agent-runner/src/mcp-tools/erp-gateway.ts:1` or `src/modules/erp-audit/index.ts:1`, so do not fake `erp` onto worker spans just to “use” the enum.

## Phase 1: Phoenix Upgrade

### Steps

1. Update compose image pins and environment defaults.
   - Modify `infra/observability/docker-compose.prod.yml:14-26`
     - Change `arizephoenix/phoenix:version-8.0.0` → `arizephoenix/phoenix:version-17.2.0`.
     - Add the 17.x hardening env set under `phoenix.environment`:
       - `PHOENIX_DISABLE_AGENT_ASSISTANT=true` (per Oracle review; validate at startup in staging)
       - `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`
       - `PHOENIX_TELEMETRY_ENABLED=false`
       - `PHOENIX_ALLOWED_PROVIDERS=NONE`
   - Modify `infra/observability/docker-compose.sim.yml:2-11`
     - Same image bump and the same Phoenix env hardening set.
   - Modify `infra/observability/.env.example:14-20`
     - Add commented/default guidance for the new Phoenix 17.x env flags if you want them configurable outside compose.

2. Update the observability operator runbook to treat Phoenix 17.2.0 as the new baseline.
   - Modify `infra/observability/README.md:42-50`
     - Replace the pinned Phoenix version table row with `17.2.0`.
   - Modify `infra/observability/README.md:136-223`
     - Add a Phoenix 17 staging→prod migration section.
     - Replace Phoenix 8.x filter caveats with Phoenix 17.x smoke-test steps.
     - Add explicit verification of the new env flags in container logs / runtime env.

3. Stage the DB migration before production.
   - Staging procedure:
     - Restore a prod-like backup into a disposable Postgres instance.
     - Bring up only the observability stack with Phoenix 17.2.0.
     - Let Phoenix run its internal migrations against the staging clone.
     - Capture startup logs and a schema diff before/after migration.
   - Prod procedure:
     - Pause or reduce host trace write traffic if practical.
     - Stop the Phoenix service only; keep the database snapshot intact.
     - Deploy the compose/env changes.
     - Start Phoenix 17.2.0 and watch migration logs to completion before resuming traffic.

4. Record the upgrade as an ADR-level change.
   - Create `docs/decisions/ADR-0017-observability-phoenix17-route-type-taxonomy.md`.
   - Update `docs/decisions/README.md` with the new ADR row.
   - Decide whether to mark `docs/decisions/ADR-0009-observability-bootstrap-contract.md:3-8` as superseded by `ADR-0017` or keep it historical and note the image-pin supersession only in the new ADR.

### Verification

- `pnpm obs:config`
  - Expected: both compose files render cleanly with Phoenix `17.2.0`.
- `pnpm obs:up` in staging
  - Expected: Phoenix starts cleanly; no migration crash loop.
- `curl -fsS http://localhost:6006 >/dev/null`
  - Expected: Phoenix UI responds.
- `docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml logs phoenix`
  - Expected: startup log shows no unknown-env or migration-failure error.
- `docker compose -p muap-observability-prod -f infra/observability/docker-compose.prod.yml exec phoenix env`
  - Expected: new env flags are present (`PHOENIX_DISABLE_AGENT_ASSISTANT`, `PHOENIX_ALLOW_EXTERNAL_RESOURCES`, `PHOENIX_TELEMETRY_ENABLED`, `PHOENIX_ALLOWED_PROVIDERS`).

## Phase 2: Business Tag Refactoring

### Files to Modify

#### `src/observability/business-tags.ts:8-18`
- [ ] Keep the flat key registry as-is (`muap.route_type`, `muap.engage_mode`, etc.); do not convert to nested JSON helpers.
- [ ] Preserve `BusinessTagKeys` constants so existing emitters keep a single source of truth.

#### `src/observability/business-tags.ts:22-29`
- [ ] Change `RouteType` from `frontdesk | worker | a2a | system` to `frontdesk | worker | erp | system`.
- [ ] Delete `RouteType.A2A`.
- [ ] Add `RouteType.ERP`.

#### `src/observability/business-tags.ts:47-56`
- [ ] Keep `muap.engage_mode` typed as `'direct' | 'a2a'`.
- [ ] Ensure `RouteType` and `ENGAGE_MODE` are now clearly separate semantics in the type surface.

#### `src/router.ts:175-185`
- [ ] Re-evaluate the `router.route` platform span so its `muap.route_type` stays `frontdesk` only for ingress routing, not as a blanket value reused elsewhere.
- [ ] Keep `muap.channel` here; this is still the right binding point for channel ingress.

#### `src/router.ts:498-546`
- [ ] Replace the hardcoded AI-span `muap.route_type='frontdesk'` with a derived route type based on the target agent group/session lane.
- [ ] Keep `muap.engage_mode=(session.spawn_depth ?? 0) > 0 ? 'a2a' : 'direct'` as the sole A2A marker.
- [ ] Avoid using `route_type='a2a'` anywhere in this function after the refactor.
- [ ] If you extract a pure route-type helper, do it here or in `src/observability/business-tags.ts`; test the helper directly.

#### `src/delivery.ts:275-299`
- [ ] Keep `delivery.session.drain` tagged as a worker-lane platform span unless you intentionally broaden delivery to frontdesk-owned sessions.
- [ ] Confirm there is no leftover `a2a` route type assumption in delivery spans.

#### `src/delivery.ts:329-336`
- [ ] Keep `delivery.message.deliver` consistent with the new enum surface and remove any stale comments/docs that imply `a2a` is still a route type.

#### `src/delivery.ts:484-495`
- [ ] Keep `delivery.channel.send` aligned with the flat-key business-tag contract and the new Phoenix 17 filter syntax examples.

#### `src/container-runner.ts:115-123`
- [ ] Keep `container.wake` as a platform span.
- [ ] Ensure the host-side route_type used here matches the same derivation rule you use for env propagation.

#### `src/container-runner.ts:165-172`
- [ ] Keep `container.spawn` as a platform span.
- [ ] Make sure this span and the env injected into the container agree on route type for the same session.

#### `src/container-runner.ts:280-284`
- [ ] Keep `container.kill` aligned with the new route taxonomy; no `a2a` route type survives here.

### Notes

- `RouteType.ERP` should be added now for taxonomy completeness, but do not force it onto current `container.spawn`, `delivery.*`, or `agent.turn` spans unless an explicit ERP runtime lane already exists.
- Because `src/types.ts:3-9` has no explicit “agent group role” field, do not add a central DB migration just to derive route type. Prefer a pure helper that uses current stable group conventions for `frontdesk` vs `worker`, and reserve `erp` for an explicit future override.

## Phase 3: Container-side Route Context Propagation

### Steps

1. Fix host-side runtime env injection first.
   - Modify `src/container-runner.ts:519-612`.
   - Inject at least:
     - `FRONTLANE_SESSION_ID=<session.id>`
     - `FRONTLANE_ROUTE_TYPE=<derived-route-type>`
   - Optional but useful if you want better future-proofing/debuggability:
     - `FRONTLANE_AGENT_GROUP_ID=<agentGroup.id>`
     - `FRONTLANE_GROUP_NAME=<agentGroup.name>`

2. Add a single derivation rule on the host.
   - Preferred implementation location: `src/container-runner.ts:497-517` or a nearby pure helper tested from `src/container-runner.test.ts`.
   - Recommended rule for this PR:
     - `*-frontdesk` folder → `frontdesk`
     - explicit future override only → `erp`
     - otherwise → `worker`
   - Do **not** infer `erp` from fuzzy substring matching alone.

3. Thread the env-derived route type into runner config.
   - Modify `container/agent-runner/src/config.ts:27-45`
     - Add a typed `routeType?: 'frontdesk' | 'worker' | 'erp' | 'system'` field or a dedicated resolver function.
   - Modify `container/agent-runner/src/config.ts:49-58`
     - Add an env-backed route-type parser similar to `resolveIdleExitMs`.
   - Modify `container/agent-runner/src/config.ts:67-95`
     - Load `FRONTLANE_ROUTE_TYPE` into the cached runner config.

4. Make `agent.turn` consume the propagated route context.
   - Modify `container/agent-runner/src/index.ts:44-49`
     - Continue loading config and OTel as today.
   - Modify `container/agent-runner/src/index.ts:101-109`
     - Pass the resolved route type into `runPollLoop()` or into the `startAgentTurn()` call path.
   - Modify `container/agent-runner/src/poll-loop.ts:362-370`
     - Pass the route type to `startAgentTurn()` if the span helper no longer reads env directly.
   - Modify `container/agent-runner/src/observability/turn-span.ts:11-37`
     - Replace hardcoded `muap.route_type='worker'` and `muap.lane='worker'` with env/config-derived values.
     - Keep `muap.provider` intact.
     - Ensure `frontdesk` turns stop pretending to be worker turns.

5. Close the hidden `session.id='unknown'` observability bug in the same pass.
   - Because `container/agent-runner/src/index.ts:47` and `container/agent-runner/src/index.ts:105` already read `FRONTLANE_SESSION_ID`, the host env injection task above should make `agent.turn` emit the real session ID instead of `unknown`.

### Verification

- `container/agent-runner/src/integration.test.ts:354-374`
  - Extend the existing exporter assertion to check not just `span.name === 'agent.turn'`, but also `session.id === 'sess-test'` and `muap.route_type === <expected-route-type>`.
- Manual container smoke test
  - Start one frontdesk-backed session and one worker-backed session.
  - Expected: frontdesk session emits `agent.turn` with `muap.route_type=frontdesk`; worker emits `muap.route_type=worker`.
- Phoenix UI / REST verification after replay
  - Expected: frontdesk container spans no longer show up under worker-only filters.

## Phase 4: Documentation Updates

### Files

#### `docs/observability-business-tags.md:47-68`
- [ ] Update the route-type registry to `frontdesk / worker / erp / system`.
- [ ] Remove `a2a` from the `muap.route_type` legal-values table.
- [ ] Keep `muap.engage_mode = direct | a2a` as the A2A location.

#### `docs/observability-business-tags.md:78-121`
- [ ] Rewrite the “setting locations” section so `agent.turn` is described as env/config-driven instead of permanently `worker`.
- [ ] Call out that frontdesk turns and worker turns can both exist in the container runtime.

#### `docs/observability-business-tags.md:125-216`
- [ ] Replace the nested-JSON filtering explanation with the flat-key Phoenix 17 model.
- [ ] Preferred examples:
  - REST: `attribute=muap.route_type:frontdesk`
  - UI DSL: `metadata["route_type"] == "frontdesk"`
- [ ] Keep `attributes["muap"]["route_type"].as_string() == "frontdesk"` only as a staging fallback diagnostic if Phoenix UI still exposes edge cases for direct attribute filtering.
- [ ] Update SQL examples away from `attributes->'muap'->>'route_type'` if your 17.2.0 schema stores flat keys as `attributes->>'muap.route_type'`.

#### `docs/observability-business-tags.md:222-245`
- [ ] Mark `agent.turn` as implemented/runtime-driven after the code refactor lands.
- [ ] Remove any remaining “待实现” language that no longer matches runtime.

#### `docs/observability-business-tags.html:189-203`
- [ ] Mirror the enum/table changes from the Markdown source.

#### `docs/observability-business-tags.html:214-355`
- [ ] Mirror the filtering syntax rewrite:
  - flat-key REST filters
  - `metadata["route_type"]` UI example
  - fallback `attributes[...]` note only if verified in staging

#### `docs/observability-span-schema.md:475-517`
- [ ] Rewrite the container OTel section so `agent.turn` no longer claims `muap.route_type='worker'` unconditionally.
- [ ] State that route type is supplied by host runtime context (`FRONTLANE_ROUTE_TYPE`) and that `a2a` is represented by `muap.engage_mode`, not `muap.route_type`.
- [ ] Add `erp` to the documented legal route-type set, with an explicit note that current runtime emitters may reserve it for future ERP-scoped spans.

#### `infra/observability/README.md:42-50`
- [ ] Update the pinned Phoenix version to `17.2.0`.

#### `infra/observability/README.md:136-223`
- [ ] Replace the Phoenix 8.x “REST attribute not supported” guidance with Phoenix 17 smoke-test instructions.
- [ ] Add staging/prod migration notes and env hardening verification.

#### `docs/decisions/README.md:56-90`
- [ ] Add the new ADR row for `ADR-0017`.

#### `docs/decisions/ADR-0017-observability-phoenix17-route-type-taxonomy.md` (new)
- [ ] Record three decisions together:
  - Phoenix image baseline moves to `17.2.0`
  - `route_type='a2a'` is deprecated in favor of `engage_mode='a2a'`
  - container route context is propagated by env rather than inferred inside `agent.turn`

### Deliberately Not Updated

- Leave historical artifacts untouched unless the team explicitly wants archival correction:
  - `reports/human/*`
  - `docs/superpowers/plans/2026-06-02-observability-refactor.md`
- If you want one more doc cleanup pass after the core refactor, `docs/observability-instrumentation-methodology.md:346-456` is the next obvious drift candidate because it still advertises `muap.route_type = a2a` and the older UI filter syntax.

## Phase 5: Testing & Verification

### Unit / Contract Tests to Modify

1. `scripts/observability-bootstrap.test.ts:114-125`
   - Update image-pin assertions from `8.0.0` to `17.2.0`.
   - If you add new compose env flags, assert they are present in the compose files.

2. `src/container-runner.test.ts:1-32`
   - Expand this file to cover the new pure helper(s):
     - route-type derivation from group metadata/folder naming
     - runtime env emission builder if one is extracted

3. `container/agent-runner/src/integration.test.ts:354-374`
   - Extend the existing `agent.turn` exporter test to assert:
     - `session.id` is no longer `unknown`
     - `muap.route_type` reflects the injected env value
     - frontdesk and worker cases both work if you parameterize the test

4. `scripts/observability-span-schema.test.ts:47-109`
   - Update only if the schema doc wording/required examples change enough to invalidate the current string checks.

5. `scripts/observability-coverage.test.ts:327-339`
   - Keep the real-repo coverage scan green after doc/runtime changes.
   - No structural test rewrite is expected unless you decide to teach the coverage gate about runner manual spans.

### Integration Test Steps

1. **Phoenix stack startup**
   - Run `pnpm obs:config`
   - Run `pnpm obs:up`
   - Expected: Phoenix/Grafana/Postgres all become healthy.

2. **Host runtime startup**
   - Run `pnpm typecheck`
   - Run `pnpm test`
   - Run `pnpm dev`
   - Expected: host starts without telemetry/runtime regressions.

3. **Frontdesk trace path**
   - Send a deterministic CLI or Feishu test message into a frontdesk-wired agent.
   - Expected Phoenix spans:
     - `router.route` tagged `muap.route_type=frontdesk`
     - `router.deliver_to_agent` tagged `muap.route_type=frontdesk`
     - `agent.turn` tagged `muap.route_type=frontdesk`

4. **Worker trace path**
   - Trigger a frontdesk → worker delegation or a directly wired worker session.
   - Expected Phoenix spans:
     - `router.deliver_to_agent` or downstream worker span tagged `muap.route_type=worker`
     - `muap.engage_mode=a2a` where delegation actually occurred
     - no span uses `muap.route_type=a2a`

5. **REST API filter validation**
   - Run a Phoenix 17 simple filter request using `attribute=muap.route_type:frontdesk`.
   - Expected: frontdesk spans are returned; worker spans are excluded.
   - Keep the exact endpoint shape aligned to the deployed 17.2.0 server (`/v1/spans` or project-scoped variant if enabled).

6. **UI DSL validation**
   - Preferred query: `metadata["route_type"] == "frontdesk"`
   - Secondary fallback diagnostic: `attributes["muap"]["route_type"].as_string() == "frontdesk"`
   - Expected: preferred metadata filter works in 17.2.0 staging; fallback is only documented if needed.

7. **SQL / Grafana drift validation**
   - Re-run every example query in the updated docs against the upgraded Postgres backend.
   - Expected: no dashboard/doc example still assumes `attributes->'muap'->>'route_type' = 'a2a'`.

### Expected Outcomes

1. `RouteType.A2A` no longer exists anywhere in production code.
2. `muap.engage_mode='a2a'` becomes the only A2A marker.
3. `agent.turn` route type matches the actual session lane.
4. Phoenix 17 REST filtering by `attribute=muap.route_type:frontdesk` works in staging and prod.
5. Docs, ADRs, and runtime examples all describe flat-key `muap.*` behavior consistently.

## Rollback Plan

1. **Phoenix image rollback**
   - Revert `infra/observability/docker-compose.prod.yml` and `infra/observability/docker-compose.sim.yml` to `version-8.0.0`.
   - Remove the new Phoenix env flags if startup rejects them.

2. **Database rollback**
   - If Phoenix 17 DB migrations fail or corrupt the staging rehearsal, discard the cloned staging database and rebuild from the pre-upgrade snapshot.
   - In prod, restore from the pre-upgrade `pg_dump` / volume snapshot; do not attempt to “downgrade in place” after a failed migration.

3. **Runtime rollback**
   - Revert the `route_type`/env propagation patch set in:
     - `src/observability/business-tags.ts`
     - `src/router.ts`
     - `src/delivery.ts`
     - `src/container-runner.ts`
     - `container/agent-runner/src/config.ts`
     - `container/agent-runner/src/index.ts`
     - `container/agent-runner/src/observability/turn-span.ts`
     - `container/agent-runner/src/poll-loop.ts`

4. **Backward compatibility during retention window**
   - Old traces will still contain `muap.route_type='a2a'` until retention expires (`PHOENIX_DEFAULT_RETENTION_POLICY_DAYS=7` in `infra/observability/docker-compose.prod.yml:25`).
   - For dashboards/queries that must span old and new data during the overlap window, use compatibility clauses such as:
     - treat `route_type='a2a'` as legacy worker-delegation data
     - or query `route_type='worker' OR engage_mode='a2a'` depending on the question being asked

5. **Grafana / SQL query rollback**
   - If flat-key SQL assumptions are wrong in the real 17.2.0 storage schema, revert doc/dashboard query examples to the verified staging syntax immediately and keep the runtime refactor separate from query-shape cleanup.

## Risk Mitigation

1. **Migration risk: Phoenix startup migrates the DB automatically**
   - Mitigation: always rehearse on a cloned staging DB and keep physical rollback snapshots for prod.

2. **Taxonomy risk: `erp` enum exists before ERP spans exist**
   - Mitigation: document `RouteType.ERP` as reserved and avoid assigning it to current worker/frontdesk spans until a real ERP emitter exists.

3. **Derivation risk: no explicit agent-group role field exists in `src/types.ts:3-9`**
   - Mitigation: use stable folder conventions for `frontdesk` vs `worker` now; if the team later needs first-class `erp`, add an explicit override rather than a heuristic.

4. **Runtime drift risk: container already expects `FRONTLANE_SESSION_ID`**
   - Mitigation: bundle `FRONTLANE_SESSION_ID` injection into the same PR as `FRONTLANE_ROUTE_TYPE`; do not ship one without the other.

5. **Query drift risk: docs and dashboards still describe nested JSON**
   - Mitigation: verify every updated SQL/REST/UI example against staging before promoting docs.

## Timeline Estimate

- **Phase 1 — Phoenix upgrade rehearsal:** `0.5-1.0` engineer day
- **Phase 2 — business-tag/runtime refactor:** `0.75-1.25` engineer day
- **Phase 3 — container env propagation + tests:** `0.5-0.75` engineer day
- **Phase 4 — docs + ADR updates:** `0.5` engineer day
- **Phase 5 — staging/prod verification + rollback rehearsal:** `0.5-0.75` engineer day
- **Total:** `2.75-4.25` engineer days, depending on how much time Phoenix 17 staging validation and query-shape verification take
