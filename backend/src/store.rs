use aws_sdk_cognitoidentityprovider::Client as CognitoClient;
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_s3::Client as S3Client;

use crate::error::AppError;
use crate::models::{
    AdminUser, Connection, ConnectionCreateRequest, ConnectionUpdateRequest, CustomTheme, Profile,
    ProfileUpdateRequest, SocialLink, SocialPlatform, ThemeId, validate_slug,
};
use crate::og_image;
use crate::profile_id::{generate_connection_id, generate_image_version, generate_profile_id};

const PROFILE_SK: &str = "PROFILE";
const LINK_PREFIX: &str = "LINK#";
const EMAIL_POINTER_SK: &str = "POINTER";
const CONNECTION_PREFIX: &str = "CONNECTION#";
const SLUG_SK: &str = "SLUG";

/// Data access layer for profile operations.
pub struct ProfileStore {
    dynamo: DynamoClient,
    s3: S3Client,
    cognito: CognitoClient,
    table_name: String,
    bucket_name: String,
    image_base_url: String,
    /// The app's public origin (e.g. `https://badgetag.me`), empty until a
    /// custom domain is configured. Used only to bake an absolute profile
    /// URL into the QR code generated for `og_image::generate` — generation
    /// itself doesn't require it (falls back to a relative `/p/{id}`).
    site_url: String,
}

impl ProfileStore {
    pub fn new(
        dynamo: DynamoClient,
        s3: S3Client,
        cognito: CognitoClient,
        table_name: String,
        bucket_name: String,
        image_base_url: String,
        site_url: String,
    ) -> Self {
        Self {
            dynamo,
            s3,
            cognito,
            table_name,
            bucket_name,
            image_base_url,
            site_url,
        }
    }

    /// Normalizes an email for use as a lookup key (matches the
    /// normalization already applied to the `email` attribute stored on
    /// the profile item itself via `authorize_profile_access`'s
    /// case-insensitive comparison).
    fn email_pk(email: &str) -> String {
        format!("EMAIL#{}", email.trim().to_lowercase())
    }

