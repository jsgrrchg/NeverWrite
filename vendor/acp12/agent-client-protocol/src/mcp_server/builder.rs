//! MCP server builder for creating MCP servers.

use std::{collections::HashSet, marker::PhantomData, pin::pin, sync::Arc};

use futures::{
    SinkExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Either},
};
use futures_concurrency::future::TryJoin;
use rustc_hash::FxHashMap;

/// Tracks which tools are enabled.
///
/// - `DenyList`: All tools enabled except those in the set (default)
/// - `AllowList`: Only tools in the set are enabled
#[derive(Clone, Debug)]
pub enum EnabledTools {
    /// All tools enabled except those in the deny set.
    DenyList(HashSet<String>),
    /// Only tools in the allow set are enabled.
    AllowList(HashSet<String>),
}

impl Default for EnabledTools {
    fn default() -> Self {
        EnabledTools::DenyList(HashSet::new())
    }
}

impl EnabledTools {
    /// Check if a tool is enabled.
    #[must_use]
    pub fn is_enabled(&self, name: &str) -> bool {
        match self {
            EnabledTools::DenyList(deny) => !deny.contains(name),
            EnabledTools::AllowList(allow) => allow.contains(name),
        }
    }
}
use rmcp::{
    ErrorData, ServerHandler,
    handler::server::tool::{schema_for_output, schema_for_type},
    model::{CallToolResult, ListToolsResult, Tool},
};
use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::{McpConnectionTo, McpTool};
use crate::{
    ByteStreams, ConnectTo, DynConnectTo,
    jsonrpc::run::{ChainRun, NullRun, RunWithConnectionTo},
    mcp_server::{
        McpServer, McpServerConnect,
        responder::{ToolCall, ToolFnMutResponder, ToolFnResponder},
    },
    role::{self, Role},
};

/// Builder for creating MCP servers with tools.
///
/// Use [`McpServer::builder`] to create a new builder, then chain methods to
/// configure the server and call [`build`](Self::build) to create the server.
///
/// # Example
///
/// ```rust,ignore
/// let server = McpServer::builder("my-server".to_string())
///     .instructions("A helpful assistant")
///     .tool(EchoTool)
///     .tool_fn(
///         "greet",
///         "Greet someone by name",
///         async |input: GreetInput, _cx| Ok(format!("Hello, {}!", input.name)),
///         agent_client_protocol::tool_fn!(),
///     )
///     .build();
/// ```
#[derive(Debug)]
pub struct McpServerBuilder<Counterpart: Role, Responder>
where
    Responder: RunWithConnectionTo<Counterpart>,
{
    phantom: PhantomData<Counterpart>,
    name: String,
    data: McpServerData<Counterpart>,
    responder: Responder,
}

#[derive(Debug)]
struct McpServerData<Counterpart: Role> {
    instructions: Option<String>,
    tool_models: Vec<rmcp::model::Tool>,
    tools: FxHashMap<String, RegisteredTool<Counterpart>>,
    enabled_tools: EnabledTools,
}

/// A registered tool with its metadata.
struct RegisteredTool<Counterpart: Role> {
    tool: Arc<dyn ErasedMcpTool<Counterpart>>,
    /// Whether this tool returns structured output (i.e., has an output_schema).
    has_structured_output: bool,
}

impl<Counterpart: Role + std::fmt::Debug> std::fmt::Debug for RegisteredTool<Counterpart> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisteredTool")
            .field("has_structured_output", &self.has_structured_output)
            .finish_non_exhaustive()
    }
}

impl<Host: Role> Default for McpServerData<Host> {
    fn default() -> Self {
        Self {
            instructions: None,
            tool_models: Vec::new(),
            tools: FxHashMap::default(),
            enabled_tools: EnabledTools::default(),
        }
    }
}

