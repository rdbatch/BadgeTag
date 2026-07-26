import type { RouterState } from 'react-router'
import { pageIdForState, resolveRumConfig } from './rum'

const baseConfig = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_test',
  userPoolClientId: 'test-client-id',
  apiBase: '',
}

function stateWithMatchedPath(path: string | undefined): RouterState {
  return {
    matches: [{ route: { path } }],
  } as unknown as RouterState
}

describe('resolveRumConfig', () => {
  it('returns null when config has no RUM identifiers (older deploy, or a config.json fetch failure)', () => {
    expect(resolveRumConfig(baseConfig)).toBeNull()
  })

  it('returns null when only some RUM fields are present', () => {
    expect(
      resolveRumConfig({ ...baseConfig, rumAppMonitorId: 'app-1', rumIdentityPoolId: '' }),
    ).toBeNull()
  })

  it('resolves a config when app monitor id, identity pool id, and region are all present', () => {
    const resolved = resolveRumConfig({
      ...baseConfig,
      rumAppMonitorId: 'app-1',
      rumIdentityPoolId: 'us-east-1:pool-1',
    })
    expect(resolved).not.toBeNull()
    expect(resolved?.appMonitorId).toBe('app-1')
    expect(resolved?.region).toBe('us-east-1')
  })

  it('omits guestRoleArn so aws-rum-web uses the enhanced (not classic) credential flow', () => {
    // aws-rum-web selects BasicAuthentication — Cognito's classic flow,
    // which needs AllowClassicFlow on the pool — as soon as both
    // identityPoolId and guestRoleArn are set. RumStack does not enable
    // that flow, so setting guestRoleArn here would make every credential
    // fetch fail and RUM would silently record nothing.
    const resolved = resolveRumConfig({
      ...baseConfig,
      rumAppMonitorId: 'app-1',
      rumIdentityPoolId: 'us-east-1:pool-1',
    })
    expect(resolved?.rumConfig.identityPoolId).toBe('us-east-1:pool-1')
    expect(resolved?.rumConfig.guestRoleArn).toBeUndefined()
  })

  it('is cookieless and never auto-records page views (initRum drives them explicitly)', () => {
    const resolved = resolveRumConfig({
      ...baseConfig,
      rumAppMonitorId: 'app-1',
      rumIdentityPoolId: 'us-east-1:pool-1',
    })
    expect(resolved?.rumConfig.allowCookies).toBe(false)
    expect(resolved?.rumConfig.disableAutoPageView).toBe(true)
  })
})

describe('pageIdForState', () => {
  it('uses the matched route pattern, not the resolved URL', () => {
    expect(pageIdForState(stateWithMatchedPath('/p/:id'))).toBe('/p/:id')
    expect(pageIdForState(stateWithMatchedPath('/:slug'))).toBe('/:slug')
    expect(pageIdForState(stateWithMatchedPath('/edit'))).toBe('/edit')
  })

  it('never leaks a real profile id or vanity slug as the page id', () => {
    // A resolved URL for the profile-view route would look like
    // "/p/abc123" or "/@ada-lovelace" — pageIdForState must report the
    // pattern the route registered under instead.
    const pageId = pageIdForState(stateWithMatchedPath('/p/:id'))
    expect(pageId).not.toContain('abc123')
    expect(pageId).not.toMatch(/^\/p\/(?!:)/)
  })

  it('falls back to a fixed sentinel (not the raw path) when no route matched', () => {
    expect(pageIdForState(stateWithMatchedPath(undefined))).toBe('__unmatched__')
  })
})
