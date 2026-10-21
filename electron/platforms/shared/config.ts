export function numberText(
  value: string | undefined,
  fallback: string,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
  integer = false,
) {
  const normalized = value?.trim()
  if (!normalized) {
    return fallback
  }

  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed)
    && parsed >= minimum
    && parsed <= maximum
    && (!integer || Number.isInteger(parsed))
    ? normalized
    : fallback
}