    /// Looks up the profile ID assigned to an email address, if any.
    async fn get_profile_id_for_email(&self, email: &str) -> Result<Option<String>, AppError> {
        let pk = Self::email_pk(email);

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(EMAIL_POINTER_SK.to_string()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        Ok(result
            .item
            .as_ref()
            .and_then(|item| get_string(item, "profile_id")))
    }

    /// Looks up the profile ID for an email, assigning a new random one
    /// (and persisting the `EMAIL#` pointer) if none exists yet.
    ///
    /// Uses a conditional put (`attribute_not_exists(pk)`) so two
    /// concurrent first-writes for the same email can't race into two
    /// different profile IDs — the loser of the race re-reads and uses the
    /// winner's ID instead of failing the request.
    async fn get_or_create_profile_id_for_email(&self, email: &str) -> Result<String, AppError> {
        if let Some(existing) = self.get_profile_id_for_email(email).await? {
            return Ok(existing);
        }

        let pk = Self::email_pk(email);
        let new_id = generate_profile_id();

        let mut item = std::collections::HashMap::new();
        item.insert("pk".to_string(), AttributeValue::S(pk));
        item.insert(
            "sk".to_string(),
            AttributeValue::S(EMAIL_POINTER_SK.to_string()),
        );
        item.insert("profile_id".to_string(), AttributeValue::S(new_id.clone()));

        let put_result = self
            .dynamo
            .put_item()
            .table_name(&self.table_name)
            .set_item(Some(item))
            .condition_expression("attribute_not_exists(pk)")
            .send()
            .await;

        match put_result {
            Ok(_) => Ok(new_id),
            Err(e) => {
                // ConditionalCheckFailedException means another request won
                // the race and created the pointer first — use its ID.
                if e.as_service_error()
                    .is_some_and(|se| se.is_conditional_check_failed_exception())
                {
                    self.get_profile_id_for_email(email).await?.ok_or_else(|| {
                        AppError::Internal(
                            "Email pointer vanished after conditional check failure".to_string(),
                        )
                    })
                } else {
                    Err(AppError::Internal(format!(
                        "DynamoDB pointer put failed: {e}"
                    )))
                }
            }
        }
    }

    /// Normalizes a slug for use as a lookup key.
    fn slug_pk(slug: &str) -> String {
        format!("SLUG#{}", slug.trim().to_lowercase())
    }

    /// Looks up the profile ID a custom slug currently points to, if any.
    async fn get_profile_id_for_slug(&self, slug: &str) -> Result<Option<String>, AppError> {
        let pk = Self::slug_pk(slug);

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(SLUG_SK.to_string()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        Ok(result
            .item
            .as_ref()
            .and_then(|item| get_string(item, "profile_id")))
    }

    /// Resolves a path segment that's either a raw profile ID or an
    /// `@`-prefixed custom slug into a real profile ID. A leading `@` is the
    /// caller's (router's) signal that this is a slug, not an ID — plain IDs
    /// are returned unchanged, so ordinary `/p/{id}` lookups never pay for
    /// the extra slug-pointer read.
    pub async fn resolve_profile_id(&self, id_or_slug: &str) -> Result<String, AppError> {
        match id_or_slug.strip_prefix('@') {
            Some(slug) => self
                .get_profile_id_for_slug(slug)
                .await?
                .ok_or(AppError::NotFound),
            None => Ok(id_or_slug.to_string()),
        }
    }

    /// Get the *public* view of a profile by its ID — omits `email` when
    /// the owner has set `display_email = false`. Safe to call from the
    /// unauthenticated public profile endpoint.
    pub async fn get_profile(&self, profile_id: &str) -> Result<Profile, AppError> {
        let profile = self.get_profile_full(profile_id).await?;
        Ok(profile.to_public())
    }

    /// Atomically increments the profile's view counter by one. Best-effort
    /// from the caller's perspective — a failure here (e.g. a delete racing
    /// this call) should never fail the profile fetch itself.
    pub async fn increment_view_count(&self, profile_id: &str) -> Result<(), AppError> {
        let pk = format!("PROFILE#{profile_id}");

        self.dynamo
            .update_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .update_expression("ADD view_count :inc")
            .expression_attribute_values(":inc", AttributeValue::N("1".to_string()))
            .condition_expression("attribute_exists(pk)")
            .send()
            .await
            .map(|_| ())
            .map_err(|e| AppError::Internal(format!("DynamoDB view count increment failed: {e}")))
    }

    /// Get the full profile (including `email` regardless of
    /// `display_email`) for the authenticated user identified by `email`.
    pub async fn get_profile_by_email(&self, email: &str) -> Result<Profile, AppError> {
        let profile_id = self
            .get_profile_id_for_email(email)
            .await?
            .ok_or(AppError::NotFound)?;
        self.get_profile_full(&profile_id).await
    }

    /// Get the full profile (including `email` regardless of
    /// `display_email`) by its ID. Internal — callers outside this module
    /// must go through `get_profile` (public/filtered) or
    /// `get_profile_by_email` (authenticated self-view).
    async fn get_profile_full(&self, profile_id: &str) -> Result<Profile, AppError> {
        let pk = format!("PROFILE#{profile_id}");

        let result = self
            .dynamo
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("pk = :pk")
            .expression_attribute_values(":pk", AttributeValue::S(pk.clone()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB query failed: {e}")))?;

        let items = result.items();
        if items.is_empty() {
            return Err(AppError::NotFound);
        }

        // Parse profile item and link items
        let mut profile_item = None;
        let mut links: Vec<(usize, SocialLink)> = Vec::new();

        for item in items {
            let sk = item
                .get("sk")
                .and_then(|v| v.as_s().ok())
                .cloned()
                .unwrap_or_default();

            if sk == PROFILE_SK {
                profile_item = Some(item);
            } else if let Some(order_str) = sk.strip_prefix(LINK_PREFIX) {
                let order: usize = order_str.parse().unwrap_or(0);
                if let Some(link) = parse_link_item(item) {
                    links.push((order, link));
                }
            }
        }

        let item = profile_item.ok_or(AppError::NotFound)?;
        links.sort_by_key(|(order, _)| *order);
        let sorted_links: Vec<SocialLink> = links.into_iter().map(|(_, link)| link).collect();

        let email = get_string(item, "email")
            .ok_or_else(|| AppError::Internal("Profile missing email".to_string()))?;

        let image_key = get_string(item, "image_key");
        let image_url = image_key.map(|key| format!("{}/{}", self.image_base_url, key));

        let og_image_key = get_string(item, "og_image_key");
        let og_image_url = og_image_key.map(|key| format!("{}/{}", self.image_base_url, key));

        let theme_str = get_string(item, "theme").unwrap_or_else(|| "light".to_string());
        let theme: ThemeId = serde_json::from_str(&format!("\"{theme_str}\"")).unwrap_or_default();

        let custom_theme = match (
            get_string(item, "custom_bg"),
            get_string(item, "custom_text"),
            get_string(item, "custom_text_muted"),
            get_string(item, "custom_accent"),
        ) {
            (Some(bg), Some(text), Some(text_muted), Some(accent)) => Some(CustomTheme {
                bg,
                text,
                text_muted,
                accent,
            }),
            _ => None,
        };

        let view_count = item
            .get("view_count")
            .and_then(|v| v.as_n().ok())
            .and_then(|s| s.parse::<i64>().ok());

        Ok(Profile {
            id: profile_id.to_string(),
            slug: get_string(item, "slug"),
            email: Some(email),
            display_name: get_string(item, "display_name"),
            tagline: get_string(item, "tagline"),
            phone: get_string(item, "phone"),
            location: get_string(item, "location"),
            pronouns: get_string(item, "pronouns"),
            image_url,
            og_image_url,
            theme,
            custom_theme,
            view_count,
            display_email: item
                .get("display_email")
                .and_then(|v| v.as_bool().ok())
                .copied()
                .unwrap_or(true),
            links: sorted_links,
            created_at: get_string(item, "created_at").unwrap_or_else(|| "unknown".to_string()),
            updated_at: get_string(item, "updated_at").unwrap_or_else(|| "unknown".to_string()),
        })
    }

    /// Create or update a profile. Resolves (or assigns, on first write)
    /// the caller's profile ID via the `EMAIL#` pointer rather than
    /// deriving it from the email — see `get_or_create_profile_id_for_email`.
    pub async fn upsert_profile(&self, req: &ProfileUpdateRequest) -> Result<Profile, AppError> {
        let profile_id = self.get_or_create_profile_id_for_email(&req.email).await?;
        let pk = format!("PROFILE#{profile_id}");
        let now = chrono_now();

        // Check if profile exists to preserve created_at
        let existing = self.get_profile_full(&profile_id).await.ok();
        let created_at = existing
            .as_ref()
            .map(|p| p.created_at.clone())
            .unwrap_or_else(|| now.clone());

        if existing.is_none() {
            // Usage-counter log line — queried by ApiStack's dashboard
            // (app-wide "profiles created" widget) via CloudWatch Logs
            // Insights. Only fires on genuine first-time creation, not
            // every subsequent edit.
            tracing::info!(metric = "profile_created", profile_id = %profile_id, "Profile created");
        }

        // Build profile item
        let mut item = std::collections::HashMap::new();
        item.insert("pk".to_string(), AttributeValue::S(pk.clone()));
        item.insert("sk".to_string(), AttributeValue::S(PROFILE_SK.to_string()));
        item.insert("email".to_string(), AttributeValue::S(req.email.clone()));
        item.insert(
            "theme".to_string(),
            AttributeValue::S(
                serde_json::to_string(&req.theme)
                    .unwrap_or_else(|_| "\"light\"".to_string())
                    .trim_matches('"')
                    .to_string(),
            ),
        );
        item.insert(
            "created_at".to_string(),
            AttributeValue::S(created_at.clone()),
        );
        item.insert("updated_at".to_string(), AttributeValue::S(now.clone()));

        item.insert(
            "display_email".to_string(),
            AttributeValue::Bool(req.display_email),
        );

        if let Some(ref name) = req.display_name {
            item.insert("display_name".to_string(), AttributeValue::S(name.clone()));
        }
        if let Some(ref tagline) = req.tagline {
            item.insert("tagline".to_string(), AttributeValue::S(tagline.clone()));
        }
        if let Some(ref phone) = req.phone {
            item.insert("phone".to_string(), AttributeValue::S(phone.clone()));
        }
        if let Some(ref location) = req.location {
            item.insert("location".to_string(), AttributeValue::S(location.clone()));
        }
        if let Some(ref pronouns) = req.pronouns {
            item.insert("pronouns".to_string(), AttributeValue::S(pronouns.clone()));
        }
        if let Some(ref custom_theme) = req.custom_theme {
            item.insert(
                "custom_bg".to_string(),
                AttributeValue::S(custom_theme.bg.clone()),
            );
            item.insert(
                "custom_text".to_string(),
                AttributeValue::S(custom_theme.text.clone()),
            );
            item.insert(
                "custom_text_muted".to_string(),
                AttributeValue::S(custom_theme.text_muted.clone()),
            );
            item.insert(
                "custom_accent".to_string(),
                AttributeValue::S(custom_theme.accent.clone()),
            );
        }

        // Preserve image_key if it exists — read the actual stored key
        // rather than re-deriving it, since upload_image no longer uses a
        // deterministic `images/{profile_id}` shape (each upload gets a
        // unique key to cache-bust CloudFront without paying for
        // invalidations).
        if let Some(existing_key) = self.get_image_key(&profile_id).await? {
            item.insert("image_key".to_string(), AttributeValue::S(existing_key));
        }

        // On genuine first-time creation, pre-generate the composite OG
        // share image (logo + QR + placeholder avatar, since no photo has
        // been uploaded yet) so a shared link unfurls with something better
        // than nothing right away. On every later edit, just preserve the
        // existing key — this item write is a full overwrite, and the OG
        // image itself only changes when the photo or slug do (see
        // upload_image and set_slug).
        if existing.is_none() {
            let og_bytes = og_image::generate(&profile_id, &self.site_url, None, None)?;
            let og_key = format!("images/{profile_id}/{}-og", generate_image_version());
            self.s3
                .put_object()
                .bucket(&self.bucket_name)
                .key(&og_key)
                .body(og_bytes.into())
                .content_type("image/png")
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("S3 OG image upload failed: {e}")))?;
            item.insert("og_image_key".to_string(), AttributeValue::S(og_key));
        } else if let Some(existing_og_key) = self.get_og_image_key(&profile_id).await? {
            item.insert(
                "og_image_key".to_string(),
                AttributeValue::S(existing_og_key),
            );
        }

        // Preserve slug if set — it's managed via a separate endpoint
        // (`set_slug`) and never part of this request, so it must be
        // explicitly carried over or this full-item PutItem would silently
        // wipe it on every profile save.
        if let Some(ref existing_profile) = existing
            && let Some(ref slug) = existing_profile.slug
        {
            item.insert("slug".to_string(), AttributeValue::S(slug.clone()));
        }

        // Write profile item
        self.dynamo
            .put_item()
            .table_name(&self.table_name)
            .set_item(Some(item))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB put failed: {e}")))?;

        // Delete existing link items
        self.delete_links(&pk).await?;

        // Write new link items
        for (i, link) in req.links.iter().enumerate() {
            let sk = format!("{LINK_PREFIX}{i:04}");
            let mut link_item = std::collections::HashMap::new();
            link_item.insert("pk".to_string(), AttributeValue::S(pk.clone()));
            link_item.insert("sk".to_string(), AttributeValue::S(sk));
            link_item.insert(
                "platform".to_string(),
                AttributeValue::S(
                    serde_json::to_string(&link.platform)
                        .unwrap_or_else(|_| "\"custom\"".to_string())
                        .trim_matches('"')
                        .to_string(),
                ),
            );
            link_item.insert("url".to_string(), AttributeValue::S(link.url.clone()));
            if let Some(ref label) = link.label {
                link_item.insert("label".to_string(), AttributeValue::S(label.clone()));
            }

            self.dynamo
                .put_item()
                .table_name(&self.table_name)
                .set_item(Some(link_item))
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("DynamoDB put link failed: {e}")))?;
        }

        // Return the full profile (self-view — the caller is the owner,
        // authorization was already checked by the router before calling
        // this method).
        self.get_profile_full(&profile_id).await
    }

