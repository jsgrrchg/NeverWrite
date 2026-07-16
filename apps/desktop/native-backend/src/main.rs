use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    mpsc::{self, Sender},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

mod ai;
mod app_paths;
mod devtools;
mod spellcheck;

use ai::NativeAi;
use app_paths::app_data_dir;
use devtools::DevTerminalManager;
use neverwrite_ai::persistence::{
    self, PersistedSessionHistory, PersistedSessionHistoryPage, SessionSearchResult,
};
use neverwrite_index::VaultIndex;
use neverwrite_types::{
    AdvancedSearchParams, BacklinkDto, NoteDetailDto, NoteDocument, NoteDto, NoteId, NoteMetadata,
    ResolvedWikilinkDto, SearchResultDto, VaultEntryDto, VaultNoteChangeDto, VaultOpenMetricsDto,
    VaultOpenStateDto, WikilinkSuggestionDto,
};
use neverwrite_vault::{
    normalize_existing_vault_path, parser::frontmatter_string_field, start_watcher,
    ScopedPathIntent, Vault, VaultEvent, WriteTracker,
};
use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcheck::SpellcheckState;

const VAULT_CHANGE_ORIGIN_USER: &str = "user";
const VAULT_CHANGE_ORIGIN_AGENT: &str = "agent";
const VAULT_CHANGE_ORIGIN_EXTERNAL: &str = "external";
const DEFAULT_GRAPH_MAX_NODES_GLOBAL: usize = 8_000;
const DEFAULT_GRAPH_MAX_LINKS_GLOBAL: usize = 24_000;
const DEFAULT_GRAPH_MAX_NODES_LOCAL: usize = 2_500;
const DEFAULT_GRAPH_MAX_LINKS_LOCAL: usize = 12_000;
const DEFAULT_LOCAL_GRAPH_HUB_NEIGHBOR_LIMIT: usize = 512;
const AI_DEVICE_SESSIONS_DIR_NAME: &str = "sessions";

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Value,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub(crate) enum RpcOutput {
    #[serde(rename = "response")]
    Response {
        id: Value,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "event")]
    Event {
        #[serde(rename = "eventName")]
        event_name: String,
        payload: Value,
    },
}

#[derive(Debug, Serialize)]
struct VaultFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
    content: String,
    size_bytes: u64,
    content_truncated: bool,
}

#[derive(Debug, Serialize)]
struct SavedBinaryFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct MapEntryDto {
    id: String,
    title: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct TagDto {
    tag: String,
    note_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GraphLinkDto {
    source: String,
    target: String,
}

#[derive(Debug, Deserialize)]
struct GraphGroupQueryDto {
    color: String,
    params: AdvancedSearchParams,
}

#[derive(Debug, Deserialize)]
struct GraphSnapshotOptions {
    #[serde(default = "default_graph_mode")]
    mode: String,
    root_note_id: Option<String>,
    local_depth: Option<u32>,
    preferred_node_ids: Option<Vec<String>>,
    #[serde(default)]
    include_tags: bool,
    #[serde(default)]
    include_attachments: bool,
    #[serde(default)]
    include_groups: bool,
    group_queries: Option<Vec<GraphGroupQueryDto>>,
    search_filter: Option<AdvancedSearchParams>,
    #[serde(default)]
    show_orphans: bool,
    max_nodes: Option<usize>,
    max_links: Option<usize>,
    overview_mode: Option<bool>,
    layout_cache_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct GraphSnapshotStatsDto {
    total_nodes: usize,
    total_links: usize,
    truncated: bool,
    cluster_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
struct GraphNodeDto {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hop_distance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_root: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    importance: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cluster_filter: Option<String>,
}

#[derive(Debug, Serialize)]
struct GraphSnapshotDto {
    version: u32,
    mode: String,
    stats: GraphSnapshotStatsDto,
    nodes: Vec<GraphNodeDto>,
    links: Vec<GraphLinkDto>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseNode {
    id: String,
    title: String,
    overview_cluster_id: String,
    overview_cluster_title: String,
    overview_cluster_filter: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseTag {
    id: String,
    title: String,
    note_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseAttachment {
    id: String,
    title: String,
    source_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedGraphBaseSnapshot {
    note_nodes: Vec<CachedGraphBaseNode>,
    note_links: Vec<GraphLinkDto>,
    tags: Vec<CachedGraphBaseTag>,
    attachments: Vec<CachedGraphBaseAttachment>,
}

fn default_graph_mode() -> String {
    "global".to_string()
}

fn graph_search_has_filters(params: &AdvancedSearchParams) -> bool {
    !params.terms.is_empty()
        || !params.tag_filters.is_empty()
        || !params.file_filters.is_empty()
        || !params.path_filters.is_empty()
        || !params.content_searches.is_empty()
        || !params.property_filters.is_empty()
}

fn normalize_graph_query(params: &AdvancedSearchParams) -> Result<String, String> {
    serde_json::to_string(params).map_err(|error| error.to_string())
}

fn resolve_graph_query_ids_batch(
    state: &VaultRuntimeState,
    queries: &[&AdvancedSearchParams],
) -> Result<HashMap<String, HashSet<String>>, String> {
    let mut resolved = HashMap::<String, HashSet<String>>::new();

    for query in queries {
        let normalized_query = normalize_graph_query(query)?;
        if resolved.contains_key(&normalized_query) {
            continue;
        }
        resolved.insert(
            normalized_query,
            state.index.advanced_search_note_ids(query, &state.vault),
        );
    }

    Ok(resolved)
}

fn graph_node_type_rank(node_type: Option<&str>) -> u8 {
    match node_type {
        Some("cluster") => 0,
        Some("tag") => 1,
        Some("attachment") => 2,
        _ => 0,
    }
}

fn graph_note_title(index: &VaultIndex, note_id: &NoteId) -> Option<String> {
    index.metadata.get(note_id).map(|meta| meta.title.clone())
}

fn graph_note_weight(index: &VaultIndex, note_id: &NoteId) -> usize {
    index.forward_links.get(note_id).map_or(0, Vec::len)
        + index.backlinks.get(note_id).map_or(0, Vec::len)
}

fn graph_sort_nodes_by_priority(
    nodes: &mut [GraphNodeDto],
    links: &[GraphLinkDto],
    preferred_node_ids: &HashSet<String>,
) {
    let mut degrees = HashMap::<&str, usize>::new();
    for link in links {
        *degrees.entry(link.source.as_str()).or_default() += 1;
        *degrees.entry(link.target.as_str()).or_default() += 1;
    }

    nodes.sort_by(|left, right| {
        let left_is_root = left.is_root.unwrap_or(false);
        let right_is_root = right.is_root.unwrap_or(false);
        right_is_root
            .cmp(&left_is_root)
            .then_with(|| {
                let left_is_preferred = preferred_node_ids.contains(&left.id);
                let right_is_preferred = preferred_node_ids.contains(&right.id);
                right_is_preferred.cmp(&left_is_preferred)
            })
            .then_with(|| {
                left.hop_distance
                    .unwrap_or(u32::MAX)
                    .cmp(&right.hop_distance.unwrap_or(u32::MAX))
            })
            .then_with(|| {
                let left_degree = degrees.get(left.id.as_str()).copied().unwrap_or(0);
                let right_degree = degrees.get(right.id.as_str()).copied().unwrap_or(0);
                right_degree.cmp(&left_degree)
            })
            .then_with(|| {
                graph_node_type_rank(left.node_type.as_deref())
                    .cmp(&graph_node_type_rank(right.node_type.as_deref()))
            })
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn graph_truncate_snapshot(
    nodes: &mut Vec<GraphNodeDto>,
    links: &mut Vec<GraphLinkDto>,
    max_nodes: usize,
    max_links: usize,
    preferred_node_ids: &HashSet<String>,
) -> bool {
    let mut truncated = false;
    let max_nodes = max_nodes.max(1);
    let max_links = max_links.max(1);

    graph_sort_nodes_by_priority(nodes, links, preferred_node_ids);

    if nodes.len() > max_nodes {
        nodes.truncate(max_nodes);
        let visible_ids: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
        links.retain(|link| {
            visible_ids.contains(link.source.as_str()) && visible_ids.contains(link.target.as_str())
        });
        truncated = true;
    }

    if links.len() > max_links {
        let mut node_rank = HashMap::<&str, usize>::new();
        for (index, node) in nodes.iter().enumerate() {
            node_rank.insert(node.id.as_str(), index);
        }

        links.sort_by(|left, right| {
            let left_min_rank = node_rank
                .get(left.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .min(
                    node_rank
                        .get(left.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let right_min_rank = node_rank
                .get(right.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .min(
                    node_rank
                        .get(right.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let left_max_rank = node_rank
                .get(left.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .max(
                    node_rank
                        .get(left.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );
            let right_max_rank = node_rank
                .get(right.source.as_str())
                .copied()
                .unwrap_or(usize::MAX)
                .max(
                    node_rank
                        .get(right.target.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                );

            left_min_rank
                .cmp(&right_min_rank)
                .then_with(|| left_max_rank.cmp(&right_max_rank))
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.target.cmp(&right.target))
        });
        links.truncate(max_links);
        truncated = true;
    }

    truncated
}

fn build_limited_local_graph(
    index: &VaultIndex,
    root: &NoteId,
    max_depth: u32,
    max_nodes: usize,
    max_links: usize,
) -> (Vec<(NoteId, u32)>, Vec<GraphLinkDto>, bool) {
    let mut visited: HashSet<NoteId> = HashSet::new();
    let mut queue: VecDeque<(NoteId, u32)> = VecDeque::new();
    let mut nodes: Vec<(NoteId, u32)> = Vec::new();
    let mut truncated = false;
    let node_limit = max_nodes.max(1);
    let link_limit = max_links.max(1);
    let hub_neighbor_limit = DEFAULT_LOCAL_GRAPH_HUB_NEIGHBOR_LIMIT.min(node_limit.max(1));

    if !index.metadata.contains_key(root) {
        return (nodes, Vec::new(), false);
    }

    visited.insert(root.clone());
    queue.push_back((root.clone(), 0));

    while let Some((current, depth)) = queue.pop_front() {
        nodes.push((current.clone(), depth));

        if depth >= max_depth {
            continue;
        }

        let mut unique_neighbors = HashSet::<NoteId>::new();
        if let Some(targets) = index.forward_links.get(&current) {
            unique_neighbors.extend(targets.iter().cloned());
        }
        if let Some(sources) = index.backlinks.get(&current) {
            unique_neighbors.extend(sources.iter().cloned());
        }

        let mut neighbors: Vec<NoteId> = unique_neighbors.into_iter().collect();
        neighbors.sort_by(|left, right| {
            let left_weight = graph_note_weight(index, left);
            let right_weight = graph_note_weight(index, right);
            right_weight
                .cmp(&left_weight)
                .then_with(|| left.0.cmp(&right.0))
        });

        if neighbors.len() > hub_neighbor_limit {
            neighbors.truncate(hub_neighbor_limit);
            truncated = true;
        }

        for neighbor in neighbors {
            if visited.contains(&neighbor) {
                continue;
            }
            if visited.len() >= node_limit {
                truncated = true;
                break;
            }
            visited.insert(neighbor.clone());
            queue.push_back((neighbor, depth + 1));
        }
    }

    let mut links: Vec<GraphLinkDto> = Vec::new();
    for node_id in &visited {
        if let Some(targets) = index.forward_links.get(node_id) {
            for target in targets {
                if visited.contains(target) {
                    links.push(GraphLinkDto {
                        source: node_id.0.clone(),
                        target: target.0.clone(),
                    });
                    if links.len() >= link_limit {
                        truncated = true;
                        return (nodes, links, truncated);
                    }
                }
            }
        }
    }

    (nodes, links, truncated)
}

fn overview_cluster_for_note_id(note_id: &str) -> (String, String, Option<String>) {
    let mut segments = note_id.split('/');
    let first = segments.next().unwrap_or_default();
    if first.is_empty() || !note_id.contains('/') {
        return (
            "cluster:__root__".to_string(),
            "Root Notes".to_string(),
            None,
        );
    }

    let cluster_id = format!("cluster:{first}");
    (cluster_id, first.to_string(), Some(first.to_string()))
}

fn build_graph_base_snapshot(index: &VaultIndex) -> CachedGraphBaseSnapshot {
    let mut note_nodes: Vec<CachedGraphBaseNode> = index
        .metadata
        .values()
        .map(|meta| {
            let (overview_cluster_id, overview_cluster_title, overview_cluster_filter) =
                overview_cluster_for_note_id(&meta.id.0);
            CachedGraphBaseNode {
                id: meta.id.0.clone(),
                title: meta.title.clone(),
                overview_cluster_id,
                overview_cluster_title,
                overview_cluster_filter,
            }
        })
        .collect();
    note_nodes.sort_by(|left, right| left.id.cmp(&right.id));

    let mut note_links: Vec<GraphLinkDto> = index
        .forward_links
        .iter()
        .flat_map(|(source_id, targets)| {
            targets.iter().map(move |target_id| GraphLinkDto {
                source: source_id.0.clone(),
                target: target_id.0.clone(),
            })
        })
        .collect();
    note_links.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.target.cmp(&right.target))
    });

    let mut tags: Vec<CachedGraphBaseTag> = index
        .tags
        .iter()
        .map(|(tag, note_ids)| {
            let mut ids: Vec<String> = note_ids.iter().map(|id| id.0.clone()).collect();
            ids.sort();
            CachedGraphBaseTag {
                id: format!("tag:{tag}"),
                title: format!("#{tag}"),
                note_ids: ids,
            }
        })
        .collect();
    tags.sort_by(|left, right| left.id.cmp(&right.id));

    let mut attachment_sources = HashMap::<String, CachedGraphBaseAttachment>::new();
    for (note_id, targets) in &index.unresolved_links {
        for target in targets {
            let attachment_id = format!("att:{target}");
            let entry = attachment_sources
                .entry(attachment_id.clone())
                .or_insert_with(|| CachedGraphBaseAttachment {
                    id: attachment_id.clone(),
                    title: target.rsplit('/').next().unwrap_or(target).to_string(),
                    source_ids: Vec::new(),
                });
            entry.source_ids.push(note_id.0.clone());
        }
    }

    let mut attachments: Vec<CachedGraphBaseAttachment> =
        attachment_sources.into_values().collect();
    for attachment in &mut attachments {
        attachment.source_ids.sort();
    }
    attachments.sort_by(|left, right| left.id.cmp(&right.id));

    CachedGraphBaseSnapshot {
        note_nodes,
        note_links,
        tags,
        attachments,
    }
}

fn build_overview_graph(
    base_nodes: &[CachedGraphBaseNode],
    visible_note_ids: &HashSet<String>,
    note_links: &[GraphLinkDto],
    show_orphans: bool,
) -> (Vec<GraphNodeDto>, Vec<GraphLinkDto>, usize) {
    let mut note_to_cluster = HashMap::<&str, (&str, &str, Option<&str>)>::new();
    let mut cluster_sizes = HashMap::<String, (String, Option<String>, u32)>::new();

    for node in base_nodes {
        if !visible_note_ids.contains(&node.id) {
            continue;
        }

        note_to_cluster.insert(
            node.id.as_str(),
            (
                node.overview_cluster_id.as_str(),
                node.overview_cluster_title.as_str(),
                node.overview_cluster_filter.as_deref(),
            ),
        );

        let entry = cluster_sizes
            .entry(node.overview_cluster_id.clone())
            .or_insert((
                node.overview_cluster_title.clone(),
                node.overview_cluster_filter.clone(),
                0,
            ));
        entry.2 += 1;
    }

    let mut cluster_links = HashSet::<(String, String)>::new();
    for link in note_links {
        let Some((source_cluster, _, _)) = note_to_cluster.get(link.source.as_str()) else {
            continue;
        };
        let Some((target_cluster, _, _)) = note_to_cluster.get(link.target.as_str()) else {
            continue;
        };
        if source_cluster == target_cluster {
            continue;
        }

        let ordered = if source_cluster <= target_cluster {
            ((*source_cluster).to_string(), (*target_cluster).to_string())
        } else {
            ((*target_cluster).to_string(), (*source_cluster).to_string())
        };
        cluster_links.insert(ordered);
    }

    let mut nodes: Vec<GraphNodeDto> = cluster_sizes
        .into_iter()
        .map(
            |(cluster_id, (cluster_title, cluster_filter, size))| GraphNodeDto {
                id: cluster_id,
                title: format!("{cluster_title} ({size})"),
                node_type: Some("cluster".to_string()),
                hop_distance: None,
                group_color: None,
                is_root: None,
                importance: Some(size),
                cluster_filter,
            },
        )
        .collect();

    let mut links: Vec<GraphLinkDto> = cluster_links
        .into_iter()
        .map(|(source, target)| GraphLinkDto { source, target })
        .collect();

    if !show_orphans {
        let connected_ids: HashSet<&str> = links
            .iter()
            .flat_map(|link| [link.source.as_str(), link.target.as_str()])
            .collect();
        nodes.retain(|node| connected_ids.contains(node.id.as_str()));
    }

    links.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.target.cmp(&right.target))
    });
    nodes.sort_by(|left, right| left.id.cmp(&right.id));

    let cluster_count = nodes.len();
    (nodes, links, cluster_count)
}

#[derive(Debug, Deserialize)]
struct ComputeLineDiffInput {
    #[serde(rename = "oldText", alias = "old_text")]
    old_text: String,
    #[serde(rename = "newText", alias = "new_text")]
    new_text: String,
}

struct VaultRuntimeState {
    vault: Vault,
    index: VaultIndex,
    entries: Vec<VaultEntryDto>,
    open_state: VaultOpenStateDto,
    graph_revision: u64,
    note_revisions: HashMap<String, u64>,
    file_revisions: HashMap<String, u64>,
    write_tracker: WriteTracker,
    _watcher: Option<RecommendedWatcher>,
}

struct NativeBackend {
    vaults: HashMap<String, VaultRuntimeState>,
    active_ai_history_moves: HashSet<String>,
    ai: NativeAi,
    devtools: DevTerminalManager,
    spellcheck: SpellcheckState,
    event_tx: Sender<RpcOutput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum AiStorageScope {
    Vault,
    Device,
}

struct AiSessionsStorage {
    scope: AiStorageScope,
    vault_key: String,
    vault_root: PathBuf,
    sessions_root: PathBuf,
}

/// Backend-owned source of truth for the active history namespace. Renderer
/// preferences mirror this value, but cannot safely arbitrate concurrent
/// windows or requests already queued in the sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiHistoryScopeState {
    scope: AiStorageScope,
    revision: u64,
    #[serde(default)]
    enforced: bool,
}

#[derive(Default)]
struct AiAttachmentCopyReport {
    failures: Vec<String>,
}

#[derive(Serialize)]
struct AiHistoryMoveResult {
    completed: bool,
    from_scope: &'static str,
    to_scope: &'static str,
    histories_moved: usize,
    histories_deduplicated: usize,
    conflicts: Vec<String>,
    recovery_required: bool,
}

struct AiAttachmentMigrationContext {
    vault_root: PathBuf,
    app_data_root: PathBuf,
    vault_key: String,
    from_scope: AiStorageScope,
    target_attachments_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
enum AiHistoryMoveJournalState {
    Preparing,
    Prepared,
    Publishing,
    CleanupPending,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiHistoryMoveJournal {
    version: u32,
    operation_id: String,
    vault_key: String,
    from_scope: AiStorageScope,
    to_scope: AiStorageScope,
    state: AiHistoryMoveJournalState,
    staging_root: PathBuf,
    staged_sessions_root: PathBuf,
    staged_attachments_root: PathBuf,
    session_ids: Vec<String>,
    #[serde(default)]
    published_session_ids: Vec<String>,
    #[serde(default)]
    publishing_session_id: Option<String>,
    #[serde(default)]
    cleanup_attachment_paths: Vec<PathBuf>,
    #[serde(default)]
    cleanup_manifest_ready: bool,
    /// Fingerprints are captured before staging. Recovery must never delete a
    /// source that changed while NeverWrite was not running.
    #[serde(default)]
    source_history_fingerprints: HashMap<String, String>,
    /// A duplicate can still need publication when it references an
    /// attachment owned by the source namespace.
    #[serde(default)]
    repair_session_ids: Vec<String>,
    #[serde(default)]
    destination_history_fingerprints: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AiHistoryMoveConflictKind {
    DifferentContent,
    SameTimestampDifferentContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AiHistoryMoveConflict {
    session_id: String,
    kind: AiHistoryMoveConflictKind,
}

#[derive(Debug)]
struct PreparedAiHistoryMove {
    journal: AiHistoryMoveJournal,
    staged_histories: Vec<PersistedSessionHistory>,
    copied_attachments: Vec<CopiedAiAttachment>,
    deduplicated_session_ids: Vec<String>,
}

#[derive(Debug)]
struct CopiedAiAttachment {
    source: PathBuf,
    target: PathBuf,
}

impl NativeBackend {
    fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            vaults: HashMap::new(),
            active_ai_history_moves: HashSet::new(),
            ai: NativeAi::new(event_tx.clone()),
            devtools: DevTerminalManager::new(event_tx.clone()),
            spellcheck: SpellcheckState::new(),
            event_tx,
        }
    }
}

impl NativeBackend {
    fn invoke(
        &mut self,
        command: &str,
        args: Value,
        backend_ref: &Arc<Mutex<NativeBackend>>,
    ) -> Result<Value, String> {
        match command {
            "ping" => Ok(json!({ "ok": true })),
            "open_vault" => {
                let path = required_string(&args, &["path"])?;
                self.open_vault(path.clone(), backend_ref)?;
                self.invoke("list_notes", json!({ "vaultPath": path }), backend_ref)
            }
            "start_open_vault" => {
                let path = required_string(&args, &["path"])?;
                self.open_vault(path, backend_ref)?;
                Ok(json!(null))
            }
            "cancel_open_vault" => {
                let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
                let root = normalize_vault_path(&vault_path)?;
                let state = self
                    .vaults
                    .entry(root.clone())
                    .or_insert_with(|| cancelled_placeholder_state(root.clone()));
                state.open_state.stage = "cancelled".to_string();
                state.open_state.message = "Opening cancelled".to_string();
                state.open_state.cancelled = true;
                state.open_state.finished_at_ms = Some(now_ms());
                Ok(json!(null))
            }
            "get_vault_open_state" => {
                let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
                let root = normalize_vault_path(&vault_path)?;
                Ok(json!(self
                    .vaults
                    .get(&root)
                    .map(|state| { state.open_state.clone() })
                    .unwrap_or_else(idle_open_state)))
            }
            "list_notes" => {
                let state = self.state(&args)?;
                let mut notes: Vec<NoteDto> =
                    state.index.metadata.values().map(note_to_dto).collect();
                notes.sort_by(|left, right| left.id.cmp(&right.id));
                Ok(json!(notes))
            }
            "get_graph_revision" => {
                let state = self.state(&args)?;
                Ok(json!(state.graph_revision.max(1)))
            }
            "get_graph_snapshot" => self.get_graph_snapshot(args),
            "list_vault_entries" => {
                let state = self.state(&args)?;
                Ok(json!(state.entries))
            }
            "read_vault_entry" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                let path = state
                    .vault
                    .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
                    .map_err(|error| error.to_string())?;
                Ok(json!(state
                    .vault
                    .read_vault_entry_from_path(&path)
                    .map_err(|error| error.to_string())?))
            }
            "read_vault_file" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                Ok(json!(build_vault_file_detail(
                    &state.vault,
                    &relative_path
                )?))
            }
            "save_vault_file" => self.save_vault_file(args),
            "save_vault_binary_file" => self.save_vault_binary_file(args),
            "ai_save_attachment" => self.ai_save_attachment(args),
            "ai_delete_attachment" => self.ai_delete_attachment(args),
            "ai_get_attachment_root" => self.ai_get_attachment_root(args),
            "copy_external_file_to_vault" => self.copy_external_file_to_vault(args),
            "read_note" => {
                let state = self.state(&args)?;
                let note_id = required_string(&args, &["noteId", "note_id"])?;
                let note = state
                    .vault
                    .read_note(&note_id)
                    .map_err(|error| error.to_string())?;
                Ok(json!(note_to_detail(&note)))
            }
            "save_note" => self.save_note(args),
            "create_note" => self.create_note(args),
            "create_folder" => self.create_folder(args),
            "delete_folder" => self.delete_folder(args),
            "delete_note" => self.delete_note(args),
            "move_folder" => self.move_folder(args),
            "copy_folder" => self.copy_folder(args),
            "rename_note" => self.rename_note(args),
            "convert_note_to_file" => self.convert_note_to_file(args),
            "move_vault_entry" => self.move_vault_entry(args),
            "move_vault_entry_to_trash" => self.move_vault_entry_to_trash(args),
            "compute_tracked_file_patches" => compute_tracked_file_patches(args),
            "search_notes" => self.search_notes(args),
            "advanced_search" => self.advanced_search(args),
            "get_tags" => {
                let state = self.state(&args)?;
                let mut tags: Vec<TagDto> = state
                    .index
                    .tags
                    .iter()
                    .map(|(tag, note_ids)| TagDto {
                        tag: tag.clone(),
                        note_ids: note_ids.iter().map(|id| id.0.clone()).collect(),
                    })
                    .collect();
                tags.sort_by(|left, right| left.tag.cmp(&right.tag));
                Ok(json!(tags))
            }
            "get_backlinks" => self.get_backlinks(args),
            "resolve_wikilinks_batch" => self.resolve_wikilinks_batch(args),
            "suggest_wikilinks" => self.suggest_wikilinks(args),
            "list_maps" => {
                let state = self.state(&args)?;
                let maps = state.entries.iter().filter_map(map_entry_from_vault_entry);
                Ok(json!(maps.collect::<Vec<_>>()))
            }
            "read_map" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                Ok(json!(state
                    .vault
                    .read_text_file(&relative_path)
                    .map_err(|error| error.to_string())?))
            }
            "save_map" => {
                self.save_vault_file(args)?;
                Ok(json!(null))
            }
            "create_map" => self.create_map(args),
            "delete_map" => self.delete_map(args),
            "ai_list_runtimes" => Ok(self.ai.list_runtimes()),
            "ai_get_setup_status" => self.ai.get_setup_status(&args),
            "ai_get_environment_diagnostics" => Ok(self.ai.get_environment_diagnostics()),
            "ai_update_setup" => self.ai.update_setup(&args),
            "ai_start_auth" => self.ai.start_auth(&args),
            "ai_logout" => self.ai.logout(&args),
            "ai_list_sessions" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.list_sessions(vault_root)
            }
            "ai_load_session" => self.ai.load_session(&args),
            "ai_load_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.load_runtime_session(&args, vault_root)
            }
            "ai_resume_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.resume_runtime_session(&args, vault_root)
            }
            "ai_fork_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.fork_runtime_session(&args, vault_root)
            }
            "ai_create_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.create_session(&args, vault_root)
            }
            "ai_set_model" => self.ai.set_model(&args),
            "ai_set_mode" => self.ai.set_mode(&args),
            "ai_set_config_option" => self.ai.set_config_option(&args),
            "ai_send_message" => self.ai.send_message(&args),
            "ai_cancel_turn" => self.ai.cancel_turn(&args),
            "ai_respond_permission" => self.ai.respond_permission(&args),
            "ai_respond_user_input" => self.ai.respond_user_input(&args),
            "ai_respond_url_elicitation" => self.ai.respond_url_elicitation(&args),
            "ai_delete_runtime_session" => self.ai.delete_runtime_session(&args),
            "ai_delete_runtime_sessions_for_vault" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.delete_runtime_sessions_for_vault(vault_root)
            }
            "ai_register_file_baseline" => self.ai.register_file_baseline(&args),
            "ai_save_session_history" => self.ai_save_session_history(args),
            "ai_set_history_scope" => self.ai_set_history_scope(args),
            "ai_move_all_session_histories" => self.ai_move_all_session_histories(args),
            "ai_load_session_histories" => self.ai_load_session_histories(args),
            "ai_load_session_history_page" => self.ai_load_session_history_page(args),
            "ai_search_session_content" => self.ai_search_session_content(args),
            "ai_fork_session_history" => self.ai_fork_session_history(args),
            "ai_delete_session_history" => self.ai_delete_session_history(args),
            "ai_delete_all_session_histories" => self.ai_delete_all_session_histories(args),
            "ai_prune_session_histories" => self.ai_prune_session_histories(args),
            "ai_get_text_file_hash" => self.ai_get_text_file_hash(args),
            "ai_restore_text_file" => self.ai_restore_text_file(args),
            "ai_start_auth_terminal_session" => self.ai.start_auth_terminal_session(&args),
            "ai_write_auth_terminal_session" => self.ai.write_auth_terminal_session(&args),
            "ai_resize_auth_terminal_session" => self.ai.resize_auth_terminal_session(&args),
            "ai_close_auth_terminal_session" => self.ai.close_auth_terminal_session(&args),
            "ai_get_auth_terminal_session_snapshot" => {
                self.ai.get_auth_terminal_session_snapshot(&args)
            }
            "devtools_create_terminal_session"
            | "devtools_write_terminal_session"
            | "devtools_resize_terminal_session"
            | "devtools_restart_terminal_session"
            | "devtools_close_terminal_session"
            | "devtools_get_terminal_session_snapshot"
            | "devtools_check_binary"
            | "devtools_read_claude_transcript" => self.devtools.invoke(command, args),
            "spellcheck_list_languages"
            | "spellcheck_list_catalog"
            | "spellcheck_check_text"
            | "spellcheck_suggest"
            | "spellcheck_add_to_dictionary"
            | "spellcheck_remove_from_dictionary"
            | "spellcheck_ignore_word"
            | "spellcheck_get_runtime_directory"
            | "spellcheck_install_dictionary"
            | "spellcheck_remove_installed_dictionary"
            | "spellcheck_check_grammar" => self.spellcheck.invoke(command, args),
            "web_clipper_ready_vaults" => self.web_clipper_ready_vaults(),
            "web_clipper_list_folders" => self.web_clipper_list_folders(args),
            "web_clipper_list_tags" => self.web_clipper_list_tags(args),
            "web_clipper_save_note" => self.web_clipper_save_note(args),
            "sync_recent_vaults"
            | "delete_vault_snapshot"
            | "register_window_vault_route"
            | "unregister_window_vault_route" => Ok(json!(null)),
            _ => Err(format!(
                "Native backend command is not implemented yet: {command}"
            )),
        }
    }

    fn state(&self, args: &Value) -> Result<&VaultRuntimeState, String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        self.vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())
    }

    fn state_mut(&mut self, args: &Value) -> Result<(String, &mut VaultRuntimeState), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get_mut(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok((root, state))
    }

    fn optional_open_vault_root(&self, args: &Value) -> Result<Option<PathBuf>, String> {
        let Some(vault_path) = optional_nullable_string(args, &["vaultPath", "vault_path"]) else {
            return Ok(None);
        };
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok(Some(state.vault.root.clone()))
    }

    fn ensure_ai_history_mutation_is_unlocked(&self, args: &Value) -> Result<(), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let vault_key = normalize_vault_path(&vault_path)?;
        if self.active_ai_history_moves.contains(&vault_key) {
            return Err(
                "AI history is being moved for this vault. Try again after recovery completes."
                    .to_string(),
            );
        }
        Ok(())
    }

    fn ensure_ai_history_scope_is_current(&self, args: &Value) -> Result<(), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let vault_key = normalize_vault_path(&vault_path)?;
        let requested_scope = ai_storage_scope_arg(args)?;
        let app_data_root = app_data_dir();
        match load_ai_history_scope_state(&vault_key, &app_data_root) {
            Some(state) if state.enforced && state.scope != requested_scope => Err(format!(
                "AI history scope changed to {} (revision {}). Refresh and retry the pending save.",
                ai_storage_scope_name(state.scope),
                state.revision,
            )),
            Some(_) => Ok(()),
            None => write_ai_history_scope_state(
                &vault_key,
                &app_data_root,
                AiHistoryScopeState {
                    scope: requested_scope,
                    revision: 1,
                    enforced: false,
                },
            ),
        }
    }

    fn required_open_vault_root(&self, args: &Value) -> Result<(String, PathBuf), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok((root, state.vault.root.clone()))
    }

    fn required_ai_sessions_storage(&self, args: &Value) -> Result<AiSessionsStorage, String> {
        let (vault_key, vault_root) = self.required_open_vault_root(args)?;
        let scope = ai_storage_scope_arg(args)?;
        Ok(ai_sessions_storage_for_scope(
            &vault_key,
            &vault_root,
            scope,
            &app_data_dir(),
        ))
    }

    fn required_ai_sessions_storage_for_existing_vault_path(
        &self,
        args: &Value,
    ) -> Result<AiSessionsStorage, String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let vault_key = normalize_vault_path(&vault_path)?;
        let vault_root = self
            .vaults
            .get(&vault_key)
            .map(|state| state.vault.root.clone())
            .unwrap_or_else(|| PathBuf::from(&vault_key));
        let scope = ai_storage_scope_arg(args)?;
        Ok(ai_sessions_storage_for_scope(
            &vault_key,
            &vault_root,
            scope,
            &app_data_dir(),
        ))
    }

