use aws_lambda_events::apigw::{ApiGatewayV2httpRequest, ApiGatewayV2httpResponse};
use aws_lambda_events::encodings::Body;
use aws_lambda_events::http::HeaderMap;
use base64::Engine;

use crate::admin::AdminAllowlist;
use crate::auth::{AuthConfig, authorize_profile_access, validate_token};
use crate::error::AppError;
use crate::models::{
    ConnectionCreateRequest, ConnectionUpdateRequest, ImageUploadRequest, ImageUploadResponse,
    OwnProfileResponse, ProfileDeleteRequest, ProfileUpdateRequest, SlugUpdateRequest,
    validate_slug,
};
use crate::og::render_og_html;
use crate::store::ProfileStore;

/// Route an incoming API Gateway request to the appropriate handler.
///
/// `site_url` is the app's public origin (e.g. `https://badgetag.me`, empty
/// if no custom domain is configured yet) — only used to build absolute
/// URLs for the crawler-facing `/__og/profile/{id}` route.
pub async fn route(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
    admin_allowlist: &AdminAllowlist,
    site_url: &str,
) -> ApiGatewayV2httpResponse {
    let start = std::time::Instant::now();
    let method = event.request_context.http.method.as_str();

    let path = event
        .raw_path
        .as_deref()
        .or(event.request_context.http.path.as_deref())
        .unwrap_or("/");

    tracing::info!(method, path, "Routing request");

    let result = match (method, path) {
        ("GET", "/api/profile/me") => {
            handle_get_own_profile(event, store, auth_config, admin_allowlist).await
        }
        ("GET", "/api/profile/admin/users") => {
            handle_list_all_profiles(event, store, auth_config, admin_allowlist).await
        }
        ("GET", p) if p.starts_with("/api/profile/") => {
            let id = p.strip_prefix("/api/profile/").unwrap_or_default();
            handle_get_profile(id, store).await
        }
        ("PUT", "/api/profile") => handle_upsert_profile(event, store, auth_config).await,
        ("DELETE", "/api/profile") => handle_delete_profile(event, store, auth_config).await,
        ("POST", "/api/profile/image") => handle_upload_image(event, store, auth_config).await,
        ("PUT", "/api/profile/slug") => handle_update_slug(event, store, auth_config).await,
        ("GET", "/api/connections") => handle_list_connections(event, store, auth_config).await,
        ("POST", "/api/connections") => handle_create_connection(event, store, auth_config).await,
        ("DELETE", p) if p.starts_with("/api/connections/") => {
            let id = p.strip_prefix("/api/connections/").unwrap_or_default();
            handle_delete_connection(event, store, auth_config, id).await
        }
        ("PATCH", p) if p.starts_with("/api/connections/") => {
            let id = p.strip_prefix("/api/connections/").unwrap_or_default();
            handle_update_connection(event, store, auth_config, id).await
        }
        ("GET", p) if p.starts_with("/__og/profile/") => {
            let id = p.strip_prefix("/__og/profile/").unwrap_or_default();
            Ok(handle_og_profile(id, store, site_url).await)
        }
        _ => Err(AppError::NotFound),
    };

    let response = match result {
        Ok(response) => response,
        Err(err) => err.to_response(),
    };

    // A structured completion log per request — queryable in CloudWatch
    // Logs Insights (see ApiStack's dashboard) for latency/error-rate
    // investigation beyond what the built-in Lambda/API Gateway metrics show.
    let duration_ms = start.elapsed().as_millis();
    tracing::info!(
        method,
        path,
        status = response.status_code,
        duration_ms,
        "Request completed"
    );

    response
}

/// GET /api/profile/{id} — public, no auth required. `id` may also be a
/// custom slug, prefixed with `@` (e.g. `@ada-lovelace`) — see
/// `ProfileStore::resolve_profile_id`.
async fn handle_get_profile(
    id: &str,
    store: &ProfileStore,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    if id.is_empty() {
        return Err(AppError::BadRequest("Profile ID is required".to_string()));
    }

    let profile_id = store.resolve_profile_id(id).await?;
    let profile = store.get_profile(&profile_id).await?;

    // Best-effort — a failed increment (e.g. a delete racing this request)
    // must never fail the fetch itself, since the profile was already read.
    if let Err(e) = store.increment_view_count(&profile_id).await {
        tracing::warn!(profile_id = %profile_id, error = %e, "Failed to increment view count");
    }

    // Usage-counter log line — queried by ApiStack's dashboard (app-wide
    // "public card views" widget) via CloudWatch Logs Insights, distinct
    // from the per-profile view_count surfaced on the edit page.
    tracing::info!(
        metric = "public_card_view",
        profile_id = %profile_id,
        "Public card viewed"
    );

    json_response(200, &profile)
}

