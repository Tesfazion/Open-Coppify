import type { Settings } from '../types'

const STORAGE_KEY = 'coppify.job-presets.v1'
const MAX_PRESETS = 20
const MAX_NAME_LENGTH = 40

export interface JobPreset {
  id: string
  name: string
  settings: Settings
  createdAt: string
}

function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false
  const settings = value as Record<string, unknown>
  return (
    Number.isFinite(settings.clip_count) &&
    Number.isFinite(settings.min_seconds) &&
    Number.isFinite(settings.max_seconds) &&
    Number.isFinite(settings.target_seconds) &&
    typeof settings.keywords === 'string' &&
    typeof settings.vertical_mode === 'string' &&
    typeof settings.captions === 'boolean' &&
    typeof settings.auto_transcribe === 'boolean' &&
    typeof settings.whisper_model === 'string' &&
    typeof settings.aspect_ratio === 'string' &&
    typeof settings.caption_style === 'string'
  )
}

function parsePresets(value: unknown): JobPreset[] {
  if (!Array.isArray(value)) {
    throw new Error('Saved presets are not in a valid format. Remove the corrupted preset data and try again.')
  }

  const presets = value.map((item): JobPreset => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      item.id.trim().length === 0 ||
      typeof item.name !== 'string' ||
      item.name.trim().length === 0 ||
      item.name.length > MAX_NAME_LENGTH ||
      typeof item.createdAt !== 'string' ||
      !isSettings(item.settings)
    ) {
      throw new Error('A saved preset is invalid. Remove the corrupted preset data and try again.')
    }

    return {
      id: item.id,
      name: item.name,
      settings: item.settings,
      createdAt: item.createdAt,
    }
  })

  if (presets.length > MAX_PRESETS) {
    throw new Error(`Only ${MAX_PRESETS} saved presets are supported. Remove extra presets and try again.`)
  }

  return presets
}

function readStorage(): JobPreset[] {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []

  try {
    return parsePresets(JSON.parse(raw))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Saved preset data could not be read. Remove the corrupted preset data and try again.')
    }
    throw error
  }
}

function writeStorage(presets: JobPreset[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
}

export function loadPresets(): JobPreset[] {
  return readStorage()
}

export function savePreset(name: string, settings: Settings): JobPreset[] {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Enter a name for this preset.')
  if (normalizedName.length > MAX_NAME_LENGTH) {
    throw new Error(`Preset names must be ${MAX_NAME_LENGTH} characters or fewer.`)
  }

  const current = readStorage()
  if (current.some((preset) => preset.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('A preset with that name already exists. Choose another name.')
  }
  if (current.length >= MAX_PRESETS) {
    throw new Error(`You can save up to ${MAX_PRESETS} presets. Delete one before saving another.`)
  }

  const preset: JobPreset = {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: normalizedName,
    settings: { ...settings },
    createdAt: new Date().toISOString(),
  }
  const updated = [...current, preset]
  writeStorage(updated)
  return updated
}

export function deletePreset(id: string): JobPreset[] {
  const updated = readStorage().filter((preset) => preset.id !== id)
  writeStorage(updated)
  return updated
}
