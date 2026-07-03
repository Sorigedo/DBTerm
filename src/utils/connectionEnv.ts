import type { ConnConfig } from '../types'

export type EnvLabel = 'prod' | 'staging' | 'test' | null

interface LegacyDbExtra {
  readOnly?: boolean
  isProduction?: boolean
  [key: string]: unknown
}

export function parseDbExtraJson(extraJson?: string): LegacyDbExtra {
  try {
    return extraJson ? JSON.parse(extraJson) as LegacyDbExtra : {}
  } catch {
    return {}
  }
}

export function applyLegacyDbEnv(config: ConnConfig): ConnConfig {
  if (config.envLabel !== undefined) return config
  const extra = parseDbExtraJson(config.extraJson)
  return extra.isProduction ? { ...config, envLabel: 'prod' } : config
}

export function normalizeDbExtraForSave<T extends object>(extra: T): T & { readOnly: boolean; isProduction: boolean } {
  return { ...extra, readOnly: false, isProduction: false }
}

export function normalizeEnvLabelForSave(envLabel: ConnConfig['envLabel']): EnvLabel {
  return envLabel ?? null
}
