use neverwrite_ai::{
    CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, GROK_RUNTIME_ID, KILO_RUNTIME_ID, OPENCODE_RUNTIME_ID,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcpProtocolFlavor {
    Current,
    Legacy12,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessEnvironmentPolicy {
    Inherited,
    #[allow(dead_code)]
    Isolated,
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
}

impl<'a> RuntimeDefinition<'a> {
    pub(crate) fn id(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.id,
        }
    }

    pub(crate) fn name(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.name,
        }
    }

    pub(crate) fn description(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.description,
        }
    }

    pub(crate) fn default_executable(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.default_executable,
        }
    }

    pub(crate) fn bin_env_var(self) -> &'a str {
        match self {
            Self::BuiltIn(definition) => definition.bin_env_var,
        }
    }

    pub(crate) fn acp_args(self) -> &'a [&'static str] {
        match self {
            Self::BuiltIn(definition) => definition.acp_args,
        }
    }

    pub(crate) fn acp_protocol(self) -> AcpProtocolFlavor {
        match self {
            Self::BuiltIn(definition) => definition.acp_protocol,
        }
    }

    pub(crate) fn process_environment_policy(self) -> ProcessEnvironmentPolicy {
        match self {
            Self::BuiltIn(_) => ProcessEnvironmentPolicy::Inherited,
        }
    }

    pub(crate) fn supports_native_resume(self) -> bool {
        match self {
            Self::BuiltIn(definition) => definition.supports_native_resume,
        }
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
}

const NO_ACP_ARGS: &[&str] = &[];
const GROK_ACP_ARGS: &[&str] = &["--no-auto-update", "agent", "stdio"];
const SHELL_ACP_ARGS: &[&str] = &["acp"];

const BUILT_IN_RUNTIME_DEFINITIONS: &[BuiltInRuntimeDefinition] = &[
    BuiltInRuntimeDefinition {
        id: CODEX_RUNTIME_ID,
        name: "Codex",
        description: "OpenAI Codex-compatible agent runtime.",
        default_executable: "codex",
        bin_env_var: "NEVERWRITE_CODEX_ACP_BIN",
        acp_args: NO_ACP_ARGS,
        acp_protocol: AcpProtocolFlavor::Current,
        supports_native_resume: true,
    },
    BuiltInRuntimeDefinition {
        id: CLAUDE_RUNTIME_ID,
        name: "Claude",
        description: "Claude ACP-compatible agent runtime.",
        default_executable: "claude",
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
    use super::*;

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

        let expected: Vec<(&str, &str, &str, &[&str])> = vec![
            (CODEX_RUNTIME_ID, "codex", "NEVERWRITE_CODEX_ACP_BIN", &[]),
            (
                CLAUDE_RUNTIME_ID,
                "claude",
                "NEVERWRITE_CLAUDE_ACP_BIN",
                &[],
            ),
            (
                GROK_RUNTIME_ID,
                "grok",
                "NEVERWRITE_GROK_ACP_BIN",
                &["--no-auto-update", "agent", "stdio"],
            ),
            (KILO_RUNTIME_ID, "kilo", "NEVERWRITE_KILO_ACP_BIN", &["acp"]),
            (
                OPENCODE_RUNTIME_ID,
                "opencode",
                "NEVERWRITE_OPENCODE_ACP_BIN",
                &["acp"],
            ),
        ];
        assert_eq!(contracts, expected);
    }

    #[test]
    fn unknown_runtime_has_no_definition_or_protocol() {
        assert!(RUNTIME_CATALOG.definition("unknown-acp").is_none());
        assert!(RUNTIME_CATALOG.validate_id("unknown-acp").is_err());
    }
}
