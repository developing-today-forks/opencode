export * as PluginVcsStatusList from "./status-list.js"

import type { Interface, StatusOptions } from "../../vcs.js"
import { pageLimit } from "../../util/number.js"

/**
 * Page the plugin `vcs.status` surface returns when the plugin supplies no
 * limit, and the largest page it will pass through. Both mirror the HTTP
 * `vcs.status` endpoint (`packages/server/src/handlers/vcs.ts`), which
 * applies the same normalisation.
 */
export const DEFAULT_STATUS_LIMIT = 200
export const MAX_STATUS_LIMIT = 1000

/**
 * A caller-supplied status limit is normalised before it reaches a provider:
 * a missing or non-finite value becomes the default page, and zero, negative
 * or fractional values are clamped to a positive integer capped at
 * MAX_STATUS_LIMIT instead of failing or returning every changed file.
 */
export function statusListLimit(limit?: number): number {
  return pageLimit(limit, { default: DEFAULT_STATUS_LIMIT, max: MAX_STATUS_LIMIT })
}

/** The plugin `vcs.status` call, with its page size normalised first. */
export const listStatus = (vcs: Pick<Interface, "status">, input?: StatusOptions) =>
  vcs.status({ limit: statusListLimit(input?.limit) })
