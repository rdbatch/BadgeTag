use aws_lambda_events::apigw::{ApiGatewayV2httpRequest, ApiGatewayV2httpResponse};
use aws_lambda_events::encodings::Body;
use aws_lambda_events::http::HeaderMap;
use lambda_runtime::{Error, LambdaEvent, service_fn};

async fn handler(
    _event: LambdaEvent<ApiGatewayV2httpRequest>,
) -> Result<ApiGatewayV2httpResponse, Error> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse()?);

    let response = ApiGatewayV2httpResponse {
        status_code: 200,
        body: Some(Body::Text(
            r#"{"message":"hello from badgetag"}"#.to_string(),
        )),
        headers,
        ..Default::default()
    };
    Ok(response)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    badgetag_backend::init_tracing();

    lambda_runtime::run(service_fn(handler)).await
}
