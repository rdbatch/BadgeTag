/**
 * Request handlers for local mock mode (`npm run dev:mock`).
 *
 * Everything the app talks to over the network — Cognito auth and the
 * profile API — is answered here from a localStorage-backed store, so the
 * frontend runs with no AWS resources at all. The real code paths are
 * untouched: the AWS SDK and the pages' fetch calls run as normal and are
 * intercepted at the fetch boundary (see install.ts).
 *
 * This module is only ever loaded via the dev-gated dynamic import in
 * main.tsx, so none of it exists in production bundles.
 */

/** localStorage key; edits survive reloads so local testing feels real. */
export const MOCK_STORE_KEY = 'badgetag-mock-store'

export const MOCK_ID_TOKEN = 'mock-id-token'
const MOCK_ACCESS_TOKEN = 'mock-access-token'
const MOCK_REFRESH_TOKEN = 'mock-refresh-token'
const MOCK_PROFILE_ID = 'mockprofile01'

/** Profile in the API's wire format (snake_case), as the pages consume it. */
interface StoredProfile {
  id: string
  email: string
  slug?: string
  display_name?: string
  tagline?: string
  phone?: string
  location?: string
  pronouns?: string
  image_url?: string
  theme: string
  custom_theme?: { bg: string; text: string; text_muted: string; accent: string }
  view_count?: number
  display_email: boolean
  links: Array<{ platform: string; url: string; label?: string }>
}

/** Connection in the API's wire format (snake_case), as the pages consume it. */
interface StoredConnection {
  id: string
  name: string
  notes?: string
  event?: string
  photo_url?: string
  source_profile_id?: string
  created_at: string
}

/** A registered passkey in the mock store's simplified shape. */
interface StoredPasskey {
  credentialId: string
  friendlyName: string
  createdAt: string
  authenticatorAttachment: string
}

interface MockStore {
  profile: StoredProfile | null
  connections: StoredConnection[]
  passkeys: StoredPasskey[]
  /**
   * Emails that have completed ConfirmSignUp — lets SignUp correctly
   * distinguish a brand-new address (mode: 'new') from a returning one
   * (mode: 'existing'), the same way real Cognito's UsernameExistsException
   * does. Without this, every SignUp call would unconditionally succeed and
   * the app could never exercise its 'existing' sign-in path (email OTP or
   * passkey) against this mock — only ever the first-time signup flow.
   */
  confirmedEmails: string[]
}

function readStore(): MockStore {
  try {
    const raw = localStorage.getItem(MOCK_STORE_KEY)
    if (raw) {
      // Defensive against a store written before `connections`/`passkeys`/
      // `confirmedEmails` existed.
      const parsed = JSON.parse(raw) as Partial<MockStore>
      return {
        profile: parsed.profile ?? null,
        connections: parsed.connections ?? [],
        passkeys: parsed.passkeys ?? [],
        confirmedEmails: parsed.confirmedEmails ?? [],
      }
    }
  } catch {
    // Corrupt store — fall through to a fresh one.
  }
  return { profile: null, connections: [], passkeys: [], confirmedEmails: [] }
}

function writeStore(store: MockStore): void {
  localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(store))
}

/**
 * Seeds a demo profile on first run so the edit page and public card have
 * data to show immediately. Never overwrites existing local edits.
 */
export function seedDemoProfile(): void {
  const store = readStore()
  if (store.profile) return
  writeStore({
    profile: {
      id: MOCK_PROFILE_ID,
      email: 'ada@example.com',
      display_name: 'Ada Lovelace',
      tagline: 'Analytical Engine Programmer',
      phone: '+1 (555) 010-1842',
      theme: 'ocean',
      display_email: true,
      links: [
        { platform: 'github', url: 'https://github.com/adalovelace' },
        { platform: 'website', url: 'https://example.com' },
      ],
    },
    connections: [],
    passkeys: [],
    // The seeded profile represents a pre-existing account, so its email
    // starts out already confirmed (a returning user), not brand new.
    confirmedEmails: ['ada@example.com'],
  })
}

