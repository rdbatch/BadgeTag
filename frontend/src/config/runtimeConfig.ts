/**
 * Runtime configuration, loaded from /config.json at app startup.
 *
 * This decouples the build artifact from any specific environment —
 * the same `dist/` build can be deployed to dev/staging/prod, with each
 * environment providing its own config.json alongside the static assets.
 *
 * config.json is written by the deploy process (see deploy.sh) and is
 * never cached by CloudFront/browsers (see FrontendStack cache behavior).
 */
export interface RuntimeConfig {
  region: string
  userPoolId: string
  userPoolClientId: string
  /** Base URL for API requests. Empty string means same-origin (via CloudFront). */
  apiBase: string
  /**
   * CloudWatch RUM identifiers (see RumStack). Optional and independently
   * gated: absent/empty on any deploy that predates RUM or a config.json
   * fetch failure, in which case RUM simply stays off rather than throwing.
   */
  rumAppMonitorId?: string
  rumIdentityPoolId?: string
}

let cachedConfig: RuntimeConfig | null = null
let loadPromise: Promise<RuntimeConfig> | null = null

const FALLBACK_CONFIG: RuntimeConfig = {
  region: '',
  userPoolId: '',
  userPoolClientId: '',
  apiBase: '',
}

/**
 * Loads runtime config from /config.json. Safe to call multiple times —
 * subsequent calls return the cached result or in-flight promise.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cachedConfig) return cachedConfig
  if (loadPromise) return loadPromise

  loadPromise = fetch('/config.json')
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load config.json: ${res.status}`)
      return res.json() as Promise<RuntimeConfig>
    })
    .then((config) => {
      cachedConfig = config
      return config
    })
    .catch((err) => {
      console.error('Failed to load runtime config, using fallback:', err)
      cachedConfig = FALLBACK_CONFIG
      return FALLBACK_CONFIG
    })

  return loadPromise
}

/**
 * Returns the cached config synchronously. Must call `loadRuntimeConfig()`
 * first (e.g., at app startup) — throws if config hasn't been loaded yet.
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (!cachedConfig) {
    throw new Error(
      'Runtime config not loaded yet. Call loadRuntimeConfig() before using getRuntimeConfig().',
    )
  }
  return cachedConfig
}
