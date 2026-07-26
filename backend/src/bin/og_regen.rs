//! Manual, admin-only Lambda for bulk-regenerating profiles' composite OG
//! share images (see `og_image::generate`). Not exposed via API Gateway —
//! it's invoked directly, either by hand (`aws lambda invoke`) or as both
//! Lambda tasks in the `OgRegenStateMachine` Step Functions state machine
//! (see `infra/lib/api-stack.ts`): once for `List`, to enumerate every
//! profile, and once per item (with bounded concurrency) for `Regenerate`.
//!
//! There's no automatic trigger (no schedule, no S3 event) — this is
//! intentionally something a human starts on demand, e.g. after a layout
//! change to `og_image::generate` that should roll out to existing
//! profiles, or as a one-time backfill for profiles that predate the
//! composite feature entirely.

use lambda_runtime::{Error, LambdaEvent, service_fn};
use serde::{Deserialize, Serialize};

use badgetag_backend::store::ProfileStore;

#[derive(Deserialize)]
#[serde(tag = "action")]
enum Event {
    #[serde(rename = "list")]
    List,
    #[serde(rename = "regenerate")]
    Regenerate {
        profile_id: String,
        #[serde(default)]
        force: bool,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    List {
        profile_ids: Vec<String>,
    },
    Regenerate {
        profile_id: String,
        regenerated: bool,
    },
}

async fn handler(store: &ProfileStore, event: LambdaEvent<Event>) -> Result<Response, Error> {
    match event.payload {
        Event::List => {
            let profile_ids = store.list_all_profile_ids().await?;
            tracing::info!(
                count = profile_ids.len(),
                "Listed profiles for OG regeneration"
            );
            Ok(Response::List { profile_ids })
        }
        Event::Regenerate { profile_id, force } => {
            let regenerated = store.regenerate_og_image(&profile_id, force).await?;
            tracing::info!(profile_id = %profile_id, regenerated, force, "Processed OG regeneration");
            Ok(Response::Regenerate {
                profile_id,
                regenerated,
            })
        }
    }
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
    // Only used to build an absolute URL for the QR code baked into each
    // composite (see og_image::generate) — falls back to a relative
    // `/p/{id}` when empty, same as the API Lambda's SITE_URL usage.
    let site_url = std::env::var("SITE_URL").unwrap_or_default();

    // Cognito is never used by this binary (ProfileStore requires a client
    // for the API's account-deletion path, which this job never calls),
    // but constructing one is cheap and keeps a single ProfileStore
    // constructor shared with the api binary rather than a parallel type.
    let store = ProfileStore::new(
        dynamo_client,
        s3_client,
        cognito_client,
        table_name,
        bucket_name,
        image_base_url,
        site_url,
    );

    lambda_runtime::run(service_fn(|event| handler(&store, event))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_list_event() {
        let event: Event = serde_json::from_str(r#"{"action": "list"}"#).unwrap();
        assert!(matches!(event, Event::List));
    }

    #[test]
    fn deserializes_regenerate_event_with_force() {
        let event: Event = serde_json::from_str(
            r#"{"action": "regenerate", "profile_id": "abc123", "force": true}"#,
        )
        .unwrap();
        match event {
            Event::Regenerate { profile_id, force } => {
                assert_eq!(profile_id, "abc123");
                assert!(force);
            }
            _ => panic!("expected Regenerate variant"),
        }
    }

    #[test]
    fn regenerate_event_defaults_force_to_false() {
        let event: Event =
            serde_json::from_str(r#"{"action": "regenerate", "profile_id": "abc123"}"#).unwrap();
        match event {
            Event::Regenerate { force, .. } => assert!(!force),
            _ => panic!("expected Regenerate variant"),
        }
    }

    #[test]
    fn serializes_list_response() {
        let response = Response::List {
            profile_ids: vec!["abc123".to_string(), "def456".to_string()],
        };
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(json, r#"{"profile_ids":["abc123","def456"]}"#);
    }

    #[test]
    fn serializes_regenerate_response() {
        let response = Response::Regenerate {
            profile_id: "abc123".to_string(),
            regenerated: true,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(json, r#"{"profile_id":"abc123","regenerated":true}"#);
    }
}
