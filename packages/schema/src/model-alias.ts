export * as ModelAlias from "./model-alias.js"

export interface Aliases {
  readonly providers?: Readonly<Record<string, string>>
  readonly models?: Readonly<Record<string, string>>
  readonly variants?: Readonly<Record<string, string>>
}

export class AliasCycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AliasCycleError"
  }
}

export class AliasMaxDepthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AliasMaxDepthError"
  }
}

export interface ResolvedRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
  readonly ref: string
}

export type ExistsPredicate = (ref: { providerID: string; modelID: string }) => boolean

const MAX_DEPTH = 10

/**
 * Builds the reference string for a structured model target. A bare alias
 * target carries an empty model id; its variant, when present, rides on the
 * provider/alias name (`provider#variant`) so alias resolution can see it —
 * dropping it would silently replace the user's variant with the alias
 * target's variant.
 */
export function refString(input: { providerID: string; id: string; variant?: string }): string {
  if (input.id)
    return input.variant ? `${input.providerID}/${input.id}#${input.variant}` : `${input.providerID}/${input.id}`
  return input.variant ? `${input.providerID}#${input.variant}` : input.providerID
}

/**
 * Resolves a model reference string (which may use provider, model, or variant aliases)
 * into a canonical `provider/model[#variant]` reference string.
 */
export function resolve(aliases: Aliases | undefined, input: string, exists?: ExistsPredicate): string {
  const result = resolveRef(aliases, input, exists)
  return result.variant ? `${result.providerID}/${result.id}#${result.variant}` : `${result.providerID}/${result.id}`
}

/**
 * Resolves a model reference string into a structured resolved ref.
 */
