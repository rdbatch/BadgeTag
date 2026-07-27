import type { DataRouter, RouterState } from 'react-router'
import type { RuntimeConfig } from '../config/runtimeConfig'
import { getRuntimeConfig } from '../config/runtimeConfig'

// Lazily typed so `aws-rum-web` (a signing/AWS-SDK-adjacent dependency) is
// never pulled into the main bundle — see the same pattern in
// auth/service.ts's getClient().
type AwsRum = InstanceType<typeof import('aws-rum-web').AwsRum>
type AwsRumConfig = ConstructorParameters<typeof import('aws-rum-web').AwsRum>[3]

let rum: AwsRum | null = null

/**
 * Validates this deploy's RUM identifiers and, if present, builds the
 * config `new AwsRum(...)` needs. Returns `null` when any are missing —
 * older deploys or a `/config.json` fetch failure (see runtimeConfig's
 * FALLBACK_CONFIG) leave RUM off rather than throwing. Pulled out of
 * `initRum` so this gating is testable independent of
 * `import.meta.env.DEV`, which a unit test can't flip.
 */
export function resolveRumConfig(
  config: RuntimeConfig,
): { appMonitorId: string; region: string; rumConfig: AwsRumConfig } | null {
  if (!config.rumAppMonitorId || !config.rumIdentityPoolId || !config.region) {
    return null
  }
  return {
    appMonitorId: config.rumAppMonitorId,
    region: config.region,
    rumConfig: {
      // aws-rum-web's own defaultConfig() hardcodes endpoint to the
      // us-west-2 dataplane and merges it in *before* our config, so the
      // constructor's `region` argument never actually determines the
      // request's destination — only the SigV4 signing scope. Left
      // unset, every request is signed for `region` but physically sent
      // to us-west-2, which AWS rejects with "Credential should be
      // scoped to a valid region." Must be set explicitly.
      endpoint: `https://dataplane.rum.${config.region}.amazonaws.com`,
      // No privacy notice exists for this app today, so the session/user
      // cookies RUM would otherwise set are deliberately left off — a
      // session then only lasts for the current page load rather than
      // persisting across visits.
      allowCookies: false,
      enableXRay: true,
      identityPoolId: config.rumIdentityPoolId,
      // Deliberately no `guestRoleArn`. aws-rum-web picks its credential
      // flow by presence: with both `identityPoolId` and `guestRoleArn` it
      // uses BasicAuthentication (the *classic* flow, GetId →
      // GetOpenIdToken → sts:AssumeRoleWithWebIdentity), which Cognito
      // rejects unless the pool sets `AllowClassicFlow`. With only the pool
      // id it uses EnhancedAuthentication (GetId →
      // GetCredentialsForIdentity), which resolves the guest role from the
      // pool's role attachment instead — that's what RumStack configures,
      // and it keeps the browser off AssumeRoleWithWebIdentity entirely.
      telemetries: [
        'errors',
        'performance',
        [
          'http',
          {
            // Only the same-origin /api/* path gets the X-Ray trace header
            // (joins a RUM session to the backend's request_id-tagged
            // logs — see api.rs) — scoping it this narrowly means it's
            // never added to the cross-origin Cognito calls, which would
            // otherwise trigger a CORS preflight those endpoints don't
            // expect.
            urlsToInclude: [/^\/api\//],
            addXRayTraceIdHeader: [/^\/api\//],
          },
        ],
      ],
      disableAutoPageView: true,
    },
  }
}

/**
 * The page ID to record for a given router state: always the matched route
 * *pattern* (e.g. "/p/:id"), never the resolved URL. Two routes carry a
 * profile ID or vanity slug in the path, and that must never leave the
 * browser — see docs-md/observability/rum.md. Falls back to a fixed
 * sentinel (not `state.location.pathname`) for the no-match case, since a
 * mistyped URL could itself be PII-shaped.
 */
export function pageIdForState(state: RouterState): string {
  return state.matches.at(-1)?.route.path ?? '__unmatched__'
}

/**
 * Initializes CloudWatch RUM and wires it to record a page view on every
 * client-side navigation. Safe to call unconditionally from main.tsx — it
 * no-ops in local dev (including `dev:mock`) and whenever this deploy's
 * config.json has no RUM identifiers.
 */
export async function initRum(router: DataRouter): Promise<void> {
  // import.meta.env.DEV is statically false in production builds, so this
  // branch — and the dynamic import below — never ships, and mock mode
  // (which only intercepts Cognito/same-origin fetches, see
  // mocks/handlers.ts) never sees real RUM traffic escape to AWS.
  if (import.meta.env.DEV) {
    return
  }

  const resolved = resolveRumConfig(getRuntimeConfig())
  if (!resolved) {
    return
  }

  try {
    const { AwsRum } = await import('aws-rum-web')
    rum = new AwsRum(resolved.appMonitorId, '1.0.0', resolved.region, resolved.rumConfig)
  } catch (err) {
    // Telemetry must never break the app — same convention as the
    // best-effort view-count increment on the backend (see
    // docs-md/observability/overview.md).
    console.error('Failed to initialize RUM', err)
    return
  }

  recordPageViewForState(router.state)
  router.subscribe(recordPageViewForState)
}

function recordPageViewForState(state: RouterState): void {
  rum?.recordPageView(pageIdForState(state))
}