    /// Claims, changes, or clears the authenticated user's custom slug
    /// (`new_slug = None` clears it). Requires an existing profile — a slug
    /// can't be claimed before the owner has saved one.
    ///
    /// The new slug's `SLUG#` pointer is claimed *before* the profile item
    /// is updated to reference it, so a profile's `slug` attribute can never
    /// point at a pointer that doesn't exist. The old pointer (if any) is
    /// released last, best-effort — a failure there leaves a harmless
    /// orphaned pointer rather than corrupting the new claim.
    pub async fn set_slug(&self, email: &str, new_slug: Option<&str>) -> Result<Profile, AppError> {
        let profile_id = self
            .get_profile_id_for_email(email)
            .await?
            .ok_or(AppError::NotFound)?;
        let profile = self.get_profile_full(&profile_id).await?;
        let existing_slug = profile.slug.clone();

        let normalized_new = match new_slug {
            Some(s) => {
                validate_slug(s).map_err(AppError::BadRequest)?;
                Some(s.trim().to_lowercase())
            }
            None => None,
        };

        if normalized_new == existing_slug {
            return Ok(profile);
        }

        let pk = format!("PROFILE#{profile_id}");

        match &normalized_new {
            Some(slug) => {
                let slug_pk = Self::slug_pk(slug);
                let mut item = std::collections::HashMap::new();
                item.insert("pk".to_string(), AttributeValue::S(slug_pk));
                item.insert("sk".to_string(), AttributeValue::S(SLUG_SK.to_string()));
                item.insert(
                    "profile_id".to_string(),
                    AttributeValue::S(profile_id.clone()),
                );

                let put_result = self
                    .dynamo
                    .put_item()
                    .table_name(&self.table_name)
                    .set_item(Some(item))
                    .condition_expression("attribute_not_exists(pk)")
                    .send()
                    .await;

                match put_result {
                    Ok(_) => {}
                    Err(e) => {
                        if !e
                            .as_service_error()
                            .is_some_and(|se| se.is_conditional_check_failed_exception())
                        {
                            return Err(AppError::Internal(format!(
                                "DynamoDB slug pointer put failed: {e}"
                            )));
                        }

                        // The pointer already exists. If it's ours — e.g.
                        // the profile's own `slug` attribute fell out of
                        // sync with its pointer, which could happen from a
                        // partial failure between the two writes below, or
                        // from a full-item profile save that didn't carry
                        // `slug` forward — re-claiming it is a self-healing
                        // no-op, not a real conflict. Only reject if some
                        // other profile actually owns it.
                        let owner = self.get_profile_id_for_slug(slug).await?;
                        if owner.as_deref() != Some(profile_id.as_str()) {
                            return Err(AppError::Conflict(
                                "That custom URL is already taken".to_string(),
                            ));
                        }
                    }
                }

                self.dynamo
                    .update_item()
                    .table_name(&self.table_name)
                    .key("pk", AttributeValue::S(pk))
                    .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
                    .update_expression("SET slug = :s, updated_at = :ua")
                    .expression_attribute_values(":s", AttributeValue::S(slug.clone()))
                    .expression_attribute_values(":ua", AttributeValue::S(chrono_now()))
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(format!("DynamoDB update failed: {e}")))?;
            }
            None => {
                self.dynamo
                    .update_item()
                    .table_name(&self.table_name)
                    .key("pk", AttributeValue::S(pk))
                    .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
                    .update_expression("REMOVE slug SET updated_at = :ua")
                    .expression_attribute_values(":ua", AttributeValue::S(chrono_now()))
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(format!("DynamoDB update failed: {e}")))?;
            }
        }

        // Release the old pointer last, best-effort — a leftover pointer
        // just keeps that old slug reserved, it doesn't corrupt anything.
        if let Some(old_slug) = existing_slug {
            let old_pk = Self::slug_pk(&old_slug);
            if let Err(e) = self
                .dynamo
                .delete_item()
                .table_name(&self.table_name)
                .key("pk", AttributeValue::S(old_pk))
                .key("sk", AttributeValue::S(SLUG_SK.to_string()))
                .send()
                .await
            {
                tracing::warn!(profile_id = %profile_id, old_slug = %old_slug, error = %e, "Failed to release old slug pointer");
            }
        }

        // The OG share image's QR caption bakes in the slug (see
        // `og_image::draw_qr_label`), so it needs a forced refresh whenever
        // the slug changes — otherwise a shared card link would keep
        // unfurling with a stale caption until something else (e.g. a photo
        // change) happened to regenerate it. Best-effort: a transient
        // failure here shouldn't fail the slug save itself.
        if let Err(e) = self.regenerate_og_image(&profile_id, true).await {
            tracing::warn!(profile_id = %profile_id, error = %e, "Failed to regenerate OG image after slug change");
        }

        self.get_profile_full(&profile_id).await
    }

    /// Delete a profile, all its link items, its `EMAIL#` pointer, and the
    /// user's Cognito account. The caller's own access token is passed through
    /// to Cognito's `DeleteUser` API — no admin credentials are required.
    pub async fn delete_profile(&self, email: &str, access_token: &str) -> Result<(), AppError> {
        let profile_id = self
            .get_profile_id_for_email(email)
            .await?
            .ok_or(AppError::NotFound)?;
        let pk = format!("PROFILE#{profile_id}");

        // Query all items for this profile
        let result = self
            .dynamo
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("pk = :pk")
            .expression_attribute_values(":pk", AttributeValue::S(pk.clone()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB query failed: {e}")))?;

        let items = result.items();
        if items.is_empty() {
            return Err(AppError::NotFound);
        }

        let profile_item = items
            .iter()
            .find(|item| get_string(item, "sk").as_deref() == Some(PROFILE_SK));
        let slug = profile_item.and_then(|item| get_string(item, "slug"));
        let image_key = profile_item.and_then(|item| get_string(item, "image_key"));

        // Delete all items
        for item in items {
            let sk = item
                .get("sk")
                .cloned()
                .unwrap_or_else(|| AttributeValue::S(String::new()));

            self.dynamo
                .delete_item()
                .table_name(&self.table_name)
                .key("pk", AttributeValue::S(pk.clone()))
                .key("sk", sk)
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("DynamoDB delete failed: {e}")))?;
        }

        // Delete the EMAIL# pointer so a future signup gets a fresh
        // randomly-assigned ID rather than reusing the deleted one.
        self.dynamo
            .delete_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(Self::email_pk(email)))
            .key("sk", AttributeValue::S(EMAIL_POINTER_SK.to_string()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB pointer delete failed: {e}")))?;

        // Delete the SLUG# pointer too, if one was claimed — otherwise the
        // slug would stay permanently reserved by a profile that no longer
        // exists.
        if let Some(slug) = slug {
            self.dynamo
                .delete_item()
                .table_name(&self.table_name)
                .key("pk", AttributeValue::S(Self::slug_pk(&slug)))
                .key("sk", AttributeValue::S(SLUG_SK.to_string()))
                .send()
                .await
                .map_err(|e| {
                    AppError::Internal(format!("DynamoDB slug pointer delete failed: {e}"))
                })?;
        }

        // Delete profile image from S3 if one was ever uploaded — its key
        // is whatever upload_image last stored, not derivable from
        // profile_id alone (each upload gets a unique cache-busting key).
        if let Some(image_key) = image_key {
            let _ = self
                .s3
                .delete_object()
                .bucket(&self.bucket_name)
                .key(&image_key)
                .send()
                .await;
        }

        // Delete the Cognito user using their own access token — no admin
        // credentials required. Cognito validates the token, so a forged or
        // expired token is rejected before any user is deleted.
        self.cognito
            .delete_user()
            .access_token(access_token)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("Cognito user deletion failed: {e}")))?;

        Ok(())
    }

    /// Creates a new connection under the authenticated user's own email
    /// partition — never under a profile's `PROFILE#` partition, since a
    /// connection belongs to the *account* that saved it, not to any
    /// profile (including the caller's own, if they have one).
    pub async fn create_connection(
        &self,
        email: &str,
        req: &ConnectionCreateRequest,
    ) -> Result<Connection, AppError> {
        let pk = Self::email_pk(email);
        let id = generate_connection_id();
        let sk = format!("{CONNECTION_PREFIX}{id}");
        let created_at = chrono_now();

        let mut item = std::collections::HashMap::new();
        item.insert("pk".to_string(), AttributeValue::S(pk));
        item.insert("sk".to_string(), AttributeValue::S(sk));
        item.insert("name".to_string(), AttributeValue::S(req.name.clone()));
        if let Some(ref notes) = req.notes {
            item.insert("notes".to_string(), AttributeValue::S(notes.clone()));
        }
        if let Some(ref event) = req.event {
            item.insert("event".to_string(), AttributeValue::S(event.clone()));
        }
        if let Some(ref photo_url) = req.photo_url {
            item.insert(
                "photo_url".to_string(),
                AttributeValue::S(photo_url.clone()),
            );
        }
        if let Some(ref source_profile_id) = req.source_profile_id {
            item.insert(
                "source_profile_id".to_string(),
                AttributeValue::S(source_profile_id.clone()),
            );
        }
        item.insert(
            "created_at".to_string(),
            AttributeValue::S(created_at.clone()),
        );

        self.dynamo
            .put_item()
            .table_name(&self.table_name)
            .set_item(Some(item))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB put connection failed: {e}")))?;

        Ok(Connection {
            id,
            name: req.name.clone(),
            notes: req.notes.clone(),
            event: req.event.clone(),
            photo_url: req.photo_url.clone(),
            source_profile_id: req.source_profile_id.clone(),
            created_at,
        })
    }

    /// Updates the name/notes/event of one of the authenticated user's own
    /// connections. Scoped to their own email partition, so a caller can
    /// never edit another user's connection. Preserves `photo_url`,
    /// `source_profile_id`, and `created_at` from the existing item — those
    /// are set once at creation time and not editable here.
    pub async fn update_connection(
        &self,
        email: &str,
        connection_id: &str,
        req: &ConnectionUpdateRequest,
    ) -> Result<Connection, AppError> {
        let pk = Self::email_pk(email);
        let sk = format!("{CONNECTION_PREFIX}{connection_id}");

        let existing = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk.clone()))
            .key("sk", AttributeValue::S(sk.clone()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?
            .item
            .ok_or(AppError::NotFound)?;

        let photo_url = get_string(&existing, "photo_url");
        let source_profile_id = get_string(&existing, "source_profile_id");
        let created_at = get_string(&existing, "created_at").unwrap_or_else(chrono_now);

        let mut item = std::collections::HashMap::new();
        item.insert("pk".to_string(), AttributeValue::S(pk));
        item.insert("sk".to_string(), AttributeValue::S(sk));
        item.insert("name".to_string(), AttributeValue::S(req.name.clone()));
        if let Some(ref notes) = req.notes {
            item.insert("notes".to_string(), AttributeValue::S(notes.clone()));
        }
        if let Some(ref event) = req.event {
            item.insert("event".to_string(), AttributeValue::S(event.clone()));
        }
        if let Some(ref photo_url) = photo_url {
            item.insert(
                "photo_url".to_string(),
                AttributeValue::S(photo_url.clone()),
            );
        }
        if let Some(ref source_profile_id) = source_profile_id {
            item.insert(
                "source_profile_id".to_string(),
                AttributeValue::S(source_profile_id.clone()),
            );
        }
        item.insert(
            "created_at".to_string(),
            AttributeValue::S(created_at.clone()),
        );

        self.dynamo
            .put_item()
            .table_name(&self.table_name)
            .set_item(Some(item))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB put connection failed: {e}")))?;

        Ok(Connection {
            id: connection_id.to_string(),
            name: req.name.clone(),
            notes: req.notes.clone(),
            event: req.event.clone(),
            photo_url,
            source_profile_id,
            created_at,
        })
    }

    /// Lists every connection the authenticated user has saved, newest
    /// first. Scoped to their own email partition — this query can never
    /// return another user's connections.
    pub async fn list_connections(&self, email: &str) -> Result<Vec<Connection>, AppError> {
        let pk = Self::email_pk(email);

        let result = self
            .dynamo
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("pk = :pk AND begins_with(sk, :prefix)")
            .expression_attribute_values(":pk", AttributeValue::S(pk))
            .expression_attribute_values(
                ":prefix",
                AttributeValue::S(CONNECTION_PREFIX.to_string()),
            )
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB query failed: {e}")))?;

        let mut connections: Vec<Connection> = result
            .items()
            .iter()
            .filter_map(parse_connection_item)
            .collect();

        connections.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(connections)
    }

    /// Deletes one of the authenticated user's own connections. Scoped to
    /// their own email partition, so a caller can never delete another
    /// user's connection — there's no id-only lookup path that could allow
    /// cross-account deletion. Deleting a nonexistent id is a silent no-op,
    /// matching DynamoDB's own DeleteItem semantics.
    pub async fn delete_connection(
        &self,
        email: &str,
        connection_id: &str,
    ) -> Result<(), AppError> {
        let pk = Self::email_pk(email);
        let sk = format!("{CONNECTION_PREFIX}{connection_id}");

        self.dynamo
            .delete_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(sk))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB delete connection failed: {e}")))?;

        Ok(())
    }

    /// Looks up the raw `image_key` attribute currently stored for a
    /// profile, if any. Unlike `Profile.image_url` (the computed,
    /// client-facing form), this is the actual S3 key — needed internally
    /// to preserve or replace it without guessing its shape.
    async fn get_image_key(&self, profile_id: &str) -> Result<Option<String>, AppError> {
        let pk = format!("PROFILE#{profile_id}");

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .projection_expression("image_key")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        Ok(result
            .item
            .as_ref()
            .and_then(|item| get_string(item, "image_key")))
    }

    /// Looks up the raw `og_image_key` attribute currently stored for a
    /// profile, if any — mirrors `get_image_key` above, for the composite
    /// OG share image rather than the raw uploaded photo.
    async fn get_og_image_key(&self, profile_id: &str) -> Result<Option<String>, AppError> {
        let pk = format!("PROFILE#{profile_id}");

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .projection_expression("og_image_key")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        Ok(result
            .item
            .as_ref()
            .and_then(|item| get_string(item, "og_image_key")))
    }

    /// Looks up the raw `slug` attribute currently stored for a profile, if
    /// any — mirrors `get_image_key` above, so callers that only need the
    /// slug (e.g. to caption a freshly-generated OG image) don't have to
    /// fetch the full profile.
    async fn get_slug(&self, profile_id: &str) -> Result<Option<String>, AppError> {
        let pk = format!("PROFILE#{profile_id}");

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .projection_expression("slug")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        Ok(result
            .item
            .as_ref()
            .and_then(|item| get_string(item, "slug")))
    }

    /// Enumerates every profile's ID in the table via a full Scan (filtered
    /// to profile items — the table also holds LINK#/POINTER/SLUG/
    /// CONNECTION# items sharing the same partitions). Used only by the
    /// manual OG-image regeneration job (see `bin/og_regen.rs`), an
    /// infrequent admin operation — not something the API itself ever
    /// calls, so an unindexed Scan here is fine.
    pub async fn list_all_profile_ids(&self) -> Result<Vec<String>, AppError> {
        let mut profile_ids = Vec::new();
        let mut exclusive_start_key = None;

        loop {
            let mut request = self
                .dynamo
                .scan()
                .table_name(&self.table_name)
                .filter_expression("sk = :sk")
                .expression_attribute_values(":sk", AttributeValue::S(PROFILE_SK.to_string()));

            if let Some(key) = exclusive_start_key {
                request = request.set_exclusive_start_key(Some(key));
            }

            let result = request
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("DynamoDB scan failed: {e}")))?;

            for item in result.items() {
                if let Some(pk) = get_string(item, "pk")
                    && let Some(profile_id) = pk.strip_prefix("PROFILE#")
                {
                    profile_ids.push(profile_id.to_string());
                }
            }

            exclusive_start_key = result.last_evaluated_key().cloned();
            if exclusive_start_key.is_none() {
                break;
            }
        }

        Ok(profile_ids)
    }

    /// Lists a compact summary of every profile in the table, for the
    /// admin-only "all profiles" view. Scans the whole table filtering to
    /// the `PROFILE` item of each profile (the same unindexed scan pattern
    /// `list_all_profile_ids` uses, fine at this app's scale and only ever
    /// reached by an allowlisted admin), then projects each item down to
    /// the handful of fields the admin table and its QR/3MF generators
    /// need.
    ///
    /// Emails here are the full stored values regardless of
    /// `display_email` — this is a server-authorized admin view, so the
    /// row is built directly rather than through `to_public()`.
    pub async fn list_all_profiles(&self) -> Result<Vec<AdminUser>, AppError> {
        let mut users = Vec::new();
        let mut exclusive_start_key = None;

        loop {
            let mut request = self
                .dynamo
                .scan()
                .table_name(&self.table_name)
                .filter_expression("sk = :sk")
                .expression_attribute_values(":sk", AttributeValue::S(PROFILE_SK.to_string()));

            if let Some(key) = exclusive_start_key {
                request = request.set_exclusive_start_key(Some(key));
            }

            let result = request
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("DynamoDB scan failed: {e}")))?;

            for item in result.items() {
                let Some(pk) = get_string(item, "pk") else {
                    continue;
                };
                let Some(profile_id) = pk.strip_prefix("PROFILE#") else {
                    continue;
                };

                let image_url = get_string(item, "image_key")
                    .map(|key| format!("{}/{}", self.image_base_url, key));
                let view_count = item
                    .get("view_count")
                    .and_then(|v| v.as_n().ok())
                    .and_then(|s| s.parse::<i64>().ok());

                users.push(AdminUser {
                    id: profile_id.to_string(),
                    email: get_string(item, "email"),
                    slug: get_string(item, "slug"),
                    display_name: get_string(item, "display_name"),
                    pronouns: get_string(item, "pronouns"),
                    image_url,
                    view_count,
                    created_at: get_string(item, "created_at")
                        .unwrap_or_else(|| "unknown".to_string()),
                });
            }

            exclusive_start_key = result.last_evaluated_key().cloned();
            if exclusive_start_key.is_none() {
                break;
            }
        }

        // Newest first — a reasonable default ordering for an admin
        // scanning recent sign-ups. created_at is an ISO-8601 string, so a
        // plain descending lexical sort is chronological.
        users.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(users)
    }

    /// Regenerates a single profile's composite OG share image — used by
    /// the manual bulk regeneration job (`bin/og_regen.rs`), and safe to
    /// call per-profile with concurrency from a Step Functions Map state.
    ///
    /// Skips (returns `Ok(false)`) if the profile already has a composite
    /// and `force` is `false` — this is what makes a `force: false` run
    /// naturally resumable: re-running it after a partial failure only
    /// picks up profiles that still don't have one. Pass `force: true` to
    /// regenerate everyone regardless (e.g. after a layout change to
    /// `og_image::generate`).
    ///
    /// Always mints a fresh key (never overwrites one in place) so
    /// CloudFront's aggressive `/images/*` caching can't keep serving a
    /// stale composite after a `force` refresh — the old object, if any, is
    /// deleted best-effort afterward.
    pub async fn regenerate_og_image(
        &self,
        profile_id: &str,
        force: bool,
    ) -> Result<bool, AppError> {
        let pk = format!("PROFILE#{profile_id}");

        let result = self
            .dynamo
            .get_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk.clone()))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .projection_expression("image_key, og_image_key, slug")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB get failed: {e}")))?;

        let item = result.item.ok_or(AppError::NotFound)?;
        let image_key = get_string(&item, "image_key");
        let old_og_image_key = get_string(&item, "og_image_key");
        let slug = get_string(&item, "slug");

        if old_og_image_key.is_some() && !force {
            return Ok(false);
        }

        let photo_bytes = match &image_key {
            Some(key) => {
                let object = self
                    .s3
                    .get_object()
                    .bucket(&self.bucket_name)
                    .key(key)
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(format!("S3 get failed: {e}")))?;
                let bytes = object
                    .body
                    .collect()
                    .await
                    .map_err(|e| AppError::Internal(format!("Failed to read S3 object: {e}")))?
                    .into_bytes();
                Some(bytes.to_vec())
            }
            None => None,
        };

        let og_bytes = og_image::generate(
            profile_id,
            &self.site_url,
            slug.as_deref(),
            photo_bytes.as_deref(),
        )?;
        let new_og_key = format!("images/{profile_id}/{}-og", generate_image_version());

        self.s3
            .put_object()
            .bucket(&self.bucket_name)
            .key(&new_og_key)
            .body(og_bytes.into())
            .content_type("image/png")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("S3 OG image upload failed: {e}")))?;

        self.dynamo
            .update_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .update_expression("SET og_image_key = :ok")
            .expression_attribute_values(":ok", AttributeValue::S(new_og_key.clone()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB update failed: {e}")))?;

        if let Some(old_key) = old_og_image_key
            && old_key != new_og_key
            && let Err(e) = self
                .s3
                .delete_object()
                .bucket(&self.bucket_name)
                .key(&old_key)
                .send()
                .await
        {
            tracing::warn!(profile_id = %profile_id, old_key = %old_key, error = %e, "Failed to delete old OG image during regeneration");
        }

        Ok(true)
    }

    /// Upload a profile image to S3.
    ///
    /// The declared `content_type` from the client is never trusted for
    /// storage — we sniff the actual image bytes (magic numbers) and only
    /// accept a fixed allow-list of raster formats. This prevents uploading
    /// SVG/HTML/script content mislabeled as an image, which could lead to
    /// stored XSS if the bucket or serving path is ever misconfigured.
    ///
    /// Each upload gets a fresh, uniquely-named key
    /// (`images/{profile_id}/{version}`) rather than overwriting a fixed
    /// key — CloudFront caches `/images/*` aggressively (see
    /// FrontendStack), so overwriting in place meant a re-upload could
    /// stay stale behind the cache until it expired, and paying for an
    /// explicit invalidation on every upload isn't worth it. The old key
    /// (if any) is deleted from S3 best-effort after the new one is live.
    pub async fn upload_image(
        &self,
        email: &str,
        image_data: &[u8],
        content_type: &str,
    ) -> Result<String, AppError> {
        let profile_id = self.get_or_create_profile_id_for_email(email).await?;
        let old_image_key = self.get_image_key(&profile_id).await?;
        let old_og_image_key = self.get_og_image_key(&profile_id).await?;
        let slug = self.get_slug(&profile_id).await?;
        let image_key = format!("images/{profile_id}/{}", generate_image_version());
        let og_image_key = format!("{image_key}-og");

        // Validate size (4MB max)
        const MAX_IMAGE_SIZE: usize = 4 * 1024 * 1024;
        if image_data.len() > MAX_IMAGE_SIZE {
            return Err(AppError::PayloadTooLarge(format!(
                "Image size {} bytes exceeds maximum of {} bytes",
                image_data.len(),
                MAX_IMAGE_SIZE
            )));
        }

        // Sniff the real content type from the file's magic bytes. Reject
        // anything outside our raster-image allow-list (SVG, HTML, etc. are
        // never allowed, regardless of what content_type the client sent).
        let sniffed_content_type = sniff_image_content_type(image_data).ok_or_else(|| {
            AppError::BadRequest(
                "Unsupported image format. Only JPEG, PNG, and WebP are allowed.".to_string(),
            )
        })?;

        // The client-declared content_type must agree with the sniffed type,
        // otherwise reject — this catches mismatched extensions/labels.
        if !content_type_matches(content_type, sniffed_content_type) {
            return Err(AppError::BadRequest(
                "Declared content type does not match image data".to_string(),
            ));
        }

        // Upload to S3 using the sniffed (trusted) content type, never the
        // client-supplied string.
        self.s3
            .put_object()
            .bucket(&self.bucket_name)
            .key(&image_key)
            .body(image_data.to_vec().into())
            .content_type(sniffed_content_type)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("S3 upload failed: {e}")))?;

        // Regenerate the composite OG share image with the new photo, using
        // the same {version}-og key convention as the placeholder generated
        // at profile creation (see upsert_profile).
        let og_bytes = og_image::generate(
            &profile_id,
            &self.site_url,
            slug.as_deref(),
            Some(image_data),
        )?;
        self.s3
            .put_object()
            .bucket(&self.bucket_name)
            .key(&og_image_key)
            .body(og_bytes.into())
            .content_type("image/png")
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("S3 OG image upload failed: {e}")))?;

        // Update the profile item with both image keys
        let pk = format!("PROFILE#{profile_id}");
        self.dynamo
            .update_item()
            .table_name(&self.table_name)
            .key("pk", AttributeValue::S(pk))
            .key("sk", AttributeValue::S(PROFILE_SK.to_string()))
            .update_expression("SET image_key = :ik, og_image_key = :ok, updated_at = :ua")
            .expression_attribute_values(":ik", AttributeValue::S(image_key.clone()))
            .expression_attribute_values(":ok", AttributeValue::S(og_image_key.clone()))
            .expression_attribute_values(":ua", AttributeValue::S(chrono_now()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB update failed: {e}")))?;

        // Release the old objects last, best-effort — the profile item
        // already points at the new keys, so a failure here just leaves a
        // harmless orphaned object rather than corrupting anything.
        if let Some(old_key) = old_image_key
            && old_key != image_key
            && let Err(e) = self
                .s3
                .delete_object()
                .bucket(&self.bucket_name)
                .key(&old_key)
                .send()
                .await
        {
            tracing::warn!(profile_id = %profile_id, old_key = %old_key, error = %e, "Failed to delete old profile image");
        }
        if let Some(old_og_key) = old_og_image_key
            && old_og_key != og_image_key
            && let Err(e) = self
                .s3
                .delete_object()
                .bucket(&self.bucket_name)
                .key(&old_og_key)
                .send()
                .await
        {
            tracing::warn!(profile_id = %profile_id, old_key = %old_og_key, error = %e, "Failed to delete old OG image");
        }

        let image_url = format!("{}/{}", self.image_base_url, image_key);
        Ok(image_url)
    }

    /// Delete all link items for a given PK.
    async fn delete_links(&self, pk: &str) -> Result<(), AppError> {
        let result = self
            .dynamo
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("pk = :pk AND begins_with(sk, :prefix)")
            .expression_attribute_values(":pk", AttributeValue::S(pk.to_string()))
            .expression_attribute_values(":prefix", AttributeValue::S(LINK_PREFIX.to_string()))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("DynamoDB query failed: {e}")))?;

        for item in result.items() {
            let sk = item
                .get("sk")
                .cloned()
                .unwrap_or_else(|| AttributeValue::S(String::new()));

            self.dynamo
                .delete_item()
                .table_name(&self.table_name)
                .key("pk", AttributeValue::S(pk.to_string()))
                .key("sk", sk)
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("DynamoDB delete link failed: {e}")))?;
        }

        Ok(())
    }
}

