use neverwrite_ai::{
    custom_runtimes::CustomAcpRuntimeDefinition, CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID,
    GROK_RUNTIME_ID, KILO_RUNTIME_ID, OPENCODE_RUNTIME_ID,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcpProtocolFlavor {
    Current,
    Legacy12,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessEnvironmentPolicy {
    Inherited,
    Isolated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeProductProfile {
    BuiltIn,
    Conservative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BuiltInRuntimeDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    default_executable: &'static str,
    bin_env_var: &'static str,
    acp_args: &'static [&'static str],
    acp_protocol: AcpProtocolFlavor,
    supports_native_resume: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeDefinition<'a> {
    BuiltIn(&'a BuiltInRuntimeDefinition),
    Custom(&'a CustomAcpRuntimeDefinition),
}

impl<'a> RuntimeDefinition<'a> {
    pub(crate) fn id(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.id,
            Self::Custom(definition) => &definition.id,
        }
    }

    pub(crate) fn name(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.name,
            Self::Custom(definition) => &definition.display_name,
        }
    }

    pub(crate) fn description(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.description,
            Self::Custom(_) => "User-configured ACP-compatible agent runtime.",
        }
    }

    pub(crate) fn default_executable(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.default_executable,
            Self::Custom(definition) => &definition.command,
        }
    }

    pub(crate) fn bin_env_var(self) -> Option<&'a str> {
        match self {
            Self::BuiltIn(definition) => Some(definition.bin_env_var),
            Self::Custom(_) => None,
        }
    }

    pub(crate) fn acp_args(self) -> Vec<String> {
        match self {
            Self::BuiltIn(definition) => definition
                .acp_args
                .iter()
                .map(|argument| (*argument).to_string())
                .collect(),
            Self::Custom(definition) => definition.args.clone(),
        }
    }

    pub(crate) fn acp_protocol(self) -> AcpProtocolFlavor {
        match self {
            Self::BuiltIn(definition) => definition.acp_protocol,
            Self::Custom(_) => AcpProtocolFlavor::Current,
        }
    }

    pub(crate) fn process_environment_policy(self) -> ProcessEnvironmentPolicy {
        match self {
            Self::BuiltIn(_) => ProcessEnvironmentPolicy::Inherited,
            Self::Custom(_) => ProcessEnvironmentPolicy::Isolated,
        }
    }

    pub(crate) fn supports_native_resume(self) -> bool {
        match self {
            Self::BuiltIn(definition) => definition.supports_native_resume,
            Self::Custom(_) => false,
        }
    }

    pub(crate) fn product_profile(self) -> RuntimeProductProfile {
        match self {
            Self::BuiltIn(_) => RuntimeProductProfile::BuiltIn,
            Self::Custom(_) => RuntimeProductProfile::Conservative,
        }
    }

    pub(crate) fn is_custom(self) -> bool {
        matches!(self, Self::Custom(_))
    }
}

#[derive(Debug)]
pub(crate) struct RuntimeCatalog {
    built_ins: &'static [BuiltInRuntimeDefinition],
}

impl RuntimeCatalog {
    const fn new(built_ins: &'static [BuiltInRuntimeDefinition]) -> Self {
        Self { built_ins }
    }

    pub(crate) fn definition(&self, runtime_id: &str) -> Option<RuntimeDefinition<'_>> {
        self.built_ins
            .iter()
            .find(|definition| definition.id == runtime_id)
            .map(RuntimeDefinition::BuiltIn)
    }

    pub(crate) fn definitions(&self) -> impl Iterator<Item = RuntimeDefinition<'_>> {
        self.built_ins.iter().map(RuntimeDefinition::BuiltIn)
    }

    pub(crate) fn validate_id(&self, runtime_id: &str) -> Result<(), String> {
        self.definition(runtime_id)
            .map(|_| ())
            .ok_or_else(|| format!("Unsupported AI runtime: {runtime_id}"))
    }

    pub(crate) fn with_custom<'a>(
        &'a self,
        custom: &'a [CustomAcpRuntimeDefinition],
    ) -> RuntimeCatalogView<'a> {
        RuntimeCatalogView {
            built_ins: self,
            custom,
        }
    }
}

