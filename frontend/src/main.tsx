import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { AuthProvider } from './auth'
import { loadRuntimeConfig } from './config/runtimeConfig'
import { initRum } from './monitoring/rum'
import { router } from './router'
import './index.css'

async function main() {
  // Local-only mock mode (`npm run dev:mock`): answers Cognito and the
  // profile API from local data. import.meta.env.DEV is statically false
  // in production builds, so this branch — and the entire src/mocks/
  // chunk behind the dynamic import — never ships.
  if (import.meta.env.DEV && import.meta.env.MODE === 'mock') {
    const { installMocks } = await import('./mocks/install')
    installMocks()
  }

  // Load runtime config (Cognito User Pool ID, etc.) before rendering,
  // so auth calls have valid configuration from the first render.
  await loadRuntimeConfig()

  // After config load, before render, so RUM captures initial page-load
  // timing and web vitals. No-ops in local dev and whenever this deploy's
  // config.json has no RUM identifiers — see monitoring/rum.ts.
  await initRum(router)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </StrictMode>,
  )
}

main()
