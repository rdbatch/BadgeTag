use aws_lambda_events::apigw::{ApiGatewayV2httpRequest, ApiGatewayV2httpResponse};
use lambda_runtime::{Error, LambdaEvent, service_fn};
use tracing::Instrument;

use badgetag_backend::auth::AuthConfig;
use badgetag_backend::router::route;
use badgetag_backend::store::ProfileStore;

struct AppState {
    store: ProfileStore,
    auth_config: AuthConfig,
    site_url: String,
}

async fn handler(
    state: &AppState,
    event: LambdaEvent<ApiGatewayV2httpRequest>,
) -> Result<ApiGatewayV2httpResponse, Error> {
    let (request, context) = event.into_parts();
    let request_id = context.request_id;

    // Every log line for this request carries request_id, so a client-side
    // RUM session's x-request-id header can be joined against these logs.
    let span = tracing::info_span!("request", request_id = %request_id);
    let mut response = route(&request, &state.store, &state.auth_config, &state.site_url)
        .instrument(span)
        .await;

    // Same-origin (via CloudFront's /api/* behavior), so the browser can
    // read this without any CORS configuration.
    if let Ok(value) = request_id.parse() {
        response.headers.insert("x-request-id", value);
    }

    Ok(response)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    badgetag_backend::init_tracing();

    let config = aws_config::load_from_env().await;
    let dynamo_client = aws_sdk_dynamodb::Client::new(&config);
    let s3_client = aws_sdk_s3::Client::new(&config);
    let cognito_client = aws_sdk_cognitoidentityprovider::Client::new(&config);

    let table_name = std::env::var("TABLE_NAME").expect("TABLE_NAME env var is required");
    let bucket_name = std::env::var("BUCKET_NAME").expect("BUCKET_NAME env var is required");
    let image_base_url =
        std::env::var("IMAGE_BASE_URL").expect("IMAGE_BASE_URL env var is required");
    let user_pool_id = std::env::var("USER_POOL_ID").expect("USER_POOL_ID env var is required");
    let user_pool_client_id =
        std::env::var("USER_POOL_CLIENT_ID").expect("USER_POOL_CLIENT_ID env var is required");
    let region = std::env::var("AWS_REGION")
        .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
        .expect("AWS_REGION env var is required");
    // Optional — empty until a custom domain is configured. Only used to
    // build absolute og:url/og:image values for the crawler-facing
    // /__og/profile/{id} route; see router::route.
    let site_url = std::env::var("SITE_URL").unwrap_or_default();

    let store = ProfileStore::new(
        dynamo_client,
        s3_client,
        cognito_client,
        table_name,
        bucket_name,
        image_base_url,
        site_url.clone(),
    );

    let auth_config = AuthConfig::new(user_pool_id, region, user_pool_client_id);

    let state = AppState {
        store,
        auth_config,
        site_url,
    };

    lambda_runtime::run(service_fn(|event| handler(&state, event))).await
}
