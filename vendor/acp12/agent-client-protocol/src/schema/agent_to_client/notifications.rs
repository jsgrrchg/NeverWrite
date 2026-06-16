use crate::schema::SessionNotification;

impl_jsonrpc_notification!(SessionNotification, "session/update");
