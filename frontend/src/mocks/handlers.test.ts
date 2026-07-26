import {
  handleMockRequest,
  MOCK_ID_TOKEN,
  MOCK_STORE_KEY,
  seedDemoProfile,
} from './handlers'

const AUTH_HEADER = { Authorization: `Bearer ${MOCK_ID_TOKEN}` }

function request(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  return new Request(new URL(path, window.location.origin), init)
}

function cognitoRequest(target: string, body: unknown): Request {
  return new Request('https://cognito-idp.local.amazonaws.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  localStorage.clear()
  seedDemoProfile()
})

describe('seedDemoProfile', () => {
  it('does not overwrite existing local edits', async () => {
    const res = await handleMockRequest(
      request('/api/profile', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({ email: 'me@example.com', theme: 'dark', display_email: false, links: [] }),
      }),
    )
    expect(res?.status).toBe(200)

    seedDemoProfile()

    const me = await handleMockRequest(
      request('/api/profile/me', { headers: AUTH_HEADER }),
    )
    const profile = await me?.json()
    expect(profile.email).toBe('me@example.com')
  })
})

describe('Cognito handlers', () => {
  it('answers InitiateAuth with SELECT_CHALLENGE, offering only EMAIL_OTP when no passkey is registered', async () => {
    const res = await handleMockRequest(
      cognitoRequest('InitiateAuth', { AuthFlow: 'USER_AUTH' }),
    )
    expect(res?.status).toBe(200)
    const body = await res?.json()
    expect(body.ChallengeName).toBe('SELECT_CHALLENGE')
    expect(body.AvailableChallenges).toEqual(['EMAIL_OTP'])
    expect(body.Session).toBeTruthy()
  })

  it('offers WEB_AUTHN in AvailableChallenges once a passkey is registered', async () => {
    await handleMockRequest(
      cognitoRequest('CompleteWebAuthnRegistration', { AccessToken: MOCK_ID_TOKEN }),
    )

    const res = await handleMockRequest(
      cognitoRequest('InitiateAuth', { AuthFlow: 'USER_AUTH' }),
    )
    const body = await res?.json()
    expect(body.AvailableChallenges).toEqual(['EMAIL_OTP', 'WEB_AUTHN'])
  })

  it('answers SELECT_CHALLENGE/EMAIL_OTP by returning an EMAIL_OTP challenge', async () => {
    const res = await handleMockRequest(
      cognitoRequest('RespondToAuthChallenge', {
        ChallengeName: 'SELECT_CHALLENGE',
        ChallengeResponses: { USERNAME: 'ada@example.com', ANSWER: 'EMAIL_OTP' },
      }),
    )
    const body = await res?.json()
    expect(body.ChallengeName).toBe('EMAIL_OTP')
    expect(body.Session).toBeTruthy()
  })

  it('answers SELECT_CHALLENGE/WEB_AUTHN by returning a WEB_AUTHN challenge with request options', async () => {
    const res = await handleMockRequest(
      cognitoRequest('RespondToAuthChallenge', {
        ChallengeName: 'SELECT_CHALLENGE',
        ChallengeResponses: { USERNAME: 'ada@example.com', ANSWER: 'WEB_AUTHN' },
      }),
    )
    const body = await res?.json()
    expect(body.ChallengeName).toBe('WEB_AUTHN')
    expect(body.Session).toBeTruthy()
    expect(JSON.parse(body.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS).challenge).toBeTruthy()
  })

  it('supports the full passkey registration/list/delete lifecycle', async () => {
    const start = await handleMockRequest(
      cognitoRequest('StartWebAuthnRegistration', { AccessToken: MOCK_ID_TOKEN }),
    )
    const startBody = await start?.json()
    expect(startBody.CredentialCreationOptions.challenge).toBeTruthy()

    await handleMockRequest(
      cognitoRequest('CompleteWebAuthnRegistration', { AccessToken: MOCK_ID_TOKEN }),
    )

    const list = await handleMockRequest(
      cognitoRequest('ListWebAuthnCredentials', { AccessToken: MOCK_ID_TOKEN }),
    )
    const listBody = await list?.json()
    expect(listBody.Credentials).toHaveLength(1)
    const credentialId = listBody.Credentials[0].CredentialId

    await handleMockRequest(
      cognitoRequest('DeleteWebAuthnCredential', {
        AccessToken: MOCK_ID_TOKEN,
        CredentialId: credentialId,
      }),
    )

    const listAfter = await handleMockRequest(
      cognitoRequest('ListWebAuthnCredentials', { AccessToken: MOCK_ID_TOKEN }),
    )
    const listAfterBody = await listAfter?.json()
    expect(listAfterBody.Credentials).toHaveLength(0)
  })

  it('accepts any code in RespondToAuthChallenge and returns tokens', async () => {
    const res = await handleMockRequest(
      cognitoRequest('RespondToAuthChallenge', {
        ChallengeResponses: { EMAIL_OTP_CODE: 'whatever' },
      }),
    )
    const body = await res?.json()
    expect(body.AuthenticationResult.IdToken).toBe(MOCK_ID_TOKEN)
    expect(body.AuthenticationResult.RefreshToken).toBeTruthy()
    expect(body.AuthenticationResult.ExpiresIn).toBeGreaterThan(0)
  })

  it('answers a token refresh without rotating the refresh token', async () => {
    const res = await handleMockRequest(
      cognitoRequest('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH' }),
    )
    const body = await res?.json()
    expect(body.AuthenticationResult.IdToken).toBe(MOCK_ID_TOKEN)
    expect(body.AuthenticationResult.RefreshToken).toBeUndefined()
  })

  it('confirms sign-up for any email', async () => {
    const res = await handleMockRequest(
      cognitoRequest('SignUp', { Username: 'anyone@example.com' }),
    )
    const body = await res?.json()
    expect(body.UserConfirmed).toBe(true)
  })

  it('completes the new-user flow: ConfirmSignUp then a Session-carrying InitiateAuth signs straight in', async () => {
    const confirmRes = await handleMockRequest(
      cognitoRequest('ConfirmSignUp', {
        Username: 'anyone@example.com',
        ConfirmationCode: '12345678',
      }),
    )
    const confirmBody = await confirmRes?.json()
    expect(confirmBody.Session).toBeTruthy()

    const signInRes = await handleMockRequest(
      cognitoRequest('InitiateAuth', {
        AuthFlow: 'USER_AUTH',
        Session: confirmBody.Session,
        AuthParameters: { USERNAME: 'anyone@example.com' },
      }),
    )
    const signInBody = await signInRes?.json()
    expect(signInBody.ChallengeName).toBeUndefined()
    expect(signInBody.AuthenticationResult.IdToken).toBe(MOCK_ID_TOKEN)
  })
})

