use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use codex_http_client::HttpClientFactory;
use codex_models_manager::manager::{
    ModelsEndpointClient, ModelsEndpointFuture, ModelsEndpointResponse, ModelsManager,
    OpenAiModelsManager,
};
use codex_protocol::{
    error::Result as CoreResult,
    openai_models::{ModelInfo, ModelVisibility},
};

use crate::thread::ModelsManagerImpl;

#[derive(Debug)]
struct SwitchingEndpoint {
    identity: Mutex<String>,
    template: Mutex<Option<ModelInfo>>,
    requests: AtomicUsize,
}

impl ModelsEndpointClient for SwitchingEndpoint {
    fn identity(&self) -> Option<String> {
        Some(self.identity.lock().unwrap().clone())
    }

    fn has_command_auth(&self) -> bool {
        true
    }

    fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool> {
        Box::pin(async { false })
    }

    fn list_models<'a>(
        &'a self,
        _client_version: &'a str,
        _http_client_factory: HttpClientFactory,
    ) -> ModelsEndpointFuture<'a, CoreResult<ModelsEndpointResponse>> {
        Box::pin(async move {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let identity = self.identity().unwrap();
            let mut model = self.template.lock().unwrap().clone().unwrap();
            model.slug = format!("{identity}-model");
            model.display_name = model.slug.clone();
            model.visibility = ModelVisibility::List;
            model.supported_in_api = true;
            Ok(ModelsEndpointResponse {
                identity,
                models: vec![model],
                etag: Some("same-etag".into()),
            })
        })
    }
}

#[tokio::test]
async fn acp_model_picker_does_not_reuse_another_identity_catalog() -> anyhow::Result<()> {
    let home = tempfile::tempdir()?;
    let endpoint = Arc::new(SwitchingEndpoint {
        identity: Mutex::new("account-a".into()),
        template: Mutex::new(None),
        requests: AtomicUsize::new(0),
    });
    let manager = OpenAiModelsManager::new(home.path().into(), endpoint.clone(), None);
    let template = manager.get_remote_models().await.into_iter().next();
    *endpoint.template.lock().unwrap() = template;
    let manager: Arc<dyn ModelsManager> = Arc::new(manager);

    let first = ModelsManagerImpl::list_models(&manager).await;
    assert!(first.iter().any(|model| model.model == "account-a-model"));
    assert_eq!(endpoint.requests.load(Ordering::SeqCst), 1);
    drop(ModelsManagerImpl::list_models(&manager).await);
    assert_eq!(
        endpoint.requests.load(Ordering::SeqCst),
        1,
        "same identity should reuse the disk cache"
    );

    *endpoint.identity.lock().unwrap() = "account-b".into();
    let second = ModelsManagerImpl::list_models(&manager).await;
    assert!(second.iter().any(|model| model.model == "account-b-model"));
    assert!(!second.iter().any(|model| model.model == "account-a-model"));
    assert_eq!(endpoint.requests.load(Ordering::SeqCst), 2);

    // A new runtime process must also reject the still-fresh cache of account B.
    *endpoint.identity.lock().unwrap() = "provider-c".into();
    let restarted: Arc<dyn ModelsManager> = Arc::new(OpenAiModelsManager::new(
        home.path().into(),
        endpoint.clone(),
        None,
    ));
    let third = ModelsManagerImpl::list_models(&restarted).await;
    assert!(third.iter().any(|model| model.model == "provider-c-model"));
    assert!(!third.iter().any(|model| model.model == "account-b-model"));
    assert_eq!(endpoint.requests.load(Ordering::SeqCst), 3);
    Ok(())
}
