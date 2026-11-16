import { Link } from 'react-router-dom'

import PageHeader from '../components/PageHeader'
import { Card, Eyebrow, Hint, Tag } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

interface Credit {
  name: string
  license: string
  url: string
  note: string
}

const RUNTIME: Credit[] = [
  {
    name: 'yt-dlp',
    license: 'The Unlicense',
    url: 'https://github.com/yt-dlp/yt-dlp',
    note: 'Downloads the source video. Contains no DRM or paywall workarounds.',
  },
  {
    name: 'FFmpeg',
    license: 'LGPL-2.1+ / GPL (build dependent)',
    url: 'https://ffmpeg.org',
    note: 'Reframing, caption burn-in and encoding. The libx264 encoder it is used with is GPL.',
  },
  {
    name: 'OpenAI Whisper',
    license: 'MIT',
    url: 'https://github.com/openai/whisper',
    note: 'Speech recognition and word timings.',
  },
  {
    name: 'faster-whisper / CTranslate2',
    license: 'MIT',
    url: 'https://github.com/SYSTRAN/faster-whisper',
    note: 'Faster local transcription backend, used when installed.',
  },
  {
    name: 'Flask & flask-cors',
    license: 'BSD-3-Clause / MIT',
    url: 'https://flask.palletsprojects.com',
    note: 'Local HTTP API for the user interface.',
  },
]

const FRONTEND: Credit[] = [
  { name: 'React & React DOM', license: 'MIT', url: 'https://react.dev', note: 'User interface runtime.' },
  {
    name: 'React Router',
    license: 'MIT',
    url: 'https://reactrouter.com',
    note: 'Client-side routing between the five screens.',
  },
  { name: 'Vite', license: 'MIT', url: 'https://vite.dev', note: 'Development server and production build.' },
  { name: 'Tailwind CSS', license: 'MIT', url: 'https://tailwindcss.com', note: 'Utility-first styling and design tokens.' },
  {
    name: 'Archivo',
    license: 'SIL Open Font License 1.1',
    url: 'https://github.com/Omnibus-Type/Archivo',
    note: 'Interface typeface, bundled locally.',
  },
  {
    name: 'Instrument Serif',
    license: 'SIL Open Font License 1.1',
    url: 'https://github.com/Instrument/instrument-serif',
    note: 'Display typeface, bundled locally.',
  },
]

export default function About() {
  useDocumentTitle('About, credits & licenses')

  return (
    <>
      <PageHeader
        title="About, credits & licenses"
        subtitle="What this is, what it runs on, and the terms of the software it stands on."
      />

      <Card>
        <Eyebrow as="h2">Local-first by design</Eyebrow>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-200">
          Coppify turns a YouTube link into vertical short clips entirely on your own machine. It
          downloads the video, transcribes it with Whisper, scores candidate moments, and renders
          them with FFmpeg. There are no accounts, no cloud services, no watermarks, and no
          telemetry — your media and transcripts never leave your computer.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-300">
          Downloaded source material may be copyright-protected. Only process video you own or have
          the rights to use. Coppify contains no workarounds for DRM or paywalled content and never
          will.
        </p>
        <Link to="/settings" className="text-sm text-sodium-500">
          Back to settings
        </Link>
      </Card>

      <CreditSection title="Runtime components" items={RUNTIME} />
      <CreditSection title="Front end" items={FRONTEND} />

      <Hint className="max-w-2xl">
        Licenses are reproduced here for attribution. When redistributing a build — especially one
        bundling FFmpeg with GPL components — confirm you meet each component&apos;s obligations.
      </Hint>
    </>
  )
}

function CreditSection({ title, items }: { title: string; items: Credit[] }) {
  return (
    <section className="mt-6">
      <div className="border-b border-ink-800 pb-3">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300">{title}</h2>
      </div>
      <ul className="divide-y divide-ink-850">
        {items.map((item) => (
          <li key={item.name} className="grid gap-2 py-4 sm:grid-cols-[14rem_1fr]">
            <div>
              <a href={item.url} target="_blank" rel="noreferrer noopener" className="text-sm text-ink-100">
                {item.name}
              </a>
              <span className="mt-1 block">
                <Tag tone="muted">{item.license}</Tag>
              </span>
            </div>
            <p className="text-sm leading-relaxed text-ink-300">{item.note}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
