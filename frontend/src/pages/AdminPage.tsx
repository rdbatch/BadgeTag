import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../auth'
import { HeaderMenu } from '../components/HeaderMenu'
import { QRModal } from '../components/QRModal'
import { QRLabelModal } from '../components/QRLabelModal'
import { Print3DModal } from '../components/Print3DModal'
import { useAdminUsers } from '../hooks/useAdminUsers'
import { useIsAdmin } from '../hooks/useIsAdmin'
import type { AdminUser } from '../types/profile'

/**
 * Read-only admin view of every signed-up profile. Admin-only and
 * unlinked from the normal UI — reached via the `/admin` route, revealed
 * in menus only for admins, and gated here on the server-computed
 * `is_admin` flag (a non-admin is redirected to `/edit`). The data itself
 * is independently protected server-side (403 for non-admins), so this
 * guard is UX, not the security boundary.
 *
 * Each row can open the target profile's public card, QR code, 3MF
 * generator, or a printable QR label. The QR and 3MF modals are the exact
 * same components the owner's edit page uses, driven here by the listed
 * user's fields, so any future change to those generators shows up here
 * automatically. The QR Label is admin-only — a black-on-white image for a
 * thermal label printer, never exposed on the owner's edit page.
 *
 * Mobile-first: the layout is a stacked list of cards (not a wide table)
 * with wrapping action buttons, since the intended use is on a phone at a
 * conference.
 */
export function AdminPage() {
  const { session, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()

  const idToken = session?.idToken
  const { isAdmin, isLoading: isCheckingAdmin } = useIsAdmin(idToken)
  const { users, isLoading, error, refresh } = useAdminUsers(
    // Only fetch the list once we've confirmed admin — avoids a guaranteed
    // 403 for a non-admin who somehow reaches the route.
    isAdmin ? idToken : undefined,
  )

  const [query, setQuery] = useState('')
  const [qrUser, setQrUser] = useState<AdminUser | null>(null)
  const [labelUser, setLabelUser] = useState<AdminUser | null>(null)
  const [printUser, setPrintUser] = useState<AdminUser | null>(null)

  // Redirect anyone who isn't signed in, or who is confirmed non-admin,
  // back to the edit page. Waits for the admin check to resolve so a real
  // admin isn't bounced on the first render before `/me` responds.
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/', { replace: true })
      return
    }
    if (!isCheckingAdmin && !isAdmin) {
      navigate('/edit', { replace: true })
    }
  }, [isAuthenticated, isCheckingAdmin, isAdmin, navigate])

  const filtered = useMemo(() => {
    if (!users) return []
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => {
      const haystack = [u.email, u.displayName, u.slug]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [users, query])

  if (!isAuthenticated || !session) {
    return null
  }

  // Hold the page blank while the admin check is in flight, and after a
  // non-admin verdict (the effect above is navigating away) — avoids a
  // flash of the admin UI for a non-admin.
  if (isCheckingAdmin || !isAdmin) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading…</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8 text-gray-900">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <a
            href="/edit"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-opacity hover:opacity-80"
          >
            Edit Your Card
          </a>
          <HeaderMenu
            themeTextClass="text-gray-700"
            items={[
              { label: 'My Connections', onClick: () => navigate('/connections') },
              { label: 'About', onClick: () => navigate('/about') },
              { label: 'Sign Out', onClick: logout },
            ]}
          />
        </div>

        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-gray-900">All Profiles</h1>
          <button
            type="button"
            onClick={refresh}
            disabled={isLoading}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Search */}
        <label htmlFor="admin-search" className="sr-only">
          Search profiles
        </label>
        <input
          id="admin-search"
          type="search"
          inputMode="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or custom URL"
          className="mb-4 block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none"
        />

        {error && (
          <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {users === null && isLoading && (
          <p className="text-center text-sm text-gray-500">Loading profiles…</p>
        )}

        {users !== null && (
          <>
            <p className="mb-3 text-sm text-gray-500">
              {filtered.length} of {users.length}{' '}
              {users.length === 1 ? 'profile' : 'profiles'}
            </p>

            {filtered.length === 0 ? (
              <p className="text-center text-sm text-gray-500">
                {users.length === 0
                  ? 'No profiles yet.'
                  : 'No profiles match your search.'}
              </p>
            ) : (
              <ul className="space-y-3">
                {filtered.map((u) => (
                  <li
                    key={u.id}
                    className="rounded-lg border border-gray-200 bg-white p-4"
                  >
                    <div className="flex items-start gap-3">
                      {u.imageUrl ? (
                        <img
                          src={u.imageUrl}
                          alt=""
                          className="h-11 w-11 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-medium text-gray-500"
                        >
                          {(u.displayName ?? u.email ?? '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-gray-900">
                          {u.displayName || '(no name)'}
                        </p>
                        {u.email && (
                          <p className="truncate text-sm text-gray-600">{u.email}</p>
                        )}
                        <p className="truncate text-xs text-gray-400">
                          {u.slug ? `/@${u.slug}` : `/p/${u.id}`}
                        </p>
                      </div>
                    </div>

                    {/* Actions — wrap on narrow screens */}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={u.slug ? `/@${u.slug}` : `/p/${u.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        Profile
                      </a>
                      <button
                        type="button"
                        onClick={() => setQrUser(u)}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        QR Code
                      </button>
                      <button
                        type="button"
                        onClick={() => setLabelUser(u)}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        QR Label
                      </button>
                      <button
                        type="button"
                        onClick={() => setPrintUser(u)}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        3MF
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* The same QR/3MF modals the owner's edit page uses, driven by the
          selected profile's fields — reuse with no duplication. */}
      {qrUser && (
        <QRModal
          profileId={qrUser.id}
          isOpen={true}
          onClose={() => setQrUser(null)}
          imageUrl={qrUser.imageUrl}
          slug={qrUser.slug}
        />
      )}
      {labelUser && (
        <QRLabelModal
          profileId={labelUser.id}
          isOpen={true}
          onClose={() => setLabelUser(null)}
          displayName={labelUser.displayName}
          pronouns={labelUser.pronouns}
          slug={labelUser.slug}
        />
      )}
      {printUser && (
        <Print3DModal
          profileId={printUser.id}
          isOpen={true}
          onClose={() => setPrintUser(null)}
          displayName={printUser.displayName}
          pronouns={printUser.pronouns}
          slug={printUser.slug}
        />
      )}
    </main>
  )
}