    fn ai_save_session_history(&self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        self.ensure_ai_history_scope_is_current(&args)?;
        let storage = self.required_ai_sessions_storage(&args)?;
        let history: PersistedSessionHistory = serde_json::from_value(
            args.get("history")
                .cloned()
                .ok_or_else(|| "Missing argument: history".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        match storage.scope {
            AiStorageScope::Vault => {
                persistence::save_session_history(&storage.vault_root, &history)?
            }
            AiStorageScope::Device => {
                persistence::save_session_history_in_storage_root(&storage.sessions_root, &history)?
            }
        }
        Ok(json!(null))
    }

    fn ai_set_history_scope(&self, args: Value) -> Result<Value, String> {
        let (vault_key, _) = self.required_open_vault_root(&args)?;
        let scope = required_ai_storage_scope_arg(&args, &["storageScope", "storage_scope"])?;
        let expected_scope = required_ai_storage_scope_arg(&args, &["expectedScope", "expected_scope"])?;
        let app_data_root = app_data_dir();
        let next_revision = match load_ai_history_scope_state(&vault_key, &app_data_root) {
            Some(state) if state.enforced && state.scope != expected_scope => {
                return Err(format!(
                    "AI history scope changed to {} (revision {}). Refresh before changing history storage.",
                    ai_storage_scope_name(state.scope),
                    state.revision,
                ));
            }
            Some(state) => state.revision.saturating_add(1),
            None => 1,
        };
        write_ai_history_scope_state(
            &vault_key,
            &app_data_root,
            AiHistoryScopeState {
                scope,
                revision: next_revision,
                enforced: true,
            },
        )?;
        Ok(json!({
            "scope": ai_storage_scope_name(scope),
            "revision": next_revision,
        }))
    }

    fn ai_move_all_session_histories(&mut self, args: Value) -> Result<Value, String> {
        let (vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let from_scope = required_ai_storage_scope_arg(&args, &["fromScope", "from_scope"])?;
        let to_scope = required_ai_storage_scope_arg(&args, &["toScope", "to_scope"])?;
        if from_scope == to_scope {
            return Err("AI history move source and destination scopes must differ.".to_string());
        }
        if !self.active_ai_history_moves.insert(vault_key.clone()) {
            return Err("AI history is already being moved for this vault.".to_string());
        }
        let app_data_root = app_data_dir();
        if let Some(state) = load_ai_history_scope_state(&vault_key, &app_data_root) {
            if state.enforced && state.scope != from_scope {
                self.active_ai_history_moves.remove(&vault_key);
                return Err(format!(
                    "AI history scope changed to {} (revision {}). Refresh before moving history.",
                    ai_storage_scope_name(state.scope),
                    state.revision,
                ));
            }
        }
        let result = (|| {
            if recover_ai_history_moves(&vault_key, &vault_root, &app_data_root).is_err() {
                return Ok(json!(AiHistoryMoveResult {
                    completed: false,
                    from_scope: ai_storage_scope_name(from_scope),
                    to_scope: ai_storage_scope_name(to_scope),
                    histories_moved: 0,
                    histories_deduplicated: 0,
                    conflicts: Vec::new(),
                    recovery_required: true,
                }));
            }
            let conflicts = inspect_ai_history_move_conflicts(
                &vault_key,
                &vault_root,
                &app_data_root,
                from_scope,
                to_scope,
            )?;
            if !conflicts.is_empty() {
                return Ok(json!(AiHistoryMoveResult {
                    completed: false,
                    from_scope: ai_storage_scope_name(from_scope),
                    to_scope: ai_storage_scope_name(to_scope),
                    histories_moved: 0,
                    histories_deduplicated: 0,
                    conflicts,
                    recovery_required: false,
                }));
            }
            let mut prepared = match prepare_ai_history_move_staging(
                &vault_key,
                &vault_root,
                &app_data_root,
                from_scope,
                to_scope,
            ) {
                Ok(prepared) => prepared,
                Err(_) => {
                    return Ok(json!(AiHistoryMoveResult {
                        completed: false,
                        from_scope: ai_storage_scope_name(from_scope),
                        to_scope: ai_storage_scope_name(to_scope),
                        histories_moved: 0,
                        histories_deduplicated: 0,
                        conflicts: Vec::new(),
                        recovery_required: false,
                    }));
                }
            };
            let histories_moved = prepared.staged_histories.len();
            let histories_deduplicated = prepared.deduplicated_session_ids.len();
            if publish_prepared_ai_history_move(&mut prepared.journal, &vault_root, &app_data_root)
                .is_err()
            {
                return Ok(json!(AiHistoryMoveResult {
                    completed: false,
                    from_scope: ai_storage_scope_name(from_scope),
                    to_scope: ai_storage_scope_name(to_scope),
                    histories_moved,
                    histories_deduplicated,
                    conflicts: Vec::new(),
                    recovery_required: true,
                }));
            }
            Ok(json!(AiHistoryMoveResult {
                completed: true,
                from_scope: ai_storage_scope_name(from_scope),
                to_scope: ai_storage_scope_name(to_scope),
                histories_moved,
                histories_deduplicated,
                conflicts: Vec::new(),
                recovery_required: false,
            }))
        })();
        self.active_ai_history_moves.remove(&vault_key);
        result
    }

    fn ai_load_session_histories(&self, args: Value) -> Result<Value, String> {
        let storage = self.required_ai_sessions_storage(&args)?;
        let include_messages = bool_arg(&args, "includeMessages")
            .or_else(|| bool_arg(&args, "include_messages"))
            .unwrap_or(true);
        let histories: Vec<PersistedSessionHistory> = match storage.scope {
            AiStorageScope::Vault => {
                persistence::load_all_session_histories(&storage.vault_root, include_messages)?
            }
            AiStorageScope::Device => persistence::load_all_session_histories_in_storage_root(
                &storage.sessions_root,
                include_messages,
            )?,
        };
        Ok(json!(histories))
    }

    fn ai_load_session_history_page(&self, args: Value) -> Result<Value, String> {
        let storage = self.required_ai_sessions_storage(&args)?;
        let session_id = required_string(&args, &["sessionId", "session_id"])?;
        let start_index = required_usize(&args, &["startIndex", "start_index"])?;
        let limit = required_usize(&args, &["limit"])?;
        let page: PersistedSessionHistoryPage = match storage.scope {
            AiStorageScope::Vault => persistence::load_session_history_page(
                &storage.vault_root,
                &session_id,
                start_index,
                limit,
            )?,
            AiStorageScope::Device => persistence::load_session_history_page_in_storage_root(
                &storage.sessions_root,
                &session_id,
                start_index,
                limit,
            )?,
        };
        Ok(json!(page))
    }

    fn ai_search_session_content(&self, args: Value) -> Result<Value, String> {
        let storage = self.required_ai_sessions_storage(&args)?;
        let query = required_string(&args, &["query"])?;
        let results: Vec<SessionSearchResult> = match storage.scope {
            AiStorageScope::Vault => {
                persistence::search_session_content(&storage.vault_root, &query)?
            }
            AiStorageScope::Device => {
                persistence::search_session_content_in_storage_root(&storage.sessions_root, &query)?
            }
        };
        Ok(json!(results))
    }

    fn ai_fork_session_history(&self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        self.ensure_ai_history_scope_is_current(&args)?;
        let storage = self.required_ai_sessions_storage(&args)?;
        let source_session_id = required_string(&args, &["sourceSessionId", "source_session_id"])?;
        let forked_id = match storage.scope {
            AiStorageScope::Vault => {
                persistence::fork_session_history(&storage.vault_root, &source_session_id)?
            }
            AiStorageScope::Device => persistence::fork_session_history_in_storage_root(
                &storage.sessions_root,
                &source_session_id,
            )?,
        };
        Ok(json!(forked_id))
    }

    fn ai_delete_session_history(&self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        self.ensure_ai_history_scope_is_current(&args)?;
        let storage = self.required_ai_sessions_storage(&args)?;
        let session_id = required_string(&args, &["sessionId", "session_id"])?;
        let history = load_session_histories_for_storage(&storage, true)?
            .into_iter()
            .find(|history| history.session_id == session_id);
        delete_session_history_for_storage(&storage, &session_id)?;
        if let Some(history) = history {
            cleanup_history_attachments(&storage, &[history])?;
        }
        Ok(json!(null))
    }

    fn ai_delete_all_session_histories(&self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        self.ensure_ai_history_scope_is_current(&args)?;
        let storage = self.required_ai_sessions_storage_for_existing_vault_path(&args)?;
        match storage.scope {
            AiStorageScope::Vault => {
                persistence::delete_all_session_histories(&storage.vault_root)?
            }
            AiStorageScope::Device => {
                persistence::delete_all_session_histories_in_storage_root(&storage.sessions_root)?
            }
        }
        cleanup_attachment_namespace(&storage)?;
        Ok(json!(null))
    }

    fn ai_prune_session_histories(&self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        self.ensure_ai_history_scope_is_current(&args)?;
        let storage = self.required_ai_sessions_storage(&args)?;
        let max_age_days = required_u32(&args, &["maxAgeDays", "max_age_days"])?;
        let pruned_histories =
            load_expired_session_histories_for_cleanup(&storage.sessions_root, max_age_days)?;
        let deleted = match storage.scope {
            AiStorageScope::Vault => {
                persistence::prune_expired_session_histories(&storage.vault_root, max_age_days)?
            }
            AiStorageScope::Device => persistence::prune_expired_session_histories_in_storage_root(
                &storage.sessions_root,
                max_age_days,
            )?,
        };
        cleanup_history_attachments(&storage, &pruned_histories)?;
        Ok(json!(deleted))
    }

    fn ai_get_text_file_hash(&self, args: Value) -> Result<Value, String> {
        let state = self.state(&args)?;
        let path = required_string(&args, &["path"])?;
        let resolved_path =
            resolve_vault_scoped_path(&state.vault, &path, ScopedPathIntent::ReadExisting)?;
        match fs::read(&resolved_path) {
            Ok(bytes) => Ok(json!(Some(content_hash_bytes(&bytes)))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!(null)),
            Err(error) => Err(error.to_string()),
        }
    }

    fn ai_restore_text_file(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["path"])?;
        let previous_path = optional_nullable_string(&args, &["previousPath", "previous_path"]);
        let content = optional_nullable_string(&args, &["content"]);
        let op_id = Some(format!("ai-restore-{}", now_ms()));
        let (vault_path, state) = self.state_mut(&args)?;
        let current_path = resolve_vault_scoped_path(
            &state.vault,
            &relative_path,
            ScopedPathIntent::CreateTarget,
        )?;
        let restore_path = previous_path
            .as_deref()
            .map(|value| {
                resolve_vault_scoped_path(&state.vault, value, ScopedPathIntent::CreateTarget)
            })
            .transpose()?;
        let final_path = restore_path.clone().unwrap_or_else(|| current_path.clone());

        state.write_tracker.track_any(current_path.clone());
        if let Some(path) = restore_path.as_ref() {
            state.write_tracker.track_any(path.clone());
        }

        let change = if let Some(text) = content {
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            state.write_tracker.track_content(final_path.clone(), &text);
            fs::write(&final_path, &text).map_err(|error| error.to_string())?;
            if final_path != current_path && current_path.exists() {
                fs::remove_file(&current_path).map_err(|error| error.to_string())?;
            }
            Self::refresh_vault_state(state)?;
            let final_relative_path = state.vault.path_to_relative_path(&final_path);
            if path_has_extension(&final_path, "md") {
                let note = state
                    .vault
                    .read_note_from_path(&final_path)
                    .map_err(|error| error.to_string())?;
                let previous_note_id = (final_path != current_path
                    && path_has_extension(&current_path, "md"))
                .then(|| state.vault.path_to_id(&current_path));
                let revision = advance_revision(
                    &mut state.note_revisions,
                    &note.id.0,
                    previous_note_id.as_deref(),
                )
                .max(1);
                build_vault_note_change(
                    VaultNoteChangeInput::new(
                        &vault_path,
                        "upsert",
                        revision,
                        state.graph_revision.max(1),
                    )
                    .with_origin(VAULT_CHANGE_ORIGIN_AGENT)
                    .with_note(note_document_to_dto(&note))
                    .with_note_id(note.id.0.clone())
                    .with_relative_path(final_relative_path)
                    .with_op_id(op_id)
                    .with_content_hash(Some(note_content_hash(&note.raw_markdown))),
                )
            } else {
                let entry = state.vault.read_vault_entry_from_path(&final_path).ok();
                let current_relative_path = state.vault.path_to_relative_path(&current_path);
                let previous_key = (current_relative_path != final_relative_path)
                    .then_some(current_relative_path.as_str());
                let revision = advance_revision(
                    &mut state.file_revisions,
                    &final_relative_path,
                    previous_key,
                )
                .max(1);
                build_vault_note_change(
                    VaultNoteChangeInput::new(
                        &vault_path,
                        "upsert",
                        revision,
                        state.graph_revision.max(1),
                    )
                    .with_origin(VAULT_CHANGE_ORIGIN_AGENT)
                    .with_optional_entry(entry)
                    .with_relative_path(final_relative_path)
                    .with_op_id(op_id)
                    .with_content_hash(Some(note_content_hash(&text))),
                )
            }
        } else {
            if current_path.exists() {
                fs::remove_file(&current_path).map_err(|error| error.to_string())?;
            }
            if let Some(path) = restore_path.as_ref() {
                if path.exists() {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                }
            }
            let current_relative_path = state.vault.path_to_relative_path(&current_path);
            let target_relative_path = restore_path
                .as_ref()
                .map(|path| state.vault.path_to_relative_path(path));
            Self::refresh_vault_state(state)?;
            if path_has_extension(&current_path, "md") {
                let note_id = markdown_note_id_from_relative_path(&current_relative_path)
                    .unwrap_or_else(|| state.vault.path_to_id(&current_path));
                let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
                build_vault_note_change(
                    VaultNoteChangeInput::new(
                        &vault_path,
                        "delete",
                        revision,
                        state.graph_revision.max(1),
                    )
                    .with_origin(VAULT_CHANGE_ORIGIN_AGENT)
                    .with_note_id(note_id)
                    .with_relative_path(current_relative_path)
                    .with_op_id(op_id),
                )
            } else {
                let revision = advance_revision(
                    &mut state.file_revisions,
                    &current_relative_path,
                    target_relative_path.as_deref(),
                )
                .max(1);
                build_vault_note_change(
                    VaultNoteChangeInput::new(
                        &vault_path,
                        "delete",
                        revision,
                        state.graph_revision.max(1),
                    )
                    .with_origin(VAULT_CHANGE_ORIGIN_AGENT)
                    .with_relative_path(current_relative_path)
                    .with_op_id(op_id),
                )
            }
        };

        self.emit_vault_change(change.clone());
        Ok(json!(change))
    }

    fn web_clipper_ready_vaults(&self) -> Result<Value, String> {
        let mut vaults = self
            .vaults
            .iter()
            .filter(|(_, state)| state.open_state.stage == "ready")
            .map(|(path, _)| {
                json!({
                    "path": path,
                    "name": clipper_vault_name(path),
                })
            })
            .collect::<Vec<_>>();
        vaults.sort_by(|left, right| {
            left.get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .cmp(
                    right
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
        });
        Ok(json!(vaults))
    }

    fn web_clipper_list_folders(&self, args: Value) -> Result<Value, String> {
        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let state = self
            .vaults
            .get(&vault_key)
            .ok_or_else(|| "Vault not found".to_string())?;
        let mut folders = state
            .entries
            .iter()
            .filter(|entry| entry.kind == "folder")
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();
        folders.sort();
        Ok(json!(folders))
    }

    fn web_clipper_list_tags(&self, args: Value) -> Result<Value, String> {
        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let state = self
            .vaults
            .get(&vault_key)
            .ok_or_else(|| "Vault not found".to_string())?;
        let mut tags = state.index.tags.keys().cloned().collect::<Vec<_>>();
        tags.sort();
        Ok(json!(tags))
    }

    fn web_clipper_save_note(&mut self, args: Value) -> Result<Value, String> {
        let request_id = required_string(&args, &["requestId", "request_id"])?;
        let title = required_string(&args, &["title"])?;
        let folder = optional_string(&args, &["folder"]).unwrap_or_default();
        let content = required_string(&args, &["content"])?;
        if content.trim().is_empty() {
            return Err("Clip content is empty.".to_string());
        }

        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let op_id = Some(format!("web-clipper-{request_id}"));
        let (note, relative_path, change) = {
            let state = self
                .vaults
                .get_mut(&vault_key)
                .ok_or_else(|| "Vault not found".to_string())?;
            let relative_path =
                build_web_clipper_relative_note_path(&state.vault, &folder, &title)?;
            let target_path = state
                .vault
                .resolve_note_relative_markdown_path(&relative_path)
                .map_err(|error| error.to_string())?;
            state.write_tracker.track_content(target_path, &content);
            let note = state
                .vault
                .create_note(&relative_path, &content)
                .map_err(|error| error.to_string())?;
            let entry = state
                .vault
                .read_vault_entry_from_path(&note.path.0)
                .map_err(|error| error.to_string())?;
            let revision = advance_revision(&mut state.note_revisions, &note.id.0, None).max(1);
            let change = build_vault_note_change(
                VaultNoteChangeInput::new(
                    &vault_key,
                    "upsert",
                    revision,
                    state.graph_revision.max(1),
                )
                .with_origin(VAULT_CHANGE_ORIGIN_EXTERNAL)
                .with_note(note_document_to_dto(&note))
                .with_note_id(note.id.0.clone())
                .with_entry(entry)
                .with_relative_path(relative_path.clone())
                .with_op_id(op_id)
                .with_content_hash(Some(note_content_hash(&content))),
            );
            Self::refresh_vault_state(state)?;
            (note, relative_path, change)
        };

        self.emit_vault_change(change);
        Ok(json!({
            "requestId": request_id,
            "vaultPath": vault_key,
            "targetWindowLabel": Value::Null,
            "noteId": note.id.0,
            "title": note.title,
            "relativePath": relative_path,
            "content": content,
        }))
    }

    fn resolve_web_clipper_vault_key(&self, args: &Value) -> Result<String, String> {
        let vault_path_hint = optional_string(args, &["vaultPathHint", "vault_path_hint"]);
        let vault_name_hint = optional_string(args, &["vaultNameHint", "vault_name_hint"]);
        let ready_keys = self
            .vaults
            .iter()
            .filter(|(_, state)| state.open_state.stage == "ready")
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();

        resolve_web_clipper_vault_key_from_ready_keys(
            &ready_keys,
            vault_path_hint.as_deref(),
            vault_name_hint.as_deref(),
        )
    }

    fn open_vault(
        &mut self,
        path: String,
        backend_ref: &Arc<Mutex<NativeBackend>>,
    ) -> Result<(), String> {
        let root = normalize_vault_path(&path)?;
        let started_at_ms = now_ms();
        let vault = Vault::open(PathBuf::from(&root)).map_err(|error| error.to_string())?;
        recover_ai_history_moves(&root, &vault.root, &app_data_dir())?;
        let scan_started_at = now_ms();
        let notes = vault.scan().map_err(|error| error.to_string())?;
        let entries = vault
            .discover_vault_entries()
            .map_err(|error| error.to_string())?;
        let index = VaultIndex::build(notes);
        let scan_ms = now_ms().saturating_sub(scan_started_at);
        let note_count = index.metadata.len();
        let entry_count = entries.len();
        let okf_version = vault.detect_okf_version();
        let write_tracker = WriteTracker::new();
        let watcher = start_vault_watcher(&root, write_tracker.clone(), backend_ref)?;

        self.vaults.insert(
            root.clone(),
            VaultRuntimeState {
                vault,
                index,
                entries,
                open_state: VaultOpenStateDto {
                    path: Some(root),
                    stage: "ready".to_string(),
                    message: "Vault ready".to_string(),
                    processed: entry_count,
                    total: entry_count,
                    note_count,
                    snapshot_used: false,
                    cancelled: false,
                    started_at_ms: Some(started_at_ms),
                    finished_at_ms: Some(now_ms()),
                    metrics: VaultOpenMetricsDto {
                        scan_ms,
                        snapshot_load_ms: 0,
                        parse_ms: 0,
                        index_ms: 0,
                        snapshot_save_ms: 0,
                    },
                    error: None,
                    okf_version,
                },
                graph_revision: 1,
                note_revisions: HashMap::new(),
                file_revisions: HashMap::new(),
                write_tracker,
                _watcher: Some(watcher),
            },
        );
        Ok(())
    }

    fn refresh_vault_state(state: &mut VaultRuntimeState) -> Result<(), String> {
        let notes = state.vault.scan().map_err(|error| error.to_string())?;
        state.index = VaultIndex::build(notes);
        state.entries = state
            .vault
            .discover_vault_entries()
            .map_err(|error| error.to_string())?;
        state.graph_revision = state.graph_revision.saturating_add(1).max(1);
        Ok(())
    }

    fn save_vault_file(&mut self, args: Value) -> Result<Value, String> {
        let content = required_string_allow_empty(&args, &["content"])?;
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::WriteExisting)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        let entry = state
            .vault
            .save_text_file(&relative_path, &content)
            .map_err(|error| error.to_string())?;
        let detail = build_vault_file_detail(&state.vault, &entry.relative_path)?;
        let revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        let change = build_vault_note_change(
            VaultNoteChangeInput::new(&vault_path, "upsert", revision, state.graph_revision.max(1))
                .with_entry(entry)
                .with_relative_path(detail.relative_path.clone())
                .with_op_id(op_id)
                .with_content_hash(Some(note_content_hash(&content))),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn save_vault_binary_file(&mut self, args: Value) -> Result<Value, String> {
        let relative_dir = required_string(&args, &["relativeDir", "relative_dir"])?;
        if is_ai_owned_vault_attachment_dir(&relative_dir) {
            self.ensure_ai_history_mutation_is_unlocked(&args)?;
        }
        let file_name = required_string(&args, &["fileName", "file_name"])?;
        let bytes = bytes_arg(&args, "bytes")?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let path = state
            .vault
            .prepare_binary_file_target(&relative_dir, &file_name)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(path.clone());
        fs::write(&path, &bytes).map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&path)
            .map_err(|error| error.to_string())?;
        let detail = SavedBinaryFileDetail {
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            file_name: entry.file_name.clone(),
            mime_type: entry.mime_type.clone(),
        };
        let revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        Self::refresh_vault_state(state)?;
        let change = build_vault_note_change(
            VaultNoteChangeInput::new(&vault_path, "upsert", revision, state.graph_revision.max(1))
                .with_entry(entry)
                .with_relative_path(detail.relative_path.clone())
                .with_op_id(op_id),
        );
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn ai_save_attachment(&mut self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
        let session_id = required_string(&args, &["sessionId", "session_id"])?;
        let file_name = required_string(&args, &["fileName", "file_name"])?;
        let mime_type = optional_nullable_string(&args, &["mimeType", "mime_type"]);
        let bytes = bytes_arg(&args, "bytes")?;
        let vault_key = normalize_vault_path(&vault_path)?;
        let file_name = sanitize_ai_attachment_file_name(&file_name)?;
        let session_dir = sanitize_ai_attachment_dir_name(&session_id);
        let root = resolve_ai_attachments_root(&vault_key, &app_data_dir());
        let path = write_unique_file(&root.join(session_dir), &file_name, &bytes)?;

        Ok(json!(SavedBinaryFileDetail {
            path: path.to_string_lossy().to_string(),
            relative_path: path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            file_name,
            mime_type,
        }))
    }

    fn ai_delete_attachment(&mut self, args: Value) -> Result<Value, String> {
        self.ensure_ai_history_mutation_is_unlocked(&args)?;
        let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
        let path = required_string(&args, &["path"])?;
        let vault_key = normalize_vault_path(&vault_path)?;
        let root = resolve_ai_attachments_root(&vault_key, &app_data_dir());
        let target = PathBuf::from(path);
        if !target.starts_with(&root) {
            return Err("Attachment path is outside AI app data".to_string());
        }
        let canonical_root = match root.canonicalize() {
            Ok(root) => root,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!(null)),
            Err(error) => return Err(error.to_string()),
        };
        if !target.exists() {
            return Ok(json!(null));
        }
        let canonical_target = target.canonicalize().map_err(|error| error.to_string())?;

        if !canonical_target.starts_with(&canonical_root) {
            return Err("Attachment path is outside AI app data".to_string());
        }
        if canonical_target.is_file() {
            fs::remove_file(canonical_target).map_err(|error| error.to_string())?;
        }

        Ok(json!(null))
    }

    fn ai_get_attachment_root(&self, args: Value) -> Result<Value, String> {
        let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
        let vault_key = normalize_vault_path(&vault_path)?;
        Ok(json!(resolve_ai_attachments_root(
            &vault_key,
            &app_data_dir()
        )
        .to_string_lossy()
        .to_string()))
    }

    fn copy_external_file_to_vault(&mut self, args: Value) -> Result<Value, String> {
        let source_path = required_string(&args, &["sourcePath", "source_path"])?;
        let target_folder =
            optional_string(&args, &["targetFolder", "target_folder"]).unwrap_or_default();
        let (vault_path, state) = self.state_mut(&args)?;

        let source = std::path::PathBuf::from(&source_path);
        if !source.is_file() {
            return Err(format!("Source file not found: {source_path}"));
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Could not determine file name from source path".to_string())?
            .to_string();

        let target = state
            .vault
            .prepare_binary_file_target(&target_folder, &file_name)
            .map_err(|error| error.to_string())?;

        state.write_tracker.track_any(target.clone());
        fs::copy(&source, &target).map_err(|error| error.to_string())?;

        let entry = state
            .vault
            .read_vault_entry_from_path(&target)
            .map_err(|error| error.to_string())?;

        let detail = SavedBinaryFileDetail {
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            file_name: entry.file_name.clone(),
            mime_type: entry.mime_type.clone(),
        };
        Self::refresh_vault_state(state)?;
        let change = if entry.kind == "note" {
            let note = state
                .vault
                .read_note_from_path(&target)
                .map_err(|error| error.to_string())?;
            let revision = advance_revision(&mut state.note_revisions, &note.id.0, None).max(1);
            note_change_from_document(
                &vault_path,
                &note,
                detail.relative_path.clone(),
                None,
                revision,
                state.graph_revision.max(1),
            )
        } else {
            let revision =
                advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
            build_vault_note_change(
                VaultNoteChangeInput::new(
                    &vault_path,
                    "upsert",
                    revision,
                    state.graph_revision.max(1),
                )
                .with_entry(entry)
                .with_relative_path(detail.relative_path.clone()),
            )
        };
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn save_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let content = required_string_allow_empty(&args, &["content"])?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        state
            .vault
            .save_note(&note_id, &content)
            .map_err(|error| error.to_string())?;
        let note = state
            .vault
            .read_note(&note_id)
            .map_err(|error| error.to_string())?;
        let relative_path = state.vault.path_to_relative_path(&note.path.0);
        let detail = note_to_detail(&note);
        let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            relative_path,
            op_id,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn create_note(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["path"])?;
        let content = required_string_allow_empty(&args, &["content"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_note_relative_markdown_path(&relative_path)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        let note = state
            .vault
            .create_note(&relative_path, &content)
            .map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|error| error.to_string())?;
        let detail = note_to_detail(&note);
        let revision = advance_revision(&mut state.note_revisions, &note.id.0, None).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            entry.relative_path,
            None,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn create_folder(&mut self, args: Value) -> Result<Value, String> {
        let path = required_string(&args, &["path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_scoped_path(&path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(target_path);
        let entry = state
            .vault
            .create_folder(&path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn delete_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        track_path_tree(&state.write_tracker, &source);
        state
            .vault
            .delete_folder(&relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn delete_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state
            .vault
            .delete_note(&note_id)
            .map_err(|error| error.to_string())?;
        let relative_path = format!("{note_id}.md");
        let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let change = build_vault_note_change(
            VaultNoteChangeInput::new(&vault_path, "delete", revision, state.graph_revision.max(1))
                .with_note_id(note_id.clone())
                .with_relative_path(relative_path),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(null))
    }

    fn move_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        track_moved_tree(&state.write_tracker, &source, &target);
        state
            .vault
            .move_folder(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn copy_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        track_copied_tree(&state.write_tracker, &source, &target);
        let entry = state
            .vault
            .copy_folder(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn rename_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let new_path = required_string(&args, &["newPath", "new_path"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_note_relative_markdown_path(&new_path)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let note = state
            .vault
            .rename_note(&note_id, &new_path)
            .map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|error| error.to_string())?;
        let detail = note_to_detail(&note);
        let revision =
            advance_revision(&mut state.note_revisions, &note.id.0, Some(&note_id)).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            entry.relative_path,
            None,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn convert_note_to_file(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let entry = state
            .vault
            .convert_note_to_file(&note_id, &new_relative_path)
            .map_err(|error| error.to_string())?;
        let delete_revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let upsert_revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        let graph_revision = state.graph_revision.max(1);
        let delete_change = build_vault_note_change(
            VaultNoteChangeInput::new(&vault_path, "delete", delete_revision, graph_revision)
                .with_note_id(note_id.clone())
                .with_relative_path(format!("{note_id}.md")),
        );
        let upsert_change = build_vault_note_change(
            VaultNoteChangeInput::new(&vault_path, "upsert", upsert_revision, graph_revision)
                .with_entry(entry.clone())
                .with_relative_path(entry.relative_path.clone()),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(delete_change);
        self.emit_vault_change(upsert_change);
        Ok(json!(entry))
    }

    fn move_vault_entry(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let entry = state
            .vault
            .move_vault_entry(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn move_vault_entry_to_trash(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        if !source.is_file() {
            return Err("Only files can be moved to trash".to_string());
        }
        state.write_tracker.track_any(source.clone());
        let trash_dir = state.vault.root.join(".trash");
        fs::create_dir_all(&trash_dir).map_err(|error| error.to_string())?;
        let target = trash_dir.join(format!(
            "{}-{}",
            now_ms(),
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file")
        ));
        fs::rename(&source, target).map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn search_notes(&mut self, args: Value) -> Result<Value, String> {
        let query = required_string(&args, &["query"])?;
        let prefer_file_name = bool_arg(&args, "preferFileName").unwrap_or(false);
        let state = self.state(&args)?;
        let query_lower = query.to_lowercase();
        let mut results: Vec<SearchResultDto> = if prefer_file_name {
            state.index.search_by_file_name(&query)
        } else {
            state.index.search(&query)
        }
        .into_iter()
        .map(|result| SearchResultDto {
            id: result.metadata.id.0.clone(),
            path: result.metadata.path.0.to_string_lossy().to_string(),
            title: result.metadata.title.clone(),
            kind: "note".to_string(),
            score: result.score,
        })
        .collect();

        results.extend(state.entries.iter().filter_map(|entry| {
            if entry.kind == "note" {
                return None;
            }
            let score = non_note_score(&query_lower, entry);
            (score > 0.0).then(|| SearchResultDto {
                id: entry.id.clone(),
                path: entry.path.clone(),
                title: entry.title.clone(),
                kind: entry.kind.clone(),
                score,
            })
        }));
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(200);
        Ok(json!(results))
    }

    fn advanced_search(&mut self, args: Value) -> Result<Value, String> {
        let params: AdvancedSearchParams = serde_json::from_value(
            args.get("params")
                .cloned()
                .ok_or_else(|| "Missing argument: params".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let state = self.state(&args)?;
        Ok(json!(state.index.advanced_search(
            &params,
            &state.vault,
            &state.entries
        )))
    }

    fn get_graph_snapshot(&mut self, args: Value) -> Result<Value, String> {
        let options: GraphSnapshotOptions = serde_json::from_value(
            args.get("options")
                .cloned()
                .ok_or_else(|| "Missing argument: options".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let state = self.state(&args)?;
        let graph_revision = state.graph_revision.max(1);

        let _ = (options.overview_mode, options.layout_cache_key.as_ref());

        let mode = if options.mode == "local" {
            "local"
        } else if options.mode == "overview" {
            "overview"
        } else {
            "global"
        };
        let local_depth = options.local_depth.unwrap_or(2);
        let root_note_id = options.root_note_id.clone();
        let max_nodes = options.max_nodes.unwrap_or(if mode == "local" {
            DEFAULT_GRAPH_MAX_NODES_LOCAL
        } else {
            DEFAULT_GRAPH_MAX_NODES_GLOBAL
        });
        let max_links = options.max_links.unwrap_or(if mode == "local" {
            DEFAULT_GRAPH_MAX_LINKS_LOCAL
        } else {
            DEFAULT_GRAPH_MAX_LINKS_GLOBAL
        });
        let mut preferred_node_ids: HashSet<String> = options
            .preferred_node_ids
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect();
        if let Some(root_id) = root_note_id.as_ref() {
            preferred_node_ids.insert(root_id.clone());
        }

        let mut note_nodes: Vec<GraphNodeDto>;
        let mut note_links: Vec<GraphLinkDto>;
        let mut truncated = false;
        let mut cluster_count = None;

        if mode == "local" {
            let Some(root_note_id) = root_note_id.as_ref() else {
                return Ok(json!(GraphSnapshotDto {
                    version: graph_revision as u32,
                    mode: mode.to_string(),
                    stats: GraphSnapshotStatsDto {
                        total_nodes: 0,
                        total_links: 0,
                        truncated: false,
                        cluster_count: None,
                    },
                    nodes: Vec::new(),
                    links: Vec::new(),
                }));
            };

            let root = NoteId(root_note_id.clone());
            let (bfs_nodes, bfs_links, local_truncated) =
                build_limited_local_graph(&state.index, &root, local_depth, max_nodes, max_links);
            truncated |= local_truncated;

            note_nodes = bfs_nodes
                .iter()
                .filter_map(|(id, depth)| {
                    graph_note_title(&state.index, id).map(|title| GraphNodeDto {
                        id: id.0.clone(),
                        title,
                        node_type: None,
                        hop_distance: Some(*depth),
                        group_color: None,
                        is_root: Some(id.0 == *root_note_id),
                        importance: None,
                        cluster_filter: None,
                    })
                })
                .collect();

            note_links = bfs_links;
        } else {
            let base_snapshot = build_graph_base_snapshot(&state.index);
            note_nodes = base_snapshot
                .note_nodes
                .into_iter()
                .map(|node| GraphNodeDto {
                    id: node.id,
                    title: node.title,
                    node_type: None,
                    hop_distance: None,
                    group_color: None,
                    is_root: None,
                    importance: None,
                    cluster_filter: None,
                })
                .collect();
            note_links = base_snapshot.note_links;
        }

        let search_filter = options
            .search_filter
            .as_ref()
            .filter(|params| graph_search_has_filters(params));
        let group_queries = options.group_queries.as_ref();
        let mut batched_queries: Vec<&AdvancedSearchParams> = Vec::new();
        if let Some(search_filter) = search_filter {
            batched_queries.push(search_filter);
        }
        if options.include_groups {
            if let Some(group_queries) = group_queries {
                for group in group_queries {
                    if graph_search_has_filters(&group.params) {
                        batched_queries.push(&group.params);
                    }
                }
            }
        }

        let resolved_graph_queries = resolve_graph_query_ids_batch(state, &batched_queries)?;

        if let Some(search_filter) = search_filter {
            let normalized_query = normalize_graph_query(search_filter)?;
            let allowed_ids = resolved_graph_queries
                .get(&normalized_query)
                .cloned()
                .unwrap_or_default();
            note_nodes.retain(|node| allowed_ids.contains(&node.id));
        }

        let visible_note_ids: HashSet<String> =
            note_nodes.iter().map(|node| node.id.clone()).collect();
        note_links.retain(|link| {
            visible_note_ids.contains(&link.source) && visible_note_ids.contains(&link.target)
        });

        if mode == "overview" {
            let base_snapshot = build_graph_base_snapshot(&state.index);
            let (mut overview_nodes, mut overview_links, overview_cluster_count) =
                build_overview_graph(
                    &base_snapshot.note_nodes,
                    &visible_note_ids,
                    &note_links,
                    options.show_orphans,
                );

            let total_nodes = overview_nodes.len();
            let total_links = overview_links.len();
            truncated |= graph_truncate_snapshot(
                &mut overview_nodes,
                &mut overview_links,
                max_nodes,
                max_links,
                &preferred_node_ids,
            );

            cluster_count = Some(overview_cluster_count);

            return Ok(json!(GraphSnapshotDto {
                version: graph_revision as u32,
                mode: mode.to_string(),
                stats: GraphSnapshotStatsDto {
                    total_nodes,
                    total_links,
                    truncated,
                    cluster_count,
                },
                nodes: overview_nodes,
                links: overview_links,
            }));
        }

        if options.include_groups {
            if let Some(group_queries) = group_queries {
                let mut note_colors = HashMap::<String, String>::new();
                for group in group_queries {
                    if !graph_search_has_filters(&group.params) {
                        continue;
                    }
                    let normalized_query = normalize_graph_query(&group.params)?;
                    let Some(group_ids) = resolved_graph_queries.get(&normalized_query) else {
                        continue;
                    };

                    for note_id in group_ids {
                        if visible_note_ids.contains(note_id) && !note_colors.contains_key(note_id)
                        {
                            note_colors.insert(note_id.clone(), group.color.clone());
                        }
                    }
                }

                for node in &mut note_nodes {
                    if let Some(color) = note_colors.get(&node.id) {
                        node.group_color = Some(color.clone());
                    }
                }
            }
        }

        let mut nodes = note_nodes;
        let mut links = note_links;

        if options.include_tags {
            let base_snapshot = build_graph_base_snapshot(&state.index);
            for tag in base_snapshot.tags {
                let connected_note_ids: Vec<String> = tag
                    .note_ids
                    .iter()
                    .filter(|id| visible_note_ids.contains(*id))
                    .cloned()
                    .collect();

                if connected_note_ids.is_empty() {
                    continue;
                }

                nodes.push(GraphNodeDto {
                    id: tag.id.clone(),
                    title: tag.title.clone(),
                    node_type: Some("tag".to_string()),
                    hop_distance: None,
                    group_color: None,
                    is_root: None,
                    importance: None,
                    cluster_filter: None,
                });

                links.extend(connected_note_ids.into_iter().map(|note_id| GraphLinkDto {
                    source: note_id,
                    target: tag.id.clone(),
                }));
            }
        }

        if options.include_attachments {
            let base_snapshot = build_graph_base_snapshot(&state.index);
            for attachment in base_snapshot.attachments {
                let connected_source_ids: Vec<String> = attachment
                    .source_ids
                    .iter()
                    .filter(|source_id| visible_note_ids.contains(*source_id))
                    .cloned()
                    .collect();

                if connected_source_ids.is_empty() {
                    continue;
                }

                nodes.push(GraphNodeDto {
                    id: attachment.id.clone(),
                    title: attachment.title.clone(),
                    node_type: Some("attachment".to_string()),
                    hop_distance: None,
                    group_color: None,
                    is_root: None,
                    importance: None,
                    cluster_filter: None,
                });

                links.extend(
                    connected_source_ids
                        .into_iter()
                        .map(|source_id| GraphLinkDto {
                            source: source_id,
                            target: attachment.id.clone(),
                        }),
                );
            }
        }

        if !options.show_orphans {
            let connected_ids: HashSet<String> = links
                .iter()
                .flat_map(|link| [link.source.clone(), link.target.clone()])
                .collect();
            nodes.retain(|node| connected_ids.contains(&node.id));
        }

        let visible_ids: HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
        links.retain(|link| {
            visible_ids.contains(&link.source) && visible_ids.contains(&link.target)
        });

        let total_nodes = nodes.len();
        let total_links = links.len();
        truncated |= graph_truncate_snapshot(
            &mut nodes,
            &mut links,
            max_nodes,
            max_links,
            &preferred_node_ids,
        );
        if !options.show_orphans {
            let connected_ids: HashSet<&str> = links
                .iter()
                .flat_map(|link| [link.source.as_str(), link.target.as_str()])
                .collect();
            nodes.retain(|node| connected_ids.contains(node.id.as_str()));
        }

        Ok(json!(GraphSnapshotDto {
            version: graph_revision as u32,
            mode: mode.to_string(),
            stats: GraphSnapshotStatsDto {
                total_nodes,
                total_links,
                truncated,
                cluster_count,
            },
            nodes,
            links,
        }))
    }

    fn get_backlinks(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let state = self.state(&args)?;
        let id = NoteId(note_id);
        let backlinks: Vec<BacklinkDto> = state
            .index
            .get_backlinks(&id)
            .into_iter()
            .filter_map(|backlink_id| {
                let note = state.index.metadata.get(backlink_id)?;
                Some(BacklinkDto {
                    id: note.id.0.clone(),
                    title: note.title.clone(),
                })
            })
            .collect();
        Ok(json!(backlinks))
    }

    fn resolve_wikilinks_batch(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let targets: Vec<String> = serde_json::from_value(
            args.get("targets")
                .cloned()
                .unwrap_or(Value::Array(Vec::new())),
        )
        .map_err(|error| error.to_string())?;
        let state = self.state(&args)?;
        let from_note = NoteId(note_id);
        let mut seen = HashSet::new();
        let links: Vec<ResolvedWikilinkDto> = targets
            .into_iter()
            .filter(|target| seen.insert(target.clone()))
            .map(|target| {
                let resolved = state.index.resolve_wikilink(&target, &from_note);
                let (resolved_note_id, resolved_title) = match resolved {
                    Some(ref id) => (
                        Some(id.0.clone()),
                        state.index.metadata.get(id).map(|note| note.title.clone()),
                    ),
                    None => (None, None),
                };
                ResolvedWikilinkDto {
                    target,
                    resolved_note_id,
                    resolved_title,
                }
            })
            .collect();
        Ok(json!(links))
    }

    fn suggest_wikilinks(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(8)
            .max(1) as usize;
        let prefer_file_name = bool_arg(&args, "preferFileName").unwrap_or(false);
        let state = self.state(&args)?;
        let suggestions: Vec<WikilinkSuggestionDto> = state
            .index
            .suggest_wikilinks(&query, &NoteId(note_id), limit, prefer_file_name)
            .into_iter()
            .filter_map(|note_id| {
                let metadata = state.index.metadata.get(&note_id)?;
                let insert_text = suggestion_insert_text(metadata);
                Some(WikilinkSuggestionDto {
                    id: metadata.id.0.clone(),
                    title: insert_text.clone(),
                    subtitle: metadata.id.0.clone(),
                    insert_text,
                })
            })
            .collect();
        Ok(json!(suggestions))
    }

    fn create_map(&mut self, args: Value) -> Result<Value, String> {
        let raw_name = optional_string(&args, &["name"]).unwrap_or_else(|| "Untitled".to_string());
        let title = raw_name.trim().trim_end_matches(".excalidraw");
        let title = if title.is_empty() { "Untitled" } else { title };
        let relative_path = format!("Excalidraw/{title}.excalidraw");
        let (_vault_path, state) = self.state_mut(&args)?;
        let target = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        state.write_tracker.track_any(target.clone());
        fs::write(&target, "{}").map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(MapEntryDto {
            id: relative_path.clone(),
            title: title.to_string(),
            relative_path,
        }))
    }

    fn delete_map(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let target = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(target.clone());
        fs::remove_file(target).map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn handle_external_vault_event(
        &mut self,
        vault_path: &str,
        event: VaultEvent,
    ) -> Result<(), String> {
        match event {
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path) => {
                let origin = self.vault_change_origin_for_path(&path);
                self.emit_external_upsert(vault_path, path, origin)
            }
            VaultEvent::FileDeleted(path) => {
                let origin = self.vault_change_origin_for_path(&path);
                self.emit_external_delete(vault_path, path, origin)
            }
            VaultEvent::FileRenamed { from, to } => {
                let origin = if self.ai.has_recent_agent_write(&from)
                    || self.ai.has_recent_agent_write(&to)
                {
                    VAULT_CHANGE_ORIGIN_AGENT
                } else {
                    VAULT_CHANGE_ORIGIN_EXTERNAL
                };
                self.emit_external_delete(vault_path, from, origin)?;
                self.emit_external_upsert(vault_path, to, origin)
            }
        }
    }

    fn vault_change_origin_for_path(&self, path: &Path) -> &'static str {
        if self.ai.has_recent_agent_write(path) {
            VAULT_CHANGE_ORIGIN_AGENT
        } else {
            VAULT_CHANGE_ORIGIN_EXTERNAL
        }
    }

    fn emit_external_delete(
        &mut self,
        vault_path: &str,
        path: PathBuf,
        origin: &'static str,
    ) -> Result<(), String> {
        let state = self
            .vaults
            .get_mut(vault_path)
            .ok_or_else(|| "Vault not open".to_string())?;
        let relative_path = state.vault.path_to_relative_path(&path);
        let note_id = markdown_note_id_from_relative_path(&relative_path);
        let revision = match &note_id {
            Some(note_id) => advance_revision(&mut state.note_revisions, note_id, None),
            None => advance_revision(&mut state.file_revisions, &relative_path, None),
        }
        .max(1);
        Self::refresh_vault_state(state)?;
        let graph_revision = state.graph_revision.max(1);
        let change = build_vault_note_change(
            VaultNoteChangeInput::new(vault_path, "delete", revision, graph_revision)
                .with_origin(origin)
                .with_optional_note_id(note_id)
                .with_relative_path(relative_path),
        );
        self.emit_vault_change(change);
        Ok(())
    }

    fn emit_external_upsert(
        &mut self,
        vault_path: &str,
        path: PathBuf,
        origin: &'static str,
    ) -> Result<(), String> {
        let state = self
            .vaults
            .get_mut(vault_path)
            .ok_or_else(|| "Vault not open".to_string())?;
        if !path.exists() {
            return Ok(());
        }

        let relative_path = state.vault.path_to_relative_path(&path);
        Self::refresh_vault_state(state)?;
        let graph_revision = state.graph_revision.max(1);
        if path.is_dir() {
            let entry = state
                .entries
                .iter()
                .find(|entry| entry.relative_path == relative_path)
                .cloned();
            let revision = advance_revision(&mut state.file_revisions, &relative_path, None).max(1);
            let change = build_vault_note_change(
                VaultNoteChangeInput::new(vault_path, "upsert", revision, graph_revision)
                    .with_origin(origin)
                    .with_optional_entry(entry)
                    .with_relative_path(relative_path),
            );
            self.emit_vault_change(change);
            return Ok(());
        }

        if let Some(note_id) = markdown_note_id_from_relative_path(&relative_path) {
            let Some(note) = state
                .index
                .metadata
                .get(&NoteId(note_id.clone()))
                .map(note_to_dto)
            else {
                return Ok(());
            };
            let content_hash = lossy_text_file_content_hash(&path);
            let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
            let change = build_vault_note_change(
                VaultNoteChangeInput::new(vault_path, "upsert", revision, graph_revision)
                    .with_origin(origin)
                    .with_note(note)
                    .with_note_id(note_id)
                    .with_relative_path(relative_path)
                    .with_content_hash(content_hash),
            );
            self.emit_vault_change(change);
            return Ok(());
        }

        let entry = state
            .entries
            .iter()
            .find(|entry| entry.relative_path == relative_path)
            .cloned();
        let revision = advance_revision(&mut state.file_revisions, &relative_path, None).max(1);
        let content_hash = lossy_text_file_content_hash(&path);
        let change = build_vault_note_change(
            VaultNoteChangeInput::new(vault_path, "upsert", revision, graph_revision)
                .with_origin(origin)
                .with_optional_entry(entry)
                .with_relative_path(relative_path)
                .with_content_hash(content_hash),
        );
        self.emit_vault_change(change);
        Ok(())
    }

    fn emit_vault_change(&mut self, change: VaultNoteChangeDto) {
        let _ = self.event_tx.send(RpcOutput::Event {
            event_name: "vault://note-changed".to_string(),
            payload: json!(change),
        });
    }
}

fn cancelled_placeholder_state(root: String) -> VaultRuntimeState {
    let vault = Vault {
        root: PathBuf::from(root.clone()),
    };
    VaultRuntimeState {
        vault,
        index: VaultIndex::build(Vec::new()),
        entries: Vec::new(),
        open_state: VaultOpenStateDto {
            path: Some(root),
            stage: "cancelled".to_string(),
            message: "Opening cancelled".to_string(),
            processed: 0,
            total: 0,
            note_count: 0,
            snapshot_used: false,
            cancelled: true,
            started_at_ms: None,
            finished_at_ms: Some(now_ms()),
            metrics: empty_metrics(),
            error: None,
            okf_version: None,
        },
        graph_revision: 1,
        note_revisions: HashMap::new(),
        file_revisions: HashMap::new(),
        write_tracker: WriteTracker::new(),
        _watcher: None,
    }
}

fn idle_open_state() -> VaultOpenStateDto {
    VaultOpenStateDto {
        path: None,
        stage: "idle".to_string(),
        message: String::new(),
        processed: 0,
        total: 0,
        note_count: 0,
        snapshot_used: false,
        cancelled: false,
        started_at_ms: None,
        finished_at_ms: None,
        metrics: empty_metrics(),
        error: None,
        okf_version: None,
    }
}

fn empty_metrics() -> VaultOpenMetricsDto {
    VaultOpenMetricsDto {
        scan_ms: 0,
        snapshot_load_ms: 0,
        parse_ms: 0,
        index_ms: 0,
        snapshot_save_ms: 0,
    }
}

fn normalize_vault_path(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("Vault path is required".to_string());
    }
    Ok(normalize_existing_vault_path(&PathBuf::from(raw))
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .to_string())
}

fn ai_storage_scope_arg(args: &Value) -> Result<AiStorageScope, String> {
    match optional_nullable_string(args, &["storageScope", "storage_scope"])
        .as_deref()
        .map(str::trim)
    {
        None | Some("") | Some("vault") => Ok(AiStorageScope::Vault),
        Some("device") => Ok(AiStorageScope::Device),
        Some(scope) => Err(format!("Unsupported AI storage scope: {scope}")),
    }
}

fn required_ai_storage_scope_arg(args: &Value, names: &[&str]) -> Result<AiStorageScope, String> {
    match optional_nullable_string(args, names)
        .as_deref()
        .map(str::trim)
    {
        Some("vault") => Ok(AiStorageScope::Vault),
        Some("device") => Ok(AiStorageScope::Device),
        Some(scope) => Err(format!("Unsupported AI storage scope: {scope}")),
        None => Err(format!("Missing argument: {}", names[0])),
    }
}

fn ai_storage_scope_name(scope: AiStorageScope) -> &'static str {
    match scope {
        AiStorageScope::Vault => "vault",
        AiStorageScope::Device => "device",
    }
}

fn inspect_ai_history_move_conflicts(
    vault_key: &str,
    vault_root: &Path,
    app_data_root: &Path,
    from_scope: AiStorageScope,
    to_scope: AiStorageScope,
) -> Result<Vec<String>, String> {
    let from_storage =
        ai_sessions_storage_for_scope(vault_key, vault_root, from_scope, app_data_root);
    let to_storage = ai_sessions_storage_for_scope(vault_key, vault_root, to_scope, app_data_root);
    let destination_by_id: HashMap<String, PersistedSessionHistory> =
        load_session_histories_for_storage(&to_storage, true)?
            .into_iter()
            .map(|history| (history.session_id.clone(), history))
            .collect();
    let mut conflicts = Vec::new();
    for source in load_session_histories_for_storage(&from_storage, true)? {
        if !has_persisted_history_content_native(&source) {
            continue;
        }
        let Some(destination) = destination_by_id.get(&source.session_id) else {
            continue;
        };
        if histories_have_same_content(&source, destination)? {
            continue;
        }
        let kind = if source.updated_at == destination.updated_at {
            "same_timestamp_different_content"
        } else {
            "different_content"
        };
        conflicts.push(format!("{}:{kind}", source.session_id));
    }
    Ok(conflicts)
}

fn ai_sessions_storage_for_scope(
    normalized_vault_key: &str,
    vault_root: &Path,
    scope: AiStorageScope,
    app_data_root: &Path,
) -> AiSessionsStorage {
    AiSessionsStorage {
        scope,
        vault_key: normalized_vault_key.to_string(),
        vault_root: vault_root.to_path_buf(),
        sessions_root: resolve_ai_sessions_root(
            normalized_vault_key,
            vault_root,
            scope,
            app_data_root,
        ),
    }
}

fn ai_attachment_root_for_scope(
    normalized_vault_key: &str,
    vault_root: &Path,
    scope: AiStorageScope,
    app_data_root: &Path,
) -> PathBuf {
    match scope {
        AiStorageScope::Vault => vault_root.join("assets").join("chat"),
        AiStorageScope::Device => {
            resolve_ai_attachments_root(normalized_vault_key, app_data_root).join("migrated")
        }
    }
}

fn is_ai_owned_vault_attachment_dir(relative_dir: &str) -> bool {
    // Other vault assets remain user-owned and must not be coupled to AI history moves.
    relative_dir
        .replace('\\', "/")
        .trim_matches('/')
        .trim_start_matches("./")
        == "assets/chat"
}

fn ai_history_move_root(normalized_vault_key: &str, app_data_root: &Path) -> PathBuf {
    app_data_root
        .join("ai")
        .join("history-moves")
        .join(sha256_hex(normalized_vault_key.as_bytes()))
}

fn ai_history_scope_state_path(normalized_vault_key: &str, app_data_root: &Path) -> PathBuf {
    app_data_root
        .join("ai")
        .join("history-scopes")
        .join(format!(
            "{}.json",
            sha256_hex(normalized_vault_key.as_bytes())
        ))
}

fn ai_history_scope_state_temporary_path(
    normalized_vault_key: &str,
    app_data_root: &Path,
) -> PathBuf {
    ai_history_scope_state_path(normalized_vault_key, app_data_root).with_extension("tmp")
}

fn load_ai_history_scope_state(
    normalized_vault_key: &str,
    app_data_root: &Path,
) -> Option<AiHistoryScopeState> {
    let canonical = ai_history_scope_state_path(normalized_vault_key, app_data_root);
    let temporary = ai_history_scope_state_temporary_path(normalized_vault_key, app_data_root);

    // A complete temporary file is the newest state and may be the only copy left when
    // Windows stops between removing the old destination and renaming its replacement.
    for path in [&temporary, &canonical] {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if let Ok(state) = serde_json::from_slice(&bytes) {
            return Some(state);
        }
    }

    None
}

fn write_ai_history_scope_state(
    normalized_vault_key: &str,
    app_data_root: &Path,
    state: AiHistoryScopeState,
) -> Result<(), String> {
    let path = ai_history_scope_state_path(normalized_vault_key, app_data_root);
    let parent = path
        .parent()
        .ok_or_else(|| "AI history scope state has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = ai_history_scope_state_temporary_path(normalized_vault_key, app_data_root);
    let bytes = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn ai_history_move_journal_path(staging_root: &Path) -> PathBuf {
    staging_root.join("journal.json")
}

fn ai_history_move_journal_temporary_path(staging_root: &Path) -> PathBuf {
    ai_history_move_journal_path(staging_root).with_extension("tmp")
}

fn write_ai_history_move_journal(journal: &AiHistoryMoveJournal) -> Result<(), String> {
    let path = ai_history_move_journal_path(&journal.staging_root);
    let parent = path
        .parent()
        .ok_or_else(|| "AI history journal has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = ai_history_move_journal_temporary_path(&journal.staging_root);
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;

    // Windows does not allow rename to replace an existing destination. Keep the complete
    // temporary journal in place until the old journal is removed; recovery reads it first
    // if the process stops in that small window.
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

fn read_ai_history_move_journal(staging_root: &Path) -> Result<AiHistoryMoveJournal, String> {
    let canonical = ai_history_move_journal_path(staging_root);
    let temporary = ai_history_move_journal_temporary_path(staging_root);
    let mut errors = Vec::new();

    // A valid temporary journal is newer than the canonical file and is the only surviving
    // copy if Windows stops after removing the old destination but before the final rename.
    for path in [&temporary, &canonical] {
        match fs::read(path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(journal) => return Ok(journal),
                Err(error) => errors.push(format!("{}: {error}", path.to_string_lossy())),
            },
            Err(error) => errors.push(format!("{}: {error}", path.to_string_lossy())),
        }
    }

    Err(format!(
        "AI history recovery requires journal repair: {}",
        errors.join("; ")
    ))
}

fn remove_ai_history_move_staging(staging_root: &Path) {
    fs::remove_dir_all(staging_root).ok();
    if let Some(move_root) = staging_root.parent() {
        fs::remove_dir(move_root).ok();
    }
}

fn histories_have_same_content(
    source: &PersistedSessionHistory,
    destination: &PersistedSessionHistory,
) -> Result<bool, String> {
    let mut source_value = serde_json::to_value(source).map_err(|error| error.to_string())?;
    let mut destination_value =
        serde_json::to_value(destination).map_err(|error| error.to_string())?;
    canonicalize_json_value(&mut source_value);
    canonicalize_json_value(&mut destination_value);
    Ok(source_value == destination_value)
}

fn persisted_history_fingerprint(history: &PersistedSessionHistory) -> Result<String, String> {
    let mut value = serde_json::to_value(history).map_err(|error| error.to_string())?;
    canonicalize_json_value(&mut value);
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(sha256_hex(&bytes))
}

fn canonicalize_json_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                canonicalize_json_value(item);
            }
        }
        Value::Object(object) => {
            let mut entries = std::mem::take(object).into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (key, mut child) in entries {
                canonicalize_json_value(&mut child);
                object.insert(key, child);
            }
        }
        _ => {}
    }
}

fn prepare_ai_history_move_staging(
    vault_key: &str,
    vault_root: &Path,
    app_data_root: &Path,
    from_scope: AiStorageScope,
    to_scope: AiStorageScope,
) -> Result<PreparedAiHistoryMove, String> {
    let from_storage =
        ai_sessions_storage_for_scope(vault_key, vault_root, from_scope, app_data_root);
    let to_storage = ai_sessions_storage_for_scope(vault_key, vault_root, to_scope, app_data_root);
    let source_histories = load_session_histories_for_storage(&from_storage, true)?;
    let destination_histories: HashMap<String, PersistedSessionHistory> =
        load_session_histories_for_storage(&to_storage, true)?
            .into_iter()
            .map(|history| (history.session_id.clone(), history))
            .collect();

    let mut conflicts = Vec::new();
    let mut histories_to_stage = Vec::new();
    let mut deduplicated_session_ids = Vec::new();
    let mut repair_session_ids = Vec::new();
    let mut source_history_fingerprints = HashMap::new();
    let mut destination_history_fingerprints = HashMap::new();
    let source_attachment_context = AiAttachmentMigrationContext {
        vault_root: vault_root.to_path_buf(),
        app_data_root: app_data_root.to_path_buf(),
        vault_key: vault_key.to_string(),
        from_scope,
        target_attachments_root: PathBuf::new(),
    };
    for history in source_histories {
        if !has_persisted_history_content_native(&history) {
            continue;
        }
        source_history_fingerprints.insert(
            history.session_id.clone(),
            persisted_history_fingerprint(&history)?,
        );
        if let Some(destination) = destination_histories.get(&history.session_id) {
            if histories_have_same_content(&history, destination)? {
                if collect_ai_owned_attachment_sources(&history, &source_attachment_context)
                    .is_empty()
                {
                    deduplicated_session_ids.push(history.session_id.clone());
                } else {
                    repair_session_ids.push(history.session_id.clone());
                    destination_history_fingerprints.insert(
                        history.session_id.clone(),
                        persisted_history_fingerprint(destination)?,
                    );
                    histories_to_stage.push(history);
                }
                continue;
            }
            conflicts.push(AiHistoryMoveConflict {
                session_id: history.session_id.clone(),
                kind: if history.updated_at == destination.updated_at {
                    AiHistoryMoveConflictKind::SameTimestampDifferentContent
                } else {
                    AiHistoryMoveConflictKind::DifferentContent
                },
            });
            continue;
        }
        histories_to_stage.push(history);
    }
    if !conflicts.is_empty() {
        let session_ids = conflicts
            .iter()
            .map(|conflict| conflict.session_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let kinds = conflicts
            .iter()
            .map(|conflict| format!("{} ({:?})", conflict.session_id, conflict.kind))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "AI history move requires conflict recovery for session IDs: {session_ids}. Conflicts: {kinds}"
        ));
    }

    let operation_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    let staging_root = ai_history_move_root(vault_key, app_data_root).join(&operation_id);
    let staged_sessions_root = staging_root.join("sessions");
    let staged_attachments_root = staging_root.join("attachments");
    let mut journal = AiHistoryMoveJournal {
        version: 1,
        operation_id,
        vault_key: vault_key.to_string(),
        from_scope,
        to_scope,
        state: AiHistoryMoveJournalState::Preparing,
        staging_root: staging_root.clone(),
        staged_sessions_root: staged_sessions_root.clone(),
        staged_attachments_root: staged_attachments_root.clone(),
        session_ids: histories_to_stage
            .iter()
            .map(|history| history.session_id.clone())
            .chain(deduplicated_session_ids.iter().cloned())
            .collect(),
        published_session_ids: Vec::new(),
        publishing_session_id: None,
        cleanup_attachment_paths: Vec::new(),
        cleanup_manifest_ready: false,
        source_history_fingerprints,
        repair_session_ids,
        destination_history_fingerprints,
    };
    write_ai_history_move_journal(&journal)?;

    let attachment_context = AiAttachmentMigrationContext {
        vault_root: vault_root.to_path_buf(),
        app_data_root: app_data_root.to_path_buf(),
        vault_key: vault_key.to_string(),
        from_scope,
        target_attachments_root: staged_attachments_root,
    };
    let mut report = AiAttachmentCopyReport::default();
    let mut staged_histories = Vec::new();
    let mut copied_attachments = Vec::new();
    let stage_result = (|| {
        for mut history in histories_to_stage {
            let copied_before_history = copied_attachments.len();
            rewrite_history_attachment_paths(
                &mut history,
                &attachment_context,
                &mut copied_attachments,
                &mut report,
            );
            if !report.failures.is_empty() {
                rollback_copied_ai_attachments(
                    &copied_attachments[copied_before_history..],
                    &mut report,
                );
                return Err(report.failures.join(" "));
            }
            persistence::save_session_history_in_storage_root(&staged_sessions_root, &history)?;
            let validated = persistence::validate_session_history_in_storage_root(
                &staged_sessions_root,
                &history.session_id,
            )?;
            staged_histories.push(validated);
        }
        for attachment in &copied_attachments {
            if !attachment.target.is_file() {
                return Err(format!(
                    "Staged AI attachment is missing: {}",
                    attachment.target.to_string_lossy()
                ));
            }
            let source_bytes = fs::read(&attachment.source).map_err(|error| error.to_string())?;
            let staged_bytes = fs::read(&attachment.target).map_err(|error| error.to_string())?;
            if source_bytes != staged_bytes {
                return Err(format!(
                    "Staged AI attachment does not match its source: {}",
                    attachment.source.to_string_lossy()
                ));
            }
        }
        Ok(())
    })();

    if let Err(error) = stage_result {
        rollback_copied_ai_attachments(&copied_attachments, &mut report);
        remove_ai_history_move_staging(&staging_root);
        return Err(error);
    }

    journal.state = AiHistoryMoveJournalState::Prepared;
    write_ai_history_move_journal(&journal)?;
    Ok(PreparedAiHistoryMove {
        journal,
        staged_histories,
        copied_attachments,
        deduplicated_session_ids,
    })
}

/// Publishes only validated staging data. The source remains untouched until every destination
/// session is readable; a retained journal makes cleanup retryable after an interruption.
fn publish_prepared_ai_history_move(
    journal: &mut AiHistoryMoveJournal,
    vault_root: &Path,
    app_data_root: &Path,
) -> Result<(), String> {
    if journal.state == AiHistoryMoveJournalState::Completed {
        return Ok(());
    }
    let from_storage = ai_sessions_storage_for_scope(
        &journal.vault_key,
        vault_root,
        journal.from_scope,
        app_data_root,
    );
    let to_storage = ai_sessions_storage_for_scope(
        &journal.vault_key,
        vault_root,
        journal.to_scope,
        app_data_root,
    );
    let destination_attachments = ai_attachment_root_for_scope(
        &journal.vault_key,
        vault_root,
        journal.to_scope,
        app_data_root,
    );
    journal.state = AiHistoryMoveJournalState::Publishing;
    write_ai_history_move_journal(journal)?;

    for session_id in &journal.session_ids {
        if journal.published_session_ids.contains(session_id) {
            continue;
        }
        let mut history = match persistence::validate_session_history_in_storage_root(
            &journal.staged_sessions_root,
            session_id,
        ) {
            Ok(history) => history,
            // A deduplicated session has no staged artifact; the destination was verified during
            // preparation, so it is already published for this operation.
            Err(error) => {
                if let Ok(destination) = persistence::validate_session_history_in_storage_root(
                    &to_storage.sessions_root,
                    session_id,
                ) {
                    let source = load_session_histories_for_storage(&from_storage, true)?
                        .into_iter()
                        .find(|item| item.session_id == *session_id);
                    if source.as_ref().is_some_and(|source| {
                        histories_have_same_content(source, &destination).unwrap_or(false)
                    }) {
                        journal.published_session_ids.push(session_id.clone());
                        write_ai_history_move_journal(journal)?;
                        continue;
                    }
                }
                return Err(error);
            }
        };
        let existing = load_session_histories_for_storage(&to_storage, false)?;
        if existing.iter().any(|item| item.session_id == *session_id) {
            let destination = persistence::validate_session_history_in_storage_root(
                &to_storage.sessions_root,
                session_id,
            )?;
            if histories_match_published_destination(
                &history,
                &destination,
                &journal.staged_attachments_root,
                &destination_attachments,
            )? {
                journal.published_session_ids.push(session_id.clone());
                journal.publishing_session_id = None;
                write_ai_history_move_journal(journal)?;
                continue;
            }

            let expected_destination_matches = journal
                .destination_history_fingerprints
                .get(session_id)
                .is_some_and(|expected| {
                    persisted_history_fingerprint(&destination)
                        .map(|actual| actual == *expected)
                        .unwrap_or(false)
                });
            if !journal.repair_session_ids.contains(session_id) || !expected_destination_matches {
                return Err(format!(
                    "AI history move destination changed while publishing: {session_id}"
                ));
            }
            // This is an exact history duplicate whose attachment paths still
            // belong to the source namespace. Publish the repaired staged copy
            // instead of treating it as a no-op.
            journal.publishing_session_id = Some(session_id.clone());
            write_ai_history_move_journal(journal)?;
            publish_staged_attachment_paths(
                &mut history,
                &journal.staged_attachments_root,
                &destination_attachments,
                &journal.operation_id,
            )?;
            save_session_history_for_storage(&to_storage, &history)?;
            verify_session_history_exists(&to_storage, session_id)?;
            journal.published_session_ids.push(session_id.clone());
            journal.publishing_session_id = None;
            write_ai_history_move_journal(journal)?;
            continue;
        }
        journal.publishing_session_id = Some(session_id.clone());
        write_ai_history_move_journal(journal)?;
        publish_staged_attachment_paths(
            &mut history,
            &journal.staged_attachments_root,
            &destination_attachments,
            &journal.operation_id,
        )?;
        save_session_history_for_storage(&to_storage, &history)?;
        verify_session_history_exists(&to_storage, session_id)?;
        journal.published_session_ids.push(session_id.clone());
        journal.publishing_session_id = None;
        write_ai_history_move_journal(journal)?;
    }

    journal.state = AiHistoryMoveJournalState::CleanupPending;
    write_ai_history_move_journal(journal)?;
    let source_histories = load_session_histories_for_storage(&from_storage, true)?;
    for source in &source_histories {
        let Some(expected) = journal.source_history_fingerprints.get(&source.session_id) else {
            continue;
        };
        if persisted_history_fingerprint(source)? != *expected {
            return Err(format!(
                "AI history source changed after staging; recovery stopped before deleting {}.",
                source.session_id,
            ));
        }
    }
    let attachment_context = AiAttachmentMigrationContext {
        vault_root: vault_root.to_path_buf(),
        app_data_root: app_data_root.to_path_buf(),
        vault_key: journal.vault_key.clone(),
        from_scope: journal.from_scope,
        target_attachments_root: PathBuf::new(),
    };
    if !journal.cleanup_manifest_ready {
        let mut remaining_refs =
            build_ai_owned_attachment_source_ref_counts(&source_histories, &attachment_context);
        let mut attachments_to_remove = Vec::new();
        for session_id in &journal.session_ids {
            if let Some(history) = source_histories
                .iter()
                .find(|item| item.session_id == *session_id)
            {
                let sources = collect_ai_owned_attachment_sources(history, &attachment_context);
                decrement_attachment_ref_counts(&sources, &mut remaining_refs);
                attachments_to_remove.extend(sources);
            }
        }
        attachments_to_remove.sort();
        attachments_to_remove.dedup();
        journal.cleanup_attachment_paths = attachments_to_remove
            .into_iter()
            .filter(|path| !remaining_refs.contains_key(path))
            .collect();
        journal.cleanup_manifest_ready = true;
        write_ai_history_move_journal(journal)?;
    }
    for session_id in &journal.session_ids {
        if source_histories
            .iter()
            .any(|item| item.session_id == *session_id)
        {
            delete_session_history_for_storage(&from_storage, session_id)?;
        }
    }
    for path in &journal.cleanup_attachment_paths {
        if path.exists() {
            fs::remove_file(path).map_err(|error| {
                format!(
                    "AI history destination was published but source cleanup needs recovery: {}",
                    error
                )
            })?;
        }
    }
    let next_revision = load_ai_history_scope_state(&journal.vault_key, app_data_root)
        .map(|state| state.revision.saturating_add(1))
        .unwrap_or(1);
    write_ai_history_scope_state(
        &journal.vault_key,
        app_data_root,
        AiHistoryScopeState {
            scope: journal.to_scope,
            revision: next_revision,
            enforced: true,
        },
    )?;
    journal.state = AiHistoryMoveJournalState::Completed;
    write_ai_history_move_journal(journal)?;
    remove_ai_history_move_staging(&journal.staging_root);
    Ok(())
}

fn histories_match_published_destination(
    staged: &PersistedSessionHistory,
    destination: &PersistedSessionHistory,
    staged_attachments_root: &Path,
    destination_attachments_root: &Path,
) -> Result<bool, String> {
    fn normalize(value: &mut Value, owned_root: &Path) {
        match value {
            Value::Array(items) => {
                for item in items {
                    normalize(item, owned_root);
                }
            }
            Value::Object(map) => {
                if let Some(Value::String(file_path)) = map.get_mut("filePath") {
                    let path = PathBuf::from(file_path.as_str());
                    if path.starts_with(owned_root) {
                        *file_path = path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or_default()
                            .to_string();
                    }
                }
                for (key, child) in map {
                    if key != "filePath" {
                        normalize(child, owned_root);
                    }
                }
            }
            _ => {}
        }
    }
    let mut staged = serde_json::to_value(staged).map_err(|error| error.to_string())?;
    let mut destination = serde_json::to_value(destination).map_err(|error| error.to_string())?;
    normalize(&mut staged, staged_attachments_root);
    normalize(&mut destination, destination_attachments_root);
    canonicalize_json_value(&mut staged);
    canonicalize_json_value(&mut destination);
    Ok(staged == destination)
}

fn publish_staged_attachment_paths(
    history: &mut PersistedSessionHistory,
    staged_root: &Path,
    destination_root: &Path,
    operation_id: &str,
) -> Result<(), String> {
    fn rewrite(
        value: &mut Value,
        staged_root: &Path,
        destination_root: &Path,
        operation_id: &str,
    ) -> Result<(), String> {
        match value {
            Value::Array(items) => {
                for item in items {
                    rewrite(item, staged_root, destination_root, operation_id)?;
                }
            }
            Value::Object(map) => {
                if let Some(Value::String(file_path)) = map.get("filePath") {
                    let source = PathBuf::from(file_path);
                    if source.starts_with(staged_root) {
                        let name = source
                            .file_name()
                            .and_then(|name| name.to_str())
                            .ok_or_else(|| "Staged AI attachment has no file name.".to_string())?;
                        let target = destination_root
                            .join(format!("history-move-{operation_id}"))
                            .join(sanitize_ai_attachment_file_name(name)?);
                        copy_ai_attachment_idempotently(&source, &target)?;
                        map.insert(
                            "filePath".to_string(),
                            Value::String(target.to_string_lossy().to_string()),
                        );
                    }
                }
                for (key, child) in map {
                    if key != "filePath" {
                        rewrite(child, staged_root, destination_root, operation_id)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    for message in &mut history.messages {
        if let Some(attachments) = message.attachments.as_mut() {
            rewrite(attachments, staged_root, destination_root, operation_id)?;
        }
    }
    Ok(())
}

fn copy_ai_attachment_idempotently(source: &Path, target: &Path) -> Result<(), String> {
    let source_bytes = fs::read(source).map_err(|error| error.to_string())?;
    if target.exists() {
        let target_bytes = fs::read(target).map_err(|error| error.to_string())?;
        return if source_bytes == target_bytes {
            Ok(())
        } else {
            Err(format!(
                "Published AI attachment differs from staged data: {}",
                target.to_string_lossy()
            ))
        };
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Published AI attachment has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = target.with_extension("move-tmp");
    fs::write(&temporary, source_bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, target).map_err(|error| error.to_string())
}

fn recover_ai_history_moves(
    vault_key: &str,
    vault_root: &Path,
    app_data_root: &Path,
) -> Result<(), String> {
    let move_root = ai_history_move_root(vault_key, app_data_root);
    let entries = match fs::read_dir(&move_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let staging_root = entry.map_err(|error| error.to_string())?.path();
        let mut journal = read_ai_history_move_journal(&staging_root)?;
        if journal.vault_key != vault_key {
            return Err("AI history recovery journal belongs to another vault.".to_string());
        }
        match journal.state {
            AiHistoryMoveJournalState::Preparing => remove_ai_history_move_staging(&staging_root),
            AiHistoryMoveJournalState::Prepared
            | AiHistoryMoveJournalState::Publishing
            | AiHistoryMoveJournalState::CleanupPending => {
                publish_prepared_ai_history_move(&mut journal, vault_root, app_data_root)?;
            }
            AiHistoryMoveJournalState::Completed => remove_ai_history_move_staging(&staging_root),
        }
    }
    Ok(())
}

fn load_session_histories_for_storage(
    storage: &AiSessionsStorage,
    include_messages: bool,
) -> Result<Vec<PersistedSessionHistory>, String> {
    match storage.scope {
        AiStorageScope::Vault => {
            persistence::load_all_session_histories(&storage.vault_root, include_messages)
        }
        AiStorageScope::Device => persistence::load_all_session_histories_in_storage_root(
            &storage.sessions_root,
            include_messages,
        ),
    }
}

fn save_session_history_for_storage(
    storage: &AiSessionsStorage,
    history: &PersistedSessionHistory,
) -> Result<(), String> {
    match storage.scope {
        AiStorageScope::Vault => persistence::save_session_history(&storage.vault_root, history),
        AiStorageScope::Device => {
            persistence::save_session_history_in_storage_root(&storage.sessions_root, history)
        }
    }
}

fn delete_session_history_for_storage(
    storage: &AiSessionsStorage,
    session_id: &str,
) -> Result<(), String> {
    match storage.scope {
        AiStorageScope::Vault => {
            persistence::delete_session_history(&storage.vault_root, session_id)
        }
        AiStorageScope::Device => {
            persistence::delete_session_history_in_storage_root(&storage.sessions_root, session_id)
        }
    }
}

fn load_expired_session_histories_for_cleanup(
    sessions_root: &Path,
    max_age_days: u32,
) -> Result<Vec<PersistedSessionHistory>, String> {
    if max_age_days == 0 {
        return Ok(Vec::new());
    }

    let histories = persistence::load_all_session_histories_in_storage_root(sessions_root, true)?;
    let max_age_ms = u64::from(max_age_days) * 24 * 60 * 60 * 1000;
    let cutoff_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        .saturating_sub(u128::from(max_age_ms)) as u64;

    Ok(histories
        .into_iter()
        .filter(|history| history.updated_at < cutoff_ms)
        .collect())
}

fn owned_attachment_root_for_storage(storage: &AiSessionsStorage) -> PathBuf {
    match storage.scope {
        AiStorageScope::Vault => storage.vault_root.join("assets").join("chat"),
        AiStorageScope::Device => resolve_ai_attachments_root(&storage.vault_key, &app_data_dir()),
    }
}

fn cleanup_attachment_namespace(storage: &AiSessionsStorage) -> Result<(), String> {
    let root = owned_attachment_root_for_storage(storage);
    if root.exists() {
        fs::remove_dir_all(root).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn cleanup_history_attachments(
    storage: &AiSessionsStorage,
    histories: &[PersistedSessionHistory],
) -> Result<(), String> {
    if histories.is_empty() {
        return Ok(());
    }

    let root = owned_attachment_root_for_storage(storage);
    let canonical_root = match root.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };

    let protected_references =
        persistence::inspect_session_attachment_references_in_storage_root(&storage.sessions_root)?;
    if !protected_references.unreadable_artifacts.is_empty() {
        for artifact in protected_references.unreadable_artifacts {
            eprintln!(
                "Preserving owned AI attachments because session references could not be inspected: {}",
                artifact.to_string_lossy()
            );
        }
        return Ok(());
    }

    let mut protected_paths = Vec::new();
    for file_path in protected_references.file_paths {
        collect_owned_attachment_file_path(&file_path, &canonical_root, &mut protected_paths);
    }
    let protected_paths: HashSet<PathBuf> = protected_paths.into_iter().collect();

    let mut file_paths = Vec::new();
    for history in histories {
        collect_owned_history_attachment_file_paths(history, &canonical_root, &mut file_paths);
    }

    file_paths.sort();
    file_paths.dedup();
    for path in file_paths {
        if protected_paths.contains(&path) {
            continue;
        }
        if path.is_file() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        prune_empty_parent_dirs(&path, &canonical_root);
    }

    Ok(())
}

fn collect_owned_history_attachment_file_paths(
    history: &PersistedSessionHistory,
    canonical_root: &Path,
    output: &mut Vec<PathBuf>,
) {
    for message in &history.messages {
        if let Some(attachments) = &message.attachments {
            collect_owned_attachment_file_paths(attachments, canonical_root, output);
        }
    }
}

fn collect_owned_attachment_file_paths(
    value: &Value,
    canonical_root: &Path,
    output: &mut Vec<PathBuf>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_owned_attachment_file_paths(item, canonical_root, output);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(file_path)) = map.get("filePath") {
                collect_owned_attachment_file_path(file_path, canonical_root, output);
            }
        }
        _ => {}
    }
}

fn collect_owned_attachment_file_path(
    file_path: &str,
    canonical_root: &Path,
    output: &mut Vec<PathBuf>,
) {
    let path = PathBuf::from(file_path);
    if let Ok(canonical_path) = path.canonicalize() {
        if canonical_path.starts_with(canonical_root) {
            output.push(canonical_path);
        }
    }
}

fn prune_empty_parent_dirs(path: &Path, root: &Path) {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        match fs::remove_dir(dir) {
            Ok(_) => current = dir.parent(),
            Err(_) => break,
        }
    }
}

fn verify_session_history_exists(
    storage: &AiSessionsStorage,
    session_id: &str,
) -> Result<(), String> {
    load_session_histories_for_storage(storage, false)?
        .into_iter()
        .any(|history| history.session_id == session_id)
        .then_some(())
        .ok_or_else(|| format!("Migrated session history was not readable: {session_id}"))
}

fn has_persisted_history_content_native(history: &PersistedSessionHistory) -> bool {
    history.message_count.unwrap_or(history.messages.len()) > 0
        || history.parent_session_id.is_some()
        || history.closed_at.is_some()
        || history
            .custom_title
            .as_deref()
            .is_some_and(|title| !title.trim().is_empty())
}

fn resolve_ai_sessions_root(
    normalized_vault_key: &str,
    vault_root: &Path,
    scope: AiStorageScope,
    app_data_root: &Path,
) -> PathBuf {
    match scope {
        AiStorageScope::Vault => persistence::sessions_root_for_vault(vault_root),
        AiStorageScope::Device => app_data_root
            .join("ai")
            .join(AI_DEVICE_SESSIONS_DIR_NAME)
            .join(sha256_hex(normalized_vault_key.as_bytes()))
            .join(AI_DEVICE_SESSIONS_DIR_NAME),
    }
}

fn resolve_ai_attachments_root(normalized_vault_key: &str, app_data_root: &Path) -> PathBuf {
    app_data_root
        .join("ai")
        .join("attachments")
        .join(sha256_hex(normalized_vault_key.as_bytes()))
}

fn sanitize_ai_attachment_dir_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "draft".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_ai_attachment_file_name(file_name: &str) -> Result<String, String> {
    let leaf = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Attachment file name is required".to_string())?;
    let sanitized: String = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '-']);
    if trimmed.is_empty() {
        Err("Attachment file name is required".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn unique_file_name_candidates(file_name: &str) -> impl Iterator<Item = String> + '_ {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    std::iter::once(file_name.to_string()).chain((1..1000).map(move |index| match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
        _ => format!("{stem}-{index}"),
    }))
}

fn create_unique_file(dir: &Path, file_name: &str) -> Result<(PathBuf, fs::File), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    for candidate_name in unique_file_name_candidates(file_name) {
        let candidate = dir.join(candidate_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err("Could not allocate attachment file name".to_string())
}

fn write_unique_file(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let (path, mut file) = create_unique_file(dir, file_name)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
        fs::remove_file(&path).ok();
        return Err(error.to_string());
    }
    Ok(path)
}

fn copy_to_unique_file(source: &Path, dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let mut source_file = fs::File::open(source).map_err(|error| error.to_string())?;
    let (path, mut target_file) = create_unique_file(dir, file_name)?;
    if let Err(error) =
        io::copy(&mut source_file, &mut target_file).and_then(|_| target_file.flush())
    {
        fs::remove_file(&path).ok();
        return Err(error.to_string());
    }
    Ok(path)
}

fn rewrite_history_attachment_paths(
    history: &mut PersistedSessionHistory,
    context: &AiAttachmentMigrationContext,
    copied_attachments: &mut Vec<CopiedAiAttachment>,
    report: &mut AiAttachmentCopyReport,
) {
    for message in &mut history.messages {
        let Some(attachments) = message.attachments.as_mut() else {
            continue;
        };
        rewrite_attachments_value_paths(attachments, context, copied_attachments, report);
    }
}

fn rewrite_attachments_value_paths(
    value: &mut Value,
    context: &AiAttachmentMigrationContext,
    copied_attachments: &mut Vec<CopiedAiAttachment>,
    report: &mut AiAttachmentCopyReport,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                rewrite_attachments_value_paths(item, context, copied_attachments, report);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(file_path)) = map.get("filePath") {
                match migrate_ai_owned_attachment(file_path, context) {
                    Ok(Some((source, target))) => {
                        map.insert(
                            "filePath".to_string(),
                            Value::String(target.to_string_lossy().to_string()),
                        );
                        copied_attachments.push(CopiedAiAttachment { source, target });
                    }
                    Ok(None) => {}
                    Err(error) => {
                        report.failures.push(error);
                    }
                }
            }
        }
        _ => {}
    }
}

fn rollback_copied_ai_attachments(
    copied_attachments: &[CopiedAiAttachment],
    report: &mut AiAttachmentCopyReport,
) {
    for attachment in copied_attachments.iter().rev() {
        if let Err(error) = fs::remove_file(&attachment.target) {
            if error.kind() != io::ErrorKind::NotFound {
                report.failures.push(format!(
                    "Failed to roll back migrated attachment {}: {error}",
                    attachment.target.to_string_lossy(),
                ));
            }
        }
    }
}

fn resolve_ai_owned_attachment_source(
    file_path: &str,
    context: &AiAttachmentMigrationContext,
) -> Result<Option<(PathBuf, String)>, String> {
    let source = PathBuf::from(file_path);
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string);
    let Some(file_name) = file_name else {
        return Ok(None);
    };
    if !file_name.starts_with("pasted-image-") {
        return Ok(None);
    }

    let source_root = match context.from_scope {
        AiStorageScope::Vault => context.vault_root.join("assets").join("chat"),
        AiStorageScope::Device => {
            resolve_ai_attachments_root(&context.vault_key, &context.app_data_root)
        }
    };
    if !source.starts_with(&source_root) {
        return Ok(None);
    }
    if !source.is_file() {
        return Err(format!(
            "NeverWrite-managed attachment is missing: {}",
            source.to_string_lossy()
        ));
    }
    let canonical_source_root = source_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_source = source.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_source.starts_with(&canonical_source_root) {
        return Ok(None);
    }

    Ok(Some((canonical_source, file_name)))
}

fn migrate_ai_owned_attachment(
    file_path: &str,
    context: &AiAttachmentMigrationContext,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let Some((canonical_source, file_name)) =
        resolve_ai_owned_attachment_source(file_path, context)?
    else {
        return Ok(None);
    };

    let target = copy_to_unique_file(
        &canonical_source,
        &context.target_attachments_root,
        &sanitize_ai_attachment_file_name(&file_name)?,
    )?;

    Ok(Some((canonical_source, target)))
}

fn build_ai_owned_attachment_source_ref_counts(
    histories: &[PersistedSessionHistory],
    context: &AiAttachmentMigrationContext,
) -> HashMap<PathBuf, usize> {
    let mut counts = HashMap::new();
    for history in histories {
        for source in collect_ai_owned_attachment_sources(history, context) {
            *counts.entry(source).or_insert(0) += 1;
        }
    }
    counts
}

fn collect_ai_owned_attachment_sources(
    history: &PersistedSessionHistory,
    context: &AiAttachmentMigrationContext,
) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    for message in &history.messages {
        let Some(attachments) = &message.attachments else {
            continue;
        };
        collect_ai_owned_attachment_sources_from_value(attachments, context, &mut sources);
    }
    sources
}

fn collect_ai_owned_attachment_sources_from_value(
    value: &Value,
    context: &AiAttachmentMigrationContext,
    output: &mut Vec<PathBuf>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_ai_owned_attachment_sources_from_value(item, context, output);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(file_path)) = map.get("filePath") {
                if let Ok(Some((source, _file_name))) =
                    resolve_ai_owned_attachment_source(file_path, context)
                {
                    output.push(source);
                }
            }
            for (key, child) in map {
                if key != "filePath" {
                    collect_ai_owned_attachment_sources_from_value(child, context, output);
                }
            }
        }
        _ => {}
    }
}

fn decrement_attachment_ref_counts(sources: &[PathBuf], counts: &mut HashMap<PathBuf, usize>) {
    for source in sources {
        match counts.get_mut(source) {
            Some(count) if *count > 1 => {
                *count -= 1;
            }
            Some(_) => {
                counts.remove(source);
            }
            None => {}
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn required_string(args: &Value, names: &[&str]) -> Result<String, String> {
    optional_string(args, names).ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn required_string_allow_empty(args: &Value, names: &[&str]) -> Result<String, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_str))
        .map(ToString::to_string)
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn optional_string(args: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        args.get(*name)
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .filter(|value| !value.is_empty())
    })
}

fn optional_nullable_string(args: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| match args.get(*name) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.to_string()),
        _ => None,
    })
}

fn clipper_vault_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn resolve_web_clipper_vault_key_from_ready_keys(
    ready_keys: &[String],
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
) -> Result<String, String> {
    if ready_keys.is_empty() {
        return Err("No ready vault is available in NeverWrite.".to_string());
    }

    if let Some(path_hint) = vault_path_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(found) = ready_keys.iter().find(|path| path.as_str() == path_hint) {
            return Ok(found.clone());
        }
    }

    if let Some(name_hint) = vault_name_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let lower = name_hint.to_lowercase();
        let mut matches = ready_keys
            .iter()
            .filter(|path| clipper_vault_name(path).to_lowercase() == lower)
            .cloned()
            .collect::<Vec<_>>();

        if matches.len() == 1 {
            return Ok(matches.remove(0));
        }
    }

    if ready_keys.len() == 1 {
        return Ok(ready_keys[0].clone());
    }

    Err("NeverWrite has multiple open vaults. Provide a more specific vault hint.".to_string())
}

fn normalize_web_clipper_folder(folder: &str) -> Result<String, String> {
    let mut normalized = PathBuf::new();

    for component in Path::new(folder).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("Folder hint must stay inside the vault.".to_string())
            }
        }
    }

    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

