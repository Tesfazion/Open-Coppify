/**
 * Small, unopinionated UI primitives.
 *
 * Every screen composes these instead of repeating Tailwind class strings, so a
 * change to the focus treatment, contrast or radius happens in exactly one
 * place. Each primitive is a plain semantic element — a <button> stays a
 * <button>, a label stays a label — which is what keeps the app keyboard- and
 * screen-reader-navigable without bolted-on ARIA.
 */

import { useId } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'

import { cn } from '../lib/cn'

// --------------------------------------------------------------------- Button

type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger'
type ButtonSize = 'sm' | 'md'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sodium-500 text-ink-900 hover:bg-sodium-400',
  ghost: 'bg-transparent text-ink-100 border border-ink-700 hover:border-ink-600',
  quiet: 'bg-transparent text-ink-300 hover:text-sodium-400 px-1',
  danger: 'bg-transparent text-bad border border-transparent hover:border-bad/50',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1 rounded',
  md: 'text-sm px-4 py-2 rounded',
}

/** Class string for a button-styled element (button, Link, <a>…). */
export function buttonClass(
  variant: ButtonVariant = 'ghost',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cn(
    'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap',
    'transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
    BUTTON_SIZES[size],
    BUTTON_VARIANTS[variant],
    extra,
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
}

export function Button({ variant = 'ghost', size = 'md', block, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={buttonClass(variant, size, cn(block && 'w-full', className))}
      {...rest}
    />
  )
}

// ------------------------------------------------------------------------ Tag

type TagTone = 'muted' | 'good' | 'bad' | 'accent'

const TAG_TONES: Record<TagTone, string> = {
  muted: 'text-ink-400',
  good: 'text-good',
  bad: 'text-bad',
  accent: 'text-sodium-500',
}

export function tagClass(tone: TagTone = 'muted', extra?: string): string {
  return cn(
    'text-[0.6875rem] font-semibold uppercase tracking-[0.06em]',
    TAG_TONES[tone],
    extra,
  )
}

interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone
}

export function Tag({ tone = 'muted', className, children, ...rest }: TagProps) {
  return (
    <span className={tagClass(tone, className)} {...rest}>
      {children}
    </span>
  )
}

// -------------------------------------------------------------------- Eyebrow

interface EyebrowProps extends HTMLAttributes<HTMLParagraphElement> {
  as?: 'p' | 'h2' | 'h3' | 'span' | 'legend'
}

export function Eyebrow({ as: Component = 'p', className, children, ...rest }: EyebrowProps) {
  return (
    <Component
      className={cn(
        'text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  )
}

// ----------------------------------------------------------------------- Hint

export function Hint({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-xs leading-relaxed text-ink-300', className)} {...rest}>
      {children}
    </p>
  )
}

// ----------------------------------------------------------------------- Card

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-ink-800 bg-ink-850/60 p-5 flex flex-col gap-4', className)}
      {...rest}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------- Field

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode
  hint?: ReactNode
  labelClassName?: string
}

export function Field({ label, hint, id, className, labelClassName, ...rest }: FieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const hintId = hint ? `${inputId}-hint` : undefined

  return (
    <div className={cn('flex flex-col gap-1', labelClassName)}>
      <label htmlFor={inputId} className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300">
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={hintId}
        className={cn(
          'w-full bg-transparent border-0 border-b border-ink-600 px-0.5 py-2.5 text-sm text-ink-100',
          'transition-colors placeholder:text-ink-500 focus:outline-none focus:border-b-sodium-500',
          'disabled:text-ink-500 disabled:border-ink-800',
          className,
        )}
        {...rest}
      />
      {hint && (
        <Hint id={hintId} className="mt-1">
          {hint}
        </Hint>
      )}
    </div>
  )
}

// --------------------------------------------------------------------- Select

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode
  hint?: ReactNode
}

export function Select({ label, hint, id, className, children, ...rest }: SelectProps) {
  const generated = useId()
  const selectId = id ?? generated
  const hintId = hint ? `${selectId}-hint` : undefined

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300">
        {label}
      </label>
      <select
        id={selectId}
        aria-describedby={hintId}
        className={cn(
          'w-full cursor-pointer appearance-none bg-transparent border-0 border-b border-ink-600',
          'px-0.5 py-2.5 pr-6 text-sm text-ink-100 transition-colors focus:outline-none focus:border-b-sodium-500',
          '[&>option]:bg-ink-850 [&>option]:text-ink-100',
          className,
        )}
        style={{
          backgroundImage:
            'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
          backgroundPosition: 'right 0.5rem center, right 0.25rem center',
          backgroundSize: '5px 5px, 5px 5px',
          backgroundRepeat: 'no-repeat',
        }}
        {...rest}
      >
        {children}
      </select>
      {hint && (
        <Hint id={hintId} className="mt-1">
          {hint}
        </Hint>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- Checkbox

interface ChecklineProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode
  note?: ReactNode
}

export function Checkline({ label, note, id, className, ...rest }: ChecklineProps) {
  const generated = useId()
  const inputId = id ?? generated

  return (
    <label htmlFor={inputId} className={cn('flex items-start gap-3 text-sm text-ink-100 cursor-pointer', className)}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-sodium-500"
        {...rest}
      />
      <span>
        {label}
        {note && <span className="mt-1 block text-xs text-ink-300">{note}</span>}
      </span>
    </label>
  )
}

// -------------------------------------------------------------------- Spinner

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-sodium-500',
        className,
      )}
    />
  )
}

// ---------------------------------------------------------------------- Empty

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-xl pt-12">
      <h2 className="font-display text-3xl text-ink-200">{title}</h2>
      {children && <div className="mt-4 text-sm leading-relaxed text-ink-300">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- StatusPill

interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  ok?: boolean
}

export function StatusPill({ ok = false, className, children, ...rest }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide',
        ok
          ? 'border-good/35 bg-good/10 text-good'
          : 'border-ink-700 bg-ink-850/60 text-ink-300',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

// --------------------------------------------------------------- VisuallyHidden

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0,0,0,0)]">
      {children}
    </span>
  )
}

// Re-export the label type helper for consumers building their own wrappers.
export type { LabelHTMLAttributes }
