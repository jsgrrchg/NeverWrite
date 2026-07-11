use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

struct ChildGuard(Child);

impl ChildGuard {
    fn terminate(mut self) {
        self.0.kill().expect("code-mode host should be killable");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.0.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Ok(None) => panic!("code-mode host did not terminate within the timeout"),
                Err(error) => panic!("failed to wait for code-mode host: {error}"),
            }
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        drop(self.0.kill());
        drop(self.0.wait());
    }
}

#[test]
fn code_mode_host_starts_and_waits_for_stdio_handshake() {
    let child = Command::new(env!("CARGO_BIN_EXE_codex-code-mode-host"))
        // Keeping stdin open verifies that the host waits for its framed handshake.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("code-mode host binary should start");
    let mut child = ChildGuard(child);

    thread::sleep(Duration::from_millis(150));
    assert!(
        child
            .0
            .try_wait()
            .expect("host status should be readable")
            .is_none(),
        "code-mode host exited before receiving a stdio handshake"
    );

    child.terminate();
}