fn sanitize_web_clipper_title(title: &str) -> String {
    let sanitized = title
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>()
        .replace('.', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    sanitized
        .chars()
        .take(96)
        .collect::<String>()
        .trim()
        .to_string()
}

fn build_web_clipper_relative_note_path(
    vault: &Vault,
    folder: &str,
    title: &str,
) -> Result<String, String> {
    let normalized_folder = normalize_web_clipper_folder(folder)?;
    let stem = sanitize_web_clipper_title(title);
    let base = if stem.is_empty() {
        "untitled-clip".to_string()
    } else {
        stem
    };

    for index in 1..10_000 {
        let file_name = if index == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{index}.md")
        };
        let relative_path = if normalized_folder.is_empty() {
            file_name
        } else {
            format!("{normalized_folder}/{file_name}")
        };
        let path = vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        if !path.exists() {
            return Ok(relative_path);
        }
    }

    Err("Could not find a free filename for the clip.".to_string())
}

fn required_usize(args: &Value, names: &[&str]) -> Result<usize, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_u64))
        .map(|value| {
            usize::try_from(value).map_err(|_| format!("Argument out of range: {}", names[0]))
        })
        .transpose()?
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn required_u32(args: &Value, names: &[&str]) -> Result<u32, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_u64))
        .map(|value| {
            u32::try_from(value).map_err(|_| format!("Argument out of range: {}", names[0]))
        })
        .transpose()?
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn bool_arg(args: &Value, name: &str) -> Option<bool> {
    args.get(name).and_then(Value::as_bool)
}

