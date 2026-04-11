use super::{
    claude::ClaudeRuntimeAdapter, codex::CodexRuntimeAdapter, gemini::GeminiRuntimeAdapter,
    kilo::KiloRuntimeAdapter, runtime::AiRuntimeAdapter,
};

const DIAGNOSTIC_EXECUTABLE_NAMES: &[&str] = &[
    "rg",
    "node",
    "npm",
    "cargo",
    "codex-acp",
    "claude-agent-acp",
    "gemini",
    "kilo",
];

pub fn default_runtime_adapters() -> Vec<Box<dyn AiRuntimeAdapter>> {
    vec![
        Box::new(CodexRuntimeAdapter::default()),
        Box::new(ClaudeRuntimeAdapter::default()),
        Box::new(GeminiRuntimeAdapter::default()),
        Box::new(KiloRuntimeAdapter::default()),
    ]
}

pub fn diagnostic_executable_names() -> &'static [&'static str] {
    DIAGNOSTIC_EXECUTABLE_NAMES
}

#[cfg(test)]
mod tests {
    use neverwrite_ai::KILO_RUNTIME_ID;

    use super::{default_runtime_adapters, diagnostic_executable_names};

    #[test]
    fn default_runtime_catalog_includes_kilo() {
        let runtime_ids: Vec<&'static str> = default_runtime_adapters()
            .into_iter()
            .map(|runtime| runtime.runtime_id())
            .collect();

        assert!(runtime_ids
            .iter()
            .any(|runtime_id| *runtime_id == KILO_RUNTIME_ID));
    }

    #[test]
    fn diagnostic_executable_names_include_kilo() {
        assert!(diagnostic_executable_names().contains(&"kilo"));
    }
}
