export function shareModelParam(models: string[]) {
  if (models.length === 0) return ""
  if (models.length === 1) return models[0]
  if (models.length === 2) return encodeURIComponent(`${models[0]} & ${models[1]}`)
  return encodeURIComponent(`${models[0]} & ${models.length - 1} others`)
}
