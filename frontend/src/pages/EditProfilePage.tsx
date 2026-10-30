import { useState, useRef, useEffect, useCallback, type FormEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../auth'
import {
  themes,
  getCustomThemeStyle,
  themeBgColors,
  getCachedProfileTheme,
  setCachedProfileTheme,
} from '../constants/themes'
import { getPlatformIcon, getPlatformLabel, getPlatformPlaceholder } from '../constants/socialPlatforms'
import { QRModal } from '../components/QRModal'
import { Print3DModal } from '../components/Print3DModal'
import { DownloadDropdown } from '../components/DownloadDropdown'
import { HeaderMenu } from '../components/HeaderMenu'
import { CustomThemeModal } from '../components/CustomThemeModal'
import { ManagePasskeysModal } from '../components/ManagePasskeysModal'
import { getRuntimeConfig } from '../config/runtimeConfig'
import { parseVCard } from '../lib/vcardImport'
import { DEFAULT_CUSTOM_THEME_COLORS, type CustomThemeColors, type SocialLink, type SocialPlatform, type ThemeId } from '../types/profile'

const SOCIAL_PLATFORMS: SocialPlatform[] = [
  'custom', 'linkedin', 'github', 'instagram', 'youtube',
  'mastodon', 'bluesky', 'website', 'calendar', 'twitter',
  'discord', 'twitch', 'awsbuilder',
]

export function EditProfilePage() {
  const { session, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/', { replace: true })
    }
  }, [isAuthenticated, navigate])

  const [displayName, setDisplayName] = useState('')
  const [slug, setSlug] = useState('')
  // What the server currently has on file — lets handleSave skip the slug
  // endpoint entirely when the field wasn't touched.
  const [initialSlug, setInitialSlug] = useState('')
  // True after a 409 from the slug endpoint — highlights the field red
  // until the user edits it again.
  const [slugConflict, setSlugConflict] = useState(false)
  const [tagline, setTagline] = useState('')
  const [phone, setPhone] = useState('')
  const [location, setLocation] = useState('')
  const [pronouns, setPronouns] = useState('')
  const [links, setLinks] = useState<SocialLink[]>([])
  // Seeded from the last-known cached theme (rather than a hardcoded
  // 'light') so switching screens doesn't flash light before the profile
  // fetch below resolves.
  const [theme, setTheme] = useState<ThemeId>(() => getCachedProfileTheme()?.theme ?? 'light')
  const [customTheme, setCustomTheme] = useState<CustomThemeColors | undefined>(
    () => getCachedProfileTheme()?.customTheme,
  )
  const [showCustomThemeModal, setShowCustomThemeModal] = useState(false)
  const [displayEmail, setDisplayEmail] = useState(true)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [saveMessage, setSaveMessage] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteEmail, setDeleteEmail] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [showQRModal, setShowQRModal] = useState(false)
  const [showPrint3DModal, setShowPrint3DModal] = useState(false)
  const [showPasskeyModal, setShowPasskeyModal] = useState(false)
  const [profileId, setProfileId] = useState('')
  const [viewCount, setViewCount] = useState<number | null>(null)
  const [openPlatformIndex, setOpenPlatformIndex] = useState<number | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const vcardInputRef = useRef<HTMLInputElement>(null)
  const email = session?.email ?? ''

  // If a request comes back 401 despite the proactive token refresh (e.g.
  // the refresh token itself expired/was revoked), the session is no
  // longer usable — clear it and send the user back to sign in again
  // rather than showing a confusing save error.
  const handleUnauthorized = useCallback(() => {
    logout()
    navigate('/', { replace: true })
  }, [logout, navigate])

  // Load the caller's own profile (including its server-assigned id) via
  // the authenticated /me endpoint. The id is never computed client-side —
  // it's a random token assigned by the backend on first save and only
  // discoverable by the authenticated owner.
  useEffect(() => {
    if (!session?.idToken) return

    async function loadProfile() {
      try {
        const res = await fetch(`${getRuntimeConfig().apiBase}/api/profile/me`, {
          headers: {
            Authorization: `Bearer ${session?.idToken}`,
          },
        })
        if (res.status === 401) {
          handleUnauthorized()
          return
        }
        if (res.ok) {
          const data = await res.json()
          setProfileId(data.id)
          setViewCount(data.view_count ?? 0)
          setSlug(data.slug ?? '')
          setInitialSlug(data.slug ?? '')
          setDisplayName(data.display_name ?? '')
          setTagline(data.tagline ?? '')
          setPhone(data.phone ?? '')
          setLocation(data.location ?? '')
          setPronouns(data.pronouns ?? '')
          setLinks(data.links)
          setTheme(data.theme)
          const loadedCustomTheme = data.custom_theme
            ? {
                bg: data.custom_theme.bg,
                text: data.custom_theme.text,
                textMuted: data.custom_theme.text_muted,
                accent: data.custom_theme.accent,
              }
            : undefined
          setCustomTheme(loadedCustomTheme)
          setCachedProfileTheme(data.theme, loadedCustomTheme)
          setDisplayEmail(data.display_email ?? true)
          if (data.image_url) {
            setImagePreview(data.image_url)
          }
        }
        // 404 means the authenticated user has no profile yet — leave the
        // form blank; profileId stays '' until the first successful save.
      } catch {
        // New user, or a transient error — leave form blank.
      } finally {
        setIsLoading(false)
      }
    }

    loadProfile()
  }, [session?.idToken, handleUnauthorized])

  useEffect(() => {
    const color =
      theme === 'custom' ? (customTheme?.bg ?? '') : (themeBgColors[theme] ?? '')
    document.documentElement.style.backgroundColor = color
    return () => {
      document.documentElement.style.backgroundColor = ''
    }
  }, [theme, customTheme])

  useEffect(() => {
    if (openPlatformIndex === null) return
    function close() { setOpenPlatformIndex(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openPlatformIndex])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setIsSaving(true)
    setSaveMessage('')
    setSlugConflict(false)

    try {
      const body = {
        email,
        display_name: displayName || undefined,
        tagline: tagline || undefined,
        phone: phone || undefined,
        location: location || undefined,
        pronouns: pronouns || undefined,
        theme,
        custom_theme:
          theme === 'custom' && customTheme
            ? {
                bg: customTheme.bg,
                text: customTheme.text,
                text_muted: customTheme.textMuted,
                accent: customTheme.accent,
              }
            : undefined,
        display_email: displayEmail,
        links: links.map((link) => ({ ...link, url: normalizeLinkUrl(link.url, link.platform) })),
      }

      const res = await fetch(`${getRuntimeConfig().apiBase}/api/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.idToken}`,
        },
        body: JSON.stringify(body),
      })

      if (res.status === 401) {
        handleUnauthorized()
        return
      }

      if (!res.ok) {
        throw new Error(`Save failed: ${res.status}`)
      }

      // The backend assigns a random profile id on first save (there's no
      // client-side id to compute anymore) — capture it so the QR code and
      // preview link work immediately for a brand-new profile.
      const saved = await res.json()
      if (saved.id) {
        setProfileId(saved.id)
      }
      setCachedProfileTheme(theme, customTheme)

      // Update the custom URL slug if changed
      if (slug !== initialSlug) {
        const slugRes = await fetch(`${getRuntimeConfig().apiBase}/api/profile/slug`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.idToken}`,
          },
          body: JSON.stringify({ slug: slug || null }),
        })

        if (slugRes.status === 401) {
          handleUnauthorized()
          return
        }

        if (slugRes.status === 409) {
          setSlugConflict(true)
          throw new Error('That custom URL is already taken')
        }

        if (!slugRes.ok) {
          throw new Error(`Custom URL update failed: ${slugRes.status}`)
        }

        const slugSaved = await slugRes.json()
        setSlug(slugSaved.slug ?? '')
        setInitialSlug(slugSaved.slug ?? '')
      }

      // Upload image if changed
      if (imageFile) {
        const resizedData = await resizeImage(imageFile)
        const imageRes = await fetch(`${getRuntimeConfig().apiBase}/api/profile/image`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.idToken}`,
          },
          body: JSON.stringify({
            image_data: resizedData,
            content_type: 'image/jpeg',
          }),
        })

        if (imageRes.status === 401) {
          handleUnauthorized()
          return
        }

        if (!imageRes.ok) {
          throw new Error(`Image upload failed: ${imageRes.status}`)
        }
        setImageFile(null)
      }

      setSaveMessage('Saved successfully!')
      setTimeout(() => setSaveMessage(''), 3000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed'
      setSaveMessage(`Error: ${message}`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (deleteEmail.toLowerCase() !== email.toLowerCase()) return

    setIsDeleting(true)
    try {
      const res = await fetch(`${getRuntimeConfig().apiBase}/api/profile`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.idToken}`,
        },
        body: JSON.stringify({ email, access_token: session?.accessToken }),
      })

      if (res.status === 401) {
        handleUnauthorized()
        return
      }

      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed: ${res.status}`)
      }

      logout()
      navigate('/', { replace: true })
    } catch {
      setSaveMessage('Error: Failed to delete profile')
    } finally {
      setIsDeleting(false)
      setShowDeleteModal(false)
    }
  }

  function handleImageChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setImageFile(file)
    const reader = new FileReader()
    reader.onload = (ev) => {
      setImagePreview(ev.target?.result as string)
    }
    reader.readAsDataURL(file)
  }

  // Only fills fields that are still blank and appends links not already
  // present (by URL) — importing never overwrites what's already typed in.
  function handleVCardImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const parsed = parseVCard(text)

      if (parsed.displayName && !displayName) setDisplayName(parsed.displayName)
      if (parsed.tagline && !tagline) setTagline(parsed.tagline.slice(0, 120))
      if (parsed.phone && !phone) setPhone(parsed.phone)
      if (parsed.location && !location) setLocation(parsed.location)
      if (parsed.pronouns && !pronouns) setPronouns(parsed.pronouns)

      if (parsed.links.length > 0) {
        setLinks((prev) => {
          const existingUrls = new Set(prev.map((link) => link.url))
          const newLinks = parsed.links.filter((link) => !existingUrls.has(link.url))
          return [...prev, ...newLinks]
        })
      }

      setSaveMessage('Imported from vCard — review and Save to keep the changes.')
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function addLink() {
    setLinks([...links, { platform: 'custom', url: '' }])
  }

  function removeLink(index: number) {
    setLinks(links.filter((_, i) => i !== index))
  }

  function updateLink(index: number, field: keyof SocialLink, value: string) {
    setLinks(
      links.map((link, i) =>
        i === index ? { ...link, [field]: value } : link,
      ),
    )
  }

  function moveLink(index: number, direction: 'up' | 'down') {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= links.length) return
    const newLinks = [...links]
    const [moved] = newLinks.splice(index, 1)
    newLinks.splice(newIndex, 0, moved)
    setLinks(newLinks)
  }

  // Applied to the edit page itself so the surrounding UI reflects the
  // currently selected theme immediately, without saving first.
  const activeTheme = themes[theme]

  if (!isAuthenticated || !session) {
    return null
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Loading your profile...</p>
      </main>
    )
  }

  return (
    <main
      className={`min-h-screen px-4 py-8 transition-colors duration-300 ${activeTheme.bg}`}
      style={getCustomThemeStyle({ theme, customTheme })}
    >
      <div className="mx-auto max-w-lg">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <a
            href="/connections"
            className={`rounded-lg border border-current/20 px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 ${activeTheme.text}`}
          >
            My Connections
          </a>
          <HeaderMenu
            themeTextClass={activeTheme.text}
            items={[
              {
                label: 'View Your Card',
                onClick: () => window.open(`/p/${profileId}`, '_blank'),
                disabled: !profileId,
              },
              {
                label: 'Import from vCard',
                onClick: () => vcardInputRef.current?.click(),
              },
              {
                label: 'Manage Passkeys',
                onClick: () => setShowPasskeyModal(true),
              },
              {
                label: 'About',
                onClick: () => navigate('/about'),
              },
              {
                label: 'Sign Out',
                onClick: logout,
              },
            ]}
          />
          <input
            ref={vcardInputRef}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            onChange={handleVCardImport}
            className="hidden"
            aria-label="Import from vCard"
          />
        </div>

        <form onSubmit={handleSave} className="space-y-6">
          <h2 className={`text-center text-2xl font-bold ${activeTheme.text}`}>Edit Your Card</h2>

          {/* Profile Picture - centered, clickable with hover overlay */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="group relative"
              aria-label={imagePreview ? 'Change profile photo' : 'Upload profile photo'}
            >
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Profile preview"
                  className="h-24 w-24 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gray-200 text-gray-400">
                  <svg className="h-8 w-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="text-xs font-medium text-white">Upload Photo</span>
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              className="hidden"
              aria-label="Upload profile photo"
            />
          </div>

          {/* Display Name */}
          <div>
            <label htmlFor="displayName" className={`block text-sm font-medium ${activeTheme.text}`}>
              Display Name
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className={`mt-1 block w-full rounded-lg border border-current/20 bg-transparent px-4 py-3 placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
            />
          </div>

          {/* Custom URL */}
          <div>
            <label htmlFor="slug" className={`block text-sm font-medium ${activeTheme.text}`}>
              Custom URL <span className={`font-normal ${activeTheme.textMuted}`}>(optional)</span>
            </label>
            <div
              className={`mt-1 flex items-center rounded-lg border ${
                slugConflict
                  ? 'border-red-500 ring-2 ring-red-500'
                  : 'border-current/20 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500'
              } ${activeTheme.text}`}
            >
              <span
                className={`max-w-[45%] shrink-0 truncate py-3 pl-4 text-sm ${activeTheme.textMuted}`}
                title={`${window.location.origin}/@`}
              >
                {window.location.origin}/@
              </span>
              <input
                id="slug"
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  setSlugConflict(false)
                }}
                placeholder="your-name"
                maxLength={30}
                aria-invalid={slugConflict}
                className="min-w-0 flex-1 bg-transparent py-3 pr-4 text-sm placeholder-current/40 focus:outline-none"
              />
            </div>
            <p className={`mt-1 text-xs ${slugConflict ? 'text-red-600' : activeTheme.textMuted}`}>
              3–30 characters: lowercase letters, numbers, and hyphens.
            </p>
          </div>

          {/* Pronouns */}
          <div>
            <label htmlFor="pronouns" className={`block text-sm font-medium ${activeTheme.text}`}>
              Pronouns <span className={`font-normal ${activeTheme.textMuted}`}>(optional)</span>
            </label>
            <input
              id="pronouns"
              type="text"
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              placeholder="she/her"
              maxLength={30}
              className={`mt-1 block w-full rounded-lg border border-current/20 bg-transparent px-4 py-3 placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
            />
          </div>

          {/* Tagline */}
          <div>
            <label htmlFor="tagline" className={`block text-sm font-medium ${activeTheme.text}`}>
              Tagline
            </label>
            <input
              id="tagline"
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value.slice(0, 120))}
              placeholder="Staff Engineer @ Acme Corp"
              maxLength={120}
              className={`mt-1 block w-full rounded-lg border border-current/20 bg-transparent px-4 py-3 placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
            />
            <p className={`mt-1 text-right text-xs ${activeTheme.textMuted}`}>
              {tagline.length}/120
            </p>
          </div>

          {/* Location */}
          <div>
            <label htmlFor="location" className={`block text-sm font-medium ${activeTheme.text}`}>
              Location <span className={`font-normal ${activeTheme.textMuted}`}>(optional)</span>
            </label>
            <input
              id="location"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="San Francisco, CA"
              maxLength={100}
              className={`mt-1 block w-full rounded-lg border border-current/20 bg-transparent px-4 py-3 placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
            />
          </div>

          {/* Email + Display Email Toggle */}
          <div>
            <label className={`block text-sm font-medium ${activeTheme.text}`}>
              Email
            </label>
            <div className={`mt-1 flex items-center rounded-lg border border-current/20 px-4 py-3 ${activeTheme.textMuted}`}>
              <span className="flex-1 truncate">{email}</span>
              <button
                id="displayEmail"
                type="button"
                role="switch"
                aria-checked={displayEmail}
                aria-label="Show email on card"
                onClick={() => setDisplayEmail(!displayEmail)}
                className="ml-3 flex shrink-0 cursor-pointer items-center gap-1.5 focus:outline-none"
              >
                <span className="text-xs">Show?</span>
                <span
                  className={`relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors duration-200 ${
                    displayEmail ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${
                      displayEmail ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </span>
              </button>
            </div>
          </div>

          {/* Phone */}
          <div>
            <label htmlFor="phone" className={`block text-sm font-medium ${activeTheme.text}`}>
              Phone <span className={`font-normal ${activeTheme.textMuted}`}>(optional)</span>
            </label>
            <input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 123-4567"
              className={`mt-1 block w-full rounded-lg border border-current/20 bg-transparent px-4 py-3 placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
            />
          </div>

          {/* Social Links */}
          <section aria-labelledby="links-heading">
            <h2 id="links-heading" className={`text-sm font-medium ${activeTheme.text}`}>
              Social Links
            </h2>
            <div className="mt-2 space-y-3">
              {links.map((link, index) => {
                const PlatformIcon = getPlatformIcon(link.platform)
                return (
                  <div key={index} className="flex items-center gap-2">
                    {/* Platform icon picker */}
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenPlatformIndex(openPlatformIndex === index ? null : index)
                        }}
                        className={`flex h-10 w-10 items-center justify-center rounded-lg border border-current/20 transition-opacity hover:opacity-80 ${activeTheme.text}`}
                        aria-label={`Platform: ${getPlatformLabel(link.platform)}`}
                        aria-expanded={openPlatformIndex === index}
                        aria-haspopup="listbox"
                      >
                        <PlatformIcon className="h-5 w-5" />
                      </button>
                      {openPlatformIndex === index && (
                        <div
                          role="listbox"
                          aria-label="Select platform"
                          className={`absolute left-0 top-full z-10 mt-1 w-48 rounded-lg border border-current/20 py-1 shadow-lg ${activeTheme.bg}`}
                        >
                          {SOCIAL_PLATFORMS.map((p) => {
                            const Icon = getPlatformIcon(p)
                            return (
                              <button
                                key={p}
                                type="button"
                                role="option"
                                aria-selected={link.platform === p}
                                onClick={() => {
                                  updateLink(index, 'platform', p)
                                  setOpenPlatformIndex(null)
                                }}
                                className={`flex w-full items-center gap-3 px-4 py-2 text-sm transition-opacity hover:opacity-70 ${activeTheme.text} ${link.platform === p ? 'font-semibold' : ''}`}
                              >
                                <Icon className="h-4 w-4 shrink-0" />
                                {getPlatformLabel(p)}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    <input
                      type="text"
                      inputMode="url"
                      value={link.url}
                      onChange={(e) => updateLink(index, 'url', e.target.value)}
                      placeholder={getPlatformPlaceholder(link.platform)}
                      className={`min-w-0 flex-1 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
                      aria-label={`URL for link ${index + 1}`}
                    />
                    {link.platform === 'custom' && (
                      <input
                        type="text"
                        value={link.label ?? ''}
                        onChange={(e) => updateLink(index, 'label', e.target.value)}
                        placeholder="Label"
                        className={`w-24 rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm placeholder-current/40 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none ${activeTheme.text}`}
                        aria-label={`Label for link ${index + 1}`}
                      />
                    )}
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => moveLink(index, 'up')}
                        disabled={index === 0}
                        className={`rounded p-1 transition-opacity hover:opacity-80 disabled:opacity-30 ${activeTheme.textMuted}`}
                        aria-label="Move link up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveLink(index, 'down')}
                        disabled={index === links.length - 1}
                        className={`rounded p-1 transition-opacity hover:opacity-80 disabled:opacity-30 ${activeTheme.textMuted}`}
                        aria-label="Move link down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeLink(index)}
                        className="rounded p-1 text-red-400 hover:text-red-600"
                        aria-label="Remove link"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={addLink}
                className={`w-full rounded-lg border-2 border-dashed border-current/20 px-4 py-2 text-sm transition-opacity hover:opacity-80 ${activeTheme.textMuted}`}
              >
                + Add link
              </button>
            </div>
          </section>

          {/* Theme Picker */}
          <section aria-labelledby="theme-heading">
            <h2 id="theme-heading" className={`text-sm font-medium ${activeTheme.text}`}>
              Card Theme
            </h2>
            <div className="mt-2 grid grid-cols-5 gap-3">
              {Object.values(themes).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    t.id === 'custom' ? setShowCustomThemeModal(true) : setTheme(t.id)
                  }
                  className={`flex flex-col items-center gap-1 rounded-lg border-2 p-2 transition-all ${activeTheme.text} ${
                    theme === t.id
                      ? 'border-blue-500 ring-2 ring-blue-200'
                      : 'border-current/20 hover:border-current/40'
                  }`}
                  aria-label={t.id === 'custom' ? 'Choose custom theme colors' : `Select ${t.name} theme`}
                  aria-pressed={theme === t.id}
                >
                  {t.id === 'custom' ? (
                    <div
                      className="h-8 w-8 rounded-full border border-gray-200"
                      style={{
                        background:
                          'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
                      }}
                    />
                  ) : (
                    <div className={`h-8 w-8 rounded-full ${t.bg} border border-gray-200`} />
                  )}
                  <span className={`text-xs ${activeTheme.textMuted}`}>{t.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* View Count */}
          {profileId && viewCount !== null && (
            <p className={`text-sm ${activeTheme.textMuted}`}>
              {viewCount === 1 ? '1 view' : `${viewCount} views`}
            </p>
          )}

          {/* Save Message */}
          {saveMessage && (
            <p
              className={`text-sm ${saveMessage.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}
              role="status"
            >
              {saveMessage}
            </p>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
            <DownloadDropdown
              label="QR Code"
              disabled={!profileId}
              themeTextClass={activeTheme.text}
              options={[
                { label: 'View / Save', onSelect: () => setShowQRModal(true) },
                { label: '3D Print', onSelect: () => setShowPrint3DModal(true) },
              ]}
            />
            <button
              type="button"
              onClick={() => window.open(`/p/${profileId}`, '_blank')}
              disabled={!profileId}
              className={`rounded-lg border border-current/20 px-4 py-3 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50 ${activeTheme.text}`}
            >
              Preview
            </button>
          </div>

          {/* Danger Zone */}
          <div className="border-t border-current/10 pt-6">
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="text-sm text-red-500 transition-colors hover:text-red-700"
            >
              Delete my card
            </button>
          </div>
        </form>

        {/* Delete Confirmation Modal */}
        {showDeleteModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
          >
            <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
              <h3 id="delete-dialog-title" className="text-lg font-bold text-gray-900">
                Delete Your Card
              </h3>
              <p className="mt-2 text-sm text-gray-600">
                This action is permanent. Type your email to confirm:
              </p>
              <input
                type="email"
                value={deleteEmail}
                onChange={(e) => setDeleteEmail(e.target.value)}
                placeholder={email}
                className="mt-3 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-900 focus:border-red-500 focus:ring-2 focus:ring-red-200 focus:outline-none"
                autoFocus
              />
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={
                    isDeleting || deleteEmail.toLowerCase() !== email.toLowerCase()
                  }
                  className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting...' : 'Delete permanently'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDeleteModal(false)
                    setDeleteEmail('')
                  }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-opacity hover:opacity-80"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* QR Code Modal */}
        {profileId && (
          <QRModal
            profileId={profileId}
            isOpen={showQRModal}
            onClose={() => setShowQRModal(false)}
            imageUrl={imagePreview ?? undefined}
            slug={slug}
          />
        )}

        {/* 3D Print Modal — owner-only, so it lives here and not on the
            public card page's QR view. */}
        {profileId && (
          <Print3DModal
            profileId={profileId}
            isOpen={showPrint3DModal}
            onClose={() => setShowPrint3DModal(false)}
            displayName={displayName}
            pronouns={pronouns}
            slug={initialSlug}
          />
        )}

        <ManagePasskeysModal
          isOpen={showPasskeyModal}
          onClose={() => setShowPasskeyModal(false)}
        />

        <CustomThemeModal
          isOpen={showCustomThemeModal}
          onClose={() => setShowCustomThemeModal(false)}
          initialColors={customTheme ?? DEFAULT_CUSTOM_THEME_COLORS}
          onApply={(colors) => {
            setCustomTheme(colors)
            setTheme('custom')
          }}
        />
      </div>
    </main>
  )
}

/**
 * Prepends https:// to a link URL that's missing a scheme, so users can
 * type "linkedin.com/in/x" without the save being rejected by the backend's
 * http(s)-only validation. Left untouched if already schemed or blank.
 *
 * Discord is the exception: its field also accepts a bare username, which
 * is stored as-is (no scheme prepended) and rendered as plain text rather
 * than a link — see CardView. A Discord value is only treated as a URL to
 * normalize if it already looks like one (has a path segment or names a
 * discord domain); anything else is left untouched as a username.
 */
function normalizeLinkUrl(url: string, platform: SocialPlatform): string {
  const trimmed = url.trim()
  if (trimmed === '' || /^https?:\/\//i.test(trimmed)) return trimmed
  if (platform === 'discord' && !looksLikeDiscordUrl(trimmed)) return trimmed
  return `https://${trimmed}`
}

function looksLikeDiscordUrl(value: string): boolean {
  return value.includes('/') || value.toLowerCase().includes('discord.')
}

/**
 * Resizes an image file to max 500x500 using Canvas API.
 * Returns base64-encoded JPEG data.
 */
async function resizeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const maxSize = 500
      let { width, height } = img

      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round((height * maxSize) / width)
          width = maxSize
        } else {
          width = Math.round((width * maxSize) / height)
          height = maxSize
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      // Remove the data:image/jpeg;base64, prefix
      const base64 = dataUrl.split(',')[1]
      resolve(base64)
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = URL.createObjectURL(file)
  })
}
