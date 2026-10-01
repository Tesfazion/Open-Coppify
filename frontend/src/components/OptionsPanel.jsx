const MODES = [
  { value: 'blur', label: 'Blur', hint: 'Original video over a blurred backdrop. Nothing is cropped.' },
  { value: 'crop', label: 'Crop', hint: 'Centre-crop to 9:16 and fill the frame. Most TikTok-native.' },
  { value: 'fit', label: 'Fit', hint: 'Scale down and pad with black bars.' },
]

export default function OptionsPanel({ options, onChange, disabled, whisperModels }) {
  const set = (key) => (event) => {
    const target = event.target
    const value = target.type === 'checkbox' ? target.checked : target.value
    onChange({ ...options, [key]: value })
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2>Clip settings</h2>
        <span className="pill pill--muted">1080 x 1920 &middot; 9:16</span>
      </div>

      <div className="grid">
        <div className="field">
          <label className="label" htmlFor="clip-count">Number of clips</label>
          <input
            id="clip-count"
            className="input"
            type="number"
            min="1"
            max="30"
            value={options.count}
            disabled={disabled}
            onChange={set('count')}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="clip-min">Minimum length (s)</label>
          <input
            id="clip-min"
            className="input"
            type="number"
            min="5"
            max="600"
            value={options.minSeconds}
            disabled={disabled}
            onChange={set('minSeconds')}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="clip-max">Maximum length (s)</label>
          <input
            id="clip-max"
            className="input"
            type="number"
            min="5"
            max="1800"
            value={options.maxSeconds}
            disabled={disabled}
            onChange={set('maxSeconds')}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="clip-target">Ideal length (s)</label>
          <input
            id="clip-target"
            className="input"
            type="number"
            min="5"
            max="1800"
            value={options.targetSeconds}
            disabled={disabled}
            onChange={set('targetSeconds')}
          />
        </div>

        <div className="field field--wide">
          <label className="label" htmlFor="keywords">
            Keywords <span className="label__optional">optional, comma separated</span>
          </label>
          <input
            id="keywords"
            className="input"
            type="text"
            placeholder="secret, mistake, why, tip"
            value={options.keywords}
            disabled={disabled}
            onChange={set('keywords')}
          />
          <p className="hint">
            Windows containing these terms are ranked higher. Leave blank to score
            purely on speech density and clean sentence boundaries.
          </p>
        </div>

        <div className="field field--wide">
          <span className="label">Vertical framing</span>
          <div className="segmented" role="radiogroup" aria-label="Vertical framing">
            {MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={options.verticalMode === mode.value}
                className={`segmented__item ${options.verticalMode === mode.value ? 'is-active' : ''}`}
                disabled={disabled}
                onClick={() => onChange({ ...options, verticalMode: mode.value })}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="hint">{MODES.find((m) => m.value === options.verticalMode)?.hint}</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="whisper-model">Whisper model</label>
          <select
            id="whisper-model"
            className="input"
            value={options.model}
            disabled={disabled}
            onChange={set('model')}
          >
            {(whisperModels.length
              ? whisperModels
              : ['tiny', 'base', 'small', 'medium', 'large-v3']
            ).map((entry) => {
              const name = typeof entry === 'string' ? entry : entry.name
              const note = typeof entry === 'string' ? '' : ` - ${entry.note}`
              return (
                <option key={name} value={name}>
                  {name}
                  {note}
                </option>
              )
            })}
          </select>
          <p className="hint">Larger models are slower. "base" is a good default on CPU.</p>
        </div>

        <div className="field field--checkboxes">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={options.captions}
              disabled={disabled}
              onChange={set('captions')}
            />
            <span>Burn in captions</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={options.autoTranscribe}
              disabled={disabled}
              onChange={set('autoTranscribe')}
            />
            <span>Transcribe automatically if needed</span>
          </label>
        </div>
      </div>
    </section>
  )
}