describe('profile API handlers', () => {
  it('serves runtime config', async () => {
    const res = await handleMockRequest(request('/config.json'))
    const config = await res?.json()
    expect(config.apiBase).toBe('')
    expect(config.userPoolId).toBeTruthy()
  })

  it('serves empty RUM identifiers so RUM never initializes in mock mode', async () => {
    const res = await handleMockRequest(request('/config.json'))
    const config = await res?.json()
    expect(config.rumAppMonitorId).toBe('')
    expect(config.rumIdentityPoolId).toBe('')
  })

  it('rejects authenticated routes without the mock token', async () => {
    const me = await handleMockRequest(request('/api/profile/me'))
    expect(me?.status).toBe(401)

    const put = await handleMockRequest(
      request('/api/profile', { method: 'PUT', body: '{}' }),
    )
    expect(put?.status).toBe(401)
  })

  it('returns the seeded profile from /me', async () => {
    const res = await handleMockRequest(
      request('/api/profile/me', { headers: AUTH_HEADER }),
    )
    expect(res?.status).toBe(200)
    const profile = await res?.json()
    expect(profile.id).toBeTruthy()
    expect(profile.display_name).toBe('Ada Lovelace')
  })

  it('updates the profile on PUT, preserving id and image', async () => {
    const imageRes = await handleMockRequest(
      request('/api/profile/image', {
        method: 'POST',
        headers: AUTH_HEADER,
        body: JSON.stringify({ image_data: 'aGk=', content_type: 'image/jpeg' }),
      }),
    )
    expect(imageRes?.status).toBe(200)

    const before = await (
      await handleMockRequest(request('/api/profile/me', { headers: AUTH_HEADER }))
    )?.json()

    const res = await handleMockRequest(
      request('/api/profile', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({
          email: 'ada@example.com',
          display_name: 'Ada King',
          theme: 'dark',
          display_email: false,
          links: [],
        }),
      }),
    )
    const saved = await res?.json()
    expect(saved.id).toBe(before.id)
    expect(saved.display_name).toBe('Ada King')
    expect(saved.image_url).toBe('data:image/jpeg;base64,aGk=')
  })

  it('preserves a previously-set slug across an unrelated PUT /api/profile save', async () => {
    await handleMockRequest(
      request('/api/profile/slug', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({ slug: 'ada-lovelace' }),
      }),
    )

    const res = await handleMockRequest(
      request('/api/profile', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({
          email: 'ada@example.com',
          display_name: 'Ada King',
          theme: 'dark',
          display_email: false,
          links: [],
        }),
      }),
    )
    const saved = await res?.json()
    expect(saved.slug).toBe('ada-lovelace')

    const me = await (
      await handleMockRequest(request('/api/profile/me', { headers: AUTH_HEADER }))
    )?.json()
    expect(me.slug).toBe('ada-lovelace')
  })

  it('serves the public card by id without auth and 404s unknown ids', async () => {
    const me = await (
      await handleMockRequest(request('/api/profile/me', { headers: AUTH_HEADER }))
    )?.json()

    const found = await handleMockRequest(request(`/api/profile/${me.id}`))
    expect(found?.status).toBe(200)

    const missing = await handleMockRequest(request('/api/profile/nope'))
    expect(missing?.status).toBe(404)
  })

  it('sets a custom slug via PUT /api/profile/slug and serves it via @-prefixed lookup', async () => {
    const res = await handleMockRequest(
      request('/api/profile/slug', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({ slug: 'ada-lovelace' }),
      }),
    )
    expect(res?.status).toBe(200)
    const saved = await res?.json()
    expect(saved.slug).toBe('ada-lovelace')

    const found = await handleMockRequest(request('/api/profile/@ada-lovelace'))
    expect(found?.status).toBe(200)
    const profile = await found?.json()
    expect(profile.display_name).toBe('Ada Lovelace')

    const missing = await handleMockRequest(request('/api/profile/@nope'))
    expect(missing?.status).toBe(404)
  })

  it('clears the slug via PUT /api/profile/slug with a null value', async () => {
    await handleMockRequest(
      request('/api/profile/slug', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({ slug: 'ada-lovelace' }),
      }),
    )

    const res = await handleMockRequest(
      request('/api/profile/slug', {
        method: 'PUT',
        headers: AUTH_HEADER,
        body: JSON.stringify({ slug: null }),
      }),
    )
    const saved = await res?.json()
    expect(saved.slug).toBeUndefined()
  })

  it('deletes the profile and then 404s /me', async () => {
    const del = await handleMockRequest(
      request('/api/profile', { method: 'DELETE', headers: AUTH_HEADER, body: '{}' }),
    )
    expect(del?.status).toBe(204)

    const me = await handleMockRequest(
      request('/api/profile/me', { headers: AUTH_HEADER }),
    )
    expect(me?.status).toBe(404)
  })

  it('persists the store in localStorage', () => {
    expect(localStorage.getItem(MOCK_STORE_KEY)).toContain('Ada Lovelace')
  })

  it('passes through requests the mocks do not own', async () => {
    expect(await handleMockRequest(request('/some-asset.svg'))).toBeNull()
    expect(
      await handleMockRequest(new Request('https://example.com/api/profile/me')),
    ).toBeNull()
  })
})
