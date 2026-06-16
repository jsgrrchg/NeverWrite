//! MCP server support for providing MCP tools over ACP.
//!
//! This module provides the infrastructure for building MCP servers that
//! integrate with ACP connections.
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use agent_client_protocol::mcp_server::{McpServer, McpTool};
//!
//! // Create an MCP server with tools
//! let server = McpServer::builder("my-server".to_string())
//!     .instructions("A helpful assistant")
//!     .tool(MyTool)
//!     .build();
//!
//! // Use the server as a handler on your connection
//! Proxy.builder()
//!     .with_handler(server)
//!     .serve(client)
//!     .await?;
//! ```
//!
//! ## Custom MCP Server Implementations
//!
//! You can implement [`McpServerConnect`](`crate::mcp_server::McpServerConnect`) to create custom MCP servers:
//!
//! ```rust,ignore
//! use agent_client_protocol::mcp_server::{McpServer, McpServerConnect, McpContext};
//! use agent_client_protocol::{DynComponent, JrLink};
//!
//! struct MyCustomServer;
//!
//! impl<R: Role> McpServerConnect<Link> for MyCustomServer {
//!     fn name(&self) -> String {
//!         "my-custom-server".to_string()
//!     }
//!
//!     fn connect(&self, cx: McpContext<Link>) -> DynComponent {
//!         // Return a component that serves MCP requests
//!         DynComponent::new(my_mcp_component)
//!     }
//! }
//!
//! let server = McpServer::new(MyCustomServer);
//! ```

mod active_session;
mod builder;
mod connect;
mod context;
mod responder;
mod server;
mod tool;

pub use builder::{EnabledTools, McpServerBuilder};
pub use connect::McpServerConnect;
pub use context::McpConnectionTo;
pub use server::McpServer;
pub use tool::McpTool;
