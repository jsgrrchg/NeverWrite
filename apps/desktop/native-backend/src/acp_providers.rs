//! Typed bridge for the unstable ACP provider configuration methods.
//!
//! The Rust ACP SDK exposes the provider schema but does not yet register the
//! provider JSON-RPC methods. Keep that compatibility boundary here so this
//! module can be removed when the SDK implements `unstable_llm_providers`.

// The lifecycle integration lands separately; remove this allowance as soon as
// the connection path starts calling the bridge.
#![allow(dead_code)]

use std::collections::HashMap;

use agent_client_protocol::{Agent, ConnectionTo, Error, JsonRpcRequest, JsonRpcResponse};
use agent_client_protocol_schema::v1::{
    DisableProviderRequest, DisableProviderResponse, InitializeResponse, ListProvidersRequest,
    ListProvidersResponse, LlmProtocol, Meta, ProviderInfo, SetProviderRequest,
    SetProviderResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAIN_PROVIDER_ID: &str = "main";
const PROVIDERS_LIST_METHOD: &str = "providers/list";
const PROVIDERS_SET_METHOD: &str = "providers/set";
const PROVIDERS_DISABLE_METHOD: &str = "providers/disable";

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "providers/list", response = ListProvidersResult)]
#[serde(transparent)]
struct ListProviders(ListProvidersRequest);

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(transparent)]
struct ListProvidersResult(ListProvidersResponse);

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "providers/set", response = SetProviderResult)]
#[serde(transparent)]
struct SetProvider(SetProviderRequest);

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(transparent)]
struct SetProviderResult(SetProviderResponse);

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "providers/disable", response = DisableProviderResult)]
#[serde(transparent)]
struct DisableProvider(DisableProviderRequest);

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(transparent)]
struct DisableProviderResult(DisableProviderResponse);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VertexProviderMeta {
    pub(crate) project_id: String,
    pub(crate) region: String,
}

impl VertexProviderMeta {
    pub(crate) fn new(project_id: impl Into<String>, region: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            region: region.into(),
        }
    }
}

pub(crate) fn supports_providers(initialize_response: &InitializeResponse) -> bool {
    initialize_response.agent_capabilities.providers.is_some()
}

pub(crate) async fn list_providers(
    connection: &ConnectionTo<Agent>,
) -> Result<Vec<ProviderInfo>, Error> {
    let response = connection
        .send_request(ListProviders(ListProvidersRequest::new()))
        .block_task()
        .await?;
    Ok(response.0.providers)
}

pub(crate) fn main_provider(providers: &[ProviderInfo]) -> Result<&ProviderInfo, Error> {
    providers
        .iter()
        .find(|provider| provider.provider_id.0.as_ref() == MAIN_PROVIDER_ID)
        .ok_or_else(|| invalid_params("The agent did not advertise the required main provider."))
}

pub(crate) async fn set_main_provider(
    connection: &ConnectionTo<Agent>,
    api_type: LlmProtocol,
    base_url: impl Into<String>,
    headers: HashMap<String, String>,
    vertex: Option<VertexProviderMeta>,
) -> Result<(), Error> {
    let request = build_set_main_provider_request(api_type, base_url, headers, vertex)?;
    connection
        .send_request(SetProvider(request))
        .block_task()
        .await?;
    Ok(())
}

pub(crate) async fn configure_main_provider(
    connection: &ConnectionTo<Agent>,
    api_type: LlmProtocol,
    base_url: impl Into<String>,
    headers: HashMap<String, String>,
    vertex: Option<VertexProviderMeta>,
) -> Result<(), Error> {
    let providers = list_providers(connection).await?;
    let provider = main_provider(&providers)?;
    if !provider.supported.contains(&api_type) {
        return Err(invalid_params(
            "The main provider does not support the requested protocol.",
        ));
    }
    set_main_provider(connection, api_type, base_url, headers, vertex).await
}

#[allow(dead_code)]
pub(crate) async fn disable_main_provider(connection: &ConnectionTo<Agent>) -> Result<(), Error> {
    connection
        .send_request(DisableProvider(DisableProviderRequest::new(
            MAIN_PROVIDER_ID,
        )))
        .block_task()
        .await?;
    Ok(())
}

