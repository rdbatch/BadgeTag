use serde::{Deserialize, Serialize};

/// Helper for serde `#[serde(default = "default_true")]`.
fn default_true() -> bool {
    true
}

/// Maximum length for the display name field.
pub const MAX_DISPLAY_NAME_LEN: usize = 100;
/// Maximum length for the tagline field.
pub const MAX_TAGLINE_LEN: usize = 120;
/// Maximum length for the phone field.
pub const MAX_PHONE_LEN: usize = 30;
/// Maximum length for the location field.
pub const MAX_LOCATION_LEN: usize = 100;
/// Maximum length for the pronouns field.
pub const MAX_PRONOUNS_LEN: usize = 30;
/// Maximum length for a social link URL.
pub const MAX_LINK_URL_LEN: usize = 500;
/// Maximum length for a custom link label.
pub const MAX_LINK_LABEL_LEN: usize = 50;
/// Maximum number of social links on a profile.
pub const MAX_LINKS: usize = 20;
/// Minimum length for a custom profile slug (`/@{slug}`).
pub const MIN_SLUG_LEN: usize = 3;
/// Maximum length for a custom profile slug (`/@{slug}`).
pub const MAX_SLUG_LEN: usize = 30;

/// Validates a custom profile slug: lowercase alphanumeric and hyphens only,
/// must start and end with an alphanumeric character, and within length
/// bounds. The slug is always passed here *without* its `@` prefix — that
/// prefix is a URL/routing convention (see `ProfileStore::resolve_profile_id`),
/// not part of the stored value.
pub fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.len() < MIN_SLUG_LEN || slug.len() > MAX_SLUG_LEN {
        return Err(format!(
            "Custom URL must be between {MIN_SLUG_LEN} and {MAX_SLUG_LEN} characters"
        ));
    }

    let bytes = slug.as_bytes();
    let is_alphanumeric = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();

    if !is_alphanumeric(bytes[0]) || !is_alphanumeric(bytes[bytes.len() - 1]) {
        return Err("Custom URL must start and end with a letter or number".to_string());
    }

    if !bytes.iter().all(|&b| is_alphanumeric(b) || b == b'-') {
        return Err(
            "Custom URL can only contain lowercase letters, numbers, and hyphens".to_string(),
        );
    }

    Ok(())
}

/// Supported social platforms
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SocialPlatform {
    Linkedin,
    Github,
    Twitter,
    Instagram,
    Youtube,
    Mastodon,
    Bluesky,
    Website,
    Calendar,
    Discord,
    Twitch,
    AwsBuilder,
    Custom,
}

/// A single social link
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SocialLink {
    pub platform: SocialPlatform,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl SocialLink {
    /// Validates URL scheme and length, and label length. Only `http://`
    /// and `https://` URLs are accepted — this rejects `javascript:`,
    /// `data:`, and other schemes that could be used for stored XSS when
    /// rendered as a link's `href` on the public card.
    ///
    /// `Discord` is the one exception: its value may instead be a bare
    /// username, which is rendered as plain text (never as an `href`) on
    /// the public card — see `to_public`'s caller, the frontend's
    /// `CardView`. So a schemeless value is only rejected for non-Discord
    /// platforms.
    fn validate(&self) -> Result<(), String> {
        if self.url.len() > MAX_LINK_URL_LEN {
            return Err(format!(
                "Link URL must be {MAX_LINK_URL_LEN} characters or less"
            ));
        }

        let lower = self.url.to_lowercase();
        let is_web_url = lower.starts_with("http://") || lower.starts_with("https://");
        if !is_web_url && self.platform != SocialPlatform::Discord {
            return Err("Link URL must start with http:// or https://".to_string());
        }
        if self.platform == SocialPlatform::Discord && self.url.trim().is_empty() {
            return Err("Discord username or link is required".to_string());
        }

        if let Some(ref label) = self.label
            && label.len() > MAX_LINK_LABEL_LEN
        {
            return Err(format!(
                "Link label must be {MAX_LINK_LABEL_LEN} characters or less"
            ));
        }

        Ok(())
    }
}

/// Available theme identifiers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeId {
    #[default]
    Light,
    Dark,
    Ocean,
    Sunset,
    Forest,
    Lavender,
    Slate,
    Rose,
    Mint,
    Custom,
}