fn bytes_arg(args: &Value, name: &str) -> Result<Vec<u8>, String> {
    let values = args
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Missing argument: {name}"))?;
    values
        .iter()
        .map(|value| {
            let byte = value
                .as_u64()
                .ok_or_else(|| "Binary bytes must be an array of numbers".to_string())?;
            u8::try_from(byte).map_err(|_| "Binary byte value out of range".to_string())
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn system_time_to_secs(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn normalize_vault_scoped_input(vault: &Vault, path: &str) -> String {
    let input_path = Path::new(path);
    if !input_path.is_absolute() {
        return path.to_string();
    }

    if let Some(relative_path) = strip_vault_root(input_path, &vault.root) {
        return relative_path;
    }

    if let Ok(canonical_input) = input_path.canonicalize() {
        if let Some(relative_path) = strip_vault_root(&canonical_input, &vault.root) {
            return relative_path;
        }
    }

    if let (Some(parent), Some(file_name)) = (input_path.parent(), input_path.file_name()) {
        if let Ok(canonical_parent) = parent.canonicalize() {
            let canonical_candidate = canonical_parent.join(file_name);
            if let Some(relative_path) = strip_vault_root(&canonical_candidate, &vault.root) {
                return relative_path;
            }
        }
    }

    path.to_string()
}

fn strip_vault_root(path: &Path, vault_root: &Path) -> Option<String> {
    path.strip_prefix(vault_root)
        .ok()
        .map(|relative_path| relative_path.to_string_lossy().replace('\\', "/"))
}

fn resolve_vault_scoped_path(
    vault: &Vault,
    path: &str,
    intent: ScopedPathIntent,
) -> Result<PathBuf, String> {
    let normalized_input = normalize_vault_scoped_input(vault, path);
    vault
        .resolve_scoped_path(&normalized_input, intent)
        .map_err(|error| error.to_string())
}

fn note_to_dto(note: &NoteMetadata) -> NoteDto {
    NoteDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        modified_at: note.modified_at,
        created_at: note.created_at,
        status: note.status.clone(),
        okf_type: note.okf_type.clone(),
    }
}

fn note_document_to_dto(note: &NoteDocument) -> NoteDto {
    let (modified_at, created_at) = get_file_times(&note.path.0);
    NoteDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        modified_at,
        created_at,
        status: frontmatter_string_field(note.frontmatter.as_ref(), "status"),
        okf_type: frontmatter_string_field(note.frontmatter.as_ref(), "type"),
    }
}

fn note_to_detail(note: &NoteDocument) -> NoteDetailDto {
    NoteDetailDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        content: note.raw_markdown.clone(),
        tags: note.tags.clone(),
        links: note.links.iter().map(|link| link.target.clone()).collect(),
        frontmatter: note.frontmatter.clone(),
        status: frontmatter_string_field(note.frontmatter.as_ref(), "status"),
        okf_type: frontmatter_string_field(note.frontmatter.as_ref(), "type"),
    }
}

fn get_file_times(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::metadata(path) else {
        return (0, 0);
    };
    let modified = meta.modified().map(system_time_to_secs).unwrap_or(0);
    let created = meta.created().map(system_time_to_secs).unwrap_or(modified);
    (modified, created)
}

fn build_vault_file_detail(vault: &Vault, relative_path: &str) -> Result<VaultFileDetail, String> {
    let path = resolve_vault_scoped_path(vault, relative_path, ScopedPathIntent::ReadExisting)?;
    let normalized_relative_path = vault.path_to_relative_path(&path);
    let content = vault
        .read_text_file(&normalized_relative_path)
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let entry = vault
        .read_vault_entry_from_path(&path)
        .map_err(|error| error.to_string())?;
    Ok(VaultFileDetail {
        path: path.to_string_lossy().to_string(),
        relative_path: normalized_relative_path,
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| relative_path.to_string()),
        mime_type: entry.mime_type,
        content,
        size_bytes: metadata.len(),
        content_truncated: false,
    })
}

