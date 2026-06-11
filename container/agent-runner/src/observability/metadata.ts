/**
 * Container-side mirror of the host's OpenInference `metadata` encoding.
 *
 * The host uses `@arizeai/openinference-core`'s `getMetadataAttributes`, which
 * emits a single `{ metadata: JSON.stringify(record) }` attribute. The container
 * deliberately has no `@arizeai` dependency, so this reproduces that exact shape
 * (same `metadata` attribute key) to keep host and container spans filterable by
 * the same Phoenix DSL. See ADR-0017.
 */
const METADATA_ATTRIBUTE_KEY = 'metadata';

export function metadataAttributes(record: Record<string, string>): Record<string, string> {
  return { [METADATA_ATTRIBUTE_KEY]: JSON.stringify(record) };
}

/**
 * Allowed `route_type` values the container is permitted to emit. Mirrors the
 * host `RouteType` taxonomy. `a2a` is intentionally absent — agent-to-agent is
 * carried in `engage_mode`, not `route_type` (ADR-0017).
 */
const ALLOWED_ROUTE_TYPES = new Set(['frontdesk', 'worker', 'erp', 'system']);

/**
 * Validate a `route_type` value the container received from the host (env
 * `FRONTLANE_ROUTE_TYPE`). Unknown / disallowed values collapse to `'worker'`
 * with a stderr warning so a manual `docker run -e FRONTLANE_ROUTE_TYPE=a2a`
 * can never reach Phoenix as `metadata.route_type='a2a'`. Always returns one
 * of the allowed values; never throws — the container should still run.
 */
export function validateRouteType(value: string | undefined): string {
  if (!value || !ALLOWED_ROUTE_TYPES.has(value)) {
    if (value) {
      console.error(
        `[agent-runner] WARNING: rejecting unknown FRONTLANE_ROUTE_TYPE='${value}', falling back to 'worker'`,
      );
    }
    return 'worker';
  }
  return value;
}