/// User-picked hex colors for the "custom" theme. Only meaningful when the
/// profile's `theme` is `ThemeId::Custom`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CustomTheme {
    pub bg: String,
    pub text: String,
    pub text_muted: String,
    pub accent: String,
}

impl CustomTheme {
    /// Validates that every color is a `#rrggbb` hex string.
    fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("Background", &self.bg),
            ("Text", &self.text),
            ("Muted text", &self.text_muted),
            ("Accent", &self.accent),
        ] {
            if !is_hex_color(value) {
                return Err(format!("{label} color must be a hex color like #a1b2c3"));
            }
        }
        Ok(())
    }
}

/// Returns true if `value` is a `#` followed by exactly 6 hex digits.
fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

/// Full profile as stored/returned by the API.
///
/// This is the full-fidelity representation — appropriate for the
/// authenticated "get my own profile" endpoint, where the owner needs to
/// see (and edit) both the email value and the `display_email` flag. The
/// *public* profile endpoint must never serialize this directly; it should
/// call `to_public()` first (see below), which omits `email` when the
/// owner has opted to hide it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    /// Optional custom vanity URL segment, reachable at `/@{slug}`. `None`
    /// if the owner hasn't claimed one — the profile is still always
    /// reachable at `/p/{id}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// Always populated for the authenticated self-view. Set to `None`
    /// (and therefore omitted from the response) by `to_public()` when
    /// `display_email` is `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tagline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronouns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// Pre-generated composite share image (logo + QR code + photo/
    /// placeholder avatar) used as `og:image` — see `og_image::generate`.
    /// `None` for profiles created before this existed; `og::render_og_html`
    /// falls back to `image_url` in that case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub og_image_url: Option<String>,
    pub theme: ThemeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_theme: Option<CustomTheme>,
    /// Total public-card views. Owner-only analytics — always stripped by
    /// `to_public()`, never shown to a viewer of the card itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<i64>,
    pub display_email: bool,
    pub links: Vec<SocialLink>,
    pub created_at: String,
    pub updated_at: String,
}

impl Profile {
    /// Returns a copy of this profile safe to serve from the *public*,
    /// unauthenticated profile endpoint.
    ///
    /// Omits `email` when the owner has set `display_email = false`. Phone
    /// has no equivalent visibility flag by design — a user who doesn't
    /// want their phone number public is expected to leave that field
    /// blank rather than fill it in and hide it, so `phone` always passes
    /// through unchanged (it's already `None` unless explicitly set).
    /// `view_count` is unconditionally stripped — it's owner-only analytics,
    /// not something a card viewer should see.
    pub fn to_public(&self) -> Profile {
        let mut public = self.clone();
        if !public.display_email {
            public.email = None;
        }
        public.view_count = None;
        public
    }

    /// Returns the compact summary row used by the admin "list all
    /// profiles" view. Carries exactly the fields that view needs to
    /// render a searchable table and open the QR/3MF generators for any
    /// profile — never the full record (no links, theme, or timestamps),
    /// and the email is included unconditionally because this is an
    /// admin-only, server-authorized view (unlike `to_public`, which
    /// honors `display_email`).
    pub fn to_admin_summary(&self) -> AdminUser {
        AdminUser {
            id: self.id.clone(),
            email: self.email.clone(),
            slug: self.slug.clone(),
            display_name: self.display_name.clone(),
            pronouns: self.pronouns.clone(),
            image_url: self.image_url.clone(),
            view_count: self.view_count,
            created_at: self.created_at.clone(),
        }
    }
}

/// A single row in the admin "list all profiles" response.
///
/// Deliberately minimal: just what the admin table renders (identity,
/// searchable text, avatar, a view-count stat) plus the fields the QR and
/// 3MF generators derive their output from (`id`, `slug`, `display_name`,
/// `pronouns`). Served only from the admin-only, allowlist-gated endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct AdminUser {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronouns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<i64>,
    pub created_at: String,
}

