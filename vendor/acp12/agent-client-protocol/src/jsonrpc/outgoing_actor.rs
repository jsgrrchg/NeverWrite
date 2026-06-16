// Types re-exported from crate root
use futures::StreamExt as _;
use futures::channel::mpsc;

use crate::jsonrpc::OutgoingMessage;
use crate::jsonrpc::ReplyMessage;

pub type OutgoingMessageTx = mpsc::UnboundedSender<OutgoingMessage>;

pub(crate) fn send_raw_message(
    tx: &OutgoingMessageTx,
    message: OutgoingMessage,
) -> Result<(), crate::Error> {
    tracing::debug!(?message, ?tx, "send_raw_message");
    tx.unbounded_send(message)
        .map_err(crate::util::internal_error)
}

/// Outgoing protocol actor: Converts application-level OutgoingMessage to protocol-level jsonrpcmsg::Message.
///
/// This actor handles JSON-RPC protocol semantics:
/// - Subscribes to reply_actor for response correlation
/// - Converts OutgoingMessage variants to jsonrpcmsg::Message
///
/// This is the protocol layer - it has no knowledge of how messages are transported.
pub(super) async fn outgoing_protocol_actor(
    mut outgoing_rx: mpsc::UnboundedReceiver<OutgoingMessage>,
    reply_tx: mpsc::UnboundedSender<ReplyMessage>,
    transport_tx: mpsc::UnboundedSender<Result<jsonrpcmsg::Message, crate::Error>>,
) -> Result<(), crate::Error> {
    while let Some(message) = outgoing_rx.next().await {
        tracing::debug!(?message, "outgoing_protocol_actor");

        // Create the message to be sent over the transport
        let json_rpc_message = match message {
            OutgoingMessage::Request {
                id,
                role_id,
                method,
                untyped,
                response_tx,
            } => {
                // Record where the reply should be sent once it arrives.
                reply_tx
                    .unbounded_send(ReplyMessage::Subscribe {
                        id: id.clone(),
                        role_id,
                        method,
                        sender: response_tx,
                    })
                    .map_err(crate::Error::into_internal_error)?;

                jsonrpcmsg::Message::Request(untyped.into_jsonrpc_msg(Some(id))?)
            }
            OutgoingMessage::Notification { untyped } => {
                let msg = untyped.into_jsonrpc_msg(None)?;
                jsonrpcmsg::Message::Request(msg)
            }
            OutgoingMessage::Response {
                id,
                response: Ok(value),
            } => {
                tracing::debug!(?id, "Sending success response");
                jsonrpcmsg::Message::Response(jsonrpcmsg::Response::success_v2(value, Some(id)))
            }
            OutgoingMessage::Response {
                id,
                response: Err(error),
            } => {
                tracing::warn!(?id, ?error, "Sending error response");
                // Convert crate::Error to jsonrpcmsg::Error
                let jsonrpc_error = jsonrpcmsg::Error {
                    code: error.code.into(),
                    message: error.message,
                    data: error.data,
                };
                jsonrpcmsg::Message::Response(jsonrpcmsg::Response::error_v2(
                    jsonrpc_error,
                    Some(id),
                ))
            }
            OutgoingMessage::Error { error } => {
                // Convert crate::Error to jsonrpcmsg::Error
                let jsonrpc_error = jsonrpcmsg::Error {
                    code: error.code.into(),
                    message: error.message,
                    data: error.data,
                };
                // Response with id: None means this is an error notification that couldn't be
                // correlated to a specific request (e.g., parse error before we could read the id)
                jsonrpcmsg::Message::Response(jsonrpcmsg::Response::error_v2(jsonrpc_error, None))
            }
        };

        // Send to transport layer (wrapped in Ok since transport expects Result)
        transport_tx
            .unbounded_send(Ok(json_rpc_message))
            .map_err(crate::Error::into_internal_error)?;
    }
    Ok(())
}
