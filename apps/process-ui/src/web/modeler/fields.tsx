/**
 * Inputs that commit on blur or Enter, not per keystroke: every commit is a
 * command, an undo entry and a lint request, and a title typed letter by letter
 * should be one of each, not twenty.
 */
import { useEffect, useState, type ReactNode } from 'react'

import { button, ghost, input } from '../ui.js'

export function TextField({
  label,
  value,
  onCommit,
  testid,
  placeholder,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  testid?: string
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = (): void => {
    if (text !== value) onCommit(text)
  }
  return (
    <Labelled label={label}>
      <input
        className={input}
        value={text}
        placeholder={placeholder}
        data-testid={testid}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
    </Labelled>
  )
}

/** Bare text input: local text re-synced from `value`, commits on blur/Enter only when `parse(text)` differs. */
function CommitInput<T>({
  value,
  format,
  parse,
  same,
  onCommit,
  className,
  placeholder,
  type,
}: {
  value: T
  format: (value: T) => string
  parse: (text: string) => T
  same: (a: T, b: T) => boolean
  onCommit: (value: T) => void
  className?: string
  placeholder?: string
  type?: string
}) {
  const shown = format(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = (): void => {
    const next = parse(text)
    if (!same(next, value)) onCommit(next)
    else setText(shown)
  }
  return (
    <input
      className={className ?? input}
      type={type}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

/** A comma-separated list; commits only when the parsed list differs. */
export function ListField({
  value,
  onCommit,
  className,
  placeholder,
}: {
  value: string[]
  onCommit: (value: string[]) => void
  className?: string
  placeholder?: string
}) {
  return (
    <CommitInput<string[]>
      value={value}
      format={(list) => list.join(', ')}
      parse={(text) => text.split(',').map((one) => one.trim()).filter(Boolean)}
      same={(a, b) => a.length === b.length && a.every((one, at) => one === b[at])}
      onCommit={onCommit}
      className={className}
      placeholder={placeholder}
    />
  )
}

/** A whole number of at least `min`; commits only when it differs from `value`. */
export function NumberField({ value, min, onCommit }: { value: number; min: number; onCommit: (value: number) => void }) {
  return (
    <CommitInput<number>
      type="number"
      value={value}
      format={String}
      parse={(text) => Math.max(min, Math.floor(Number(text)) || min)}
      same={(a, b) => a === b}
      onCommit={onCommit}
    />
  )
}

/**
 * A caption over a control or a group of controls. A `div`, not a `label`: some
 * groups hold checkboxes with labels of their own, and labels must not nest.
 */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block" role="group" aria-label={label}>
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </div>
  )
}

export function Panel({
  title,
  onClose,
  onSubmit,
  submitLabel,
  children,
}: {
  title: string
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  children: ReactNode
}) {
  return (
    <div data-testid="new-element" className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3 dark:border-slate-600">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
      <div className="flex gap-2">
        <button type="button" className={button} data-testid="new-element-submit" onClick={onSubmit}>
          {submitLabel}
        </button>
        <button type="button" className={ghost} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