impl<Counterpart: Role> McpServerBuilder<Counterpart, NullRun> {
    pub(super) fn new(name: String) -> Self {
        Self {
            name,
            phantom: PhantomData,
            data: McpServerData::default(),
            responder: NullRun,
        }
    }
}

impl<Counterpart: Role, Responder> McpServerBuilder<Counterpart, Responder>
where
    Responder: RunWithConnectionTo<Counterpart>,
{
    /// Set the server instructions that are provided to the client.
    #[must_use]
    pub fn instructions(mut self, instructions: impl ToString) -> Self {
        self.data.instructions = Some(instructions.to_string());
        self
    }

    /// Add a tool to the server.
    #[must_use]
    pub fn tool(mut self, tool: impl McpTool<Counterpart> + 'static) -> Self {
        let tool_model = make_tool_model(&tool);
        let has_structured_output = tool_model.output_schema.is_some();
        self.data.tool_models.push(tool_model);
        self.data.tools.insert(
            tool.name(),
            RegisteredTool {
                tool: make_erased_mcp_tool(tool),
                has_structured_output,
            },
        );
        self
    }

    /// Disable all tools. After calling this, only tools explicitly enabled
    /// with [`enable_tool`](Self::enable_tool) will be available.
    #[must_use]
    pub fn disable_all_tools(mut self) -> Self {
        self.data.enabled_tools = EnabledTools::AllowList(HashSet::new());
        self
    }

    /// Enable all tools. After calling this, all tools will be available
    /// except those explicitly disabled with [`disable_tool`](Self::disable_tool).
    #[must_use]
    pub fn enable_all_tools(mut self) -> Self {
        self.data.enabled_tools = EnabledTools::DenyList(HashSet::new());
        self
    }

    /// Disable a specific tool by name.
    ///
    /// Returns an error if the tool is not registered.
    pub fn disable_tool(mut self, name: &str) -> Result<Self, crate::Error> {
        if !self.data.tools.contains_key(name) {
            return Err(crate::Error::invalid_request().data(format!("unknown tool: {name}")));
        }
        match &mut self.data.enabled_tools {
            EnabledTools::DenyList(deny) => {
                deny.insert(name.to_string());
            }
            EnabledTools::AllowList(allow) => {
                allow.remove(name);
            }
        }
        Ok(self)
    }

    /// Enable a specific tool by name.
    ///
    /// Returns an error if the tool is not registered.
    pub fn enable_tool(mut self, name: &str) -> Result<Self, crate::Error> {
        if !self.data.tools.contains_key(name) {
            return Err(crate::Error::invalid_request().data(format!("unknown tool: {name}")));
        }
        match &mut self.data.enabled_tools {
            EnabledTools::DenyList(deny) => {
                deny.remove(name);
            }
            EnabledTools::AllowList(allow) => {
                allow.insert(name.to_string());
            }
        }
        Ok(self)
    }

    /// Private fn: adds the tool but also adds a responder that will be
    /// run while the MCP server is active.
    fn tool_with_responder(
        self,
        tool: impl McpTool<Counterpart> + 'static,
        tool_responder: impl RunWithConnectionTo<Counterpart>,
    ) -> McpServerBuilder<Counterpart, impl RunWithConnectionTo<Counterpart>> {
        let this = self.tool(tool);
        McpServerBuilder {
            phantom: PhantomData,
            name: this.name,
            data: this.data,
            responder: ChainRun::new(this.responder, tool_responder),
        }
    }

    /// Convenience wrapper for defining a "single-threaded" tool without having to create a struct.
    /// By "single-threaded", we mean that only one invocation of the tool can be running at a time.
    /// Typically agents invoke a tool once per session and then block waiting for the result,
    /// so this is fine, but they could attempt to run multiple invocations concurrently, in which
    /// case those invocations would be serialized.
    ///
    /// # Parameters
    ///
    /// * `name`: The name of the tool.
    /// * `description`: The description of the tool.
    /// * `func`: The function that implements the tool. Use an async closure like `async |args, cx| { .. }`.
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// McpServer::builder("my-server")
    ///     .tool_fn_mut(
    ///         "greet",
    ///         "Greet someone by name",
    ///         async |input: GreetInput, _cx| Ok(format!("Hello, {}!", input.name)),
    ///     )
    /// ```
    pub fn tool_fn_mut<P, Ret, F>(
        self,
        name: impl ToString,
        description: impl ToString,
        func: F,
        tool_future_hack: impl for<'a> Fn(
            &'a mut F,
            P,
            McpConnectionTo<Counterpart>,
        ) -> BoxFuture<'a, Result<Ret, crate::Error>>
        + Send
        + 'static,
    ) -> McpServerBuilder<Counterpart, impl RunWithConnectionTo<Counterpart>>
    where
        P: JsonSchema + DeserializeOwned + 'static + Send,
        Ret: JsonSchema + Serialize + 'static + Send,
        F: AsyncFnMut(P, McpConnectionTo<Counterpart>) -> Result<Ret, crate::Error> + Send,
    {
        let (call_tx, call_rx) = mpsc::channel(128);
        self.tool_with_responder(
            ToolFnTool {
                name: name.to_string(),
                description: description.to_string(),
                call_tx,
            },
            ToolFnMutResponder {
                func,
                call_rx,
                tool_future_fn: Box::new(tool_future_hack),
            },
        )
    }

    /// Convenience wrapper for defining a stateless tool that can run concurrently.
    /// Unlike [`tool_fn_mut`](Self::tool_fn_mut), multiple invocations of this tool can run
    /// at the same time since the function is `Fn` rather than `FnMut`.
    ///
    /// # Parameters
    ///
    /// * `name`: The name of the tool.
    /// * `description`: The description of the tool.
    /// * `func`: The function that implements the tool. Use an async closure like `async |args, cx| { .. }`.
    ///
    /// # Examples
    ///
    /// ```rust,ignore
    /// McpServer::builder("my-server")
    ///     .tool_fn(
    ///         "greet",
    ///         "Greet someone by name",
    ///         async |input: GreetInput, _cx| Ok(format!("Hello, {}!", input.name)),
    ///     )
    /// ```
    pub fn tool_fn<P, Ret, F>(
        self,
        name: impl ToString,
        description: impl ToString,
        func: F,
        tool_future_hack: impl for<'a> Fn(
            &'a F,
            P,
            McpConnectionTo<Counterpart>,
        ) -> BoxFuture<'a, Result<Ret, crate::Error>>
        + Send
        + Sync
        + 'static,
    ) -> McpServerBuilder<Counterpart, impl RunWithConnectionTo<Counterpart>>
    where
        P: JsonSchema + DeserializeOwned + 'static + Send,
        Ret: JsonSchema + Serialize + 'static + Send,
        F: AsyncFn(P, McpConnectionTo<Counterpart>) -> Result<Ret, crate::Error>
            + Send
            + Sync
            + 'static,
    {
        let (call_tx, call_rx) = mpsc::channel(128);
        self.tool_with_responder(
            ToolFnTool {
                name: name.to_string(),
                description: description.to_string(),
                call_tx,
            },
            ToolFnResponder {
                func,
                call_rx,
                tool_future_fn: Box::new(tool_future_hack),
            },
        )
    }

    /// Create an MCP server from this builder.
    ///
    /// This builder can be attached to new sessions (see [`SessionBuilder::with_mcp_server`](`crate::SessionBuilder::with_mcp_server`))
    /// or served up as part of a proxy (see [`Builder::with_mcp_server`](`crate::Builder::with_mcp_server`)).
    pub fn build(self) -> McpServer<Counterpart, Responder> {
        McpServer::new(
            McpServerBuilt {
                name: self.name,
                data: Arc::new(self.data),
            },
            self.responder,
        )
    }
}

