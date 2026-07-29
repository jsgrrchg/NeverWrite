use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const CUSTOM_ACP_RUNTIME_PREFIX: &str = "custom:";
pub const MAX_CUSTOM_ACP_RUNTIME_COUNT: usize = 32;
pub const MAX_CUSTOM_ACP_DISPLAY_NAME_LENGTH: usize = 80;
pub const MAX_CUSTOM_ACP_COMMAND_LENGTH: usize = 4_096;
pub const MAX_CUSTOM_ACP_ARG_COUNT: usize = 64;
pub const MAX_CUSTOM_ACP_ARG_LENGTH: usize = 4_096;
pub const MAX_CUSTOM_ACP_ENV_COUNT: usize = 32;
pub const MAX_CUSTOM_ACP_ENV_VALUE_LENGTH: usize = 8_192;
pub const MAX_CUSTOM_ACP_LAUNCH_TEXT_LENGTH: usize = 32_768;
pub const MAX_CUSTOM_ACP_REVISION: u64 = 9_007_199_254_740_991;
const CUSTOM_ACP_LAUNCH_PROFILE: &str = "acp-current-custom-v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomAcpAuthMode {
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomAcpRuntimeDefinitionInput {
    pub display_name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub auth_mode: CustomAcpAuthMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomAcpRuntimeDefinition {
    pub id: String,
    pub display_name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub auth_mode: CustomAcpAuthMode,
    pub revision: u64,
    #[serde(default)]
    pub launch_fingerprint: String,
}

impl CustomAcpRuntimeDefinition {
    pub fn as_input(&self) -> CustomAcpRuntimeDefinitionInput {
        CustomAcpRuntimeDefinitionInput {
            display_name: self.display_name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            auth_mode: self.auth_mode,
        }
    }
}

pub fn is_custom_acp_runtime_id(runtime_id: &str) -> bool {
    let Some(suffix) = runtime_id.strip_prefix(CUSTOM_ACP_RUNTIME_PREFIX) else {
        return false;
    };
    Uuid::parse_str(suffix)
        .map(|uuid| uuid.hyphenated().to_string() == suffix)
        .unwrap_or(false)
}

pub fn validate_custom_acp_runtime_input(
    input: CustomAcpRuntimeDefinitionInput,
    existing_definitions: &[CustomAcpRuntimeDefinition],
    exclude_id: Option<&str>,
) -> Result<CustomAcpRuntimeDefinitionInput, String> {
    let display_name = require_trimmed_string(
        input.display_name,
        "Runtime name",
        MAX_CUSTOM_ACP_DISPLAY_NAME_LENGTH,
    )?;
    let command = require_trimmed_string(input.command, "Command", MAX_CUSTOM_ACP_COMMAND_LENGTH)?;
    reject_nul(&command, "Command")?;

    if input.args.len() > MAX_CUSTOM_ACP_ARG_COUNT {
        return Err(format!(
            "Arguments must contain at most {MAX_CUSTOM_ACP_ARG_COUNT} items."
        ));
    }
    for (index, argument) in input.args.iter().enumerate() {
        if argument.chars().count() > MAX_CUSTOM_ACP_ARG_LENGTH {
            return Err(format!(
                "Argument {} must be at most {MAX_CUSTOM_ACP_ARG_LENGTH} characters.",
                index + 1
            ));
        }
        reject_nul(argument, &format!("Argument {}", index + 1))?;
    }

    if input.env.len() > MAX_CUSTOM_ACP_ENV_COUNT {
        return Err(format!(
            "Environment must contain at most {MAX_CUSTOM_ACP_ENV_COUNT} variables."
        ));
    }
    for (key, value) in &input.env {
        if !is_valid_env_key(key) {
            return Err(format!(
                "Environment variable \"{key}\" has an invalid name."
            ));
        }
        if matches!(key.to_ascii_uppercase().as_str(), "PATH" | "PATHEXT") {
            return Err(format!(
                "Environment variable \"{key}\" is controlled by NeverWrite."
            ));
        }
        if is_secret_like_env_key(key) {
            return Err(format!(
                "Environment variable \"{key}\" looks secret. Custom runtime secrets are not supported."
            ));
        }
        if value.chars().count() > MAX_CUSTOM_ACP_ENV_VALUE_LENGTH {
            return Err(format!(
                "Environment variable \"{key}\" must be at most {MAX_CUSTOM_ACP_ENV_VALUE_LENGTH} characters."
            ));
        }
        reject_nul(value, &format!("Environment variable \"{key}\""))?;
    }

    let launch_text_length = command.chars().count()
        + input
            .args
            .iter()
            .map(|argument| argument.chars().count())
            .sum::<usize>()
        + input
            .env
            .iter()
            .map(|(key, value)| key.chars().count() + value.chars().count())
            .sum::<usize>();
    if launch_text_length > MAX_CUSTOM_ACP_LAUNCH_TEXT_LENGTH {
        return Err("Custom runtime launch definition is too large.".to_string());
    }

    let normalized_name = display_name.to_lowercase();
    if existing_definitions.iter().any(|definition| {
        Some(definition.id.as_str()) != exclude_id
            && definition.display_name.to_lowercase() == normalized_name
    }) {
        return Err(format!(
            "A custom runtime named \"{display_name}\" already exists."
        ));
    }

    Ok(CustomAcpRuntimeDefinitionInput {
        display_name,
        command,
        args: input.args,
        env: input.env,
        auth_mode: input.auth_mode,
    })
}

pub fn calculate_custom_acp_launch_fingerprint(
    definition: &CustomAcpRuntimeDefinitionInput,
) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CanonicalLaunch<'a> {
        profile: &'static str,
        command: &'a str,
        args: &'a [String],
        auth_mode: CustomAcpAuthMode,
        env: &'a BTreeMap<String, String>,
    }

    let encoded = serde_json::to_vec(&CanonicalLaunch {
        profile: CUSTOM_ACP_LAUNCH_PROFILE,
        command: &definition.command,
        args: &definition.args,
        auth_mode: definition.auth_mode,
        env: &definition.env,
    })
    .expect("canonical custom ACP launch serialization cannot fail");
    let digest = Sha256::digest(encoded);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn create_custom_acp_runtime_definition(
    input: CustomAcpRuntimeDefinitionInput,
    existing_definitions: &[CustomAcpRuntimeDefinition],
) -> Result<CustomAcpRuntimeDefinition, String> {
    create_custom_acp_runtime_definition_with_id(
        input,
        existing_definitions,
        Uuid::new_v4().hyphenated().to_string(),
    )
}