/// Response body for `GET /api/profile/me` — the caller's own profile plus
/// an `is_admin` flag telling the frontend whether to reveal the admin UI.
///
/// The flag is computed server-side from the verified JWT email against
/// the `ADMIN_EMAILS` allowlist, so the frontend never holds the admin
/// list itself; it only mirrors this decision. The flattened `profile`
/// keeps the wire shape backward-compatible — every existing field stays
/// at the top level, with `is_admin` added alongside.
#[derive(Debug, Clone, Serialize)]
pub struct OwnProfileResponse {
    #[serde(flatten)]
    pub profile: Profile,
    pub is_admin: bool,
}

/// Request body for creating/updating a profile
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileUpdateRequest {
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub tagline: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub pronouns: Option<String>,
    #[serde(default)]
    pub theme: ThemeId,
    #[serde(default)]
    pub custom_theme: Option<CustomTheme>,
    #[serde(default = "default_true")]
    pub display_email: bool,
    #[serde(default)]
    pub links: Vec<SocialLink>,
}

impl ProfileUpdateRequest {
    /// Validates all free-text field lengths and link URLs. Called by the
    /// router before any write to the store.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(ref name) = self.display_name
            && name.len() > MAX_DISPLAY_NAME_LEN
        {
            return Err(format!(
                "Display name must be {MAX_DISPLAY_NAME_LEN} characters or less"
            ));
        }

        if let Some(ref tagline) = self.tagline
            && tagline.len() > MAX_TAGLINE_LEN
        {
            return Err(format!(
                "Tagline must be {MAX_TAGLINE_LEN} characters or less"
            ));
        }

        if let Some(ref phone) = self.phone
            && phone.len() > MAX_PHONE_LEN
        {
            return Err(format!("Phone must be {MAX_PHONE_LEN} characters or less"));
        }

        if let Some(ref location) = self.location
            && location.len() > MAX_LOCATION_LEN
        {
            return Err(format!(
                "Location must be {MAX_LOCATION_LEN} characters or less"
            ));
        }

        if let Some(ref pronouns) = self.pronouns
            && pronouns.len() > MAX_PRONOUNS_LEN
        {
            return Err(format!(
                "Pronouns must be {MAX_PRONOUNS_LEN} characters or less"
            ));
        }

        if let Some(ref custom_theme) = self.custom_theme {
            custom_theme.validate()?;
        }

        if self.links.len() > MAX_LINKS {
            return Err(format!("A profile can have at most {MAX_LINKS} links"));
        }

        for link in &self.links {
            link.validate()?;
        }

        Ok(())
    }
}

/// Request body for deleting a profile (requires email confirmation)
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileDeleteRequest {
    pub email: String,
    /// The caller's own Cognito access token, passed through to Cognito's
    /// DeleteUser API so the user deletes themselves (no admin credentials
    /// required). Cognito validates the token and rejects it if it is
    /// expired, forged, or belongs to a different user.
    pub access_token: String,
}

/// Request body for image upload
#[derive(Debug, Clone, Deserialize)]
pub struct ImageUploadRequest {
    /// Base64-encoded image data
    pub image_data: String,
    /// Content type (e.g., "image/jpeg", "image/png")
    pub content_type: String,
}

/// Response for image upload
#[derive(Debug, Clone, Serialize)]
pub struct ImageUploadResponse {
    pub image_url: String,
}

/// Request body for setting/clearing a profile's custom slug.
/// `None`/absent clears the current slug, reverting to `/p/{id}` only.
#[derive(Debug, Clone, Deserialize)]
pub struct SlugUpdateRequest {
    #[serde(default)]
    pub slug: Option<String>,
}

/// Maximum length for a connection's name.
pub const MAX_CONNECTION_NAME_LEN: usize = 100;
/// Maximum length for a connection's notes.
pub const MAX_CONNECTION_NOTES_LEN: usize = 1000;
/// Maximum length for a connection's event tag.
pub const MAX_CONNECTION_EVENT_LEN: usize = 100;
/// Maximum length for a connection's photo URL.
pub const MAX_CONNECTION_PHOTO_URL_LEN: usize = 500;