function isEmailConfirmed(email: string | undefined): boolean {
  if (!email) return false
  return readStore().confirmedEmails.includes(email.toLowerCase())
}

function confirmEmail(email: string | undefined): void {
  if (!email) return
  const store = readStore()
  const normalized = email.toLowerCase()
  if (store.confirmedEmails.includes(normalized)) return
  writeStore({ ...store, confirmedEmails: [...store.confirmedEmails, normalized] })
}

function hasMockPasskey(): boolean {
  return readStore().passkeys.length > 0
}

function getMockPasskeys(): StoredPasskey[] {
  return readStore().passkeys
}

function addMockPasskey(): void {
  const store = readStore()
  const passkey: StoredPasskey = {
    credentialId: crypto.randomUUID(),
    // Mirrors Cognito's own auto-naming convention for FriendlyCredentialName.
    friendlyName: `Device #${store.passkeys.length + 1}`,
    createdAt: new Date().toISOString(),
    authenticatorAttachment: 'platform',
  }
  writeStore({ ...store, passkeys: [...store.passkeys, passkey] })
}

function removeMockPasskey(credentialId: string | undefined): void {
  if (!credentialId) return
  const store = readStore()
  writeStore({
    ...store,
    passkeys: store.passkeys.filter((p) => p.credentialId !== credentialId),
  })
}

/** Minimal, inert CredentialCreationOptions/CredentialRequestOptions JSON —
 * real field values don't matter here since navigator.credentials.create()/
 * get() are stubbed under mock mode (see mocks/webauthn.ts) and never
 * actually read them. */
function mockCredentialCreationOptions() {
  return {
    challenge: 'bW9jay1jaGFsbGVuZ2U',
    rp: { id: 'localhost', name: 'BadgeTag (mock)' },
    user: { id: 'bW9jay11c2Vy', name: 'mock@example.com', displayName: 'Mock User' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }
}

function mockCredentialRequestOptions() {
  return {
    challenge: 'bW9jay1jaGFsbGVuZ2U',
    rpId: 'localhost',
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Cognito's JSON protocol; the SDK requires this content type to parse. */
function cognitoJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/x-amz-json-1.1' },
  })
}

const authenticationResult = {
  IdToken: MOCK_ID_TOKEN,
  AccessToken: MOCK_ACCESS_TOKEN,
  RefreshToken: MOCK_REFRESH_TOKEN,
  ExpiresIn: 3600,
  TokenType: 'Bearer',
}

/**
 * Answers the Cognito calls made by src/auth/service.ts. Any email signs
 * up, and any verification code passes the OTP/confirmation challenge. A
 * mock account is treated as "has a passkey" once one has been registered
 * via the ManagePasskeysModal flow (see addMockPasskey) — real Cognito
 * scopes this per-account, but since this mock has only one demo
 * account/store, "has any mock passkey registered" stands in for that.
 */
