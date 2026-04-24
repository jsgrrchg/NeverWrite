// Shared utilities for AI runtime clients.

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use neverwrite_ai::{AiConfigOption, AiConfigOptionCategory, AiSession};
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Prevents the child process from spawning a visible console window on Windows.
/// No-op on other platforms.
pub fn configure_background_process(command: &mut Command) {
    #[cfg(windows)]
    {
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    // Suppress unused-parameter warning on non-Windows builds.
    let _ = command;
}

pub(crate) fn apply_mode_update_to_session(session: &mut AiSession, mode_id: &str) {
    session.mode_id = mode_id.to_string();
    if let Some(option) = session
        .config_options
        .iter_mut()
        .find(|option| option.id == "mode")
    {
        option.value = mode_id.to_string();
    }
}

pub(crate) fn apply_config_options_to_session(
    session: &mut AiSession,
    config_options: Vec<AiConfigOption>,
) {
    let mode_id = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Mode))
        .map(|option| option.value.clone());
    let model_id = config_options
        .iter()
        .find(|option| matches!(option.category, AiConfigOptionCategory::Model))
        .map(|option| option.value.clone());

    session.config_options = config_options;

    if let Some(mode_id) = mode_id {
        session.mode_id = mode_id;
    }
    if let Some(model_id) = model_id {
        session.model_id = model_id;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use neverwrite_ai::{AiConfigSelectOption, AiSessionStatus, CLAUDE_RUNTIME_ID};

    use super::*;

    fn test_select_option(value: &str) -> AiConfigSelectOption {
        AiConfigSelectOption {
            value: value.to_string(),
            label: value.to_string(),
            description: None,
        }
    }

    fn test_config_option(
        id: &str,
        category: AiConfigOptionCategory,
        value: &str,
        options: Vec<AiConfigSelectOption>,
    ) -> AiConfigOption {
        AiConfigOption {
            id: id.to_string(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            category,
            label: id.to_string(),
            description: None,
            kind: "select".to_string(),
            value: value.to_string(),
            options,
        }
    }

    fn test_session() -> AiSession {
        AiSession {
            session_id: "session-1".to_string(),
            runtime_id: CLAUDE_RUNTIME_ID.to_string(),
            model_id: "claude-3-5-sonnet".to_string(),
            mode_id: "default".to_string(),
            status: AiSessionStatus::Idle,
            efforts_by_model: HashMap::new(),
            models: Vec::new(),
            modes: Vec::new(),
            config_options: vec![
                test_config_option(
                    "model",
                    AiConfigOptionCategory::Model,
                    "claude-3-5-sonnet",
                    vec![
                        test_select_option("claude-3-5-sonnet"),
                        test_select_option("claude-3-7-sonnet"),
                    ],
                ),
                test_config_option(
                    "mode",
                    AiConfigOptionCategory::Mode,
                    "default",
                    vec![test_select_option("default"), test_select_option("plan")],
                ),
            ],
        }
    }

    #[test]
    fn apply_mode_update_updates_session_and_mode_config_option() {
        let mut session = test_session();

        apply_mode_update_to_session(&mut session, "plan");

        assert_eq!(session.mode_id, "plan");
        assert_eq!(
            session
                .config_options
                .iter()
                .find(|option| option.id == "mode")
                .map(|option| option.value.as_str()),
            Some("plan")
        );
    }

    #[test]
    fn apply_config_options_updates_config_options_and_derived_ids() {
        let mut session = test_session();
        let updated_options = vec![
            test_config_option(
                "model",
                AiConfigOptionCategory::Model,
                "claude-3-7-sonnet",
                vec![
                    test_select_option("claude-3-5-sonnet"),
                    test_select_option("claude-3-7-sonnet"),
                ],
            ),
            test_config_option(
                "mode",
                AiConfigOptionCategory::Mode,
                "plan",
                vec![test_select_option("default"), test_select_option("plan")],
            ),
            test_config_option(
                "reasoning",
                AiConfigOptionCategory::Reasoning,
                "high",
                vec![test_select_option("medium"), test_select_option("high")],
            ),
        ];

        apply_config_options_to_session(&mut session, updated_options.clone());

        assert_eq!(session.model_id, "claude-3-7-sonnet");
        assert_eq!(session.mode_id, "plan");
        assert_eq!(session.config_options, updated_options);
    }

    #[test]
    fn apply_config_options_removes_stale_reasoning_option() {
        let mut session = test_session();
        session.config_options.push(test_config_option(
            "effort",
            AiConfigOptionCategory::Reasoning,
            "high",
            vec![test_select_option("medium"), test_select_option("high")],
        ));

        let updated_options = vec![
            test_config_option(
                "model",
                AiConfigOptionCategory::Model,
                "claude-haiku-4-5",
                vec![
                    test_select_option("claude-sonnet-4-5"),
                    test_select_option("claude-haiku-4-5"),
                ],
            ),
            test_config_option(
                "mode",
                AiConfigOptionCategory::Mode,
                "default",
                vec![test_select_option("default"), test_select_option("plan")],
            ),
        ];

        apply_config_options_to_session(&mut session, updated_options);

        assert_eq!(session.model_id, "claude-haiku-4-5");
        assert!(session
            .config_options
            .iter()
            .all(|option| !matches!(option.category, AiConfigOptionCategory::Reasoning)));
    }
}