fn note_content_hash(content: &str) -> String {
    content_hash_bytes(content.as_bytes())
}

fn lossy_text_file_content_hash(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(note_content_hash(String::from_utf8_lossy(&bytes).as_ref()))
}

fn content_hash_bytes(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn advance_revision(
    revisions: &mut HashMap<String, u64>,
    key: &str,
    previous_key: Option<&str>,
) -> u64 {
    let previous_revision = previous_key
        .filter(|previous| *previous != key)
        .and_then(|previous| revisions.remove(previous))
        .unwrap_or(0);
    let current_revision = revisions.get(key).copied().unwrap_or(0);
    let next_revision = previous_revision
        .max(current_revision)
        .saturating_add(1)
        .max(1);
    revisions.insert(key.to_string(), next_revision);
    next_revision
}

struct VaultNoteChangeInput {
    vault_path: String,
    kind: String,
    note: Option<NoteDto>,
    note_id: Option<String>,
    entry: Option<VaultEntryDto>,
    relative_path: Option<String>,
    origin: String,
    op_id: Option<String>,
    revision: u64,
    content_hash: Option<String>,
    graph_revision: u64,
}

impl VaultNoteChangeInput {
    fn new(vault_path: &str, kind: &str, revision: u64, graph_revision: u64) -> Self {
        Self {
            vault_path: vault_path.to_string(),
            kind: kind.to_string(),
            note: None,
            note_id: None,
            entry: None,
            relative_path: None,
            origin: VAULT_CHANGE_ORIGIN_USER.to_string(),
            op_id: None,
            revision,
            content_hash: None,
            graph_revision,
        }
    }

    fn with_origin(mut self, origin: &str) -> Self {
        self.origin = origin.to_string();
        self
    }

    fn with_note(mut self, note: NoteDto) -> Self {
        self.note = Some(note);
        self
    }

    fn with_note_id(mut self, note_id: String) -> Self {
        self.note_id = Some(note_id);
        self
    }

    fn with_optional_note_id(mut self, note_id: Option<String>) -> Self {
        self.note_id = note_id;
        self
    }

    fn with_entry(mut self, entry: VaultEntryDto) -> Self {
        self.entry = Some(entry);
        self
    }

    fn with_optional_entry(mut self, entry: Option<VaultEntryDto>) -> Self {
        self.entry = entry;
        self
    }

    fn with_relative_path(mut self, relative_path: String) -> Self {
        self.relative_path = Some(relative_path);
        self
    }

    fn with_op_id(mut self, op_id: Option<String>) -> Self {
        self.op_id = op_id;
        self
    }

    fn with_content_hash(mut self, content_hash: Option<String>) -> Self {
        self.content_hash = content_hash;
        self
    }
}

fn build_vault_note_change(input: VaultNoteChangeInput) -> VaultNoteChangeDto {
    // Mirror the changed note's frontmatter-derived fields at the top level so
    // the file tree can react to status/type changes without inspecting `note`.
    let status = input.note.as_ref().and_then(|note| note.status.clone());
    let okf_type = input.note.as_ref().and_then(|note| note.okf_type.clone());
    VaultNoteChangeDto {
        vault_path: input.vault_path,
        kind: input.kind,
        note: input.note,
        note_id: input.note_id,
        entry: input.entry,
        relative_path: input.relative_path,
        status,
        okf_type,
        origin: input.origin,
        op_id: input.op_id,
        revision: input.revision,
        content_hash: input.content_hash,
        graph_revision: input.graph_revision,
    }
}

fn note_change_from_document(
    vault_path: &str,
    note: &NoteDocument,
    relative_path: String,
    op_id: Option<String>,
    revision: u64,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    build_vault_note_change(
        VaultNoteChangeInput::new(vault_path, "upsert", revision, graph_revision)
            .with_note(note_document_to_dto(note))
            .with_note_id(note.id.0.clone())
            .with_relative_path(relative_path)
            .with_op_id(op_id)
            .with_content_hash(Some(note_content_hash(&note.raw_markdown))),
    )
}

fn compute_tracked_file_patches(args: Value) -> Result<Value, String> {
    let inputs: Vec<ComputeLineDiffInput> = serde_json::from_value(
        args.get("inputs")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| error.to_string())?;
    let patches: Vec<_> = inputs
        .into_iter()
        .map(|input| neverwrite_diff::compute_tracked_file_patch(&input.old_text, &input.new_text))
        .collect();
    Ok(json!(patches))
}

fn non_note_score(query: &str, entry: &VaultEntryDto) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let title = entry.title.to_lowercase();
    let path = entry.relative_path.to_lowercase();
    score_substring(query, &title).max(score_substring(query, &path) * 0.85)
}

