import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { describeError, getSettings, listProjects, startClips } from '../lib/api'
import { cn } from '../lib/cn'
import { extractVideoId, formatDuration } from '../lib/format'
import { deletePreset, loadPresets, savePreset } from '../lib/presets'
import type { JobPreset } from '../lib/presets'
import type { Project, Settings, SettingsResponse } from '../types'
import ErrorNote from '../components/ErrorNote'
import PageHeader from '../components/PageHeader'
import { Button, Card, Checkline, Eyebrow, Field, Hint, Select, Tag } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

const VERTICAL_MODES = [
  { value: 'blur', label: 'Blur', note: 'Original over a blurred backdrop. Nothing is cropped.' },
  { value: 'crop', label: 'Crop', note: 'Centre-crop to fill the frame. Most TikTok-native.' },
  { value: 'fit', label: 'Fit', note: 'Scale down and pad with black bars.' },
]

const FALLBACK_MODELS = [
  { value: 'tiny', label: 'tiny — fastest, roughest' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small — balanced' },
  { value: 'medium', label: 'medium' },
  { value: 'large-v3', label: 'large-v3 — slowest, best' },
]

export default function Ingest() {
  useDocumentTitle('New job')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [url, setUrl] = useState('')
  const [overrides, setOverrides] = useState<Partial<Settings>>({})
  const [catalog, setCatalog] = useState<SettingsResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null)
  const [touched, setTouched] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [presets, setPresets] = useState<JobPreset[]>([])
  const [presetName, setPresetName] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [presetStatus, setPresetStatus] = useState('')

  const settings = catalog?.settings ?? null
  const videoId = useMemo(() => extractVideoId(url), [url])
  const invalid = touched && url.trim().length > 0 && !videoId

  useEffect(() => {
    getSettings()
      .then((data) => setCatalog(data))
      .catch((err) => setError(describeError(err)))
  }, [])

  useEffect(() => {
    try {
      setPresets(loadPresets())
    } catch (err) {
      setError(describeError(err))
    }
  }, [])

  useEffect(() => {
    const preset = params.get('video')
    if (preset) {
      setUrl(`https://www.youtube.com/watch?v=${preset}`)
      setTouched(true)
    }
  }, [params])

  const effective = useCallback(
    <K extends keyof Settings>(key: K, fallback: Settings[K]): Settings[K] =>
      (overrides[key] ?? settings?.[key] ?? fallback) as Settings[K],
    [overrides, settings],
  )

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSelectedPresetId('')
    setPresetStatus('')
    setOverrides((current) => ({ ...current, [key]: value }))
  }

  const saveCurrentPreset = () => {
    try {
      const name = presetName.trim()
      const current: Settings = {
        clip_count: effective('clip_count', 5),
        min_seconds: effective('min_seconds', 30),
        max_seconds: effective('max_seconds', 60),
        target_seconds: effective('target_seconds', 45),
        keywords: effective('keywords', ''),
        vertical_mode: effective('vertical_mode', 'blur'),
        captions: effective('captions', true),
        auto_transcribe: effective('auto_transcribe', true),
        whisper_model: effective('whisper_model', 'base'),
        aspect_ratio: effective('aspect_ratio', '9:16'),
        caption_style: effective('caption_style', 'bold'),
      }
      const updated = savePreset(name, current)
      setPresets(updated)
      setSelectedPresetId(updated[updated.length - 1].id)
      setPresetName('')
      setPresetStatus(`Saved "${name}".`)
      setError(null)
    } catch (err) {
      setPresetStatus('')
      setError(describeError(err))
    }
  }

  const removeSelectedPreset = () => {
    try {
      const removed = presets.find((preset) => preset.id === selectedPresetId)
      setPresets(deletePreset(selectedPresetId))
      setSelectedPresetId('')
      setPresetStatus(removed ? `Deleted "${removed.name}".` : 'Preset deleted.')
      setError(null)
    } catch (err) {
      setPresetStatus('')
      setError(describeError(err))
    }
  }

  const applyPreset = (id: string) => {
    const preset = presets.find((item) => item.id === id)
    setSelectedPresetId(id)
    setOverrides(preset ? { ...preset.settings } : {})
    setPresetStatus(preset ? `Applied "${preset.name}".` : 'Using saved defaults.')
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!videoId || busy) return
    setBusy(true)
    setError(null)
    try {
      const started = await startClips({
        url,
        video_id: videoId,
        count: Number(effective('clip_count', 5)),
        min_seconds: Number(effective('min_seconds', 30)),
        max_seconds: Number(effective('max_seconds', 60)),
        target_seconds: Number(effective('target_seconds', 45)),
        keywords: effective('keywords', ''),
        vertical_mode: effective('vertical_mode', 'blur'),
        captions: Boolean(effective('captions', true)),
        auto_transcribe: Boolean(effective('auto_transcribe', true)),
        model: effective('whisper_model', 'base'),
        aspect_ratio: effective('aspect_ratio', '9:16'),
        caption_style: effective('caption_style', 'bold'),
      })
      navigate(`/jobs/${started.job.id}`)
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="New job"
        subtitle="Paste a YouTube link to generate vertical clips. Everything runs on this machine."
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Card>
          <Field
            label="Source"
            id="url"
            placeholder="https://youtube.com/watch?v=…"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setTouched(true)
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={invalid || undefined}
            hint={
              invalid
                ? 'That does not look like a single YouTube video link. watch, youtu.be, /shorts/, /live/ and /embed/ all work.'
                : 'Only download video you own or have the rights to process.'
            }
          />

          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
              {busy ? 'Starting…' : 'Start'}
            </Button>
            <Button
              variant="quiet"
              onClick={() => setOptionsOpen((value) => !value)}
              aria-expanded={optionsOpen}
              aria-controls="job-options"
            >
              {optionsOpen ? 'Hide options' : 'Options'}
            </Button>
          </div>

          <div
            id="job-options"
            hidden={!optionsOpen}
            className="border-t border-ink-800 pt-5"
          >
            <Options
              overrides={overrides}
              catalog={catalog}
              presets={presets}
              presetName={presetName}
              selectedPresetId={selectedPresetId}
              presetStatus={presetStatus}
              effective={effective}
              update={update}
              onClear={() => {
                setSelectedPresetId('')
                setPresetStatus('Using saved defaults.')
                setOverrides({})
              }}
              onPresetNameChange={setPresetName}
              onSavePreset={saveCurrentPreset}
              onDeletePreset={removeSelectedPreset}
              onApplyPreset={applyPreset}
            />
          </div>
        </Card>

        {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}
      </form>

      <RecentProjects />
    </>
  )
}