async function handleCognito(request: Request): Promise<Response> {
  const target = request.headers.get('x-amz-target') ?? ''
  const body = (await request.json().catch(() => ({}))) as {
    AuthFlow?: string
    Session?: string
    ChallengeName?: string
    ChallengeResponses?: Record<string, string>
    AccessToken?: string
    CredentialId?: string
    Username?: string
  }

  if (target.endsWith('.SignUp')) {
    if (isEmailConfirmed(body.Username)) {
      // Mirrors real Cognito: signing up an already-confirmed email fails
      // with UsernameExistsException, which service.ts's signUpUser()
      // catches to fall into the 'existing' sign-in path instead.
      return json({ __type: 'UsernameExistsException', message: 'User already exists' }, 400)
    }
    return cognitoJson({ UserConfirmed: true, UserSub: 'mock-user-sub' })
  }
  if (target.endsWith('.ConfirmSignUp')) {
    confirmEmail(body.Username)
    // service.ts's 'new' mode (see AuthMode) immediately follows this with
    // an InitiateAuth carrying this Session, expecting a completed sign-in
    // rather than another challenge — matched by the `body.Session` branch
    // below.
    return cognitoJson({ Session: 'mock-confirm-session' })
  }
  if (target.endsWith('.InitiateAuth')) {
    if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      // Like real Cognito, a refresh does not return a new RefreshToken.
      const { RefreshToken: _omitted, ...rest } = authenticationResult
      return cognitoJson({ AuthenticationResult: rest })
    }
    if (body.Session) {
      // Sign-in immediately following ConfirmSignUp ('new' mode) — Cognito
      // completes this in one step, no further challenge.
      return cognitoJson({ AuthenticationResult: authenticationResult })
    }
    // Real Cognito reports, per-account, which first factors are
    // available via SELECT_CHALLENGE/AvailableChallenges — mirrored here
    // via whether a mock passkey has been registered.
    return cognitoJson({
      ChallengeName: 'SELECT_CHALLENGE',
      Session: 'mock-select-challenge-session',
      AvailableChallenges: hasMockPasskey() ? ['EMAIL_OTP', 'WEB_AUTHN'] : ['EMAIL_OTP'],
    })
  }
  if (target.endsWith('.RespondToAuthChallenge')) {
    if (
      body.ChallengeName === 'SELECT_CHALLENGE' &&
      body.ChallengeResponses?.ANSWER === 'EMAIL_OTP'
    ) {
      return cognitoJson({ ChallengeName: 'EMAIL_OTP', Session: 'mock-challenge-session' })
    }
    if (
      body.ChallengeName === 'SELECT_CHALLENGE' &&
      body.ChallengeResponses?.ANSWER === 'WEB_AUTHN'
    ) {
      return cognitoJson({
        ChallengeName: 'WEB_AUTHN',
        Session: 'mock-webauthn-session',
        ChallengeParameters: {
          CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(mockCredentialRequestOptions()),
        },
      })
    }
    // EMAIL_OTP code submission, or a WEB_AUTHN assertion submission —
    // both complete sign-in in this mock (no real code/signature
    // checking, same as today's unconditional success).
    return cognitoJson({ AuthenticationResult: authenticationResult })
  }
  if (target.endsWith('.StartWebAuthnRegistration')) {
    return cognitoJson({ CredentialCreationOptions: mockCredentialCreationOptions() })
  }
  if (target.endsWith('.CompleteWebAuthnRegistration')) {
    addMockPasskey()
    return cognitoJson({})
  }
  if (target.endsWith('.ListWebAuthnCredentials')) {
    return cognitoJson({
      Credentials: getMockPasskeys().map((p) => ({
        CredentialId: p.credentialId,
        FriendlyCredentialName: p.friendlyName,
        RelyingPartyId: 'localhost',
        AuthenticatorAttachment: p.authenticatorAttachment,
        AuthenticatorTransports: ['internal'],
        // The SDK's Smithy JSON protocol deserializes Date-typed fields
        // (like CreatedAt) as epoch-seconds numbers, not ISO strings — the
        // store keeps an ISO string for its own bookkeeping, converted
        // here to match what a real Cognito response would send over the
        // wire.
        CreatedAt: Math.floor(new Date(p.createdAt).getTime() / 1000),
      })),
    })
  }
  if (target.endsWith('.DeleteWebAuthnCredential')) {
    removeMockPasskey(body.CredentialId)
    return cognitoJson({})
  }
  return json({ __type: 'UnknownOperationException' }, 400)
}