pub(crate) struct RuntimeCatalogView<'a> {
    built_ins: &'a RuntimeCatalog,
    custom: &'a [CustomAcpRuntimeDefinition],
}

impl<'a> RuntimeCatalogView<'a> {
    pub(crate) fn definition(&self, runtime_id: &str) -> Option<RuntimeDefinition<'a>> {
        self.built_ins.definition(runtime_id).or_else(|| {
            self.custom
                .iter()
                .find(|definition| definition.id == runtime_id)
                .map(RuntimeDefinition::Custom)
        })
    }

    pub(crate) fn definitions(&self) -> impl Iterator<Item = RuntimeDefinition<'a>> {
        self.built_ins
            .definitions()
            .chain(self.custom.iter().map(RuntimeDefinition::Custom))
    }
}

const NO_ACP_ARGS: &[&str] = &[];
const GROK_ACP_ARGS: &[&str] = &["--no-auto-update", "agent", "stdio"];
const SHELL_ACP_ARGS: &[&str] = &["acp"];

const BUILT_IN_RUNTIME_DEFINITIONS: &[BuiltInRuntimeDefinition] = &[
    BuiltInRuntimeDefinition {
        id: CODEX_RUNTIME_ID,
        name: "Codex",
        description: "OpenAI Codex-compatible agent runtime.",
        default_executable: "codex-acp",
        bin_env_var: "NEVERWRITE_CODEX_ACP_BIN",
        acp_args: NO_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Current,
        supports_native_resume: true,
    },
    BuiltInRuntimeDefinition {
        id: CLAUDE_RUNTIME_ID,
        name: "Claude",
        description: "Claude ACP-compatible agent runtime.",
        default_executable: "claude-agent-acp",
        bin_env_var: "NEVERWRITE_CLAUDE_ACP_BIN",
        acp_args: NO_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Current,
        supports_native_resume: false,
    },
    BuiltInRuntimeDefinition {
        id: GROK_RUNTIME_ID,
        name: "Grok",
        description: "Grok ACP-compatible agent runtime.",
        default_executable: "grok",
        bin_env_var: "NEVERWRITE_GROK_ACP_BIN",
        acp_args: GROK_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Legacy12,
        supports_native_resume: false,
    },
    BuiltInRuntimeDefinition {
        id: KILO_RUNTIME_ID,
        name: "Kilo",
        description: "Kilo ACP-compatible agent runtime.",
        default_executable: "kilo",
        bin_env_var: "NEVERWRITE_KILO_ACP_BIN",
        acp_args: SHELL_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Current,
        supports_native_resume: false,
    },
    BuiltInRuntimeDefinition {
        id: OPENCODE_RUNTIME_ID,
        name: "OpenCode",
        description: "OpenCode ACP-compatible agent runtime.",
        default_executable: "opencode",
        bin_env_var: "NEVERWRITE_OPENCODE_ACP_BIN",
        acp_args: SHELL_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Current,
        supports_native_resume: false,
    },
];