fn parse_link_item(item: &std::collections::HashMap<String, AttributeValue>) -> Option<SocialLink> {
    let platform_str = get_string(item, "platform")?;
    let url = get_string(item, "url")?;
    let label = get_string(item, "label");

    let platform: SocialPlatform =
        serde_json::from_str(&format!("\"{platform_str}\"")).unwrap_or(SocialPlatform::Custom);

    Some(SocialLink {
        platform,
        url,
        label,
    })
}

fn parse_connection_item(
    item: &std::collections::HashMap<String, AttributeValue>,
) -> Option<Connection> {
    let sk = get_string(item, "sk")?;
    let id = sk.strip_prefix(CONNECTION_PREFIX)?.to_string();
    let name = get_string(item, "name")?;

    Some(Connection {
        id,
        name,
        notes: get_string(item, "notes"),
        event: get_string(item, "event"),
        photo_url: get_string(item, "photo_url"),
        source_profile_id: get_string(item, "source_profile_id"),
        created_at: get_string(item, "created_at").unwrap_or_else(|| "unknown".to_string()),
    })
}

fn get_string(
    item: &std::collections::HashMap<String, AttributeValue>,
    key: &str,
) -> Option<String> {
    item.get(key).and_then(|v| v.as_s().ok()).cloned()
}