pub fn create_custom_acp_runtime_definition_with_id(
    input: CustomAcpRuntimeDefinitionInput,
    existing_definitions: &[CustomAcpRuntimeDefinition],
    uuid: String,
) -> Result<CustomAcpRuntimeDefinition, String> {
    if existing_definitions.len() >= MAX_CUSTOM_ACP_RUNTIME_COUNT {
        return Err(format!(
            "At most {MAX_CUSTOM_ACP_RUNTIME_COUNT} custom runtimes are supported."
        ));
    }
    let normalized = validate_custom_acp_runtime_input(input, existing_definitions, None)?;
    let id = format!("{CUSTOM_ACP_RUNTIME_PREFIX}{uuid}");
    if !is_custom_acp_runtime_id(&id)
        || existing_definitions
            .iter()
            .any(|definition| definition.id == id)
    {
        return Err("Generated an invalid or duplicate custom runtime ID.".to_string());
    }
    Ok(definition_from_input(id, 1, normalized))
}

pub fn update_custom_acp_runtime_definition(
    current: &CustomAcpRuntimeDefinition,
    input: CustomAcpRuntimeDefinitionInput,
    existing_definitions: &[CustomAcpRuntimeDefinition],
) -> Result<CustomAcpRuntimeDefinition, String> {
    if !is_custom_acp_runtime_id(&current.id) || current.revision == 0 {
        return Err("Custom runtime identity or revision is invalid.".to_string());
    }
    let normalized =
        validate_custom_acp_runtime_input(input, existing_definitions, Some(&current.id))?;
    let revision = current
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_CUSTOM_ACP_REVISION)
        .ok_or_else(|| "Custom runtime revision is too large.".to_string())?;
    Ok(definition_from_input(
        current.id.clone(),
        revision,
        normalized,
    ))
}

pub fn normalize_persisted_custom_acp_runtime_definition(
    definition: CustomAcpRuntimeDefinition,
    existing_definitions: &[CustomAcpRuntimeDefinition],
) -> Result<CustomAcpRuntimeDefinition, String> {
    if !is_custom_acp_runtime_id(&definition.id)
        || definition.revision == 0
        || definition.revision > MAX_CUSTOM_ACP_REVISION
    {
        return Err("Custom runtime identity or revision is invalid.".to_string());
    }
    let normalized =
        validate_custom_acp_runtime_input(definition.as_input(), existing_definitions, None)?;
    Ok(definition_from_input(
        definition.id,
        definition.revision,
        normalized,
    ))
}

