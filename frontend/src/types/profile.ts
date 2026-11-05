/** Supported social platforms with dedicated icons */
export type SocialPlatform =
  | 'linkedin'
  | 'github'
  | 'twitter'
  | 'instagram'
  | 'youtube'
  | 'mastodon'
  | 'bluesky'
  | 'website'
  | 'calendar'
  | 'discord'
  | 'twitch'
  | 'awsbuilder'
  | 'custom'

/** A single social link entry */
export interface SocialLink {
  platform: SocialPlatform
  url: string
  /** User-provided label for custom links */
  label?: string
}

/** Available preset theme identifiers */
export type ThemeId =
  | 'light'
  | 'dark'
  | 'ocean'
  | 'sunset'
  | 'forest'
  | 'lavender'
  | 'slate'
  | 'rose'
  | 'mint'
  | 'custom'

/** Theme color configuration */
export interface ThemeConfig {
  id: ThemeId
  name: string
  /** Background color (Tailwind class or hex) */
  bg: string
  /** Primary text color */
  text: string
  /** Secondary/muted text color */
  textMuted: string
  /** Accent color for links and interactive elements */
  accent: string
}

/** User-picked hex colors for the "custom" theme, only meaningful when `theme === 'custom'`. */
export interface CustomThemeColors {
  bg: string
  text: string
  textMuted: string
  accent: string
}

export const DEFAULT_CUSTOM_THEME_COLORS: CustomThemeColors = {
  bg: '#ffffff',
  text: '#111827',
  textMuted: '#4b5563',
  accent: '#2563eb',
}

/**
 * A single row in the admin "all profiles" view, as returned by
 * `GET /api/profile/admin/users`. Mirrors the backend's `AdminUser`:
 * minimal identity + search fields, plus what the QR and 3MF generators
 * need (`id`, `slug`, `displayName`, `pronouns`).
 */
export interface AdminUser {
  id: string
  email?: string
  slug?: string
  displayName?: string
  pronouns?: string
  imageUrl?: string
  viewCount?: number
  createdAt: string
}

/** Complete user profile */
export interface Profile {
  email: string
  /** Custom vanity URL segment (`/@{slug}`), if the owner has claimed one. */
  slug?: string
  displayName?: string
  tagline?: string
  phone?: string
  location?: string
  pronouns?: string
  imageUrl?: string
  theme: ThemeId
  /** Only present when `theme === 'custom'`. */
  customTheme?: CustomThemeColors
  /** Whether the email address is shown on the public card. Defaults to true. */
  displayEmail: boolean
  links: SocialLink[]
}