/// Inspects the leading bytes of image data and returns the sniffed MIME
/// type if it matches one of our allowed raster formats. Returns `None` for
/// anything else (including SVG, HTML, or any other file type) — this is a
/// strict allow-list, not a blocklist.
fn sniff_image_content_type(data: &[u8]) -> Option<&'static str> {
    const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF];
    const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const WEBP_RIFF: &[u8] = b"RIFF";
    const WEBP_MAGIC: &[u8] = b"WEBP";

    if data.starts_with(JPEG_MAGIC) {
        return Some("image/jpeg");
    }

    if data.starts_with(PNG_MAGIC) {
        return Some("image/png");
    }

    // WebP: "RIFF" + 4-byte size + "WEBP"
    if data.len() >= 12 && data.starts_with(WEBP_RIFF) && &data[8..12] == WEBP_MAGIC {
        return Some("image/webp");
    }

    None
}

/// Checks whether a client-declared content type is consistent with the
/// sniffed (trusted) content type. Allows minor variations like
/// "image/jpg" vs "image/jpeg".
fn content_type_matches(declared: &str, sniffed: &str) -> bool {
    let declared = declared.trim().to_lowercase();
    match sniffed {
        "image/jpeg" => declared == "image/jpeg" || declared == "image/jpg",
        other => declared == other,
    }
}