struct McpServerBuilt<Counterpart: Role> {
    name: String,
    data: Arc<McpServerData<Counterpart>>,
}

impl<Counterpart: Role> McpServerConnect<Counterpart> for McpServerBuilt<Counterpart> {
    fn name(&self) -> String {
        self.name.clone()
    }

    fn connect(
        &self,
        mcp_connection: McpConnectionTo<Counterpart>,
    ) -> DynConnectTo<role::mcp::Client> {
        DynConnectTo::new(McpServerConnection {
            data: self.data.clone(),
            mcp_connection,
        })
    }
}

/// An MCP server instance connected to the ACP framework.
pub(crate) struct McpServerConnection<Counterpart: Role> {
    data: Arc<McpServerData<Counterpart>>,
    mcp_connection: McpConnectionTo<Counterpart>,
}

impl<Counterpart: Role> ConnectTo<role::mcp::Client> for McpServerConnection<Counterpart> {
    async fn connect_to(
        self,
        client: impl ConnectTo<role::mcp::Server>,
    ) -> Result<(), crate::Error> {
        // Create tokio byte streams that rmcp expects
        let (mcp_server_stream, mcp_client_stream) = tokio::io::duplex(8192);
        let (mcp_server_read, mcp_server_write) = tokio::io::split(mcp_server_stream);
        let (mcp_client_read, mcp_client_write) = tokio::io::split(mcp_client_stream);

        let run_client = async {
            let byte_streams =
                ByteStreams::new(mcp_client_write.compat_write(), mcp_client_read.compat());
            <ByteStreams<_, _> as ConnectTo<role::mcp::Client>>::connect_to(byte_streams, client)
                .await
        };

        let run_server = async {
            // Run the rmcp server with the server side of the duplex stream
            let running_server = rmcp::ServiceExt::serve(self, (mcp_server_read, mcp_server_write))
                .await
                .map_err(crate::Error::into_internal_error)?;

            // Wait for the server to finish
            running_server
                .waiting()
                .await
                .map(|_quit_reason| ())
                .map_err(crate::Error::into_internal_error)
        };

        (run_client, run_server).try_join().await?;
        Ok(())
    }
}