/// A person the authenticated user met and chose to save — either typed in
/// by hand, or captured from viewing someone else's public card (in which
/// case `source_profile_id` links back to that card).
#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_profile_id: Option<String>,
    pub created_at: String,
}

/// Request body for creating a connection.
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionCreateRequest {
    pub name: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub photo_url: Option<String>,
    #[serde(default)]
    pub source_profile_id: Option<String>,
}

impl ConnectionCreateRequest {
    /// Validates field lengths and that a name was actually provided.
    /// Called by the router before any write to the store.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Name is required".to_string());
        }
        if self.name.len() > MAX_CONNECTION_NAME_LEN {
            return Err(format!(
                "Name must be {MAX_CONNECTION_NAME_LEN} characters or less"
            ));
        }

        if let Some(ref notes) = self.notes
            && notes.len() > MAX_CONNECTION_NOTES_LEN
        {
            return Err(format!(
                "Notes must be {MAX_CONNECTION_NOTES_LEN} characters or less"
            ));
        }

        if let Some(ref event) = self.event
            && event.len() > MAX_CONNECTION_EVENT_LEN
        {
            return Err(format!(
                "Event must be {MAX_CONNECTION_EVENT_LEN} characters or less"
            ));
        }

        if let Some(ref photo_url) = self.photo_url
            && photo_url.len() > MAX_CONNECTION_PHOTO_URL_LEN
        {
            return Err(format!(
                "Photo URL must be {MAX_CONNECTION_PHOTO_URL_LEN} characters or less"
            ));
        }

        Ok(())
    }
}

/// Request body for updating an existing connection's name, notes, or
/// event tag. Does not allow changing `photo_url` or `source_profile_id` —
/// those are set once at creation time and never edited by the owner.
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionUpdateRequest {
    pub name: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
}

