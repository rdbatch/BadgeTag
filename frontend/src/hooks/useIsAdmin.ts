import { useEffect, useState } from 'react'
import { getRuntimeConfig } from '../config/runtimeConfig'

/**
 * Module-level cache of the admin decision, keyed by ID token so a
 * sign-out/sign-in as a different user re-fetches rather than reusing a
 * stale verdict. The flag comes from `GET /api/profile/me`'s `is_admin`
 * field, computed server-side against the `ADMIN_EMAILS` allowlist — the
 * frontend never holds the allowlist itself.
 */
let cache: { token: string; isAdmin: boolean } | null = null

/** Test-only: clears the cached admin decision. */
export function __resetIsAdminCacheForTests(): void {
  cache = null
}

export interface UseIsAdminResult {
  /** True once confirmed admin; false if confirmed non-admin. */
  isAdmin: boolean
  /** True until the first `/me` response resolves. */
  isLoading: boolean
}

/**
 * Resolves whether the current session's user is an admin by reading the
 * `is_admin` flag from `GET /api/profile/me`. Used to gate the admin menu
 * item and the `/admin` route. A missing session resolves to non-admin
 * immediately. Any fetch failure (including the 404 a brand-new user with
 * no profile gets) resolves to non-admin, failing closed.
 */
export function useIsAdmin(idToken: string | undefined): UseIsAdminResult {
  const [isAdmin, setIsAdmin] = useState<boolean>(
    () => (idToken && cache?.token === idToken ? cache.isAdmin : false),
  )
  const [isLoading, setIsLoading] = useState<boolean>(
    () => !(idToken && cache?.token === idToken),
  )

  useEffect(() => {
    if (!idToken) {
      setIsAdmin(false)
      setIsLoading(false)
      return
    }

    if (cache?.token === idToken) {
      setIsAdmin(cache.isAdmin)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    async function check(token: string) {
      try {
        const res = await fetch(`${getRuntimeConfig().apiBase}/api/profile/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const admin = res.ok ? Boolean((await res.json()).is_admin) : false
        cache = { token, isAdmin: admin }
        if (!cancelled) setIsAdmin(admin)
      } catch {
        // Fail closed — treat any error as non-admin.
        cache = { token, isAdmin: false }
        if (!cancelled) setIsAdmin(false)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void check(idToken)

    return () => {
      cancelled = true
    }
  }, [idToken])

  return { isAdmin, isLoading }
}