/// GET /__og/profile/{id} — public, no auth required. Serves a minimal
/// HTML document with OpenGraph/Twitter meta tags for social-media
/// crawlers, since they never execute the client-rendered SPA's JS. Never
/// intended for a real browser — see the CloudFront Function that rewrites
/// crawler User-Agents' requests for `/p/{id}` to this path.
async fn handle_og_profile(
    id: &str,
    store: &ProfileStore,
    site_url: &str,
) -> ApiGatewayV2httpResponse {
    let result = async {
        let profile_id = store.resolve_profile_id(id).await?;
        store.get_profile(&profile_id).await
    }
    .await;

    let (status, html) = match result {
        Ok(profile) => (200, render_og_html(Some(&profile), id, site_url)),
        Err(AppError::NotFound) => (404, render_og_html(None, id, site_url)),
        Err(e) => {
            tracing::error!(profile_id = id, error = %e, "Failed to render OG HTML");
            (500, render_og_html(None, id, site_url))
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "text/html; charset=utf-8".parse().expect("valid header"),
    );

    ApiGatewayV2httpResponse {
        status_code: status,
        body: Some(Body::Text(html)),
        headers,
        ..Default::default()
    }
}

/// GET /api/profile/me — authenticated, returns the caller's own profile
/// in full (including `email`, `phone`, and the `display_email` flag
/// itself, regardless of its value) so the edit page has everything it
/// needs to render and let the owner change their visibility settings.
/// 404 if the authenticated user has no profile yet (frontend already
/// treats a non-ok response as "new user, leave the form blank").
async fn handle_get_own_profile(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
    admin_allowlist: &AdminAllowlist,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;
    let profile = store.get_profile_by_email(&token_email).await?;
    // The admin decision is made here, against the verified token email, so
    // the frontend never holds the allowlist — it only reads this flag to
    // decide whether to reveal the admin menu item and /admin route.
    let is_admin = admin_allowlist.is_admin(&token_email);
    json_response(200, &OwnProfileResponse { profile, is_admin })
}

/// GET /api/profile/admin/users — authenticated AND admin-only. Returns a
/// compact summary of every profile for the read-only admin view. Rejected
/// with 403 for any authenticated caller not on the `ADMIN_EMAILS`
/// allowlist, so hiding the page in the UI is never the only control — the
/// data itself is gated server-side against the verified token email.
async fn handle_list_all_profiles(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
    admin_allowlist: &AdminAllowlist,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    if !admin_allowlist.is_admin(&token_email) {
        tracing::warn!(
            token_email,
            "Non-admin user attempted to access the admin profile list"
        );
        return Err(AppError::Forbidden);
    }

    let users = store.list_all_profiles().await?;
    json_response(200, &users)
}

/// PUT /api/profile — authenticated, user can only modify their own profile
async fn handle_upsert_profile(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    let body = get_request_body(event)?;
    let req: ProfileUpdateRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    if req.email.is_empty() {
        return Err(AppError::BadRequest("Email is required".to_string()));
    }

    req.validate().map_err(AppError::BadRequest)?;

    // Ensure user can only modify their own profile
    authorize_profile_access(&token_email, &req.email)?;

    let profile = store.upsert_profile(&req).await?;
    json_response(200, &profile)
}

/// DELETE /api/profile — authenticated, user can only delete their own profile
async fn handle_delete_profile(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    let body = get_request_body(event)?;
    let req: ProfileDeleteRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    if req.email.is_empty() {
        return Err(AppError::BadRequest("Email is required".to_string()));
    }

    // Ensure user can only delete their own profile
    authorize_profile_access(&token_email, &req.email)?;

    store.delete_profile(&req.email, &req.access_token).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "application/json".parse().expect("valid header"),
    );

    Ok(ApiGatewayV2httpResponse {
        status_code: 204,
        body: None,
        headers,
        ..Default::default()
    })
}

/// POST /api/profile/image — authenticated, user can only upload to their own profile
async fn handle_upload_image(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    let body = get_request_body(event)?;
    let req: ImageUploadRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    // Decode base64 image data
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.image_data)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64 image data: {e}")))?;

    let image_url = store
        .upload_image(&token_email, &image_bytes, &req.content_type)
        .await?;

    json_response(200, &ImageUploadResponse { image_url })
}

