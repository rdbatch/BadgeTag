import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { AuthProvider } from '../auth'
import { AdminPage } from './AdminPage'
import { __resetAdminUsersCacheForTests } from '../hooks/useAdminUsers'
import { __resetIsAdminCacheForTests } from '../hooks/useIsAdmin'

// The QR Label modal draws to a canvas on open; jsdom has no canvas backend,
// so stub the drawing (the lib itself is covered in qrLabel.test.ts).
vi.mock('../lib/qrLabel', async () => {
  const actual = await vi.importActual<typeof import('../lib/qrLabel')>('../lib/qrLabel')
  return { ...actual, drawQrLabel: vi.fn(), renderQrLabel: vi.fn() }
})

const SESSION_KEY = 'badgetag-auth-session'

function seedSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      idToken: 'test-id-token',
      accessToken: 'test-access-token',
      email: 'admin@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
  )
}

const SAMPLE_USERS = [
  {
    id: 'p1',
    email: 'grace@example.com',
    slug: 'grace',
    display_name: 'Grace Hopper',
    pronouns: 'she/her',
    view_count: 128,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p2',
    email: 'alan@example.com',
    display_name: 'Alan Turing',
    view_count: 342,
    created_at: '2026-01-02T00:00:00Z',
  },
]

/**
 * Builds a fetch mock that answers /api/profile/me (admin flag) and
 * /api/profile/admin/users. `isAdmin` controls the /me flag; `users` is
 * returned from the list endpoint, or a 403 when `listStatus` is 403.
 */
function mockFetch(opts: {
  isAdmin: boolean
  users?: typeof SAMPLE_USERS
  listStatus?: number
}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/api/profile/me')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'self', email: 'admin@example.com', is_admin: opts.isAdmin }),
      })
    }
    if (url.endsWith('/api/profile/admin/users')) {
      const status = opts.listStatus ?? 200
      return Promise.resolve({
        ok: status === 200,
        status,
        json: () => Promise.resolve(status === 200 ? (opts.users ?? SAMPLE_USERS) : { error: 'Forbidden' }),
      })
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  })
}

function renderAdminPage() {
  const router = createMemoryRouter(
    [
      { path: '/admin', element: <AdminPage /> },
      { path: '/', element: <div>Landing page</div> },
      { path: '/edit', element: <div>Edit page</div> },
    ],
    { initialEntries: ['/admin'] },
  )
  return render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  )
}

describe('AdminPage', () => {
  beforeEach(() => {
    __resetAdminUsersCacheForTests()
    __resetIsAdminCacheForTests()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('redirects to the landing page when not authenticated', async () => {
    renderAdminPage()
    await waitFor(() => {
      expect(screen.getByText('Landing page')).toBeInTheDocument()
    })
  })

  it('redirects a confirmed non-admin to the edit page', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: false })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Edit page')).toBeInTheDocument()
    })
  })

  it('renders the profile list for an admin', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: true })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })
    expect(screen.getByText('Alan Turing')).toBeInTheDocument()
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
    // Each row carries Profile / QR Code / QR Label / 3MF controls.
    expect(screen.getAllByRole('button', { name: 'QR Code' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'QR Label' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '3MF' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'Profile' })).toHaveLength(2)
  })

  it('filters the list client-side by the search query', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: true })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Search profiles'), {
      target: { value: 'alan' },
    })

    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument()
    expect(screen.getByText('Alan Turing')).toBeInTheDocument()
  })

  it('points the Profile link at the vanity slug when present, else /p/{id}', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: true })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })

    const graceRow = screen.getByText('Grace Hopper').closest('li')!
    expect(within(graceRow).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/@grace',
    )

    const alanRow = screen.getByText('Alan Turing').closest('li')!
    expect(within(alanRow).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/p/p2',
    )
  })

  it('opens the QR modal for a row', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: true })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })

    const graceRow = screen.getByText('Grace Hopper').closest('li')!
    fireEvent.click(within(graceRow).getByRole('button', { name: 'QR Code' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Your QR Code')).toBeInTheDocument()
  })

  it('opens the QR label modal for a row', async () => {
    seedSession()
    globalThis.fetch = mockFetch({ isAdmin: true })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })

    const graceRow = screen.getByText('Grace Hopper').closest('li')!
    fireEvent.click(within(graceRow).getByRole('button', { name: 'QR Label' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'QR Label' })).toBeInTheDocument()
  })

  it('re-runs the scan when Refresh is clicked', async () => {
    seedSession()
    const fetchMock = mockFetch({ isAdmin: true })
    globalThis.fetch = fetchMock

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    })

    const listCallsBefore = fetchMock.mock.calls.filter(([url]: [string]) =>
      url.endsWith('/api/profile/admin/users'),
    ).length

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      const listCallsAfter = fetchMock.mock.calls.filter(([url]: [string]) =>
        url.endsWith('/api/profile/admin/users'),
      ).length
      expect(listCallsAfter).toBe(listCallsBefore + 1)
    })
  })

  it('surfaces a 403 from the list endpoint as an error', async () => {
    seedSession()
    // Admin per /me, but the list endpoint rejects — surfaces as an error
    // rather than silently showing an empty list.
    globalThis.fetch = mockFetch({ isAdmin: true, listStatus: 403 })

    renderAdminPage()

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/do not have access/i)
    })
  })
})