export function resolveRef(aliases: Aliases | undefined, input: string, exists?: ExistsPredicate): ResolvedRef {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Empty model reference cannot be resolved")
  }
  if (hasPaddedSegment(trimmed) || hasEmptySegment(trimmed) || hasWhitespaceSegment(trimmed)) {
    throw new Error(`Invalid model reference: ${trimmed}`)
  }

  if (!aliases || (!aliases.providers && !aliases.models && !aliases.variants)) {
    return parseRefString(trimmed)
  }

  let current = trimmed
  let explicitVariant: string | undefined
  const visited = new Set<string>()
  let depth = 0
  let settled = false

  while (depth < MAX_DEPTH) {
    depth++
    if (visited.has(current)) {
      throw new AliasCycleError(`Cycle detected in alias resolution: ${current}`)
    }
    visited.add(current)

    // Separate variant from model reference if present
    const hashIdx = current.indexOf("#")
    let base = hashIdx === -1 ? current : current.slice(0, hashIdx)
    const variantInCurrent = hashIdx === -1 ? undefined : current.slice(hashIdx + 1)
    if (variantInCurrent !== undefined && (!variantInCurrent || variantInCurrent.includes("#"))) {
      throw new Error(`Invalid model reference: ${current}`)
    }
    if (variantInCurrent !== undefined && explicitVariant === undefined) {
      explicitVariant = variantInCurrent
    }

    // Rule 1: Global model alias (no "/" in base)
    if (!base.includes("/")) {
      const aliasTarget = ownAlias(aliases.models, base)
      if (aliasTarget !== undefined) {
        if (!aliasTarget || hasPaddedSegment(aliasTarget) || hasWhitespaceSegment(aliasTarget)) {
          throw new Error(`Invalid model reference: ${current}`)
        }
        current = aliasTarget
        continue
      }
      // If it doesn't contain a slash and isn't an alias, cannot be a valid standard ref
      settled = true
      break
    }

    // Split provider and model
    const slashIdx = base.indexOf("/")
    let provider = base.slice(0, slashIdx)
    let model = base.slice(slashIdx + 1)

    // Check if the exact provider/model exists; if so, real ID wins
    if (exists && exists({ providerID: provider, modelID: model })) {
      settled = true
      break
    }

    // Check scoped model alias under current provider name first (e.g. "openai/gpt-4o")
    const origScopedKey = `${provider}/${model}`
    const origScopedAlias = ownAlias(aliases.models, origScopedKey)
    if (origScopedAlias !== undefined) {
      if (!origScopedAlias || hasPaddedSegment(origScopedAlias) || hasWhitespaceSegment(origScopedAlias)) {
        throw new Error(`Invalid model reference: ${current}`)
      }
      const origHash = origScopedAlias.indexOf("#")
      const origBase = origHash === -1 ? origScopedAlias : origScopedAlias.slice(0, origHash)
      if (origBase.includes("/")) {
        current = origScopedAlias
      } else {
        const scopedHash = origScopedAlias.indexOf("#")
        if (scopedHash !== -1) {
          const scopedModel = origScopedAlias.slice(0, scopedHash)
          const scopedVar = origScopedAlias.slice(scopedHash + 1)
          current = `${provider}/${scopedModel}#${scopedVar}`
        } else {
          current = `${provider}/${origScopedAlias}`
        }
      }
      continue
    }

    let modified = false

    // Rule 2: Provider alias
    const providerAlias = ownAlias(aliases.providers, provider)
    if (providerAlias !== undefined && providerAlias !== provider) {
      if (
        !providerAlias ||
        providerAlias.includes("/") ||
        providerAlias.includes("#") ||
        providerAlias.trim() !== providerAlias ||
        /\s/.test(providerAlias)
      ) {
        throw new Error(`Invalid model reference: ${current}`)
      }
      provider = providerAlias
      modified = true
    }

    // Rule 3: Provider-scoped model alias under resolved provider
    const scopedKey = `${provider}/${model}`
    const scopedAlias = ownAlias(aliases.models, scopedKey)
    if (scopedAlias !== undefined) {
      if (!scopedAlias || hasPaddedSegment(scopedAlias) || hasWhitespaceSegment(scopedAlias)) {
        throw new Error(`Invalid model reference: ${current}`)
      }
      // Scoped alias target could be "newModel" or "newProvider/newModel"
      const scopedBaseHash = scopedAlias.indexOf("#")
      const scopedBase = scopedBaseHash === -1 ? scopedAlias : scopedAlias.slice(0, scopedBaseHash)
      if (scopedBase.includes("/")) {
        current = scopedAlias
      } else {
        const scopedHash = scopedAlias.indexOf("#")
        if (scopedHash !== -1) {
          const scopedModel = scopedAlias.slice(0, scopedHash)
          const scopedVar = scopedAlias.slice(scopedHash + 1)
          current = `${provider}/${scopedModel}#${scopedVar}`
        } else {
          current = `${provider}/${scopedAlias}`
        }
      }
      continue
    }

    if (modified) {
      current = `${provider}/${model}`
      continue
    }

    settled = true
    break
  }

  if (!settled) {
    throw new AliasMaxDepthError(`Max alias resolution depth exceeded for: ${input}`)
  }

  // Parse the settled base provider and model
  const settledHash = current.indexOf("#")
  const settledBase = settledHash === -1 ? current : current.slice(0, settledHash)
  const settledVariant = settledHash === -1 ? undefined : current.slice(settledHash + 1)

  const slashIdx = settledBase.indexOf("/")
  if (slashIdx <= 0 || slashIdx === settledBase.length - 1) {
    throw new Error(`Invalid model reference after alias resolution: ${settledBase}`)
  }
  if (hasPaddedSegment(settledBase) || hasEmptySegment(settledBase) || hasWhitespaceSegment(settledBase)) {
    throw new Error(`Invalid model reference after alias resolution: ${settledBase}`)
  }

  const finalProvider = settledBase.slice(0, slashIdx)
  const finalModel = settledBase.slice(slashIdx + 1)
  const initialVariant = explicitVariant ?? settledVariant

  // Rule 4: Variant / effort resolution (most specific wins)
  let finalVariant = initialVariant
  if (initialVariant !== undefined && aliases.variants) {
    finalVariant = resolveVariant(aliases.variants, finalProvider, finalModel, initialVariant)
    if (!finalVariant || finalVariant.includes("#")) {
      throw new Error(`Invalid model reference: ${finalProvider}/${finalModel}#${finalVariant}`)
    }
  }
  if (
    finalVariant !== undefined &&
    (hasPaddedSegment(finalVariant) || hasEmptySegment(finalVariant) || hasWhitespaceSegment(finalVariant))
  ) {
    throw new Error(`Invalid model reference: ${finalProvider}/${finalModel}#${finalVariant}`)
  }

  const canonicalRef = finalVariant ? `${finalProvider}/${finalModel}#${finalVariant}` : `${finalProvider}/${finalModel}`

  return {
    providerID: finalProvider,
    id: finalModel,
    variant: finalVariant,
    ref: canonicalRef,
  }
}

