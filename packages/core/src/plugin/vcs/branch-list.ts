export * as PluginVcsBranchList from "./branch-list.js"

import type { BranchOptions, Interface } from "../../vcs.js"
import { pageLimit } from "../../util/number.js"

/**
 * Page the plugin `vcs.branch.list` surface returns when the plugin supplies no
 * limit, and the largest page it will pass through. Both mirror the HTTP
 * `vcs.branch.list` endpoint (`packages/server/src/handlers/vcs.ts`), which
 * applies `Math.min(limit ?? 50, 100)`.
 */
export const DEFAULT_BRANCH_LIMIT = 50
export const MAX_BRANCH_LIMIT = 100

/**
 * `git for-each-ref --count=` accepts only a positive integer, so a plugin
 * supplied limit is normalised before it reaches a provider: a missing or
 * non-finite value becomes the default page, and zero, negative or fractional
 * values are clamped to a positive integer instead of failing the git call.
 */
export function branchListLimit(limit?: number): number {
  return pageLimit(limit, { default: DEFAULT_BRANCH_LIMIT, max: MAX_BRANCH_LIMIT })
}

/** The plugin `vcs.branch.list` call, with its page size normalised first. */
export const listBranches = (vcs: Pick<Interface, "branches">, input?: BranchOptions) =>
  vcs.branches({ search: input?.search, limit: branchListLimit(input?.limit) })