/// Returns current UTC timestamp in ISO 8601 format.
/// Using a simple approach without chrono dependency.
fn chrono_now() -> String {
    // We'll use std::time for a UTC timestamp
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    // Simple ISO 8601 UTC format
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;

    // Calculate year, month, day from days since epoch
    let (year, month, day) = days_to_date(days);

    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod email_pk_tests {
    use super::ProfileStore;

    #[test]
    fn lowercases_and_trims() {
        assert_eq!(
            ProfileStore::email_pk("  Test@Example.COM  "),
            "EMAIL#test@example.com"
        );
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            ProfileStore::email_pk("test@example.com"),
            ProfileStore::email_pk("Test@Example.com")
        );
    }
}

#[cfg(test)]
mod slug_pk_tests {
    use super::ProfileStore;

    #[test]
    fn lowercases_and_trims() {
        assert_eq!(
            ProfileStore::slug_pk("  Ada-Lovelace  "),
            "SLUG#ada-lovelace"
        );
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            ProfileStore::slug_pk("ada-lovelace"),
            ProfileStore::slug_pk("Ada-Lovelace")
        );
    }
}

#[cfg(test)]
mod resolve_profile_id_tests {
    use super::ProfileStore;

    /// A `ProfileStore` backed by dummy (non-network) AWS SDK clients —
    /// sufficient for the plain-ID branch of `resolve_profile_id`, which
    /// never touches the network.
    fn test_store() -> ProfileStore {
        let dynamo_config = aws_sdk_dynamodb::Config::builder()
            .behavior_version(aws_sdk_dynamodb::config::BehaviorVersion::latest())
            .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
            .credentials_provider(aws_sdk_dynamodb::config::Credentials::for_tests())
            .build();
        let s3_config = aws_sdk_s3::Config::builder()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .credentials_provider(aws_sdk_s3::config::Credentials::for_tests())
            .build();
        let cognito_config = aws_sdk_cognitoidentityprovider::Config::builder()
            .behavior_version(aws_sdk_cognitoidentityprovider::config::BehaviorVersion::latest())
            .region(aws_sdk_cognitoidentityprovider::config::Region::new(
                "us-east-1",
            ))
            .credentials_provider(aws_sdk_cognitoidentityprovider::config::Credentials::for_tests())
            .build();

        ProfileStore::new(
            aws_sdk_dynamodb::Client::from_conf(dynamo_config),
            aws_sdk_s3::Client::from_conf(s3_config),
            aws_sdk_cognitoidentityprovider::Client::from_conf(cognito_config),
            "test-table".to_string(),
            "test-bucket".to_string(),
            "".to_string(),
            "".to_string(),
        )
    }