pub(crate) const RUNTIME_CATALOG: RuntimeCatalog =
    RuntimeCatalog::new(BUILT_IN_RUNTIME_DEFINITIONS);

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use neverwrite_ai::custom_runtimes::{
        create_custom_acp_runtime_definition_with_id, CustomAcpAuthMode,
        CustomAcpRuntimeDefinitionInput,
    };

    use super::*;

    fn custom_definition() -> CustomAcpRuntimeDefinition {
        create_custom_acp_runtime_definition_with_id(
            CustomAcpRuntimeDefinitionInput {
                display_name: "Local agent".to_string(),
                command: "/opt/local/agent-acp".to_string(),
                args: vec!["--stdio".to_string()],
                env: BTreeMap::new(),
                auth_mode: CustomAcpAuthMode::External,
            },
            &[],
            "123e4567-e89b-12d3-a456-426614174000".to_string(),
        )
        .unwrap()
    }

    #[test]
    fn built_in_inventory_and_order_are_stable() {
        assert_eq!(
            RUNTIME_CATALOG
                .definitions()
                .map(|definition| definition.id())
                .collect::<Vec<_>>(),
            [
                CODEX_RUNTIME_ID,
                CLAUDE_RUNTIME_ID,
                GROK_RUNTIME_ID,
                KILO_RUNTIME_ID,
                OPENCODE_RUNTIME_ID,
            ]
        );
    }

    #[test]
    fn built_in_protocols_are_explicit() {
        for definition in RUNTIME_CATALOG.definitions() {
            let expected = if definition.id() == GROK_RUNTIME_ID {
                AcpProtocolFlavor::Legacy12
            } else {
                AcpProtocolFlavor::Current
            };
            assert_eq!(definition.acp_protocol(), expected, "{}", definition.id());
        }
    }

    #[test]
    fn built_in_launch_contracts_are_stable() {
        let contracts = RUNTIME_CATALOG
            .definitions()
            .map(|definition| {
                (
                    definition.id(),
                    definition.default_executable(),
                    definition.bin_env_var(),
                    definition.acp_args(),
                )
            })
            .collect::<Vec<_>>();

        let expected = vec![
            (
                CODEX_RUNTIME_ID,
                "codex-acp",
                Some("NEVERWRITE_CODEX_ACP_BIN"),
                Vec::<String>::new(),
            ),
            (
                CLAUDE_RUNTIME_ID,
                "claude-agent-acp",
                Some("NEVERWRITE_CLAUDE_ACP_BIN"),
                Vec::new(),
            ),
            (
                GROK_RUNTIME_ID,
                "grok",
                Some("NEVERWRITE_GROK_ACP_BIN"),
                vec![
                    "--no-auto-update".to_string(),
                    "agent".to_string(),
                    "stdio".to_string(),
                ],
            ),
            (
                KILO_RUNTIME_ID,
                "kilo",
                Some("NEVERWRITE_KILO_ACP_BIN"),
                vec!["acp".to_string()],
            ),
            (
                OPENCODE_RUNTIME_ID,
                "opencode",
                Some("NEVERWRITE_OPENCODE_ACP_BIN"),
                vec!["acp".to_string()],
            ),
        ];
        assert_eq!(contracts, expected);
    }

    #[test]
    fn catalog_view_combines_built_in_and_custom_definitions() {
        let custom = [custom_definition()];
        let catalog = RUNTIME_CATALOG.with_custom(&custom);
        let definitions = catalog.definitions().collect::<Vec<_>>();

        assert_eq!(definitions.len(), 6);
        let custom = catalog.definition(&custom[0].id).unwrap();
        assert!(custom.is_custom());
        assert_eq!(custom.name(), "Local agent");
        assert_eq!(custom.default_executable(), "/opt/local/agent-acp");
        assert_eq!(custom.acp_args(), vec!["--stdio".to_string()]);
        assert_eq!(custom.acp_protocol(), AcpProtocolFlavor::Current);
        assert_eq!(
            custom.process_environment_policy(),
            ProcessEnvironmentPolicy::Isolated
        );
        assert!(!custom.supports_native_resume());
        assert_eq!(
            custom.product_profile(),
            RuntimeProductProfile::Conservative
        );
        assert_eq!(custom.bin_env_var(), None);
    }

    #[test]
    fn unknown_runtime_has_no_definition_or_protocol() {
        assert!(RUNTIME_CATALOG.definition("unknown-acp").is_none());
        assert!(RUNTIME_CATALOG.validate_id("unknown-acp").is_err());
    }
}
