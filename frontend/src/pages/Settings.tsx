import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { describeError, getHealth, getSettings, putSettings, resetSettings } from '../lib/api'
import type { ApiError } from '../lib/api'
import type { CaptionStyle, Health, Settings, WhisperModel } from '../types'
import ErrorNote from '../components/ErrorNote'
import PageHeader from '../components/PageHeader'
import { Button, Card, Checkline, Field, Hint, Select, Tag } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

interface Meta {
  aspectRatios: string[]
  verticalModes: string[]
  whisperModels: WhisperModel[]
  captionStyles: CaptionStyle[]
  limits: Record<string, [number, number]>
  path?: string
}

export default function SettingsPage() {
  useDocumentTitle('Settings')
  const [values, setValues] = useState<Settings | null>(null)
  const [meta, setMeta] = useState<Meta>({
    aspectRatios: [],
    verticalModes: [],
    whisperModels: [],
    captionStyles: [],
    limits: {},
  })
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getSettings()
      .then((data) => {
        if (!alive) return
        setValues(data.settings)
        setMeta({
          aspectRatios: data.aspect_ratios || [],
          verticalModes: data.vertical_modes || [],
          whisperModels: data.whisper_models || [],
          captionStyles: data.caption_styles || [],
          limits: data.limits || {},
          path: data.path,
        })
      })
      .catch((err) => alive && setError(describeError(err)))
    getHealth()
      .then((data) => alive && setHealth(data))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const save = async (patch: Partial<Settings>) => {
    if (!values) return
    setValues({ ...values, ...patch })
    setSaved(false)
    try {
      const data = await putSettings(patch)
      setValues(data.settings)
      setError(null)
      setSaved(true)
    } catch (err) {
      setError(describeError(err))
    }
  }

  const onReset = async () => {
    setBusy(true)
    try {
      const data = await resetSettings()
      setValues(data.settings)
      setError(null)
      setSaved(true)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  if (!values) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Persisted defaults for new jobs." />
        <Card>
          <Hint>Loading settings…</Hint>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Persisted defaults for new jobs. Anything changed on the ingest screen applies to that run only."
        actions={
          <>
            {saved && <Tag tone="good" role="status">saved</Tag>}
            <Button size="sm" onClick={onReset} disabled={busy}>
              Reset to defaults
            </Button>
          </>
        }
      />

      {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}

      <Section title="Output">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Select label="Aspect ratio" value={values.aspect_ratio} onChange={(e) => save({ aspect_ratio: e.target.value })}>
            {(meta.aspectRatios.length ? meta.aspectRatios : ['9:16', '1:1', '16:9']).map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio}
              </option>
            ))}
          </Select>

          <Select label="Vertical framing" value={values.vertical_mode} onChange={(e) => save({ vertical_mode: e.target.value })}>
            {(meta.verticalModes.length ? meta.verticalModes : ['blur', 'crop', 'fit']).map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>

          <Select
            label="Caption style"
            value={values.caption_style}
            hint={meta.captionStyles.find((style) => style.key === values.caption_style)?.description}
            onChange={(e) => save({ caption_style: e.target.value })}
          >
            {(meta.captionStyles.length ? meta.captionStyles : [{ key: 'bold', label: 'Bold' }]).map((style) => (
              <option key={style.key} value={style.key}>
                {style.label}
              </option>
            ))}
          </Select>

          <div className="flex flex-col gap-3">
            <Checkline
              label="Burn in captions"
              note="Rendered by FFmpeg, so they are in the file."
              checked={Boolean(values.captions)}
              onChange={(e) => save({ captions: e.target.checked })}
            />
            <Checkline
              label="Transcribe automatically"
              note="Off means a missing transcript fails the run instead."
              checked={Boolean(values.auto_transcribe)}
              onChange={(e) => save({ auto_transcribe: e.target.checked })}
            />
          </div>
        </div>
      </Section>

      <Section title="Clips">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            label="Number of clips"
            type="number"
            min={meta.limits.clip_count?.[0] ?? 1}
            max={meta.limits.clip_count?.[1] ?? 30}
            value={values.clip_count}
            onChange={(e) => save({ clip_count: Number(e.target.value) })}
          />
          <Field
            label="Ideal length (s)"
            type="number"
            value={values.target_seconds}
            onChange={(e) => save({ target_seconds: Number(e.target.value) })}
          />
          <Field
            label="Min length (s)"
            type="number"
            value={values.min_seconds}
            onChange={(e) => save({ min_seconds: Number(e.target.value) })}
          />
          <Field
            label="Max length (s)"
            type="number"
            value={values.max_seconds}
            onChange={(e) => save({ max_seconds: Number(e.target.value) })}
          />
          <Field
            label="Keywords"
            className="sm:col-span-2"
            labelClassName="sm:col-span-2"
            placeholder="secret, mistake, why, tip"
            value={values.keywords}
            hint="Comma-separated. Windows containing these are ranked higher when choosing cuts."
            onChange={(e) => save({ keywords: e.target.value })}
          />
        </div>
      </Section>

      <Section title="Transcription">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Select label="Whisper model" value={values.whisper_model} onChange={(e) => save({ whisper_model: e.target.value })}>
            {(meta.whisperModels.length ? meta.whisperModels : [{ name: 'base' }]).map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
                {model.note ? ` — ${model.note}` : ''}
              </option>
            ))}
          </Select>
        </div>
        {health?.whisper?.ok && (
          <Hint className="mt-3 numeric">
            Loaded via {health.whisper.backend} on {health.whisper.device}
            {health.whisper.cuda ? ' (CUDA)' : ''}.
          </Hint>
        )}
      </Section>

      <Section title="Machine">
        {!health && <Hint>Checking…</Hint>}
        {health && (
          <div className="flex flex-col gap-2 text-[0.8125rem] numeric">
            <Status label="FFmpeg" ok={Boolean(health.ffmpeg?.ok)} detail={health.ffmpeg?.ok ? health.ffmpeg.version : health.ffmpeg?.error} />
            <Status label="FFprobe" ok={Boolean(health.ffprobe?.ok)} detail={health.ffprobe?.ok ? health.ffprobe.version : health.ffprobe?.error} />
            <Status label="yt-dlp" ok={Boolean(health.ytdlp_version)} detail={health.ytdlp_version ?? undefined} />
            <Status label="Whisper" ok={Boolean(health.whisper?.ok)} detail={health.whisper?.ok ? health.whisper.backend : health.whisper?.error} />
            <Hint className="mt-2">
              Clips directory: <code className="text-ink-200">{health.clips_dir}</code>
            </Hint>
            <Hint>
              Settings file: <code className="text-ink-200">{meta.path}</code>
            </Hint>
          </div>
        )}
      </Section>

      <Section title="Data & privacy">
        <Hint className="max-w-2xl leading-relaxed">
          Coppify is local-first. Videos, transcripts, and clips are written to the folders shown
          above and are never uploaded anywhere. Nothing is sent to a server you do not control,
          and there is no telemetry, account, or analytics.
        </Hint>
        <Hint className="max-w-2xl leading-relaxed">
          Downloaded source material may be copyright-protected. Only process video you own or have
          the rights to use. See{' '}
          <Link to="/about" className="text-sodium-500">
            About, credits &amp; licenses
          </Link>{' '}
          for the open-source components this project builds on.
        </Hint>
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="border-b border-ink-800 pb-3">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300">{title}</h2>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Status({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <Tag tone={ok ? 'good' : 'bad'}>{ok ? 'ok' : 'missing'}</Tag>
      <span className="min-w-20 text-ink-200">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ink-300">{detail || '—'}</span>
    </div>
  )
}
