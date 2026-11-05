import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminUsers, __resetAdminUsersCacheForTests } from './useAdminUsers'

const WIRE_USERS = [
  {
    id: 'p1',
    email: 'grace@example.com',
    slug: 'grace',
    display_name: 'Grace Hopper',
    pronouns: 'she/her',
    image_url: '/images/p1',
    view_count: 7,
    created_at: '2026-01-01T00:00:00Z',
  },
]

describe('useAdminUsers', () => {
  beforeEach(() => {
    __resetAdminUsersCacheForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fetch when no token is provided', () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const { result } = renderHook(() => useAdminUsers(undefined))
    expect(result.current.users).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches and maps snake_case wire fields to camelCase', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(WIRE_USERS),
    })

    const { result } = renderHook(() => useAdminUsers('tok'))

    await waitFor(() => expect(result.current.users).not.toBeNull())
    expect(result.current.users).toEqual([
      {
        id: 'p1',
        email: 'grace@example.com',
        slug: 'grace',
        displayName: 'Grace Hopper',
        pronouns: 'she/her',
        imageUrl: '/images/p1',
        viewCount: 7,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
  })

  it('reuses the module cache on remount without re-fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(WIRE_USERS),
    })
    globalThis.fetch = fetchMock

    const first = renderHook(() => useAdminUsers('tok'))
    await waitFor(() => expect(first.result.current.users).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    first.unmount()
    const second = renderHook(() => useAdminUsers('tok'))
    // Cache served synchronously; no second fetch.
    expect(second.result.current.users).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refresh() bypasses the cache and re-fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(WIRE_USERS),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useAdminUsers('tok'))
    await waitFor(() => expect(result.current.users).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.refresh()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('surfaces a 403 as an access error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    })

    const { result } = renderHook(() => useAdminUsers('tok'))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toMatch(/do not have access/i)
    expect(result.current.users).toBeNull()
  })
})
