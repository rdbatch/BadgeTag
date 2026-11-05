import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIsAdmin, __resetIsAdminCacheForTests } from './useIsAdmin'

function meResponse(isAdmin: boolean) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: 'self', email: 'x@example.com', is_admin: isAdmin }),
  }
}

describe('useIsAdmin', () => {
  beforeEach(() => {
    __resetIsAdminCacheForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves to non-admin immediately with no token', () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const { result } = renderHook(() => useIsAdmin(undefined))
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the is_admin flag from /me', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(meResponse(true))
    const { result } = renderHook(() => useIsAdmin('tok'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isAdmin).toBe(true)
  })

  it('treats a confirmed non-admin as not admin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(meResponse(false))
    const { result } = renderHook(() => useIsAdmin('tok'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isAdmin).toBe(false)
  })

  it('fails closed to non-admin when /me errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useIsAdmin('tok'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isAdmin).toBe(false)
  })

  it('fails closed when /me returns 404 (no profile yet)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ message: 'Not found' }),
    })
    const { result } = renderHook(() => useIsAdmin('tok'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isAdmin).toBe(false)
  })

  it('serves the cached verdict for the same token without re-fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(meResponse(true))
    globalThis.fetch = fetchMock

    const first = renderHook(() => useIsAdmin('tok'))
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = renderHook(() => useIsAdmin('tok'))
    expect(second.result.current.isAdmin).toBe(true)
    expect(second.result.current.isLoading).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches when the token changes (different user signs in)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(meResponse(true))
      .mockResolvedValueOnce(meResponse(false))
    globalThis.fetch = fetchMock

    const { result, rerender } = renderHook(({ token }) => useIsAdmin(token), {
      initialProps: { token: 'tok-a' },
    })
    await waitFor(() => expect(result.current.isAdmin).toBe(true))

    rerender({ token: 'tok-b' })
    await waitFor(() => expect(result.current.isAdmin).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