fn score_substring(query: &str, target: &str) -> f64 {
    target.find(query).map_or(0.0, |index| {
        1.0 / (1.0 + index as f64) + query.len() as f64 / target.len().max(1) as f64
    })
}

fn map_entry_from_vault_entry(entry: &VaultEntryDto) -> Option<MapEntryDto> {
    if !entry.extension.eq_ignore_ascii_case("excalidraw") {
        return None;
    }
    Some(MapEntryDto {
        id: entry.relative_path.clone(),
        title: entry.title.clone(),
        relative_path: entry.relative_path.clone(),
    })
}

fn markdown_note_id_from_relative_path(relative_path: &str) -> Option<String> {
    relative_path
        .to_lowercase()
        .ends_with(".md")
        .then(|| relative_path[..relative_path.len().saturating_sub(3)].to_string())
}

fn track_path_tree(write_tracker: &WriteTracker, path: &Path) {
    write_tracker.track_any(path.to_path_buf());
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        track_path_tree(write_tracker, &entry.path());
    }
}

fn track_moved_tree(write_tracker: &WriteTracker, source: &Path, target: &Path) {
    write_tracker.track_any(source.to_path_buf());
    write_tracker.track_any(target.to_path_buf());
    let Ok(metadata) = fs::metadata(source) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        track_moved_tree(write_tracker, &source_child, &target_child);
    }
}

fn track_copied_tree(write_tracker: &WriteTracker, source: &Path, target: &Path) {
    write_tracker.track_any(target.to_path_buf());
    let Ok(metadata) = fs::metadata(source) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        track_copied_tree(write_tracker, &source_child, &target_child);
    }
}