/// PUT /api/profile/slug — authenticated, user can only set/clear their own
/// profile's custom slug. An empty or absent `slug` clears it.
async fn handle_update_slug(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    let body = get_request_body(event)?;
    let req: SlugUpdateRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    let slug = req.slug.as_deref().filter(|s| !s.trim().is_empty());
    if let Some(s) = slug {
        validate_slug(s).map_err(AppError::BadRequest)?;
    }

    let profile = store.set_slug(&token_email, slug).await?;
    json_response(200, &profile)
}

/// GET /api/connections — authenticated, lists the caller's saved
/// connections (people they've met), newest first.
async fn handle_list_connections(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;
    let connections = store.list_connections(&token_email).await?;
    json_response(200, &connections)
}

/// POST /api/connections — authenticated, saves a new connection under the
/// caller's own account (never under a profile, including the caller's own).
async fn handle_create_connection(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    let body = get_request_body(event)?;
    let req: ConnectionCreateRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    req.validate().map_err(AppError::BadRequest)?;

    let connection = store.create_connection(&token_email, &req).await?;
    json_response(200, &connection)
}

/// DELETE /api/connections/{id} — authenticated. Scoped to the caller's own
/// email partition in the store, so this can never delete another user's
/// connection regardless of what id is passed.
async fn handle_delete_connection(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
    id: &str,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    if id.is_empty() {
        return Err(AppError::BadRequest(
            "Connection ID is required".to_string(),
        ));
    }

    store.delete_connection(&token_email, id).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "application/json".parse().expect("valid header"),
    );

    Ok(ApiGatewayV2httpResponse {
        status_code: 204,
        body: None,
        headers,
        ..Default::default()
    })
}

/// PATCH /api/connections/{id} — authenticated. Scoped to the caller's own
/// email partition in the store, so this can never edit another user's
/// connection regardless of what id is passed.
async fn handle_update_connection(
    event: &ApiGatewayV2httpRequest,
    store: &ProfileStore,
    auth_config: &AuthConfig,
    id: &str,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let token_email = validate_token(event, auth_config).await?;

    if id.is_empty() {
        return Err(AppError::BadRequest(
            "Connection ID is required".to_string(),
        ));
    }

    let body = get_request_body(event)?;
    let req: ConnectionUpdateRequest = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid request body: {e}")))?;

    req.validate().map_err(AppError::BadRequest)?;

    let connection = store.update_connection(&token_email, id, &req).await?;
    json_response(200, &connection)
}

/// Extract the request body as a string, handling base64-encoded bodies.
fn get_request_body(event: &ApiGatewayV2httpRequest) -> Result<String, AppError> {
    match &event.body {
        Some(body) => {
            if event.is_base64_encoded {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(body.as_bytes())
                    .map_err(|e| {
                        AppError::BadRequest(format!("Failed to decode base64 body: {e}"))
                    })?;
                String::from_utf8(decoded)
                    .map_err(|e| AppError::BadRequest(format!("Body is not valid UTF-8: {e}")))
            } else {
                Ok(body.clone())
            }
        }
        None => Err(AppError::BadRequest("Request body is required".to_string())),
    }
}