    #[tokio::test]
    async fn plain_id_is_returned_unchanged_without_a_slug_lookup() {
        let store = test_store();
        let resolved = store
            .resolve_profile_id("abc123def456")
            .await
            .expect("should not touch the network for a non-@ input");
        assert_eq!(resolved, "abc123def456");
    }
}

#[cfg(test)]
mod parse_connection_item_tests {
    use super::*;
    use std::collections::HashMap;

    fn item_with(pairs: &[(&str, &str)]) -> HashMap<String, AttributeValue> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), AttributeValue::S(v.to_string())))
            .collect()
    }

    #[test]
    fn parses_a_minimal_item() {
        let item = item_with(&[
            ("sk", "CONNECTION#abc123def456"),
            ("name", "Grace Hopper"),
            ("created_at", "2024-01-01T00:00:00Z"),
        ]);
        let connection = parse_connection_item(&item).expect("should parse");
        assert_eq!(connection.id, "abc123def456");
        assert_eq!(connection.name, "Grace Hopper");
        assert_eq!(connection.notes, None);
        assert_eq!(connection.event, None);
    }

    #[test]
    fn parses_a_full_item() {
        let item = item_with(&[
            ("sk", "CONNECTION#abc123def456"),
            ("name", "Grace Hopper"),
            ("notes", "Follow up re: COBOL"),
            ("event", "AWS re:Invent"),
            ("photo_url", "/images/xyz789"),
            ("source_profile_id", "xyz789"),
            ("created_at", "2024-01-01T00:00:00Z"),
        ]);
        let connection = parse_connection_item(&item).expect("should parse");
        assert_eq!(connection.notes, Some("Follow up re: COBOL".to_string()));
        assert_eq!(connection.event, Some("AWS re:Invent".to_string()));
        assert_eq!(connection.photo_url, Some("/images/xyz789".to_string()));
        assert_eq!(connection.source_profile_id, Some("xyz789".to_string()));
    }

    #[test]
    fn returns_none_when_sk_is_not_a_connection_item() {
        // e.g. the POINTER item that shares the same pk — must never be
        // mistaken for a connection.
        let item = item_with(&[("sk", "POINTER"), ("profile_id", "abc123")]);
        assert!(parse_connection_item(&item).is_none());
    }

    #[test]
    fn returns_none_when_name_is_missing() {
        let item = item_with(&[
            ("sk", "CONNECTION#abc123def456"),
            ("created_at", "2024-01-01T00:00:00Z"),
        ]);
        assert!(parse_connection_item(&item).is_none());
    }
}

