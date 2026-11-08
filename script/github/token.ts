/**
 * The one token convention for script/github/ (#1972).
 *
 * The repo-sweeper workflow supplies the token as GH_TOKEN (its job
 * env maps secrets.GITHUB_TOKEN onto that name, the gh CLI
 * convention). Scripts in this directory must never read a token env
 * var directly: they resolve through this helper, which accepts
 * GITHUB_TOKEN first (direct/local runs, the Actions default name)
 * and GH_TOKEN second (the workflow convention). A script reading
 * only one name while the workflow supplies the other is exactly the
 * mismatch that made the daily stale-issue close fail every 02:00 UTC
 * run while every other run stayed green.
 */
export const GITHUB_TOKEN_ENV_NAMES = ["GITHUB_TOKEN", "GH_TOKEN"] as const

export function resolveGitHubToken(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const name of GITHUB_TOKEN_ENV_NAMES) {
    const value = env[name]
    if (value && value.trim() !== "") return value
  }
  return undefined
}

export const GITHUB_TOKEN_REQUIRED_MESSAGE =
  "GitHub authentication is required. Set GITHUB_TOKEN or GH_TOKEN (the repo-sweeper workflow supplies GH_TOKEN)."