fn start_vault_watcher(
    root: &str,
    write_tracker: WriteTracker,
    backend_ref: &Arc<Mutex<NativeBackend>>,
) -> Result<RecommendedWatcher, String> {
    let vault_path = root.to_string();
    let backend_ref = Arc::downgrade(backend_ref);
    start_watcher(PathBuf::from(root), write_tracker, move |event| {
        let Some(backend_ref) = backend_ref.upgrade() else {
            return;
        };
        let mut backend = backend_ref.lock().unwrap();
        if let Err(error) = backend.handle_external_vault_event(&vault_path, event) {
            eprintln!("Failed to process vault watcher event: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

fn suggestion_insert_text(note: &NoteMetadata) -> String {
    if note.title.trim().is_empty() {
        note.id
            .0
            .split('/')
            .next_back()
            .unwrap_or(&note.id.0)
            .trim_end_matches(".md")
            .to_string()
    } else {
        note.title.trim().to_string()
    }
}

fn write_output(output: &RpcOutput) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, output)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn main() {
    let stdin = io::stdin();
    let (event_tx, event_rx) = mpsc::channel::<RpcOutput>();
    thread::spawn(move || {
        for event in event_rx {
            if let Err(error) = write_output(&event) {
                eprintln!("Failed to write event: {error}");
                break;
            }
        }
    });
    let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("Failed to read request: {error}");
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request: Result<RpcRequest, _> = serde_json::from_str(&line);
        let output = match request {
            Ok(request) => {
                let id = request.id.clone();
                let result =
                    backend
                        .lock()
                        .unwrap()
                        .invoke(&request.command, request.args, &backend);
                match result {
                    Ok(result) => RpcOutput::Response {
                        id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => RpcOutput::Response {
                        id,
                        ok: false,
                        result: None,
                        error: Some(error),
                    },
                }
            }
            Err(error) => RpcOutput::Response {
                id: Value::Null,
                ok: false,
                result: None,
                error: Some(format!("Invalid request: {error}")),
            },
        };

        if let Err(error) = write_output(&output) {
            eprintln!("Failed to write response: {error}");
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    static APP_DATA_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.previous {
                    Some(value) => std::env::set_var(self.key, value),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    fn invoke(
        backend: &Arc<Mutex<NativeBackend>>,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        backend.lock().unwrap().invoke(command, args, backend)
    }

    fn recv_vault_change(event_rx: &std::sync::mpsc::Receiver<RpcOutput>) -> Value {
        match event_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
        {
            RpcOutput::Event {
                event_name,
                payload,
            } => {
                assert_eq!(event_name, "vault://note-changed");
                payload
            }
            output => panic!("expected vault change event, got {output:?}"),
        }
    }

    fn test_backend_with_open_vault() -> (Arc<Mutex<NativeBackend>>, tempfile::TempDir, String) {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();
        (backend, vault_dir, vault_path)
    }

    fn test_history(session_id: &str, attachment_path: Option<&Path>) -> Value {
        let attachments = attachment_path
            .map(|path| {
                json!([
                    {
                        "id": "shot-1",
                        "type": "file",
                        "noteId": null,
                        "label": "Screenshot",
                        "path": null,
                        "filePath": path.to_string_lossy(),
                        "mimeType": "image/png"
                    }
                ])
            })
            .unwrap_or_else(|| json!([]));
        json!({
            "version": 1,
            "session_id": session_id,
            "runtime_id": "test-runtime",
            "model_id": "test-model",
            "mode_id": "default",
            "additional_roots": [],
            "created_at": 1,
            "updated_at": 2,
            "title": "Migrated chat",
            "preview": "hello migration",
            "messages": [
                {
                    "id": "msg-1",
                    "role": "user",
                    "kind": "text",
                    "content": "hello migration",
                    "timestamp": 1,
                    "attachments": attachments
                }
            ]
        })
    }

    #[test]
    fn ai_storage_scope_defaults_to_vault() {
        assert_eq!(
            ai_storage_scope_arg(&json!({})).unwrap(),
            AiStorageScope::Vault
        );
        assert_eq!(
            ai_storage_scope_arg(&json!({ "storageScope": null })).unwrap(),
            AiStorageScope::Vault
        );
    }

    #[test]
    fn ai_storage_scope_rejects_unknown_values() {
        assert!(ai_storage_scope_arg(&json!({ "storageScope": "shared" })).is_err());
    }

    #[test]
    fn history_scope_state_recovers_an_interrupted_windows_replacement() {
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = "scope-recovery-vault";
        let canonical = ai_history_scope_state_path(vault_key, app_data.path());
        let temporary = ai_history_scope_state_temporary_path(vault_key, app_data.path());
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        fs::write(
            &temporary,
            serde_json::to_vec(&AiHistoryScopeState {
                scope: AiStorageScope::Device,
                revision: 2,
                enforced: true,
            })
            .unwrap(),
        )
        .unwrap();

        let recovered = load_ai_history_scope_state(vault_key, app_data.path()).unwrap();

        assert_eq!(recovered.scope, AiStorageScope::Device);
        assert_eq!(recovered.revision, 2);
        assert!(recovered.enforced);
    }

    #[test]
    fn history_scope_state_ignores_a_corrupt_temporary_file() {
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = "scope-corrupt-temporary-vault";
        write_ai_history_scope_state(
            vault_key,
            app_data.path(),
            AiHistoryScopeState {
                scope: AiStorageScope::Vault,
                revision: 1,
                enforced: true,
            },
        )
        .unwrap();
        fs::write(
            ai_history_scope_state_temporary_path(vault_key, app_data.path()),
            b"not-json",
        )
        .unwrap();

        let recovered = load_ai_history_scope_state(vault_key, app_data.path()).unwrap();

        assert_eq!(recovered.scope, AiStorageScope::Vault);
        assert_eq!(recovered.revision, 1);
    }

    #[test]
    fn prepares_complete_history_move_staging_without_touching_the_source() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("staged-session", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();

        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        assert_eq!(prepared.journal.state, AiHistoryMoveJournalState::Prepared);
        assert!(ai_history_move_journal_path(&prepared.journal.staging_root).is_file());
        assert_eq!(prepared.staged_histories.len(), 1);
        assert!(prepared.copied_attachments.is_empty());
        assert!(prepared.deduplicated_session_ids.is_empty());
        assert!(persistence::validate_session_history_in_storage_root(
            &prepared.journal.staged_sessions_root,
            "staged-session",
        )
        .is_ok());
        assert!(verify_session_history_exists(&source, "staged-session").is_ok());
    }

    #[test]
    fn migrates_metadata_only_histories() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let mut history: PersistedSessionHistory =
            serde_json::from_value(test_history("metadata-only-session", None)).unwrap();
        history.messages.clear();
        history.title = None;
        history.preview = None;
        history.custom_title = Some("Child task".to_string());
        history.parent_session_id = Some("parent-session".to_string());
        history.closed_at = Some("123".to_string());
        save_session_history_for_storage(&source, &history).unwrap();

        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        assert_eq!(prepared.staged_histories.len(), 1);
        assert_eq!(
            prepared.staged_histories[0].parent_session_id.as_deref(),
            Some("parent-session")
        );
    }

    #[test]
    fn staging_rejects_conflicting_destination_without_creating_a_journal() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let source_history: PersistedSessionHistory =
            serde_json::from_value(test_history("conflicting-session", None)).unwrap();
        let mut destination_history = source_history.clone();
        destination_history.messages[0].content = "different content".to_string();
        save_session_history_for_storage(&source, &source_history).unwrap();
        save_session_history_for_storage(&destination, &destination_history).unwrap();

        let error = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap_err();

        assert!(error.contains("conflicting-session"));
        assert!(!ai_history_move_root(&vault_key, app_data.path()).exists());
        assert!(verify_session_history_exists(&source, "conflicting-session").is_ok());
    }

    #[test]
    fn staging_deduplicates_histories_with_equivalent_json_object_order() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let mut source_history: PersistedSessionHistory =
            serde_json::from_value(test_history("duplicate-session", None)).unwrap();
        let mut destination_history = source_history.clone();
        source_history.messages[0].meta = Some(json!({ "alpha": 1, "beta": 2 }));
        destination_history.messages[0].meta = Some(json!({ "beta": 2, "alpha": 1 }));
        save_session_history_for_storage(&source, &source_history).unwrap();
        save_session_history_for_storage(&destination, &destination_history).unwrap();

        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        assert!(prepared.staged_histories.is_empty());
        assert_eq!(prepared.deduplicated_session_ids, ["duplicate-session"]);
    }

    #[test]
    fn staging_reports_same_timestamp_conflicts_explicitly() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let source_history: PersistedSessionHistory =
            serde_json::from_value(test_history("timestamp-conflict", None)).unwrap();
        let mut destination_history = source_history.clone();
        destination_history.messages[0].content = "different content".to_string();
        save_session_history_for_storage(&source, &source_history).unwrap();
        save_session_history_for_storage(&destination, &destination_history).unwrap();

        let error = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap_err();

        assert!(error.contains("SameTimestampDifferentContent"));
        assert!(verify_session_history_exists(&source, "timestamp-conflict").is_ok());
    }

    #[test]
    fn staging_rolls_back_when_a_later_session_has_a_missing_owned_attachment() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source_attachment = vault
            .path()
            .join("assets")
            .join("chat")
            .join("pasted-image-present.png");
        fs::create_dir_all(source_attachment.parent().unwrap()).unwrap();
        fs::write(&source_attachment, [137, 80, 78, 71]).unwrap();
        let missing_attachment = source_attachment
            .parent()
            .unwrap()
            .join("pasted-image-missing.png");
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let first: PersistedSessionHistory =
            serde_json::from_value(test_history("first-session", Some(&source_attachment)))
                .unwrap();
        let second: PersistedSessionHistory =
            serde_json::from_value(test_history("second-session", Some(&missing_attachment)))
                .unwrap();
        save_session_history_for_storage(&source, &first).unwrap();
        save_session_history_for_storage(&source, &second).unwrap();

        let error = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap_err();

        assert!(error.contains("missing"));
        assert!(!ai_history_move_root(&vault_key, app_data.path()).exists());
        assert!(source_attachment.is_file());
        assert!(verify_session_history_exists(&source, "first-session").is_ok());
        assert!(verify_session_history_exists(&source, "second-session").is_ok());
    }

    #[test]
    fn staged_history_validation_rejects_a_corrupt_index() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("corrupt-staged-index", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();
        let session_dir = fs::read_dir(&prepared.journal.staged_sessions_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(session_dir.join("index.json"), "{}").unwrap();

        assert!(persistence::validate_session_history_in_storage_root(
            &prepared.journal.staged_sessions_root,
            "corrupt-staged-index",
        )
        .is_err());
    }

    #[test]
    fn staging_copies_owned_attachments_and_rewrites_the_staged_history() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source_attachment = vault
            .path()
            .join("assets")
            .join("chat")
            .join("pasted-image-source.png");
        fs::create_dir_all(source_attachment.parent().unwrap()).unwrap();
        fs::write(&source_attachment, [137, 80, 78, 71]).unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("attachment-session", Some(&source_attachment)))
                .unwrap();
        save_session_history_for_storage(&source, &history).unwrap();

        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        assert_eq!(prepared.copied_attachments.len(), 1);
        let staged_attachment = &prepared.copied_attachments[0].target;
        assert!(staged_attachment.is_file());
        assert_eq!(fs::read(staged_attachment).unwrap(), vec![137, 80, 78, 71]);
        let attachment_path = prepared.staged_histories[0].messages[0]
            .attachments
            .as_ref()
            .and_then(|value| value[0]["filePath"].as_str())
            .unwrap();
        assert_eq!(PathBuf::from(attachment_path), *staged_attachment);
        assert!(source_attachment.is_file());
    }

    #[test]
    fn moving_history_preserves_external_attachment_paths() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let external_attachment = vault.path().join("docs").join("pasted-image-external.png");
        fs::create_dir_all(external_attachment.parent().unwrap()).unwrap();
        fs::write(&external_attachment, [137, 80, 78, 71]).unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory = serde_json::from_value(test_history(
            "external-attachment-session",
            Some(&external_attachment),
        ))
        .unwrap();
        save_session_history_for_storage(&source, &history).unwrap();

        let mut prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        assert!(prepared.copied_attachments.is_empty());
        assert_eq!(
            prepared.staged_histories[0].messages[0]
                .attachments
                .as_ref()
                .unwrap()[0]["filePath"],
            json!(external_attachment.to_string_lossy().to_string())
        );

        publish_prepared_ai_history_move(&mut prepared.journal, vault.path(), app_data.path())
            .unwrap();

        assert!(external_attachment.is_file());
    }

    #[test]
    fn attachment_publication_reuses_the_same_target_after_interruption() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source_attachment = vault.path().join("assets/chat/pasted-image-idempotent.png");
        fs::create_dir_all(source_attachment.parent().unwrap()).unwrap();
        fs::write(&source_attachment, b"image").unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory = serde_json::from_value(test_history(
            "idempotent-attachment-session",
            Some(&source_attachment),
        ))
        .unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let mut prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();
        prepared.journal.publishing_session_id = Some("idempotent-attachment-session".to_string());
        write_ai_history_move_journal(&prepared.journal).unwrap();
        let destination_root = ai_attachment_root_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );

        for _ in 0..2 {
            let mut staged = prepared.staged_histories[0].clone();
            publish_staged_attachment_paths(
                &mut staged,
                &prepared.journal.staged_attachments_root,
                &destination_root,
                &prepared.journal.operation_id,
            )
            .unwrap();
        }

        let published_root =
            destination_root.join(format!("history-move-{}", prepared.journal.operation_id));
        assert_eq!(fs::read_dir(published_root).unwrap().count(), 1);
    }

    #[test]
    fn publishes_staged_history_then_removes_its_source_and_attachment() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let attachment = vault.path().join("assets/chat/pasted-image-move.png");
        fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        fs::write(&attachment, b"image").unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("move-session", Some(&attachment))).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let mut prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        publish_prepared_ai_history_move(&mut prepared.journal, vault.path(), app_data.path())
            .unwrap();

        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        assert!(verify_session_history_exists(&destination, "move-session").is_ok());
        assert!(verify_session_history_exists(&source, "move-session").is_err());
        assert!(!attachment.exists());
        assert!(!prepared.journal.staging_root.exists());
    }

    #[test]
    fn recovery_resumes_a_prepared_history_move() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("recover-session", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Device,
            AiStorageScope::Vault,
        )
        .unwrap();

        recover_ai_history_moves(&vault_key, vault.path(), app_data.path()).unwrap();

        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        assert!(verify_session_history_exists(&destination, "recover-session").is_ok());
        assert!(verify_session_history_exists(&source, "recover-session").is_err());
        assert!(!prepared.journal.staging_root.exists());
    }

    #[test]
    fn recovery_preserves_a_source_history_changed_after_staging() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let mut history: PersistedSessionHistory =
            serde_json::from_value(test_history("changed-after-staging", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let mut prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();

        history.messages[0].content = "newer synced content".to_string();
        history.updated_at = history.updated_at.saturating_add(1);
        save_session_history_for_storage(&source, &history).unwrap();

        let error =
            publish_prepared_ai_history_move(&mut prepared.journal, vault.path(), app_data.path())
                .unwrap_err();
        assert!(error.contains("source changed"));
        let source_history = load_session_histories_for_storage(&source, true)
            .unwrap()
            .into_iter()
            .find(|item| item.session_id == "changed-after-staging")
            .unwrap();
        assert_eq!(source_history.messages[0].content, "newer synced content");
    }

    #[test]
    fn deduplicated_history_repairs_owned_attachment_paths_before_cleanup() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let attachment = vault.path().join("assets/chat/pasted-image-duplicate.png");
        fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        fs::write(&attachment, b"image").unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let history: PersistedSessionHistory = serde_json::from_value(test_history(
            "duplicate-attachment-session",
            Some(&attachment),
        ))
        .unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        save_session_history_for_storage(&destination, &history).unwrap();

        let mut prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Vault,
            AiStorageScope::Device,
        )
        .unwrap();
        assert_eq!(
            prepared.journal.repair_session_ids,
            ["duplicate-attachment-session"]
        );

        publish_prepared_ai_history_move(&mut prepared.journal, vault.path(), app_data.path())
            .unwrap();
        let repaired = load_session_histories_for_storage(&destination, true)
            .unwrap()
            .into_iter()
            .find(|item| item.session_id == "duplicate-attachment-session")
            .unwrap();
        let repaired_path = repaired.messages[0].attachments.as_ref().unwrap()[0]["filePath"]
            .as_str()
            .unwrap();
        assert!(Path::new(repaired_path).is_file());
        assert!(!PathBuf::from(repaired_path).starts_with(vault.path()));
        assert!(!attachment.exists());
    }

    #[test]
    fn recovery_uses_temporary_journal_when_windows_replacement_is_interrupted() {
        let vault = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = vault.path().to_string_lossy().to_string();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("temporary-journal-session", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Device,
            AiStorageScope::Vault,
        )
        .unwrap();

        let journal_path = ai_history_move_journal_path(&prepared.journal.staging_root);
        fs::copy(
            &journal_path,
            ai_history_move_journal_temporary_path(&prepared.journal.staging_root),
        )
        .unwrap();
        fs::remove_file(journal_path).unwrap();

        recover_ai_history_moves(&vault_key, vault.path(), app_data.path()).unwrap();

        let destination = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Vault,
            app_data.path(),
        );
        assert!(verify_session_history_exists(&destination, "temporary-journal-session").is_ok());
        assert!(verify_session_history_exists(&source, "temporary-journal-session").is_err());
        assert!(!prepared.journal.staging_root.exists());
    }

    #[test]
    fn blocks_history_mutations_while_a_vault_move_is_active() {
        let (backend, _vault, vault_path) = test_backend_with_open_vault();
        let vault_key = normalize_vault_path(&vault_path).unwrap();
        backend
            .lock()
            .unwrap()
            .active_ai_history_moves
            .insert(vault_key);

        let error = invoke(
            &backend,
            "ai_delete_all_session_histories",
            json!({ "vaultPath": vault_path }),
        )
        .unwrap_err();

        assert!(error.contains("being moved"));
    }

    #[test]
    fn blocks_vault_owned_attachment_writes_while_a_vault_move_is_active() {
        let (backend, _vault, vault_path) = test_backend_with_open_vault();
        let vault_key = normalize_vault_path(&vault_path).unwrap();
        backend
            .lock()
            .unwrap()
            .active_ai_history_moves
            .insert(vault_key);

        let error = invoke(
            &backend,
            "save_vault_binary_file",
            json!({
                "vaultPath": vault_path,
                "relativeDir": "assets/chat",
                "fileName": "pasted-image.png",
                "bytes": [137, 80, 78, 71],
            }),
        )
        .unwrap_err();

        assert!(error.contains("being moved"));
    }

    #[test]
    fn all_history_move_command_returns_explicit_success() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data.path());
        let (backend, _vault, vault_path) = test_backend_with_open_vault();
        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("move-command-session", None),
            }),
        )
        .unwrap();

        let result = invoke(
            &backend,
            "ai_move_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "fromScope": "device",
                "toScope": "vault",
            }),
        )
        .unwrap();

        assert_eq!(result["completed"], json!(true));
        assert_eq!(result["from_scope"], json!("device"));
        assert_eq!(result["to_scope"], json!("vault"));
        assert_eq!(result["histories_moved"], json!(1));
        assert_eq!(result["recovery_required"], json!(false));
    }

    #[test]
    fn stale_scope_mutations_are_rejected_after_a_history_move() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data.path());
        let (backend, _vault, vault_path) = test_backend_with_open_vault();

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("stale-scope-session", None),
            }),
        )
        .unwrap();
        invoke(
            &backend,
            "ai_move_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "fromScope": "device",
                "toScope": "vault",
            }),
        )
        .unwrap();

        let error = invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("late-window-save", None),
            }),
        )
        .unwrap_err();
        assert!(error.contains("scope changed to vault"));
    }

    #[test]
    fn all_history_move_command_reports_conflicts_without_changing_source() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data.path());
        let (backend, _vault, vault_path) = test_backend_with_open_vault();
        let source = test_history("conflict-command-session", None);
        let mut destination = source.clone();
        destination["messages"][0]["content"] = json!("different destination");
        for (storage_scope, history) in [("device", source), ("vault", destination)] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": storage_scope,
                    "history": history,
                }),
            )
            .unwrap();
        }

        let result = invoke(
            &backend,
            "ai_move_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "fromScope": "device",
                "toScope": "vault",
            }),
        )
        .unwrap();

        assert_eq!(result["completed"], json!(false));
        assert_eq!(result["recovery_required"], json!(false));
        assert_eq!(result["conflicts"].as_array().unwrap().len(), 1);
        let source_histories = invoke(
            &backend,
            "ai_load_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "includeMessages": false,
            }),
        )
        .unwrap();
        assert_eq!(source_histories.as_array().unwrap().len(), 1);
    }

    #[test]
    fn all_history_move_command_reports_pending_recovery() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data.path());
        let (backend, vault, vault_path) = test_backend_with_open_vault();
        let vault_key = normalize_vault_path(&vault_path).unwrap();
        let source = ai_sessions_storage_for_scope(
            &vault_key,
            vault.path(),
            AiStorageScope::Device,
            app_data.path(),
        );
        let history: PersistedSessionHistory =
            serde_json::from_value(test_history("recovery-command-session", None)).unwrap();
        save_session_history_for_storage(&source, &history).unwrap();
        let prepared = prepare_ai_history_move_staging(
            &vault_key,
            vault.path(),
            app_data.path(),
            AiStorageScope::Device,
            AiStorageScope::Vault,
        )
        .unwrap();
        fs::remove_dir_all(&prepared.journal.staged_sessions_root).unwrap();

        let result = invoke(
            &backend,
            "ai_move_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "fromScope": "device",
                "toScope": "vault",
            }),
        )
        .unwrap();

        assert_eq!(result["completed"], json!(false));
        assert_eq!(result["recovery_required"], json!(true));
        assert!(verify_session_history_exists(&source, "recovery-command-session").is_ok());
    }

    #[test]
    fn resolves_vault_ai_sessions_inside_vault_state_dir() {
        let vault_root = PathBuf::from("/vaults/work");
        let root = resolve_ai_sessions_root(
            "/vaults/work",
            &vault_root,
            AiStorageScope::Vault,
            Path::new("/app-data"),
        );

        assert_eq!(root, vault_root.join(".neverwrite").join("sessions"));
    }

    #[test]
    fn resolves_device_ai_sessions_under_app_data_namespace() {
        let vault_root = PathBuf::from("/vaults/work");
        let app_data = PathBuf::from("/app-data/NeverWrite");
        let root = resolve_ai_sessions_root(
            "/vaults/work",
            &vault_root,
            AiStorageScope::Device,
            &app_data,
        );

        assert!(root.starts_with(&app_data));
        assert!(!root.starts_with(&vault_root));
        assert_eq!(
            root.file_name().and_then(|name| name.to_str()),
            Some("sessions")
        );
        assert!(root
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .is_some_and(|hash| hash.len() == 64));
    }

    #[test]
    fn ai_attachment_commands_route_to_device_app_data() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());

        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "session/a",
                "fileName": "../pasted image.png",
                "mimeType": "image/png",
                "bytes": [137, 80, 78, 71]
            }),
        )
        .unwrap();
        let saved_path = PathBuf::from(saved["path"].as_str().unwrap());

        assert!(saved_path.starts_with(app_data_dir.path()));
        assert!(!saved_path.starts_with(vault_dir.path()));
        assert!(saved_path.is_file());
        assert_eq!(fs::read(&saved_path).unwrap(), vec![137, 80, 78, 71]);
        assert_eq!(saved["file_name"].as_str(), Some("pasted-image.png"));
        assert_eq!(saved["mime_type"].as_str(), Some("image/png"));
        assert!(!vault_dir.path().join("assets").join("chat").exists());

        let attachment_root = invoke(
            &backend,
            "ai_get_attachment_root",
            json!({ "vaultPath": vault_path }),
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(attachment_root.as_str().unwrap()),
            saved_path.parent().unwrap().parent().unwrap().to_path_buf()
        );

        invoke(
            &backend,
            "ai_delete_attachment",
            json!({
                "vaultPath": vault_path,
                "path": saved_path
            }),
        )
        .unwrap();

        assert!(!saved_path.exists());
    }

    #[test]
    fn ai_delete_attachment_rejects_paths_outside_device_app_data() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());

        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let outside_file = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside_file.path(), b"keep me").unwrap();

        let result = invoke(
            &backend,
            "ai_delete_attachment",
            json!({
                "vaultPath": vault_path,
                "path": outside_file.path()
            }),
        );

        assert!(result.is_err());
        assert!(outside_file.path().exists());
    }

    #[test]
    fn ai_delete_attachment_is_a_noop_when_attachment_root_is_missing() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let vault_key = normalize_vault_path(&vault_path).unwrap();
        let missing_path =
            resolve_ai_attachments_root(&vault_key, app_data_dir.path()).join("missing.png");

        invoke(
            &backend,
            "ai_delete_attachment",
            json!({
                "vaultPath": vault_path,
                "path": missing_path
            }),
        )
        .unwrap();

        assert!(!missing_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn ai_save_attachment_does_not_reuse_a_dangling_symlink_name() {
        use std::os::unix::fs::symlink;

        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let vault_key = normalize_vault_path(&vault_path).unwrap();
        let attachment_dir = resolve_ai_attachments_root(&vault_key, app_data_dir.path())
            .join("dangling-symlink-session");
        fs::create_dir_all(&attachment_dir).unwrap();
        let dangling_path = attachment_dir.join("pasted-image.png");
        symlink(app_data_dir.path().join("missing-target"), &dangling_path).unwrap();

        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "dangling-symlink-session",
                "fileName": "pasted-image.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let saved_path = PathBuf::from(saved["path"].as_str().unwrap());

        assert!(fs::symlink_metadata(&dangling_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            saved_path.file_name().and_then(|name| name.to_str()),
            Some("pasted-image-1.png")
        );
        assert_eq!(fs::read(saved_path).unwrap(), b"png");
    }

    #[test]
    fn ai_delete_all_session_histories_accepts_unopened_existing_vault() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "history": test_history("vault-session", None)
            }),
        )
        .unwrap();
        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("device-session", None)
            }),
        )
        .unwrap();

        let vault_key = normalize_vault_path(&vault_path).unwrap();
        let vault_sessions_root = persistence::sessions_root_for_vault(vault_dir.path());
        let device_sessions_root = resolve_ai_sessions_root(
            &vault_key,
            vault_dir.path(),
            AiStorageScope::Device,
            app_data_dir.path(),
        );
        assert!(vault_sessions_root.read_dir().unwrap().next().is_some());
        assert!(device_sessions_root.read_dir().unwrap().next().is_some());

        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let unopened_backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        for storage_scope in ["device", "vault"] {
            invoke(
                &unopened_backend,
                "ai_delete_all_session_histories",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": storage_scope
                }),
            )
            .unwrap();
        }

        assert!(vault_sessions_root.read_dir().unwrap().next().is_none());
        assert!(device_sessions_root.read_dir().unwrap().next().is_none());
    }

    #[test]
    fn ai_session_history_commands_route_to_device_scope() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());

        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let history = json!({
            "version": 1,
            "session_id": "device-session",
            "runtime_id": "test-runtime",
            "model_id": "test-model",
            "mode_id": "default",
            "additional_roots": [],
            "created_at": 1,
            "updated_at": 2,
            "title": "Device chat",
            "preview": "hello device",
            "messages": [
                {
                    "id": "msg-1",
                    "role": "user",
                    "kind": "text",
                    "content": "hello from device storage",
                    "timestamp": 1
                }
            ]
        });
        let device_args = json!({
            "vaultPath": vault_path,
            "storageScope": "device",
            "history": history
        });

        invoke(&backend, "ai_save_session_history", device_args).unwrap();
        assert!(!vault_dir
            .path()
            .join(".neverwrite")
            .join("sessions")
            .exists());

        let loaded = invoke(
            &backend,
            "ai_load_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "includeMessages": true
            }),
        )
        .unwrap();
        assert_eq!(loaded.as_array().unwrap().len(), 1);
        assert_eq!(loaded[0]["session_id"], "device-session");

        let page = invoke(
            &backend,
            "ai_load_session_history_page",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sessionId": "device-session",
                "startIndex": 0,
                "limit": 1
            }),
        )
        .unwrap();
        assert_eq!(page["session_id"], "device-session");
        assert_eq!(page["messages"][0]["content"], "hello from device storage");

        let search = invoke(
            &backend,
            "ai_search_session_content",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "query": "device storage"
            }),
        )
        .unwrap();
        assert_eq!(search.as_array().unwrap().len(), 1);

        let forked_id = invoke(
            &backend,
            "ai_fork_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sourceSessionId": "device-session"
            }),
        )
        .unwrap();
        assert_ne!(forked_id.as_str().unwrap(), "device-session");

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sessionId": forked_id
            }),
        )
        .unwrap();

        let old_history = json!({
            "version": 1,
            "session_id": "old-device-session",
            "runtime_id": "test-runtime",
            "model_id": "test-model",
            "mode_id": "default",
            "additional_roots": [],
            "created_at": 1,
            "updated_at": 1,
            "messages": [
                {
                    "id": "old-msg",
                    "role": "assistant",
                    "kind": "text",
                    "content": "old",
                    "timestamp": 1
                }
            ]
        });
        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": old_history
            }),
        )
        .unwrap();

        let pruned = invoke(
            &backend,
            "ai_prune_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "maxAgeDays": 1
            }),
        )
        .unwrap();
        assert_eq!(pruned.as_u64(), Some(2));
    }

    #[test]
    fn ai_delete_device_history_removes_associated_device_attachments() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "device-delete-session",
                "fileName": "pasted-image-delete.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("device-delete-session", Some(&attachment_path))
            }),
        )
        .unwrap();
        assert!(attachment_path.exists());

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sessionId": "device-delete-session"
            }),
        )
        .unwrap();

        assert!(!attachment_path.exists());
    }

    #[test]
    fn ai_delete_vault_history_removes_associated_vault_attachments() {
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let attachment_path = vault_dir
            .path()
            .join("assets")
            .join("chat")
            .join("pasted-image-delete.png");
        fs::create_dir_all(attachment_path.parent().unwrap()).unwrap();
        fs::write(&attachment_path, b"png").unwrap();

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "history": test_history("vault-delete-session", Some(&attachment_path))
            }),
        )
        .unwrap();

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "sessionId": "vault-delete-session"
            }),
        )
        .unwrap();

        assert!(!attachment_path.exists());
    }

    #[test]
    fn ai_delete_vault_history_keeps_attachments_referenced_by_remaining_history() {
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let attachment_path = vault_dir
            .path()
            .join("assets")
            .join("chat")
            .join("pasted-image-shared-delete.png");
        fs::create_dir_all(attachment_path.parent().unwrap()).unwrap();
        fs::write(&attachment_path, b"png").unwrap();

        for session_id in ["vault-shared-delete-old", "vault-shared-delete-current"] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": "vault",
                    "history": test_history(session_id, Some(&attachment_path))
                }),
            )
            .unwrap();
        }

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "sessionId": "vault-shared-delete-old"
            }),
        )
        .unwrap();

        assert!(attachment_path.exists());
    }

    #[test]
    fn ai_delete_device_history_keeps_attachments_referenced_by_remaining_history() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "shared-delete-old",
                "fileName": "pasted-image-shared-delete.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());

        for session_id in ["shared-delete-old", "shared-delete-current"] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": "device",
                    "history": test_history(session_id, Some(&attachment_path))
                }),
            )
            .unwrap();
        }

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sessionId": "shared-delete-old"
            }),
        )
        .unwrap();

        assert!(attachment_path.exists());
    }

    #[test]
    fn ai_delete_device_history_keeps_attachments_referenced_by_corrupt_history() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "deleted-session",
                "fileName": "pasted-image-corrupt-reference.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());

        for session_id in ["deleted-session", "corrupt-session"] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": "device",
                    "history": test_history(session_id, Some(&attachment_path))
                }),
            )
            .unwrap();
        }

        let vault_key = normalize_vault_path(&vault_path).unwrap();
        let sessions_root = resolve_ai_sessions_root(
            &vault_key,
            vault_dir.path(),
            AiStorageScope::Device,
            app_data_dir.path(),
        );
        let corrupt_session_dir = fs::read_dir(&sessions_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.is_dir()
                    && fs::read_to_string(path.join("session-meta.json"))
                        .ok()
                        .and_then(|metadata| serde_json::from_str::<Value>(&metadata).ok())
                        .and_then(|metadata| metadata["session_id"].as_str().map(str::to_owned))
                        .as_deref()
                        == Some("corrupt-session")
            })
            .expect("corrupt session directory");
        fs::write(corrupt_session_dir.join("index.json"), "not json").unwrap();

        invoke(
            &backend,
            "ai_delete_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "sessionId": "deleted-session"
            }),
        )
        .unwrap();

        assert!(attachment_path.exists());
    }

    #[test]
    fn ai_delete_all_device_histories_removes_attachment_namespace() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "device-delete-all-session",
                "fileName": "pasted-image-delete-all.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());
        let attachment_root = attachment_path
            .ancestors()
            .nth(2)
            .expect("attachment namespace root")
            .to_path_buf();

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": test_history("device-delete-all-session", Some(&attachment_path))
            }),
        )
        .unwrap();
        assert!(attachment_path.exists());

        invoke(
            &backend,
            "ai_delete_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device"
            }),
        )
        .unwrap();

        assert!(!attachment_root.exists());
    }

    #[test]
    fn ai_delete_all_vault_histories_removes_owned_attachment_namespace() {
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let attachment_root = vault_dir.path().join("assets").join("chat");
        let attachment_path = attachment_root.join("pasted-image-delete-all.png");
        fs::create_dir_all(&attachment_root).unwrap();
        fs::write(&attachment_path, b"png").unwrap();

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "history": test_history("vault-delete-all-session", Some(&attachment_path))
            }),
        )
        .unwrap();

        invoke(
            &backend,
            "ai_delete_all_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault"
            }),
        )
        .unwrap();

        assert!(!attachment_root.exists());
    }

    #[test]
    fn ai_retention_prune_removes_device_attachments_for_pruned_histories() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "device-prune-session",
                "fileName": "pasted-image-prune.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());
        let mut history = test_history("device-prune-session", Some(&attachment_path));
        history["updated_at"] = json!(1);

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "history": history
            }),
        )
        .unwrap();

        let pruned = invoke(
            &backend,
            "ai_prune_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "maxAgeDays": 1
            }),
        )
        .unwrap();

        assert_eq!(pruned.as_u64(), Some(1));
        assert!(!attachment_path.exists());
    }

    #[test]
    fn ai_retention_prune_keeps_device_attachments_used_by_remaining_history() {
        let _env_guard = APP_DATA_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let app_data_dir = tempfile::tempdir().unwrap();
        let _app_data_env = EnvVarGuard::set_path("NEVERWRITE_APP_DATA_DIR", app_data_dir.path());
        let (backend, _vault_dir, vault_path) = test_backend_with_open_vault();
        let saved = invoke(
            &backend,
            "ai_save_attachment",
            json!({
                "vaultPath": vault_path,
                "sessionId": "shared-prune-old",
                "fileName": "pasted-image-shared-prune.png",
                "bytes": [112, 110, 103]
            }),
        )
        .unwrap();
        let attachment_path = PathBuf::from(saved["path"].as_str().unwrap());
        let mut old_history = test_history("shared-prune-old", Some(&attachment_path));
        old_history["updated_at"] = json!(1);
        let mut current_history = test_history("shared-prune-current", Some(&attachment_path));
        current_history["updated_at"] = json!(u64::MAX);

        for history in [old_history, current_history] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": "device",
                    "history": history
                }),
            )
            .unwrap();
        }

        let pruned = invoke(
            &backend,
            "ai_prune_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "device",
                "maxAgeDays": 1
            }),
        )
        .unwrap();

        assert_eq!(pruned.as_u64(), Some(1));
        assert!(attachment_path.exists());
    }

    #[test]
    fn ai_vault_retention_removes_owned_vault_attachments() {
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let asset_dir = vault_dir.path().join("assets").join("chat");
        fs::create_dir_all(&asset_dir).unwrap();
        let asset_path = asset_dir.join("manual-reference.png");
        fs::write(&asset_path, b"png").unwrap();
        let mut history = test_history("vault-prune-session", Some(&asset_path));
        history["updated_at"] = json!(1);

        invoke(
            &backend,
            "ai_save_session_history",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "history": history
            }),
        )
        .unwrap();

        let pruned = invoke(
            &backend,
            "ai_prune_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "maxAgeDays": 1
            }),
        )
        .unwrap();

        assert_eq!(pruned.as_u64(), Some(1));
        assert!(!asset_path.exists());
    }

    #[test]
    fn ai_vault_retention_keeps_owned_attachments_used_by_remaining_history() {
        let (backend, vault_dir, vault_path) = test_backend_with_open_vault();
        let attachment_path = vault_dir
            .path()
            .join("assets")
            .join("chat")
            .join("pasted-image-shared-prune.png");
        fs::create_dir_all(attachment_path.parent().unwrap()).unwrap();
        fs::write(&attachment_path, b"png").unwrap();
        let mut old_history = test_history("vault-shared-prune-old", Some(&attachment_path));
        old_history["updated_at"] = json!(1);
        let mut current_history =
            test_history("vault-shared-prune-current", Some(&attachment_path));
        current_history["updated_at"] = json!(u64::MAX);

        for history in [old_history, current_history] {
            invoke(
                &backend,
                "ai_save_session_history",
                json!({
                    "vaultPath": vault_path,
                    "storageScope": "vault",
                    "history": history
                }),
            )
            .unwrap();
        }

        let pruned = invoke(
            &backend,
            "ai_prune_session_histories",
            json!({
                "vaultPath": vault_path,
                "storageScope": "vault",
                "maxAgeDays": 1
            }),
        )
        .unwrap();

        assert_eq!(pruned.as_u64(), Some(1));
        assert!(attachment_path.exists());
    }

    #[test]
    fn invokes_vault_editor_commands_without_electron() {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let notes_dir = vault_dir.path().join("Notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(notes_dir.join("A.md"), "# Alpha\n\n[[B]] #tag-one\n").unwrap();
        fs::write(notes_dir.join("B.md"), "# Beta\n").unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let notes = invoke(&backend, "list_notes", json!({ "vaultPath": vault_path })).unwrap();
        assert!(notes
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/A")));

        let backlinks = invoke(
            &backend,
            "get_backlinks",
            json!({ "vaultPath": vault_path, "noteId": "Notes/B" }),
        )
        .unwrap();
        assert!(backlinks
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/A")));

        let suggestions = invoke(
            &backend,
            "suggest_wikilinks",
            json!({
                "vaultPath": vault_path,
                "noteId": "Notes/A",
                "query": "Be",
                "limit": 8
            }),
        )
        .unwrap();
        assert!(suggestions
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/B")));
    }

    #[test]
    fn creates_and_saves_empty_markdown_notes() {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let created = invoke(
            &backend,
            "create_note",
            json!({
                "vaultPath": vault_path,
                "path": "Untitled.md",
                "content": "",
            }),
        )
        .unwrap();
        assert_eq!(created.get("id").and_then(Value::as_str), Some("Untitled"));
        assert_eq!(created.get("content").and_then(Value::as_str), Some(""));
        assert_eq!(
            fs::read_to_string(vault_dir.path().join("Untitled.md")).unwrap(),
            ""
        );

        invoke(
            &backend,
            "save_note",
            json!({
                "vaultPath": vault_path,
                "noteId": "Untitled",
                "content": "",
            }),
        )
        .unwrap();
    }

    #[test]
    fn listed_vault_entry_relative_path_can_read_file() {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let nested_dir = vault_dir.path().join("src").join("app");
        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(nested_dir.join("main.ts"), "export const value = 1;\n").unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let entries = invoke(
            &backend,
            "list_vault_entries",
            json!({ "vaultPath": vault_path }),
        )
        .unwrap();
        let relative_path = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry.get("file_name").and_then(Value::as_str) == Some("main.ts"))
            .and_then(|entry| entry.get("relative_path").and_then(Value::as_str))
            .unwrap();
        assert_eq!(relative_path, "src/app/main.ts");
        assert!(!relative_path.contains('\\'));

        let detail = invoke(
            &backend,
            "read_vault_file",
            json!({
                "vaultPath": vault_path,
                "relativePath": relative_path,
            }),
        )
        .unwrap();
        assert_eq!(
            detail.get("relative_path").and_then(Value::as_str),
            Some("src/app/main.ts")
        );
        assert_eq!(
            detail.get("content").and_then(Value::as_str),
            Some("export const value = 1;\n")
        );
    }

    #[test]
    fn external_markdown_copy_emits_note_change() {
        let (event_tx, event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source_path = source_dir.path().join("Imported.md");
        fs::write(&source_path, "# Imported\n\n[[Existing]] #tag-one\n").unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let detail = invoke(
            &backend,
            "copy_external_file_to_vault",
            json!({
                "vaultPath": vault_path,
                "sourcePath": source_path.to_string_lossy().to_string(),
                "targetFolder": "Inbox",
            }),
        )
        .unwrap();
        assert_eq!(
            detail.get("relative_path").and_then(Value::as_str),
            Some("Inbox/Imported.md")
        );

        let change = recv_vault_change(&event_rx);
        assert_eq!(change.get("kind").and_then(Value::as_str), Some("upsert"));
        assert_eq!(
            change.get("note_id").and_then(Value::as_str),
            Some("Inbox/Imported")
        );
        assert_eq!(
            change.get("relative_path").and_then(Value::as_str),
            Some("Inbox/Imported.md")
        );
        assert_eq!(change.get("entry"), Some(&Value::Null));
        assert_eq!(
            change
                .get("note")
                .and_then(|note| note.get("id"))
                .and_then(Value::as_str),
            Some("Inbox/Imported")
        );
        assert_eq!(
            change.get("content_hash").and_then(Value::as_str),
            Some(content_hash_bytes(b"# Imported\n\n[[Existing]] #tag-one\n").as_str())
        );

        let notes = invoke(&backend, "list_notes", json!({ "vaultPath": vault_path })).unwrap();
        assert!(notes
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Inbox/Imported")));
    }

    #[test]
    fn ai_review_file_ops_accept_absolute_paths_inside_vault() {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let notes_dir = vault_dir.path().join("Notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let note_path = notes_dir.join("A.md");
        fs::write(&note_path, "# Alpha\n").unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        let absolute_note_path = note_path.to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let hash = invoke(
            &backend,
            "ai_get_text_file_hash",
            json!({
                "vaultPath": vault_path,
                "path": absolute_note_path,
            }),
        )
        .unwrap();
        let expected_hash = content_hash_bytes(b"# Alpha\n");
        assert_eq!(hash.as_str(), Some(expected_hash.as_str()));

        let change = invoke(
            &backend,
            "ai_restore_text_file",
            json!({
                "vaultPath": vault_path,
                "path": absolute_note_path,
                "previousPath": null,
                "content": "# Beta\n",
            }),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&note_path).unwrap(), "# Beta\n");
        assert_eq!(change.get("origin").and_then(Value::as_str), Some("agent"));
    }

    #[test]
    fn external_upsert_hashes_non_utf8_markdown_and_text_lossily() {
        let (event_tx, event_rx) = mpsc::channel::<RpcOutput>();
        let mut backend = NativeBackend::new(event_tx);
        let vault_dir = tempfile::tempdir().unwrap();
        let vault_path = vault_dir.path().to_string_lossy().to_string();
        let root = normalize_vault_path(&vault_path).unwrap();
        let root_path = PathBuf::from(&root);
        let vault = Vault::open(PathBuf::from(&root)).unwrap();
        let notes = vault.scan().unwrap();
        let entries = vault.discover_vault_entries().unwrap();
        let index = VaultIndex::build(notes);

        backend.vaults.insert(
            root.clone(),
            VaultRuntimeState {
                vault,
                index,
                entries,
                open_state: VaultOpenStateDto {
                    path: Some(root.clone()),
                    stage: "ready".to_string(),
                    message: "Vault ready".to_string(),
                    processed: 0,
                    total: 0,
                    note_count: 0,
                    snapshot_used: false,
                    cancelled: false,
                    started_at_ms: None,
                    finished_at_ms: None,
                    metrics: empty_metrics(),
                    error: None,
                    okf_version: None,
                },
                graph_revision: 1,
                note_revisions: HashMap::new(),
                file_revisions: HashMap::new(),
                write_tracker: WriteTracker::new(),
                _watcher: None,
            },
        );

        let note_path = root_path.join("bad.md");
        let note_bytes = b"# Bad\nhello \xff markdown\n";
        fs::write(&note_path, note_bytes).unwrap();
        backend
            .emit_external_upsert(&root, note_path, VAULT_CHANGE_ORIGIN_EXTERNAL)
            .unwrap();
        let note_change = recv_vault_change(&event_rx);
        let expected_note_hash = note_content_hash(String::from_utf8_lossy(note_bytes).as_ref());
        assert_eq!(
            note_change.get("content_hash").and_then(Value::as_str),
            Some(expected_note_hash.as_str())
        );

        let text_path = root_path.join("notes.txt");
        let text_bytes = b"hello \xff text\n";
        fs::write(&text_path, text_bytes).unwrap();
        backend
            .emit_external_upsert(&root, text_path, VAULT_CHANGE_ORIGIN_EXTERNAL)
            .unwrap();
        let text_change = recv_vault_change(&event_rx);
        let expected_text_hash = note_content_hash(String::from_utf8_lossy(text_bytes).as_ref());
        assert_eq!(
            text_change.get("content_hash").and_then(Value::as_str),
            Some(expected_text_hash.as_str())
        );
    }

    #[test]
    fn exposes_status_okf_type_and_okf_version() {
        let (event_tx, event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        // Bundle-root index.md declaring the OKF version.
        fs::write(
            vault_dir.path().join("index.md"),
            "---\nokf_version: \"0.1\"\n---\n# Root\n",
        )
        .unwrap();
        let notes_dir = vault_dir.path().join("Notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(
            notes_dir.join("A.md"),
            "---\nstatus: draft\ntype: article\n---\n# Alpha\n",
        )
        .unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        // okf_version surfaces on the vault-open state DTO.
        let open_state = invoke(
            &backend,
            "get_vault_open_state",
            json!({ "vaultPath": vault_path }),
        )
        .unwrap();
        assert_eq!(
            open_state.get("okf_version").and_then(Value::as_str),
            Some("0.1")
        );

        // list_notes carries status + okf_type per note.
        let notes = invoke(&backend, "list_notes", json!({ "vaultPath": vault_path })).unwrap();
        let note_a = notes
            .as_array()
            .unwrap()
            .iter()
            .find(|note| note.get("id").and_then(Value::as_str) == Some("Notes/A"))
            .expect("note A present");
        assert_eq!(note_a.get("status").and_then(Value::as_str), Some("draft"));
        assert_eq!(
            note_a.get("okf_type").and_then(Value::as_str),
            Some("article")
        );

        // Editing the status produces a change event carrying the new value,
        // and the save_note RESPONSE carries it too. The response matters
        // because the renderer ignores user-origin change events and updates
        // its store from the response instead (Editor.tsx saveNow).
        let detail = invoke(
            &backend,
            "save_note",
            json!({
                "vaultPath": vault_path,
                "noteId": "Notes/A",
                "content": "---\nstatus: published\ntype: article\n---\n# Alpha\n",
            }),
        )
        .unwrap();
        assert_eq!(
            detail.get("status").and_then(Value::as_str),
            Some("published")
        );
        assert_eq!(
            detail.get("okf_type").and_then(Value::as_str),
            Some("article")
        );
        let change = recv_vault_change(&event_rx);
        assert_eq!(
            change.get("status").and_then(Value::as_str),
            Some("published")
        );
        assert_eq!(
            change.get("okf_type").and_then(Value::as_str),
            Some("article")
        );
        assert_eq!(
            change
                .get("note")
                .and_then(|note| note.get("status"))
                .and_then(Value::as_str),
            Some("published")
        );
    }
}