impl ConnectionUpdateRequest {
    /// Validates field lengths and that a name was actually provided.
    /// Called by the router before any write to the store.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Name is required".to_string());
        }
        if self.name.len() > MAX_CONNECTION_NAME_LEN {
            return Err(format!(
                "Name must be {MAX_CONNECTION_NAME_LEN} characters or less"
            ));
        }

        if let Some(ref notes) = self.notes
            && notes.len() > MAX_CONNECTION_NOTES_LEN
        {
            return Err(format!(
                "Notes must be {MAX_CONNECTION_NOTES_LEN} characters or less"
            ));
        }

        if let Some(ref event) = self.event
            && event.len() > MAX_CONNECTION_EVENT_LEN
        {
            return Err(format!(
                "Event must be {MAX_CONNECTION_EVENT_LEN} characters or less"
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_update_request_deserializes_minimal() {
        let json = r#"{"email": "test@example.com"}"#;
        let req: ProfileUpdateRequest = serde_json::from_str(json).expect("valid");
        assert_eq!(req.email, "test@example.com");
        assert_eq!(req.theme, ThemeId::Light); // default
        assert!(req.links.is_empty());
    }

    #[test]
    fn profile_update_request_deserializes_full() {
        let json = r#"{
            "email": "test@example.com",
            "display_name": "Test User",
            "tagline": "Staff Engineer",
            "phone": "+1 555-0100",
            "theme": "dark",
            "links": [
                {"platform": "github", "url": "https://github.com/test"},
                {"platform": "custom", "url": "https://blog.test.com", "label": "My Blog"}
            ]
        }"#;
        let req: ProfileUpdateRequest = serde_json::from_str(json).expect("valid");
        assert_eq!(req.display_name, Some("Test User".to_string()));
        assert_eq!(req.theme, ThemeId::Dark);
        assert_eq!(req.links.len(), 2);
        assert_eq!(req.links[1].label, Some("My Blog".to_string()));
    }

    #[test]
    fn profile_serializes_without_none_fields() {
        let profile = Profile {
            id: "abc123".to_string(),
            slug: None,
            email: Some("test@example.com".to_string()),
            display_name: None,
            tagline: None,
            phone: None,
            location: None,
            pronouns: None,
            image_url: None,
            og_image_url: None,
            theme: ThemeId::Light,
            custom_theme: None,
            view_count: None,
            display_email: true,
            links: vec![],
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&profile).expect("valid");
        assert!(!json.contains("display_name"));
        assert!(!json.contains("tagline"));
        assert!(!json.contains("phone"));
        assert!(!json.contains("location"));
        assert!(!json.contains("pronouns"));
        assert!(!json.contains("image_url"));
        assert!(!json.contains("custom_theme"));
        assert!(!json.contains("view_count"));
    }

    fn full_profile(display_email: bool) -> Profile {
        Profile {
            id: "abc123".to_string(),
            slug: None,
            email: Some("test@example.com".to_string()),
            display_name: Some("Test User".to_string()),
            tagline: None,
            phone: Some("+1 555-0100".to_string()),
            location: None,
            pronouns: None,
            image_url: None,
            og_image_url: None,
            theme: ThemeId::Light,
            custom_theme: None,
            view_count: None,
            display_email,
            links: vec![],
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn to_public_omits_email_when_display_email_false() {
        let profile = full_profile(false);
        let public = profile.to_public();
        assert_eq!(public.email, None);
        let json = serde_json::to_string(&public).expect("valid");
        // `"email":` (the field itself, not the "display_email" field name
        // which also contains the substring "email") must be absent.
        assert!(!json.contains("\"email\":"));
        assert!(!json.contains("test@example.com"));
        // Phone has no visibility flag — always passes through.
        assert_eq!(public.phone, Some("+1 555-0100".to_string()));
    }

    #[test]
    fn to_public_always_strips_view_count() {
        let mut profile = full_profile(true);
        profile.view_count = Some(42);
        let public = profile.to_public();
        assert_eq!(public.view_count, None);
        let json = serde_json::to_string(&public).expect("valid");
        assert!(!json.contains("view_count"));
    }

    #[test]
    fn to_public_keeps_email_when_display_email_true() {
        let profile = full_profile(true);
        let public = profile.to_public();
        assert_eq!(public.email, Some("test@example.com".to_string()));
        let json = serde_json::to_string(&public).expect("valid");
        assert!(json.contains("test@example.com"));
    }

    #[test]
    fn to_public_does_not_mutate_original() {
        let profile = full_profile(false);
        let _ = profile.to_public();
        assert_eq!(profile.email, Some("test@example.com".to_string()));
    }

    #[test]
    fn tagline_validation() {
        // Tagline should be ≤ MAX_TAGLINE_LEN chars (validation happens at the router level)
        let tagline = "a".repeat(MAX_TAGLINE_LEN);
        assert_eq!(tagline.len(), MAX_TAGLINE_LEN);
    }

    fn base_request() -> ProfileUpdateRequest {
        ProfileUpdateRequest {
            email: "test@example.com".to_string(),
            display_name: None,
            tagline: None,
            phone: None,
            location: None,
            pronouns: None,
            theme: ThemeId::Light,
            custom_theme: None,
            display_email: true,
            links: vec![],
        }
    }

    #[test]
    fn validate_accepts_minimal_request() {
        assert!(base_request().validate().is_ok());
    }

    #[test]
    fn validate_rejects_display_name_too_long() {
        let mut req = base_request();
        req.display_name = Some("a".repeat(MAX_DISPLAY_NAME_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_accepts_display_name_at_max_length() {
        let mut req = base_request();
        req.display_name = Some("a".repeat(MAX_DISPLAY_NAME_LEN));
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_rejects_tagline_too_long() {
        let mut req = base_request();
        req.tagline = Some("a".repeat(MAX_TAGLINE_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_phone_too_long() {
        let mut req = base_request();
        req.phone = Some("1".repeat(MAX_PHONE_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_location_too_long() {
        let mut req = base_request();
        req.location = Some("a".repeat(MAX_LOCATION_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_accepts_location_at_max_length() {
        let mut req = base_request();
        req.location = Some("a".repeat(MAX_LOCATION_LEN));
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_rejects_pronouns_too_long() {
        let mut req = base_request();
        req.pronouns = Some("a".repeat(MAX_PRONOUNS_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_accepts_pronouns_at_max_length() {
        let mut req = base_request();
        req.pronouns = Some("a".repeat(MAX_PRONOUNS_LEN));
        assert!(req.validate().is_ok());
    }

    fn valid_custom_theme() -> CustomTheme {
        CustomTheme {
            bg: "#ffffff".to_string(),
            text: "#111827".to_string(),
            text_muted: "#4b5563".to_string(),
            accent: "#2563eb".to_string(),
        }
    }

    #[test]
    fn validate_accepts_valid_custom_theme() {
        let mut req = base_request();
        req.theme = ThemeId::Custom;
        req.custom_theme = Some(valid_custom_theme());
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_rejects_custom_theme_with_invalid_hex() {
        let mut req = base_request();
        req.theme = ThemeId::Custom;
        let mut custom = valid_custom_theme();
        custom.bg = "not-a-color".to_string();
        req.custom_theme = Some(custom);
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_custom_theme_missing_hash() {
        let mut req = base_request();
        req.theme = ThemeId::Custom;
        let mut custom = valid_custom_theme();
        custom.accent = "2563eb".to_string();
        req.custom_theme = Some(custom);
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_custom_theme_with_short_hex() {
        let mut req = base_request();
        req.theme = ThemeId::Custom;
        let mut custom = valid_custom_theme();
        custom.text = "#fff".to_string();
        req.custom_theme = Some(custom);
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_too_many_links() {
        let mut req = base_request();
        req.links = (0..MAX_LINKS + 1)
            .map(|i| SocialLink {
                platform: SocialPlatform::Custom,
                url: format!("https://example.com/{i}"),
                label: None,
            })
            .collect();
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_javascript_scheme_url() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Custom,
            url: "javascript:alert(1)".to_string(),
            label: None,
        }];
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_data_scheme_url() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Custom,
            url: "data:text/html,<script>alert(1)</script>".to_string(),
            label: None,
        }];
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_accepts_https_url() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Github,
            url: "https://github.com/test".to_string(),
            label: None,
        }];
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_accepts_discord_bare_username() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Discord,
            url: "coolusername".to_string(),
            label: None,
        }];
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_accepts_discord_url() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Discord,
            url: "https://discord.gg/abc123".to_string(),
            label: None,
        }];
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_rejects_discord_empty_value() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Discord,
            url: "".to_string(),
            label: None,
        }];
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_non_discord_bare_username() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Twitch,
            url: "coolusername".to_string(),
            label: None,
        }];
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_accepts_http_url() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Website,
            url: "http://example.com".to_string(),
            label: None,
        }];
        assert!(req.validate().is_ok());
    }

    #[test]
    fn validate_rejects_link_url_too_long() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Custom,
            url: format!("https://example.com/{}", "a".repeat(MAX_LINK_URL_LEN)),
            label: None,
        }];
        assert!(req.validate().is_err());
    }

    #[test]
    fn validate_rejects_link_label_too_long() {
        let mut req = base_request();
        req.links = vec![SocialLink {
            platform: SocialPlatform::Custom,
            url: "https://example.com".to_string(),
            label: Some("a".repeat(MAX_LINK_LABEL_LEN + 1)),
        }];
        assert!(req.validate().is_err());
    }

    fn base_connection_request() -> ConnectionCreateRequest {
        ConnectionCreateRequest {
            name: "Grace Hopper".to_string(),
            notes: None,
            event: None,
            photo_url: None,
            source_profile_id: None,
        }
    }

    #[test]
    fn connection_validate_accepts_minimal_request() {
        assert!(base_connection_request().validate().is_ok());
    }

    #[test]
    fn connection_validate_rejects_empty_name() {
        let mut req = base_connection_request();
        req.name = "   ".to_string();
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_validate_rejects_name_too_long() {
        let mut req = base_connection_request();
        req.name = "a".repeat(MAX_CONNECTION_NAME_LEN + 1);
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_validate_accepts_name_at_max_length() {
        let mut req = base_connection_request();
        req.name = "a".repeat(MAX_CONNECTION_NAME_LEN);
        assert!(req.validate().is_ok());
    }

    #[test]
    fn connection_validate_rejects_notes_too_long() {
        let mut req = base_connection_request();
        req.notes = Some("a".repeat(MAX_CONNECTION_NOTES_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_validate_rejects_event_too_long() {
        let mut req = base_connection_request();
        req.event = Some("a".repeat(MAX_CONNECTION_EVENT_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_validate_rejects_photo_url_too_long() {
        let mut req = base_connection_request();
        req.photo_url = Some("a".repeat(MAX_CONNECTION_PHOTO_URL_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_validate_accepts_full_request() {
        let req = ConnectionCreateRequest {
            name: "Grace Hopper".to_string(),
            notes: Some("Met at the conference, follow up re: COBOL".to_string()),
            event: Some("AWS re:Invent".to_string()),
            photo_url: Some("/images/abc123".to_string()),
            source_profile_id: Some("abc123".to_string()),
        };
        assert!(req.validate().is_ok());
    }

    fn base_connection_update_request() -> ConnectionUpdateRequest {
        ConnectionUpdateRequest {
            name: "Grace Hopper".to_string(),
            notes: None,
            event: None,
        }
    }

    #[test]
    fn connection_update_validate_accepts_minimal_request() {
        assert!(base_connection_update_request().validate().is_ok());
    }

    #[test]
    fn connection_update_validate_rejects_empty_name() {
        let mut req = base_connection_update_request();
        req.name = "   ".to_string();
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_update_validate_rejects_name_too_long() {
        let mut req = base_connection_update_request();
        req.name = "a".repeat(MAX_CONNECTION_NAME_LEN + 1);
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_update_validate_rejects_notes_too_long() {
        let mut req = base_connection_update_request();
        req.notes = Some("a".repeat(MAX_CONNECTION_NOTES_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_update_validate_rejects_event_too_long() {
        let mut req = base_connection_update_request();
        req.event = Some("a".repeat(MAX_CONNECTION_EVENT_LEN + 1));
        assert!(req.validate().is_err());
    }

    #[test]
    fn connection_update_request_deserializes() {
        let json = r#"{"name": "Grace Hopper", "notes": "Follow up", "event": "re:Invent"}"#;
        let req: ConnectionUpdateRequest = serde_json::from_str(json).expect("valid");
        assert_eq!(req.name, "Grace Hopper");
        assert_eq!(req.notes, Some("Follow up".to_string()));
        assert_eq!(req.event, Some("re:Invent".to_string()));
    }

    #[test]
    fn validate_slug_accepts_simple_slug() {
        assert!(validate_slug("ada-lovelace").is_ok());
    }

    #[test]
    fn validate_slug_accepts_alphanumeric() {
        assert!(validate_slug("ada123").is_ok());
    }

    #[test]
    fn validate_slug_rejects_too_short() {
        assert!(validate_slug("ab").is_err());
    }

    #[test]
    fn validate_slug_accepts_min_length() {
        assert!(validate_slug("abc").is_ok());
    }

    #[test]
    fn validate_slug_rejects_too_long() {
        assert!(validate_slug(&"a".repeat(MAX_SLUG_LEN + 1)).is_err());
    }

    #[test]
    fn validate_slug_accepts_max_length() {
        assert!(validate_slug(&"a".repeat(MAX_SLUG_LEN)).is_ok());
    }

    #[test]
    fn validate_slug_rejects_leading_hyphen() {
        assert!(validate_slug("-ada").is_err());
    }

    #[test]
    fn validate_slug_rejects_trailing_hyphen() {
        assert!(validate_slug("ada-").is_err());
    }

    #[test]
    fn validate_slug_rejects_uppercase() {
        assert!(validate_slug("Ada-Lovelace").is_err());
    }

    #[test]
    fn validate_slug_rejects_underscore() {
        assert!(validate_slug("ada_lovelace").is_err());
    }

    #[test]
    fn validate_slug_rejects_spaces() {
        assert!(validate_slug("ada lovelace").is_err());
    }

    #[test]
    fn validate_slug_accepts_a_string_shaped_like_a_profile_id() {
        // The `@` prefix (applied by the router, not stored) is what
        // disambiguates slugs from IDs — the bare slug value itself has no
        // need to avoid hex-looking strings.
        assert!(validate_slug("abc123def456").is_ok());
    }
}