fn definition_from_input(
    id: String,
    revision: u64,
    input: CustomAcpRuntimeDefinitionInput,
) -> CustomAcpRuntimeDefinition {
    let launch_fingerprint = calculate_custom_acp_launch_fingerprint(&input);
    CustomAcpRuntimeDefinition {
        id,
        display_name: input.display_name,
        command: input.command,
        args: input.args,
        env: input.env,
        auth_mode: input.auth_mode,
        revision,
        launch_fingerprint,
    }
}

fn require_trimmed_string(value: String, label: &str, max_length: usize) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("{label} is required."));
    }
    if normalized.chars().count() > max_length {
        return Err(format!("{label} must be at most {max_length} characters."));
    }
    Ok(normalized.to_string())
}

fn reject_nul(value: &str, label: &str) -> Result<(), String> {
    if value.contains('\0') {
        Err(format!("{label} cannot contain NUL characters."))
    } else {
        Ok(())
    }
}

fn is_valid_env_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

fn is_secret_like_env_key(key: &str) -> bool {
    let segments = key
        .split('_')
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>();
    segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            "APIKEY"
                | "AUTH"
                | "CREDENTIAL"
                | "CREDENTIALS"
                | "PASSWORD"
                | "PRIVATE"
                | "SECRET"
                | "TOKEN"
        )
    }) || segments
        .windows(2)
        .any(|parts| parts[0] == "API" && parts[1] == "KEY")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> CustomAcpRuntimeDefinitionInput {
        CustomAcpRuntimeDefinitionInput {
            display_name: name.to_string(),
            command: "agent-acp".to_string(),
            args: vec!["--stdio".to_string()],
            env: BTreeMap::from([
                ("AGENT_COLOR".to_string(), "blue".to_string()),
                ("LANG".to_string(), "en_US.UTF-8".to_string()),
            ]),
            auth_mode: CustomAcpAuthMode::External,
        }
    }

    fn definition(name: &str, uuid: &str) -> CustomAcpRuntimeDefinition {
        create_custom_acp_runtime_definition_with_id(input(name), &[], uuid.to_string()).unwrap()
    }

    #[test]
    fn creates_stable_custom_identity_and_normalized_input() {
        let mut candidate = input("  Local agent  ");
        candidate.command = "  /opt/local/agent-acp  ".to_string();
        let definition = create_custom_acp_runtime_definition_with_id(
            candidate,
            &[],
            "123e4567-e89b-12d3-a456-426614174000".to_string(),
        )
        .unwrap();

        assert_eq!(definition.id, "custom:123e4567-e89b-12d3-a456-426614174000");
        assert_eq!(definition.display_name, "Local agent");
        assert_eq!(definition.command, "/opt/local/agent-acp");
        assert_eq!(definition.revision, 1);
        assert_eq!(definition.launch_fingerprint.len(), 64);
    }

    #[test]
    fn rename_increments_revision_without_changing_launch_fingerprint() {
        let current = definition("Local agent", "123e4567-e89b-12d3-a456-426614174000");
        let mut renamed = current.as_input();
        renamed.display_name = "Renamed agent".to_string();
        let updated =
            update_custom_acp_runtime_definition(&current, renamed, std::slice::from_ref(&current))
                .unwrap();

        assert_eq!(updated.revision, 2);
        assert_eq!(updated.launch_fingerprint, current.launch_fingerprint);
    }

    #[test]
    fn launch_changes_produce_different_fingerprints() {
        let base = input("Local agent");
        let base_fingerprint = calculate_custom_acp_launch_fingerprint(&base);

        let mut command = base.clone();
        command.command = "other-agent".to_string();
        let mut args = base.clone();
        args.args.push("--verbose".to_string());
        let mut env = base.clone();
        env.env.insert("AGENT_COLOR".to_string(), "red".to_string());

        assert_ne!(
            calculate_custom_acp_launch_fingerprint(&command),
            base_fingerprint
        );
        assert_ne!(
            calculate_custom_acp_launch_fingerprint(&args),
            base_fingerprint
        );
        assert_ne!(
            calculate_custom_acp_launch_fingerprint(&env),
            base_fingerprint
        );
    }

    #[test]
    fn fingerprint_uses_canonical_environment_order() {
        let json_a = r#"{"displayName":"Agent","command":"agent","args":[],"env":{"ZED":"1","ALPHA":"2"},"authMode":"external"}"#;
        let json_b = r#"{"displayName":"Agent","command":"agent","args":[],"env":{"ALPHA":"2","ZED":"1"},"authMode":"external"}"#;
        let left: CustomAcpRuntimeDefinitionInput = serde_json::from_str(json_a).unwrap();
        let right: CustomAcpRuntimeDefinitionInput = serde_json::from_str(json_b).unwrap();

        assert_eq!(
            calculate_custom_acp_launch_fingerprint(&left),
            calculate_custom_acp_launch_fingerprint(&right)
        );
    }

    #[test]
    fn rejects_duplicate_names_case_insensitively() {
        let existing = definition("Local Agent", "123e4567-e89b-12d3-a456-426614174000");
        let error =
            validate_custom_acp_runtime_input(input("local agent"), &[existing], None).unwrap_err();
        assert!(error.contains("already exists"));
    }

    #[test]
    fn rejects_protected_and_secret_like_environment_keys() {
        for key in [
            "PATH",
            "Path",
            "PATHEXT",
            "OPENAI_API_KEY",
            "AUTH_TOKEN",
            "PASSWORD",
            "PRIVATE_VALUE",
            "SERVICE_CREDENTIALS",
        ] {
            let mut candidate = input("Agent");
            candidate.env = BTreeMap::from([(key.to_string(), "value".to_string())]);
            assert!(
                validate_custom_acp_runtime_input(candidate, &[], None).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn rejects_invalid_environment_names_and_nul() {
        for key in ["", "9VALUE", "WITH-DASH", "NON_ASCII_Ñ"] {
            let mut candidate = input("Agent");
            candidate.env = BTreeMap::from([(key.to_string(), "value".to_string())]);
            assert!(
                validate_custom_acp_runtime_input(candidate, &[], None).is_err(),
                "{key}"
            );
        }

        let mut candidate = input("Agent");
        candidate.args = vec!["bad\0argument".to_string()];
        assert!(validate_custom_acp_runtime_input(candidate, &[], None).is_err());
    }

    #[test]
    fn enforces_definition_limits() {
        let mut candidate = input("Agent");
        candidate.display_name = "x".repeat(MAX_CUSTOM_ACP_DISPLAY_NAME_LENGTH + 1);
        assert!(validate_custom_acp_runtime_input(candidate, &[], None).is_err());

        let mut candidate = input("Agent");
        candidate.args = vec![String::new(); MAX_CUSTOM_ACP_ARG_COUNT + 1];
        assert!(validate_custom_acp_runtime_input(candidate, &[], None).is_err());

        let mut candidate = input("Agent");
        candidate.env = (0..=MAX_CUSTOM_ACP_ENV_COUNT)
            .map(|index| (format!("VALUE_{index}"), String::new()))
            .collect();
        assert!(validate_custom_acp_runtime_input(candidate, &[], None).is_err());

        let mut candidate = input("Agent");
        candidate.command = "x".repeat(MAX_CUSTOM_ACP_COMMAND_LENGTH);
        candidate.args = vec!["x".repeat(MAX_CUSTOM_ACP_ARG_LENGTH); 8];
        assert!(validate_custom_acp_runtime_input(candidate, &[], None).is_err());
    }

    #[test]
    fn normalizing_persisted_definition_recalculates_fingerprint() {
        let mut persisted = definition("Agent", "123e4567-e89b-12d3-a456-426614174000");
        let expected = persisted.launch_fingerprint.clone();
        persisted.launch_fingerprint = "untrusted".to_string();

        let normalized = normalize_persisted_custom_acp_runtime_definition(persisted, &[]).unwrap();
        assert_eq!(normalized.launch_fingerprint, expected);
    }

    #[test]
    fn rejects_noncanonical_custom_ids_and_zero_revisions() {
        let mut persisted = definition("Agent", "123e4567-e89b-12d3-a456-426614174000");
        persisted.id = "custom:not-a-uuid".to_string();
        assert!(normalize_persisted_custom_acp_runtime_definition(persisted, &[]).is_err());

        let mut persisted = definition("Agent", "123e4567-e89b-12d3-a456-426614174000");
        persisted.revision = 0;
        assert!(normalize_persisted_custom_acp_runtime_definition(persisted, &[]).is_err());

        let mut persisted = definition("Agent", "123e4567-e89b-12d3-a456-426614174000");
        persisted.revision = MAX_CUSTOM_ACP_REVISION + 1;
        assert!(normalize_persisted_custom_acp_runtime_definition(persisted, &[]).is_err());
    }
}
