/**
 * This UI's own sign-in.
 *
 * The accounts are the UI's, never the connector's — which is the sentence at
 * the bottom of the form, and the reason a third party can replace this app
 * without the connector noticing.
 */
import { useState } from 'react'

import { api } from '../api.js'
import { Card, button, input } from '../ui.js'

export function SignIn({
  onDone,
  participant,
  did,
}: {
  onDone: () => void
  participant: string
  did: string | null
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="mx-auto mt-24 w-full max-w-sm">
      <Card title={`Sign in — ${participant}`}>
        {did ? (
          <p className="mb-3 text-xs text-slate-500" data-testid="signin-did">
            This UI belongs to <span className="font-mono">{did}</span>.
          </p>
        ) : null}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            const work = creating
              ? api.signUp(email, password, email.split('@')[0] ?? email)
              : api.signIn(email, password)
            void work.then(onDone).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause))
            })
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Email</span>
            <input
              className={input}
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Password</span>
            <input
              className={input}
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button className={button} type="submit">
            {creating ? 'Create account' : 'Sign in'}
          </button>
          <button
            type="button"
            className="text-xs text-slate-500 underline"
            onClick={() => setCreating(!creating)}
          >
            {creating ? 'I already have an account' : 'Create an account'}
          </button>
        </form>
        <p className="mt-4 text-xs text-slate-500">
          These accounts belong to <em>this</em> UI, not to the connector. The connector
          authenticates one API key and records who was driving as an audit hint — it has no idea
          who you are, and that is what lets somebody else’s UI replace this one.
        </p>
      </Card>
    </div>
  )
}
