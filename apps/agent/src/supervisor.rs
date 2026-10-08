//! Supervising the local game server process.
//!
//! The job is small but the details matter: a world must never be lost because the
//! agent killed a server abruptly, and a handover must not start until the world is
//! safely on disk. So the supervisor always asks the server to stop politely first,
//! waits for it to exit, and only then escalates.

use std::path::PathBuf;
use std::time::Duration;

/// How to launch the server.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
    /// Executable, e.g. the resolved `java` binary.
    pub program: PathBuf,
    /// Arguments, e.g. `["-Xmx4G", "-jar", "server.jar", "nogui"]`.
    pub args: Vec<String>,
    /// Working directory (the server folder that holds `world/`).
    pub cwd: PathBuf,
}

impl ServerSpec {
    /// A conventional Java launch line for a Vanilla/Paper-style server.
    pub fn java_server(java: impl Into<PathBuf>, cwd: impl Into<PathBuf>, heap_mb: u32) -> Self {
        Self {
            program: java.into(),
            args: vec![
                format!("-Xmx{heap_mb}M"),
                format!("-Xms{heap_mb}M"),
                "-jar".into(),
                "server.jar".into(),
                "nogui".into(),
            ],
            cwd: cwd.into(),
        }
    }
}

/// What the supervisor is currently doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerState {
    /// No process running.
    Stopped,
    /// Process launched, not yet ready to serve.
    Starting,
    /// Ready and accepting players.
    Running,
    /// Politely asked to stop; waiting for it to exit.
    Stopping,
}

impl ServerState {
    /// Whether a checkpoint must wait for the state to settle.
    pub fn is_busy(self) -> bool {
        matches!(self, ServerState::Starting | ServerState::Stopping)
    }
}

/// The policy for stopping a server without losing the world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopPolicy {
    /// How long to wait after a graceful stop request before forcing the process.
    pub graceful_timeout: Duration,
    /// How long to let writes settle after the process exits.
    pub flush_settle: Duration,
}

impl Default for StopPolicy {
    fn default() -> Self {
        Self {
            graceful_timeout: Duration::from_secs(30),
            flush_settle: Duration::from_millis(500),
        }
    }
}

/// Decide the next action when stopping, given how long we have already waited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopAction {
    /// Keep waiting; the process may still be saving.
    Wait,
    /// Escalate to a forced kill.
    Force,
    /// The process is gone.
    Done,
}

/// Pure decision function for the stop sequence.
///
/// This is the safety-critical part of the supervisor, so it lives on its own and
/// is tested without launching anything.
pub fn next_stop_action(policy: &StopPolicy, exited: bool, waited: Duration) -> StopAction {
    if exited {
        return StopAction::Done;
    }
    if waited >= policy.graceful_timeout {
        StopAction::Force
    } else {
        StopAction::Wait
    }
}

/// Owns a running server process.
///
/// Spawning is left to the caller: this type tracks state and enforces the rules
/// around it, which is exactly the part worth testing.
#[derive(Debug)]
pub struct Supervisor {
    pub spec: ServerSpec,
    pub state: ServerState,
    pub policy: StopPolicy,
}

impl Supervisor {
    /// Create a supervisor for a spec, initially stopped.
    pub fn new(spec: ServerSpec) -> Self {
        Self {
            spec,
            state: ServerState::Stopped,
            policy: StopPolicy::default(),
        }
    }

    /// Whether a checkpoint may be taken right now.
    ///
    /// Only a running or stopped server is quiescent enough to copy safely; a
    /// starting or stopping process is mid-write.
    pub fn may_checkpoint(&self) -> bool {
        matches!(self.state, ServerState::Running | ServerState::Stopped)
    }

    /// Note that the process has launched.
    pub fn mark_starting(&mut self) {
        self.state = ServerState::Starting;
    }

    /// Note that the server is ready to serve.
    pub fn mark_running(&mut self) {
        self.state = ServerState::Running;
    }

    /// Begin a graceful stop.
    pub fn begin_stop(&mut self) {
        if self.state != ServerState::Stopped {
            self.state = ServerState::Stopping;
        }
    }

    /// Note that the process has exited.
    pub fn mark_stopped(&mut self) {
        self.state = ServerState::Stopped;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sup() -> Supervisor {
        Supervisor::new(ServerSpec::java_server("java", "/srv/world", 4096))
    }

    #[test]
    fn java_launch_line_is_well_formed() {
        let s = ServerSpec::java_server("java", "/srv/world", 4096);
        assert_eq!(s.args[0], "-Xmx4096M");
        assert!(s.args.iter().any(|a| a == "nogui"));
    }

    #[test]
    fn checkpoint_is_only_allowed_when_quiescent() {
        let mut s = sup();
        assert!(s.may_checkpoint(), "stopped server is quiescent");
        s.mark_starting();
        assert!(!s.may_checkpoint(), "starting server is mid-write");
        s.mark_running();
        assert!(
            s.may_checkpoint(),
            "running server has a consistent save point"
        );
        s.begin_stop();
        assert!(!s.may_checkpoint(), "stopping server is mid-write");
        s.mark_stopped();
        assert!(s.may_checkpoint());
    }

    #[test]
    fn stop_waits_then_forces() {
        let policy = StopPolicy {
            graceful_timeout: Duration::from_secs(30),
            flush_settle: Duration::from_millis(100),
        };
        assert_eq!(
            next_stop_action(&policy, false, Duration::from_secs(0)),
            StopAction::Wait
        );
        assert_eq!(
            next_stop_action(&policy, false, Duration::from_secs(29)),
            StopAction::Wait
        );
        assert_eq!(
            next_stop_action(&policy, false, Duration::from_secs(30)),
            StopAction::Force
        );
        assert_eq!(
            next_stop_action(&policy, true, Duration::from_secs(31)),
            StopAction::Done,
            "an exited process is done regardless of elapsed time"
        );
    }

    #[test]
    fn stopping_an_already_stopped_server_is_a_no_op() {
        let mut s = sup();
        s.begin_stop();
        assert_eq!(s.state, ServerState::Stopped);
    }
}