function isAuthorized(request: Request): boolean {
  return request.headers.get('authorization') === `Bearer ${MOCK_ID_TOKEN}`
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const { pathname } = url
  const method = request.method.toUpperCase()
  const store = readStore()

  // Public card lookup — the only /api route without auth. Mirrors the real
  // backend's best-effort view counter on every public fetch. The requested
  // segment may be a raw ID or an `@`-prefixed slug (see
  // ProfileStore::resolve_profile_id on the real backend).
  const publicMatch = pathname.match(/^\/api\/profile\/([^/]+)$/)
  if (method === 'GET' && publicMatch && publicMatch[1] !== 'me') {
    const requested = publicMatch[1]
    const existing = store.profile
    const matchesProfile =
      existing !== null &&
      (requested === existing.id ||
        (requested.startsWith('@') && requested.slice(1) === existing.slug))
    if (matchesProfile && existing) {
      const viewed = { ...existing, view_count: (existing.view_count ?? 0) + 1 }
      writeStore({ ...store, profile: viewed })
      return json(viewed)
    }
    return json({ message: 'Not found' }, 404)
  }

  if (!isAuthorized(request)) {
    return json({ message: 'Unauthorized' }, 401)
  }

  if (method === 'GET' && pathname === '/api/profile/me') {
    return store.profile ? json(store.profile) : json({ message: 'Not found' }, 404)
  }

  if (method === 'PUT' && pathname === '/api/profile') {
    const body = (await request.json()) as Omit<StoredProfile, 'id' | 'image_url' | 'slug'>
    const profile: StoredProfile = {
      ...body,
      // Preserve the server-assigned/separately-managed bits the PUT body
      // doesn't carry — slug is set via its own endpoint (PUT
      // /api/profile/slug), never part of this request.
      id: store.profile?.id ?? MOCK_PROFILE_ID,
      image_url: store.profile?.image_url,
      slug: store.profile?.slug,
    }
    writeStore({ ...store, profile })
    return json(profile)
  }

  if (method === 'PUT' && pathname === '/api/profile/slug') {
    const existing = store.profile
    if (!existing) return json({ message: 'Not found' }, 404)
    const body = (await request.json()) as { slug?: string | null }
    const profile: StoredProfile = { ...existing, slug: body.slug ?? undefined }
    writeStore({ ...store, profile })
    return json(profile)
  }

  if (method === 'POST' && pathname === '/api/profile/image') {
    if (!store.profile) return json({ message: 'Not found' }, 404)
    const body = (await request.json()) as {
      image_data: string
      content_type: string
    }
    const imageUrl = `data:${body.content_type};base64,${body.image_data}`
    writeStore({ ...store, profile: { ...store.profile, image_url: imageUrl } })
    return json({ image_url: imageUrl })
  }

  if (method === 'DELETE' && pathname === '/api/profile') {
    writeStore({ ...store, profile: null })
    return new Response(null, { status: 204 })
  }

  if (method === 'GET' && pathname === '/api/connections') {
    return json(store.connections)
  }

  if (method === 'POST' && pathname === '/api/connections') {
    const body = (await request.json()) as {
      name: string
      notes?: string
      event?: string
      photo_url?: string
      source_profile_id?: string
    }
    const connection: StoredConnection = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      name: body.name,
      notes: body.notes,
      event: body.event,
      photo_url: body.photo_url,
      source_profile_id: body.source_profile_id,
      created_at: new Date().toISOString(),
    }
    writeStore({ ...store, connections: [connection, ...store.connections] })
    return json(connection)
  }

  const connectionDeleteMatch = pathname.match(/^\/api\/connections\/([^/]+)$/)
  if (method === 'DELETE' && connectionDeleteMatch) {
    const id = connectionDeleteMatch[1]
    writeStore({ ...store, connections: store.connections.filter((c) => c.id !== id) })
    return new Response(null, { status: 204 })
  }

  return json({ message: 'Not found' }, 404)
}

/**
 * Routes a request to the matching mock handler, or returns null for
 * anything the mocks don't own (Vite dev-server traffic, etc.) so the
 * caller can pass it through to the real fetch.
 */
export async function handleMockRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url, window.location.origin)

  if (url.hostname.includes('cognito-idp')) {
    return handleCognito(request)
  }

  if (url.origin === window.location.origin) {
    // Serve config the app would normally get from the deploy process.
    if (url.pathname === '/config.json') {
      return json({
        region: 'local',
        userPoolId: 'local_mock',
        userPoolClientId: 'local-mock-client',
        apiBase: '',
        // Deliberately empty — RUM must never initialize in mock mode (see
        // monitoring/rum.ts's double gate), so there's no mock app monitor
        // id to serve here.
        rumAppMonitorId: '',
        rumIdentityPoolId: '',
      })
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url)
    }
  }

  return null
}