impl<R: Role> ServerHandler for McpServerConnection<R> {
    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        // Lookup the tool definition, erroring if not found or disabled
        let Some(registered) = self.data.tools.get(&request.name[..]) else {
            return Err(rmcp::model::ErrorData::invalid_params(
                format!("tool `{}` not found", request.name),
                None,
            ));
        };

        // Treat disabled tools as not found
        if !self.data.enabled_tools.is_enabled(&request.name) {
            return Err(rmcp::model::ErrorData::invalid_params(
                format!("tool `{}` not found", request.name),
                None,
            ));
        }

        // Convert input into JSON
        let serde_value = serde_json::to_value(request.arguments).expect("valid json");

        // Execute the user's tool, unless cancellation occurs
        let has_structured_output = registered.has_structured_output;
        match futures::future::select(
            registered
                .tool
                .call_tool(serde_value, self.mcp_connection.clone()),
            pin!(context.ct.cancelled()),
        )
        .await
        {
            // If completed successfully
            Either::Left((m, _)) => match m {
                Ok(result) => {
                    // Use structured output only if the tool declared an output_schema
                    if has_structured_output {
                        Ok(CallToolResult::structured(result))
                    } else {
                        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
                            result.to_string(),
                        )]))
                    }
                }
                Err(error) => Err(to_rmcp_error(error)),
            },

            // If cancelled
            Either::Right(((), _)) => {
                Err(rmcp::ErrorData::internal_error("operation cancelled", None))
            }
        }
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, ErrorData> {
        // Return only enabled tools
        let tools: Vec<_> = self
            .data
            .tool_models
            .iter()
            .filter(|t| self.data.enabled_tools.is_enabled(&t.name))
            .cloned()
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    fn get_info(&self) -> rmcp::model::ServerInfo {
        // Basic server info
        let base = rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::default())
        .with_protocol_version(rmcp::model::ProtocolVersion::default());

        if let Some(instr) = self.data.instructions.clone() {
            base.with_instructions(instr)
        } else {
            base
        }
    }
}