/**
 * Resolves a variant name using precedence:
 * 1. provider/model#variant (provider model effort)
 * 2. * /model#variant (model effort)
 * 3. provider/*#variant (provider effort)
 * 4. * /*#variant (global wildcard effort)
 * 5. variant (bare effort)
 */
function resolveVariant(
  variantAliases: Readonly<Record<string, string>>,
  provider: string,
  model: string,
  variant: string,
): string {
  // 1. provider/model#variant
  const key1 = `${provider}/${model}#${variant}`
  const value1 = ownAlias(variantAliases, key1)
  if (value1 !== undefined) return checkedVariantTarget(value1, provider, model)

  // 2. */model#variant
  const key2 = `*/${model}#${variant}`
  const value2 = ownAlias(variantAliases, key2)
  if (value2 !== undefined) return checkedVariantTarget(value2, provider, model)

  // 3. provider/*#variant
  const key3 = `${provider}/*#${variant}`
  const value3 = ownAlias(variantAliases, key3)
  if (value3 !== undefined) return checkedVariantTarget(value3, provider, model)

  // 4. */*#variant
  const key4 = `*/*#${variant}`
  const value4 = ownAlias(variantAliases, key4)
  if (value4 !== undefined) return checkedVariantTarget(value4, provider, model)

  // 5. bare variant
  const value5 = ownAlias(variantAliases, variant)
  if (value5 !== undefined) return checkedVariantTarget(value5, provider, model)

  // Real variant passes through
  return variant
}

function ownAlias(map: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined
  const value = map[key]
  return typeof value === "string" ? value : undefined
}

function hasPaddedSegment(target: string): boolean {
  return target.split(/[/#]/).some((segment) => segment !== segment.trim())
}

function hasEmptySegment(target: string): boolean {
  return target.split(/[/#]/).some((segment) => !segment)
}

function hasWhitespaceSegment(target: string): boolean {
  return target.split(/[/#]/).some((segment) => /\s/.test(segment))
}

function checkedVariantTarget(target: string, provider: string, model: string): string {
  if (hasPaddedSegment(target) || hasWhitespaceSegment(target)) {
    throw new Error(`Invalid model reference: ${provider}/${model}#${target}`)
  }
  return target
}

function parseRefString(input: string): ResolvedRef {
  if (hasPaddedSegment(input) || hasEmptySegment(input) || hasWhitespaceSegment(input)) {
    throw new Error(`Invalid model reference: ${input}`)
  }
  const providerEnd = input.indexOf("/")
  if (providerEnd <= 0) {
    throw new Error(`Invalid model reference: ${input}`)
  }
  const providerID = input.slice(0, providerEnd)
  const variantStart = input.indexOf("#", providerEnd + 1)
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
  if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) {
    throw new Error(`Invalid model reference: ${input}`)
  }
  const ref = variant ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`
  return {
    providerID,
    id,
    variant,
    ref,
  }
}
