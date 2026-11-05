import { useCallback, useEffect, useState } from 'react'
import { getRuntimeConfig } from '../config/runtimeConfig'
import type { AdminUser } from '../types/profile'

/** The admin list in the API's wire format (snake_case). */
interface AdminUserWire {
  id: string
  email?: string
  slug?: string
  display_name?: string
  pronouns?: string
  image_url?: string
  view_count?: number
  created_at: string
}

function fromWire(u: AdminUserWire): AdminUser {
  return {
    id: u.id,
    email: u.email,
    slug: u.slug,
    displayName: u.display_name,
    pronouns: u.pronouns,
    imageUrl: u.image_url,
    viewCount: u.view_count,
    createdAt: u.created_at,
  }
}

/**
 * Module-level cache of the last successful admin-user scan. The admin page
 * scans the whole table server-side, so this avoids re-running that scan on
 * every mount/navigation — the list is fetched once and reused, with an
 * explicit refresh (see `refresh` below) the only thing that re-runs it.
 * Lives at module scope (not in the hook) so it survives unmount/remount
 * within a session; a full reload clears it, which is fine.
 */
let cachedUsers: AdminUser[] | null = null

/** Test-only: drops the module cache so each test starts clean. */
export function __resetAdminUsersCacheForTests(): void {
  cachedUsers = null
}

export interface UseAdminUsersResult {
  /** The loaded users, or null until the first successful load. */
  users: AdminUser[] | null
  /** True while a fetch is in flight. */
  isLoading: boolean
  /** A user-facing error message from the last failed fetch, or null. */
  error: string | null
  /** Re-runs the scan, bypassing the cache, and updates it on success. */
  refresh: () => void
}

/**
 * Loads the admin "all profiles" list from `GET /api/profile/admin/users`,
 * caching the result at module scope so navigating away and back doesn't
 * re-scan. On first mount it serves the cache if present and otherwise
 * fetches once; `refresh()` forces a re-fetch on demand.
 *
 * `idToken` is the caller's Cognito ID token (the admin's) — the endpoint
 * is admin-gated server-side, so a non-admin token yields a 403 surfaced
 * here as an error. Passing `undefined` (no session) skips the fetch.
 */
export function useAdminUsers(idToken: string | undefined): UseAdminUsersResult {
  const [users, setUsers] = useState<AdminUser[] | null>(cachedUsers)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (force: boolean) => {
      if (!idToken) return
      if (!force && cachedUsers) {
        setUsers(cachedUsers)
        return
      }

      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(`${getRuntimeConfig().apiBase}/api/profile/admin/users`, {
          headers: { Authorization: `Bearer ${idToken}` },
        })
        if (res.status === 403) {
          throw new Error('You do not have access to this page.')
        }
        if (!res.ok) {
          throw new Error(`Failed to load users: ${res.status}`)
        }
        const data = (await res.json()) as AdminUserWire[]
        const mapped = data.map(fromWire)
        cachedUsers = mapped
        setUsers(mapped)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load users')
      } finally {
        setIsLoading(false)
      }
    },
    [idToken],
  )

  // Initial load: serve the cache if we have one, otherwise fetch once.
  useEffect(() => {
    void load(false)
  }, [load])

  const refresh = useCallback(() => {
    void load(true)
  }, [load])

  return { users, isLoading, error, refresh }
}
