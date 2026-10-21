import Store from 'electron-store'
import { z } from 'zod'

type JsonObject = Record<string, unknown>

export type ValidatedStoreOptions<TStore extends JsonObject> = {
  name: string
  defaults: TStore
}

function schemaFromDefault(value: unknown): z.ZodType {
  if (typeof value === 'string') return z.string()
  if (typeof value === 'number') return z.number().finite()
  if (typeof value === 'boolean') return z.boolean()
  if (Array.isArray(value)) return z.array(z.unknown())
  if (value === null || value === undefined) return z.unknown()
  if (typeof value === 'object') {
    const shape = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, schemaFromDefault(nestedValue).optional()]),
    )
    return z.object(shape).passthrough()
  }
  return z.unknown()
}

function repairWithDefaults(value: unknown, defaults: unknown): unknown {
  if (defaults === null || defaults === undefined) return value ?? defaults
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults)

  if (typeof defaults === 'object') {
    const source = value && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : {}
    const repaired: JsonObject = { ...source }

    for (const [key, defaultValue] of Object.entries(defaults)) {
      repaired[key] = repairWithDefaults(source[key], defaultValue)
    }
    return repaired
  }

  return typeof value === typeof defaults ? value : defaults
}

export function createValidatedStore<TStore extends JsonObject>({
  name,
  defaults,
}: ValidatedStoreOptions<TStore>) {
  const store = new Store<TStore>({ name, defaults })
  const schema = schemaFromDefault(defaults)
  const parsed = schema.safeParse(store.store)

  if (!parsed.success) {
    store.store = repairWithDefaults(store.store, defaults) as TStore
  }

  return store
}