/// Create a JSON response with the given status code and body.
fn json_response<T: serde::Serialize>(
    status: i64,
    data: &T,
) -> Result<ApiGatewayV2httpResponse, AppError> {
    let body = serde_json::to_string(data)
        .map_err(|e| AppError::Internal(format!("Failed to serialize response: {e}")))?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "application/json".parse().expect("valid header"),
    );

    Ok(ApiGatewayV2httpResponse {
        status_code: status,
        body: Some(Body::Text(body)),
        headers,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthConfig;
    use crate::store::ProfileStore;

    /// Builds a `ProfileStore` backed by dummy (non-network) AWS SDK
    /// clients — sufficient for tests that only need to exercise routing
    /// and auth short-circuiting *before* any AWS call would happen.
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

    fn test_auth_config() -> AuthConfig {
        AuthConfig::new(
            "us-east-1_ABC123".to_string(),
            "us-east-1".to_string(),
            "test-client-id".to_string(),
        )
    }

    fn test_admin_allowlist() -> AdminAllowlist {
        AdminAllowlist::from_csv("admin@example.com")
    }

    #[test]
    fn route_path_extraction() {
        let path = "/api/profile/abc123def456";
        let id = path.strip_prefix("/api/profile/").unwrap_or_default();
        assert_eq!(id, "abc123def456");
    }

    #[test]
    fn route_path_empty_id() {
        let path = "/api/profile/";
        let id = path.strip_prefix("/api/profile/").unwrap_or_default();
        assert_eq!(id, "");
    }

    #[tokio::test]
    async fn me_route_requires_auth() {
        let event = ApiGatewayV2httpRequest {
            raw_path: Some("/api/profile/me".to_string()),
            request_context: aws_lambda_events::apigw::ApiGatewayV2httpRequestContext {
                http: aws_lambda_events::apigw::ApiGatewayV2httpRequestContextHttpDescription {
                    method: aws_lambda_events::http::Method::GET,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let store = test_store();
        let auth_config = test_auth_config();
        let response = route(&event, &store, &auth_config, &test_admin_allowlist(), "").await;
        // No Authorization header — must be rejected before ever reaching
        // the store, and must not fall through to the public /{id} handler.
        assert_eq!(response.status_code, 401);
    }

    #[tokio::test]
    async fn connections_routes_require_auth() {
        let store = test_store();
        let auth_config = test_auth_config();

        for (method, path) in [
            (aws_lambda_events::http::Method::GET, "/api/connections"),
            (aws_lambda_events::http::Method::POST, "/api/connections"),
            (
                aws_lambda_events::http::Method::DELETE,
                "/api/connections/abc123",
            ),
            (
                aws_lambda_events::http::Method::PATCH,
                "/api/connections/abc123",
            ),
        ] {
            let event = ApiGatewayV2httpRequest {
                raw_path: Some(path.to_string()),
                request_context: aws_lambda_events::apigw::ApiGatewayV2httpRequestContext {
                    http: aws_lambda_events::apigw::ApiGatewayV2httpRequestContextHttpDescription {
                        method,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            };
            let response = route(&event, &store, &auth_config, &test_admin_allowlist(), "").await;
            assert_eq!(
                response.status_code, 401,
                "expected 401 for unauthenticated {path}"
            );
        }
    }

    #[tokio::test]
    async fn slug_route_requires_auth() {
        let event = ApiGatewayV2httpRequest {
            raw_path: Some("/api/profile/slug".to_string()),
            request_context: aws_lambda_events::apigw::ApiGatewayV2httpRequestContext {
                http: aws_lambda_events::apigw::ApiGatewayV2httpRequestContextHttpDescription {
                    method: aws_lambda_events::http::Method::PUT,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let store = test_store();
        let auth_config = test_auth_config();
        let response = route(&event, &store, &auth_config, &test_admin_allowlist(), "").await;
        assert_eq!(response.status_code, 401);
    }

    #[tokio::test]
    async fn admin_users_route_requires_auth() {
        // No Authorization header — the admin list must be rejected at the
        // auth gate (401) before the allowlist check, and must never fall
        // through to the public /api/profile/{id} handler.
        let event = ApiGatewayV2httpRequest {
            raw_path: Some("/api/profile/admin/users".to_string()),
            request_context: aws_lambda_events::apigw::ApiGatewayV2httpRequestContext {
                http: aws_lambda_events::apigw::ApiGatewayV2httpRequestContextHttpDescription {
                    method: aws_lambda_events::http::Method::GET,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let store = test_store();
        let auth_config = test_auth_config();
        let response = route(&event, &store, &auth_config, &test_admin_allowlist(), "").await;
        assert_eq!(response.status_code, 401);
    }

    #[test]
    fn og_route_path_extraction() {
        let path = "/__og/profile/abc123def456";
        let id = path.strip_prefix("/__og/profile/").unwrap_or_default();
        assert_eq!(id, "abc123def456");
    }

    #[test]
    fn json_response_produces_valid_output() {
        let data = serde_json::json!({"message": "ok"});
        let resp = json_response(200, &data).expect("should succeed");
        assert_eq!(resp.status_code, 200);
        if let Some(Body::Text(body)) = &resp.body {
            assert!(body.contains("message"));
            assert!(body.contains("ok"));
        } else {
            panic!("Expected text body");
        }
    }

    #[test]
    fn get_request_body_returns_error_when_none() {
        let event = ApiGatewayV2httpRequest {
            body: None,
            ..Default::default()
        };
        let result = get_request_body(&event);
        assert!(result.is_err());
    }

    #[test]
    fn get_request_body_returns_plain_text() {
        let event = ApiGatewayV2httpRequest {
            body: Some(r#"{"email":"test@example.com"}"#.to_string()),
            is_base64_encoded: false,
            ..Default::default()
        };
        let result = get_request_body(&event).expect("should succeed");
        assert_eq!(result, r#"{"email":"test@example.com"}"#);
    }

    #[test]
    fn get_request_body_decodes_base64() {
        let original = r#"{"email":"test@example.com"}"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(original);
        let event = ApiGatewayV2httpRequest {
            body: Some(encoded),
            is_base64_encoded: true,
            ..Default::default()
        };
        let result = get_request_body(&event).expect("should succeed");
        assert_eq!(result, original);
    }
}
