//! MCP-specific responder types.

use futures::{
    StreamExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
};

use crate::{
    ConnectionTo, jsonrpc::run::RunWithConnectionTo, mcp_server::McpConnectionTo, role::Role,
};

/// A tool call request sent through the channel.
pub(super) struct ToolCall<P, R, MyRole: Role> {
    pub(crate) params: P,
    pub(crate) mcp_connection: McpConnectionTo<MyRole>,
    pub(crate) result_tx: futures::channel::oneshot::Sender<Result<R, crate::Error>>,
}

/// Responder for a `tool_fn` closure that receives tool calls through a channel
/// and invokes the user's async function.
pub(super) struct ToolFnMutResponder<F, P, R, Counterpart: Role> {
    pub(crate) func: F,
    pub(crate) call_rx: mpsc::Receiver<ToolCall<P, R, Counterpart>>,
    pub(crate) tool_future_fn: Box<
        dyn for<'a> Fn(
                &'a mut F,
                P,
                McpConnectionTo<Counterpart>,
            ) -> BoxFuture<'a, Result<R, crate::Error>>
            + Send,
    >,
}

impl<F, P, R, Counterpart, Counterpart1> RunWithConnectionTo<Counterpart1>
    for ToolFnMutResponder<F, P, R, Counterpart>
where
    Counterpart: Role,
    Counterpart1: Role,
    P: Send,
    R: Send,
    F: Send,
{
    async fn run_with_connection_to(
        self,
        _connection: ConnectionTo<Counterpart1>,
    ) -> Result<(), crate::Error> {
        let ToolFnMutResponder {
            mut func,
            mut call_rx,
            tool_future_fn,
        } = self;
        while let Some(ToolCall {
            params,
            mcp_connection,
            result_tx,
        }) = call_rx.next().await
        {
            let result = tool_future_fn(&mut func, params, mcp_connection).await;
            result_tx
                .send(result)
                .map_err(|_| crate::util::internal_error("failed to send MCP result"))?;
        }
        Ok(())
    }
}

/// Responder for a `tool_fn` closure that receives tool calls through a channel
/// and invokes the user's async function concurrently.
pub(super) struct ToolFnResponder<F, P, R, Counterpart: Role> {
    pub(crate) func: F,
    pub(crate) call_rx: mpsc::Receiver<ToolCall<P, R, Counterpart>>,
    pub(crate) tool_future_fn: Box<
        dyn for<'a> Fn(
                &'a F,
                P,
                McpConnectionTo<Counterpart>,
            ) -> BoxFuture<'a, Result<R, crate::Error>>
            + Send
            + Sync,
    >,
}

impl<F, P, R, Counterpart, Counterpart1> RunWithConnectionTo<Counterpart1>
    for ToolFnResponder<F, P, R, Counterpart>
where
    Counterpart: Role,
    Counterpart1: Role,
    P: Send,
    R: Send,
    F: Send + Sync,
{
    async fn run_with_connection_to(
        self,
        _connection: ConnectionTo<Counterpart1>,
    ) -> Result<(), crate::Error> {
        let ToolFnResponder {
            func,
            call_rx,
            tool_future_fn,
        } = self;
        crate::util::process_stream_concurrently(
            call_rx,
            async |tool_call| {
                fn hack<'a, F, P, R, MyRole>(
                    func: &'a F,
                    params: P,
                    mcp_connection: McpConnectionTo<MyRole>,
                    tool_future_fn: &'a (
                            dyn Fn(
                        &'a F,
                        P,
                        McpConnectionTo<MyRole>,
                    ) -> BoxFuture<'a, Result<R, crate::Error>>
                                + Send
                                + Sync
                        ),
                    result_tx: oneshot::Sender<Result<R, crate::Error>>,
                ) -> BoxFuture<'a, ()>
                where
                    MyRole: Role,
                    P: Send,
                    R: Send,
                    F: Send + Sync,
                {
                    Box::pin(async move {
                        let result = tool_future_fn(func, params, mcp_connection).await;
                        // Ignore send errors - the receiver may have been dropped
                        drop(result_tx.send(result));
                    })
                }

                let ToolCall {
                    params,
                    mcp_connection,
                    result_tx,
                } = tool_call;

                hack(&func, params, mcp_connection, &*tool_future_fn, result_tx).await;
                Ok(())
            },
            |a, b| Box::pin(a(b)),
        )
        .await
    }
}