fn build_set_main_provider_request(
    api_type: LlmProtocol,
    base_url: impl Into<String>,
    headers: HashMap<String, String>,
    vertex: Option<VertexProviderMeta>,
) -> Result<SetProviderRequest, Error> {
    validate_protocol(&api_type)?;
    let base_url = base_url.into();
    validate_base_url(&base_url)?;
    validate_vertex_configuration(&api_type, vertex.as_ref())?;

    let mut request =
        SetProviderRequest::new(MAIN_PROVIDER_ID, api_type, base_url).headers(headers);
    if let Some(vertex) = vertex {
        request = request.meta(vertex_meta(vertex));
    }
    Ok(request)
}

fn validate_protocol(api_type: &LlmProtocol) -> Result<(), Error> {
    if matches!(
        api_type,
        LlmProtocol::Anthropic | LlmProtocol::Bedrock | LlmProtocol::Vertex
    ) {
        return Ok(());
    }
    Err(invalid_params(
        "Claude supports only anthropic, bedrock, or vertex provider protocols.",
    ))
}

fn validate_base_url(base_url: &str) -> Result<(), Error> {
    let url = reqwest::Url::parse(base_url)
        .map_err(|_| invalid_params("Provider base URL must be an absolute HTTP(S) URL."))?;
    if matches!(url.scheme(), "http" | "https") {
        return Ok(());
    }
    Err(invalid_params(
        "Provider base URL must be an absolute HTTP(S) URL.",
    ))
}

fn validate_vertex_configuration(
    api_type: &LlmProtocol,
    vertex: Option<&VertexProviderMeta>,
) -> Result<(), Error> {
    match (api_type, vertex) {
        (LlmProtocol::Vertex, Some(vertex))
            if !vertex.project_id.trim().is_empty() && !vertex.region.trim().is_empty() =>
        {
            Ok(())
        }
        (LlmProtocol::Vertex, _) => Err(invalid_params(
            "Vertex requires non-empty project ID and region values.",
        )),
        (_, None) => Ok(()),
        (_, Some(_)) => Err(invalid_params(
            "Vertex metadata is only valid for the vertex provider protocol.",
        )),
    }
}

fn vertex_meta(vertex: VertexProviderMeta) -> Meta {
    [(
        "claudeCode".to_string(),
        json!({
            "vertex": {
                "projectId": vertex.project_id,
                "region": vertex.region,
            }
        }),
    )]
    .into_iter()
    .collect()
}