#[cfg(test)]
mod image_validation_tests {
    use super::*;

    #[test]
    fn sniffs_jpeg_magic_bytes() {
        let data = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(sniff_image_content_type(&data), Some("image/jpeg"));
    }

    #[test]
    fn sniffs_png_magic_bytes() {
        let data = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00];
        assert_eq!(sniff_image_content_type(&data), Some("image/png"));
    }

    #[test]
    fn sniffs_webp_magic_bytes() {
        let mut data = b"RIFF".to_vec();
        data.extend_from_slice(&[0, 0, 0, 0]); // size (unused by sniffer)
        data.extend_from_slice(b"WEBP");
        assert_eq!(sniff_image_content_type(&data), Some("image/webp"));
    }

    #[test]
    fn rejects_svg_disguised_as_image() {
        let data = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
        assert_eq!(sniff_image_content_type(data), None);
    }

    #[test]
    fn rejects_html_content() {
        let data = b"<html><body><script>alert(1)</script></body></html>";
        assert_eq!(sniff_image_content_type(data), None);
    }

    #[test]
    fn rejects_empty_data() {
        assert_eq!(sniff_image_content_type(&[]), None);
    }

    #[test]
    fn rejects_truncated_webp_header() {
        // Starts with RIFF but too short to contain the WEBP marker.
        let data = b"RIFF\x00\x00";
        assert_eq!(sniff_image_content_type(data), None);
    }

    #[test]
    fn content_type_matches_exact() {
        assert!(content_type_matches("image/png", "image/png"));
        assert!(content_type_matches("image/webp", "image/webp"));
    }

    #[test]
    fn content_type_matches_jpeg_jpg_alias() {
        assert!(content_type_matches("image/jpg", "image/jpeg"));
        assert!(content_type_matches("IMAGE/JPEG", "image/jpeg"));
    }

    #[test]
    fn content_type_rejects_mismatch() {
        assert!(!content_type_matches("image/png", "image/jpeg"));
        assert!(!content_type_matches("image/svg+xml", "image/png"));
    }
}
