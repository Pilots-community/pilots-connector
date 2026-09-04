import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './App.js'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      /*
       * A refetch must never blank a screen that already has data.
       *
       * Without this, every revalidation drops the view back to its loading
       * state for a moment — which, on a five-second timer, is a page that
       * flickers all day. Keeping the previous value means the refresh is
       * invisible unless something actually changed.
       */
      placeholderData: <T,>(previous: T): T => previous,
      staleTime: 2_000,
      // The live sync decides when to revalidate; a per-query interval here
      // would be a second, competing answer to the same question.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