fn invalid_params(message: &str) -> Error {
    Error::invalid_params().data(json!({ "reason": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::JsonRpcMessage;
    use agent_client_protocol_schema::v1::{AgentCapabilities, ErrorCode, ProvidersCapabilities};
    use agent_client_protocol_schema::ProtocolVersion;
    use serde_json::{json, Value};

    fn error_reason(error: &Error) -> Option<&str> {
        error
            .data
            .as_ref()
            .and_then(|data| data.get("reason"))
            .and_then(Value::as_str)
    }

    #[test]
    fn detects_provider_capability_only_when_advertised() {
        let supported: InitializeResponse = serde_json::from_value(json!({
            "protocolVersion": 1,
            "agentCapabilities": { "providers": {} }
        }))
        .expect("provider capability should deserialize");
        let unsupported = InitializeResponse::new(ProtocolVersion::LATEST);

        assert!(supports_providers(&supported));
        assert!(!supports_providers(&unsupported));
    }

    #[test]
    fn serializes_list_request_with_the_official_method() {
        let request = ListProviders(ListProvidersRequest::new());
        let untyped = request
            .to_untyped_message()
            .expect("list request should serialize");

        assert_eq!(request.method(), PROVIDERS_LIST_METHOD);
        assert_eq!(untyped.params, json!({}));
    }

    #[test]
    fn serializes_vertex_set_request_without_exposing_headers_in_responses() {
        let request = build_set_main_provider_request(
            LlmProtocol::Vertex,
            "https://vertex.example",
            HashMap::from([("authorization".to_string(), "Bearer secret".to_string())]),
            Some(VertexProviderMeta::new("project-1", "us-east5")),
        )
        .expect("valid Vertex request should build");
        let untyped = SetProvider(request)
            .to_untyped_message()
            .expect("set request should serialize");

        assert_eq!(untyped.method, PROVIDERS_SET_METHOD);
        assert_eq!(
            untyped.params,
            json!({
                "providerId": "main",
                "apiType": "vertex",
                "baseUrl": "https://vertex.example",
                "headers": { "authorization": "Bearer secret" },
                "_meta": {
                    "claudeCode": {
                        "vertex": {
                            "projectId": "project-1",
                            "region": "us-east5"
                        }
                    }
                }
            })
        );

        let response = <ListProvidersResult as JsonRpcResponse>::from_value(
            PROVIDERS_LIST_METHOD,
            json!({
                "providers": [{
                    "providerId": "main",
                    "supported": ["anthropic", "bedrock", "vertex"],
                    "required": false,
                    "current": {
                        "apiType": "vertex",
                        "baseUrl": "https://vertex.example",
                        "headers": { "authorization": "Bearer secret" }
                    }
                }]
            }),
        )
        .expect("list response should deserialize");
        let serialized = serde_json::to_string(&response).expect("response should serialize");

        assert!(!serialized.contains("secret"));
        assert_eq!(
            main_provider(&response.0.providers)
                .unwrap()
                .supported
                .len(),
            3
        );
    }

    #[test]
    fn serializes_disable_request_for_main_provider() {
        let request = DisableProvider(DisableProviderRequest::new(MAIN_PROVIDER_ID));
        let untyped = request
            .to_untyped_message()
            .expect("disable request should serialize");

        assert_eq!(untyped.method, PROVIDERS_DISABLE_METHOD);
        assert_eq!(untyped.params, json!({ "providerId": "main" }));
        <DisableProviderResult as JsonRpcResponse>::from_value(PROVIDERS_DISABLE_METHOD, json!({}))
            .expect("empty disable response should deserialize");
        <SetProviderResult as JsonRpcResponse>::from_value(PROVIDERS_SET_METHOD, json!({}))
            .expect("empty set response should deserialize");
    }

    #[test]
    fn rejects_unknown_methods_and_missing_main_provider() {
        let method_error = ListProviders::parse_message("providers/unknown", &json!({}))
            .expect_err("unknown method should fail");
        let provider_error = main_provider(&[ProviderInfo::new(
            "secondary",
            vec![LlmProtocol::Anthropic],
            false,
            None,
        )])
        .expect_err("missing main provider should fail");

        assert_eq!(method_error.code, ErrorCode::MethodNotFound);
        assert_eq!(provider_error.code, ErrorCode::InvalidParams);
        assert_eq!(i32::from(method_error.code), -32601);
        assert_eq!(i32::from(provider_error.code), -32602);
        assert_eq!(
            error_reason(&provider_error),
            Some("The agent did not advertise the required main provider.")
        );
    }

    #[test]
    fn rejects_unsupported_protocols_and_invalid_configuration() {
        let unsupported = build_set_main_provider_request(
            LlmProtocol::Other("custom".to_string()),
            "https://provider.example",
            HashMap::new(),
            None,
        )
        .expect_err("unknown protocol should fail");
        let invalid_url = build_set_main_provider_request(
            LlmProtocol::Anthropic,
            "ftp://provider.example",
            HashMap::new(),
            None,
        )
        .expect_err("non-HTTP URL should fail");
        let missing_vertex = build_set_main_provider_request(
            LlmProtocol::Vertex,
            "https://vertex.example",
            HashMap::new(),
            None,
        )
        .expect_err("missing Vertex metadata should fail");
        let stray_vertex = build_set_main_provider_request(
            LlmProtocol::Bedrock,
            "https://bedrock.example",
            HashMap::new(),
            Some(VertexProviderMeta::new("project-1", "us-east5")),
        )
        .expect_err("Vertex metadata on Bedrock should fail");

        for error in [unsupported, invalid_url, missing_vertex, stray_vertex] {
            assert_eq!(error.code, ErrorCode::InvalidParams);
            assert!(error_reason(&error).is_some());
        }
    }

    #[test]
    fn capability_builder_exposes_provider_support() {
        let response = InitializeResponse::new(ProtocolVersion::LATEST)
            .agent_capabilities(AgentCapabilities::new().providers(ProvidersCapabilities::new()));

        assert!(supports_providers(&response));
    }
}