function Options({
  overrides,
  catalog,
  presets,
  presetName,
  selectedPresetId,
  presetStatus,
  effective,
  update,
  onClear,
  onPresetNameChange,
  onSavePreset,
  onDeletePreset,
  onApplyPreset,
}: {
  overrides: Partial<Settings>
  catalog: SettingsResponse | null
  presets: JobPreset[]
  presetName: string
  selectedPresetId: string
  presetStatus: string
  effective: <K extends keyof Settings>(key: K, fallback: Settings[K]) => Settings[K]
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  onClear: () => void
  onPresetNameChange: (value: string) => void
  onSavePreset: () => void
  onDeletePreset: () => void
  onApplyPreset: (id: string) => void
}) {
  const dirty = Object.keys(overrides).length > 0

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <div className="flex flex-col gap-3 sm:col-span-2">
        <Eyebrow as="h2">Run presets</Eyebrow>
        <Hint>Save a reusable configuration in this browser. Presets contain settings only, never video links.</Hint>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]">
          <Select
            label="Apply a saved preset"
            value={selectedPresetId}
            onChange={(event) => onApplyPreset(event.target.value)}
          >
            <option value="">Use saved defaults</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="danger"
            onClick={onDeletePreset}
            disabled={!selectedPresetId}
          >
            Delete selected
          </Button>
        </div>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]">
          <Field
            label="Save current options as"
            value={presetName}
            maxLength={40}
            onChange={(event) => onPresetNameChange(event.target.value)}
            placeholder="e.g. Podcast highlights"
          />
          <Button size="sm" onClick={onSavePreset} disabled={!presetName.trim() || !catalog}>
            Save preset
          </Button>
        </div>
        {presetStatus && (
          <Hint role="status" aria-live="polite">
            {presetStatus}
          </Hint>
        )}
      </div>

      <Field
        label="Number of clips"
        type="number"
        min={1}
        max={30}
        value={effective('clip_count', 5)}
        onChange={(event) => update('clip_count', Number(event.target.value))}
      />
      <Field
        label="Ideal length (s)"
        type="number"
        min={5}
        max={1800}
        value={effective('target_seconds', 45)}
        onChange={(event) => update('target_seconds', Number(event.target.value))}
      />
      <Field
        label="Min length (s)"
        type="number"
        min={5}
        max={600}
        value={effective('min_seconds', 30)}
        onChange={(event) => update('min_seconds', Number(event.target.value))}
      />
      <Field
        label="Max length (s)"
        type="number"
        min={5}
        max={1800}
        value={effective('max_seconds', 60)}
        onChange={(event) => update('max_seconds', Number(event.target.value))}
      />

      <Select
        label="Whisper model"
        value={effective('whisper_model', 'base')}
        onChange={(event) => update('whisper_model', event.target.value)}
      >
        {(catalog?.whisper_models?.length
          ? catalog.whisper_models.map((entry) => ({ value: entry.name, label: `${entry.name}${entry.note ? ` — ${entry.note}` : ''}` }))
          : FALLBACK_MODELS
        ).map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </Select>

      <Select
        label="Caption style"
        value={effective('caption_style', 'bold')}
        onChange={(event) => update('caption_style', event.target.value)}
      >
        {(
          catalog?.caption_styles?.length
            ? catalog.caption_styles.map((style) => ({ key: style.key, label: style.label }))
            : [
                { key: 'bold', label: 'Bold' },
                { key: 'clean', label: 'Clean' },
                { key: 'boxed', label: 'Boxed' },
              ]
        ).map((style) => (
          <option key={style.key} value={style.key}>
            {style.label}
          </option>
        ))}
      </Select>

      <div className="sm:col-span-2">
        <Select
          label="Aspect ratio"
          value={effective('aspect_ratio', '9:16')}
          onChange={(event) => update('aspect_ratio', event.target.value)}
        >
          {(catalog?.aspect_ratios?.length ? catalog.aspect_ratios : ['9:16', '1:1', '16:9']).map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio}
            </option>
          ))}
        </Select>
      </div>

      <div className="sm:col-span-2">
        <Field
          label="Keywords"
          placeholder="secret, mistake, why, tip"
          value={effective('keywords', '')}
          onChange={(event) => update('keywords', event.target.value)}
          hint="Windows containing these terms are ranked higher. Leave blank to score purely on speech density and clean sentence boundaries."
        />
      </div>

      <fieldset className="sm:col-span-2">
        <Eyebrow as="legend" className="mb-2">
          Vertical framing
        </Eyebrow>
        <div className="flex flex-col divide-y divide-ink-800">
          {VERTICAL_MODES.map((mode) => {
            const selected = effective('vertical_mode', 'blur') === mode.value
            return (
              <button
                key={mode.value}
                type="button"
                aria-pressed={selected}
                onClick={() => update('vertical_mode', mode.value)}
                className={cn(
                  'w-full border-l-2 px-3 py-3 text-left transition-colors',
                  selected
                    ? 'border-l-sodium-500 bg-ink-850/70'
                    : 'border-l-transparent hover:border-l-ink-600 hover:bg-ink-850/40',
                )}
              >
                <span className="text-sm text-ink-100">{mode.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-300">{mode.note}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 sm:col-span-2">
        <Checkline
          label="Burn in captions"
          checked={Boolean(effective('captions', true))}
          onChange={(event) => update('captions', event.target.checked)}
        />
        <Checkline
          label="Transcribe automatically if needed"
          note="Turn off to fail fast instead of spending minutes on Whisper."
          checked={Boolean(effective('auto_transcribe', true))}
          onChange={(event) => update('auto_transcribe', event.target.checked)}
        />
      </div>

      {dirty && (
        <div className="flex items-center gap-3 sm:col-span-2">
          <Hint>
            Using {Object.keys(overrides).length} override{Object.keys(overrides).length === 1 ? '' : 's'} for this run.
          </Hint>
          <Button variant="quiet" size="sm" onClick={onClear}>
            reset to saved
          </Button>
        </div>
      )}
    </div>
  )
}

function RecentProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null)

  useEffect(() => {
    let alive = true
    listProjects()
      .then((records) => alive && setProjects(records))
      .catch(() => alive && setProjects([]))
    return () => {
      alive = false
    }
  }, [])

  if (!projects?.length) return null

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-4 border-b border-ink-800 pb-3">
        <Eyebrow as="h2">Recent</Eyebrow>
        <span className="text-xs text-ink-300 numeric">{projects.length} on disk</span>
      </div>
      <ul className="flex flex-col">
        {projects.slice(0, 8).map((project) => (
          <li key={project.video_id}>
            <Link
              to={
                project.clip_count
                  ? `/library?video=${encodeURIComponent(project.video_id)}`
                  : `/?video=${encodeURIComponent(project.video_id)}`
              }
              className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-ink-850 px-2 py-3.5 no-underline transition-colors hover:bg-ink-850/50"
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.9375rem] text-ink-200">{project.title}</span>
                <span className="mt-0.5 block text-xs text-ink-300 numeric">
                  {[
                    project.duration ? formatDuration(project.duration) : null,
                    project.clip_count ? `${project.clip_count} clip${project.clip_count === 1 ? '' : 's'}` : 'no clips yet',
                    project.kept_count ? `${project.kept_count} kept` : null,
                    project.has_transcript ? 'transcribed' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Tag tone="muted">{project.clip_count ? 'review' : 'open'}</Tag>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