/// Erased version of the MCP tool trait that is dyn-compatible.
trait ErasedMcpTool<Counterpart: Role>: Send + Sync {
    fn call_tool(
        &self,
        input: serde_json::Value,
        connection: McpConnectionTo<Counterpart>,
    ) -> BoxFuture<'_, Result<serde_json::Value, crate::Error>>;
}

/// Create an `rmcp` tool model from our [`McpTool`] trait.
fn make_tool_model<R: Role, M: McpTool<R>>(tool: &M) -> Tool {
    let mut tool = rmcp::model::Tool::new(
        tool.name(),
        tool.description(),
        schema_for_type::<M::Input>(),
    )
    .with_execution(rmcp::model::ToolExecution::new());

    if let Ok(schema) = schema_for_output::<M::Output>() {
        // schema_for_output returns Err for non-object types (strings, integers, etc.)
        // since MCP structured output requires JSON objects. We set
        // output_schema to None for these tools, signaling unstructured output.
        tool = tool.with_raw_output_schema(schema);
    }

    tool
}

/// Create a [`ErasedMcpTool`] from a [`McpTool`], erasing the type details.
fn make_erased_mcp_tool<'s, R: Role, M: McpTool<R> + 's>(
    tool: M,
) -> Arc<dyn ErasedMcpTool<R> + 's> {
    struct ErasedMcpToolImpl<M> {
        tool: M,
    }

    impl<R, M> ErasedMcpTool<R> for ErasedMcpToolImpl<M>
    where
        R: Role,
        M: McpTool<R>,
    {
        fn call_tool(
            &self,
            input: serde_json::Value,
            context: McpConnectionTo<R>,
        ) -> BoxFuture<'_, Result<serde_json::Value, crate::Error>> {
            Box::pin(async move {
                let input = serde_json::from_value(input).map_err(crate::util::internal_error)?;
                serde_json::to_value(self.tool.call_tool(input, context).await?)
                    .map_err(crate::util::internal_error)
            })
        }
    }

    Arc::new(ErasedMcpToolImpl { tool })
}

/// Convert a [`crate::Error`] into an [`rmcp::ErrorData`].
fn to_rmcp_error(error: crate::Error) -> rmcp::ErrorData {
    rmcp::ErrorData {
        code: rmcp::model::ErrorCode(error.code.into()),
        message: error.message.into(),
        data: error.data,
    }
}

/// MCP tool used for `tool_fn` and `tooL_fn_mut`.
/// Each time it is invoked, it sends a `ToolCall`  message to `call_tx`.
struct ToolFnTool<P, Ret, R: Role> {
    name: String,
    description: String,
    call_tx: mpsc::Sender<ToolCall<P, Ret, R>>,
}

impl<P, Ret, R> McpTool<R> for ToolFnTool<P, Ret, R>
where
    R: Role,
    P: JsonSchema + DeserializeOwned + 'static + Send,
    Ret: JsonSchema + Serialize + 'static + Send,
{
    type Input = P;
    type Output = Ret;

    fn name(&self) -> String {
        self.name.clone()
    }

    fn description(&self) -> String {
        self.description.clone()
    }

    async fn call_tool(
        &self,
        params: P,
        mcp_connection: McpConnectionTo<R>,
    ) -> Result<Ret, crate::Error> {
        let (result_tx, result_rx) = oneshot::channel();

        self.call_tx
            .clone()
            .send(ToolCall {
                params,
                mcp_connection,
                result_tx,
            })
            .await
            .map_err(crate::util::internal_error)?;

        result_rx.await.map_err(crate::util::internal_error)?
    }
}
