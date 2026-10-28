//! Turning the API on and off, and keeping the connection file true to it.
//!
//! This is what the Settings commands drive. It owns the one running server (if
//! any), the token every request is checked against, and the file that tells
//! other tools where to knock. No Tauri here: what a request is forwarded to is
//! passed in.

use std::collections::HashSet;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Instant;

use serde::Serialize;

use super::broker::{Answer, Broker};
use super::connection::{self, ConnectionFile};
use super::server::{
    self, Forward, Gate, ReleaseWait, RouterReady, Running, SharedToken, ANSWER_TIMEOUT,
};
use super::vet::MAX_BODY_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatusReport {
    pub enabled: bool,
    /// The port in the connection file: the one listening now, or the one that
    /// will be tried first next time.
    pub port: Option<u16>,
    pub running: bool,
    /// Where the connection file is, for Settings to show.
    pub file: String,
}

pub struct ApiControl {
    dir: PathBuf,
    token: SharedToken,
    broker: Arc<Broker>,
    router_ready: RouterReady,
    /// The routers the host has given ids to, and which of them listen.
    /// `router_ready` is whether any listens, kept beside it so the gate reads
    /// one flag.
    routers: Mutex<Routers>,
    /// Held for a whole toggle, so toggles run one at a time. It guards the
    /// port the last one released.
    toggling: Mutex<Option<Released>>,
    release_wait: ReleaseWait,
    /// Held only for moments, never through a wait, so the status, the token
    /// and a rotation are answered while a toggle waits for its port.
    inner: Mutex<Inner>,
}

struct Inner {
    file: ConnectionFile,
    running: Option<Running>,
}

/// Every router asks the host for an id before it listens, and names itself
/// by it. Ids count up and are never reused, so a page load can tell its own
/// routers from those of the page before it: anything below `this_page_from`
/// was handed to a page that has gone (#161).
#[derive(Default)]
struct Routers {
    next: u64,
    this_page_from: u64,
    listening: HashSet<u64>,
}

/// The port this server stopped listening on, and when.
struct Released {
    port: u16,
    at: Instant,
}

impl ApiControl {
    /// Reads the connection file in `dir`, creating it (off) when there is none.
    pub fn load(dir: PathBuf) -> Result<Self, String> {
        let file = connection::load_or_create(&dir)?;
        Ok(ApiControl {
            dir,
            token: Arc::new(RwLock::new(file.token.clone())),
            broker: Arc::default(),
            // Not until the webview says so: it loads after the app starts.
            router_ready: Arc::new(AtomicBool::new(false)),
            routers: Mutex::default(),
            toggling: Mutex::default(),
            release_wait: ReleaseWait::default(),
            inner: Mutex::new(Inner {
                file,
                running: None,
            }),
        })
    }

    /// The same, waiting for a released port as `release_wait` says.
    #[cfg(test)]
    fn waiting_for_released_ports(self, release_wait: ReleaseWait) -> Self {
        ApiControl {
            release_wait,
            ..self
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        // Every change to `Inner` is a whole-field assignment, so a panic
        // elsewhere cannot leave it half-updated.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> ApiStatusReport {
        let inner = self.inner();
        ApiStatusReport {
            enabled: inner.file.enabled,
            port: (inner.file.port != 0).then_some(inner.file.port),
            running: inner.running.is_some(),
            file: connection::path_in(&self.dir).display().to_string(),
        }
    }

    pub fn token(&self) -> String {
        self.inner().file.token.clone()
    }

    /// On app start: serve again if the API was left on.
    pub fn resume(&self, forward: Forward) -> Result<(), String> {
        if self.inner().file.enabled {
            self.set_enabled(true, forward)?;
        }
        Ok(())
    }

    /// Starts or stops the server and records the choice. Either both happen or
    /// neither does: the file and what is running never disagree, so a failed
    /// save is an error and the state is as it was before the call.
    pub fn set_enabled(&self, enabled: bool, forward: Forward) -> Result<ApiStatusReport, String> {
        {
            // Each change to it is one assignment after the port is free, so
            // a panic elsewhere cannot leave it half-updated.
            let mut released = self
                .toggling
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if enabled {
                self.turn_on(&released, forward)?;
            } else {
                self.turn_off(&mut released)?;
            }
        }
        Ok(self.status())
    }

    /// The file only says "on" once the server is bound, and says which port it
    /// got; nothing is served until the file says so. The port is bound
    /// outside `inner`: binding may wait out a child's copy of the listener
    /// this server released, and the port cannot change meanwhile, since only
    /// a toggle changes it and toggles run one at a time.
    fn turn_on(&self, released: &Option<Released>, forward: Forward) -> Result<(), String> {
        let recorded = {
            let mut inner = self.inner();
            if inner.running.is_some() {
                let next = ConnectionFile {
                    enabled: true,
                    ..inner.file.clone()
                };
                connection::save(&self.dir, &next)?;
                inner.file = next;
                return Ok(());
            }
            inner.file.port
        };
        let listener = self.bind(recorded, released)?;
        let mut inner = self.inner();
        // From the file as it is now: the token may have been rotated during
        // the wait.
        let mut next = ConnectionFile {
            enabled: true,
            ..inner.file.clone()
        };
        replace_the_token_if_moved(&mut next, &listener)?;
        let gate = Arc::new(Gate {
            token: self.token.clone(),
            broker: self.broker.clone(),
            forward,
            answer_timeout: ANSWER_TIMEOUT,
            max_body: MAX_BODY_BYTES,
            router_ready: self.router_ready.clone(),
        });
        let (running, serving) = server::start(listener, gate)
            .map_err(|error| format!("cannot start the API server: {error}"))?;
        next.port = running.port;
        // Dropping `running` and `serving` on a failed save closes the listener
        // before it has served anything.
        connection::save(&self.dir, &next)?;
        self.put_token(&next.token);
        tauri::async_runtime::spawn(serving);
        inner.running = Some(running);
        inner.file = next;
        Ok(())
    }

    /// The file first: if it cannot say "off", the server keeps running and the
    /// caller is told, rather than the next launch turning back on an API the
    /// user saw go off.
    /// The server is stopped outside `inner`: stopping waits for the listener
    /// to close.
    fn turn_off(&self, released: &mut Option<Released>) -> Result<(), String> {
        let running = {
            let mut inner = self.inner();
            let next = ConnectionFile {
                enabled: false,
                ..inner.file.clone()
            };
            connection::save(&self.dir, &next)?;
            inner.file = next;
            inner.running.take()
        };
        if let Some(running) = running {
            let port = running.port;
            running.stop();
            *released = Some(Released {
                port,
                at: Instant::now(),
            });
        }
        Ok(())
    }

    /// Binds `port`, or another. The port this server released is waited for
    /// rather than taken for a squatter's (#89), but only for `release_wait`
    /// after it was released: a child's copy is gone by then, and whatever
    /// holds the port later is someone else.
    fn bind(&self, port: u16, released: &Option<Released>) -> Result<TcpListener, String> {
        let until = released
            .as_ref()
            .filter(|released| port != 0 && released.port == port)
            .map(|released| released.at + self.release_wait.within)
            .filter(|until| Instant::now() < *until);
        match until {
            Some(until) => server::bind_released(port, until, &self.release_wait),
            None => server::bind(port),
        }
        .map_err(cannot_listen)
    }

    fn put_token(&self, token: &str) {
        *self
            .token
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = token.to_string();
    }

    /// A new token, in force from the next request: the old one is refused at
    /// once, even on a connection that is already open.
    pub fn rotate_token(&self) -> Result<String, String> {
        let mut inner = self.inner();
        let next = ConnectionFile {
            token: connection::new_token()?,
            ..inner.file.clone()
        };
        // The file first: if it cannot be written, the old token stays in force
        // everywhere rather than callers holding one the server no longer takes.
        connection::save(&self.dir, &next)?;
        self.put_token(&next.token);
        inner.file = next;
        Ok(inner.file.token.clone())
    }

    /// The id a router in the webview names itself by from now on.
    pub fn register_router(&self) -> u64 {
        let mut routers = self.routers();
        let id = routers.next;
        routers.next += 1;
        id
    }

    /// A router in the webview started or stopped listening for requests. The
    /// API is ready while any of them listens, so one stopping never takes
    /// readiness from another — whatever order the two calls arrive in. (Under
    /// React StrictMode the abandoned first router says it stopped after the
    /// second has said it listens: #158.)
    pub fn set_router_ready(&self, listener: u64, ready: bool) {
        let mut routers = self.routers();
        if ready {
            routers.listening.insert(listener);
        } else {
            routers.listening.remove(&listener);
        }
        // Under the lock, so the flag follows the set in the order it changed.
        self.router_ready
            .store(!routers.listening.is_empty(), Ordering::SeqCst);
    }

    /// The page went away, and every router in it: nothing listens until the
    /// next page says so.
    pub fn forget_routers(&self) {
        let mut routers = self.routers();
        routers.listening.clear();
        routers.this_page_from = routers.next;
        self.router_ready.store(false, Ordering::SeqCst);
    }

    fn routers(&self) -> MutexGuard<'_, Routers> {
        // Each change is one insert, remove, clear or counter step, so a panic
        // elsewhere cannot leave the routers half-updated.
        self.routers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The app's answer to a forwarded request. An id nobody is waiting on —
    /// too late, or never asked — is ignored.
    pub fn respond(&self, id: &str, answer: Answer) {
        if !self.broker.answer(id, answer) {
            log::debug!("API answer for {id} arrived with nobody waiting");
        }
    }
}

fn cannot_listen(error: std::io::Error) -> String {
    format!("cannot listen on 127.0.0.1: {error}")
}

/// On a port other than the one `next` records, `next` gets a new token:
/// whoever holds the recorded port may have been collecting the old one from
/// tools that knocked there while DFAI was closed.
fn replace_the_token_if_moved(
    next: &mut ConnectionFile,
    listener: &TcpListener,
) -> Result<(), String> {
    let port = listener.local_addr().map_err(cannot_listen)?.port();
    if next.port != 0 && port != next.port {
        log::warn!(
            "API port {} was taken; the token is replaced before serving on {port}",
            next.port
        );
        next.token = connection::new_token()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// A router that is listening and answers with the path it was asked for.
    fn echo(control: &Arc<ApiControl>) -> Forward {
        let echo = control.register_router();
        control.set_router_ready(echo, true);
        let control = Arc::downgrade(control);
        Arc::new(move |request| {
            if let Some(control) = control.upgrade() {
                let body = serde_json::json!({ "path": request.path });
                control.respond(&request.id, Answer { status: 200, body });
            }
            Ok(())
        })
    }

    fn get_status(port: u16, token: &str) -> std::io::Result<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        write!(
            stream,
            "GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
             Authorization: Bearer {token}\r\nConnection: close\r\n\r\n"
        )?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        Ok(response)
    }

    fn loaded() -> (tempfile::TempDir, Arc<ApiControl>) {
        waiting(ReleaseWait::default())
    }

    fn waiting(release_wait: ReleaseWait) -> (tempfile::TempDir, Arc<ApiControl>) {
        let dir = tempfile::tempdir().unwrap();
        let control = ApiControl::load(dir.path().join("app"))
            .unwrap()
            .waiting_for_released_ports(release_wait);
        (dir, Arc::new(control))
    }

    #[test]
    fn is_off_until_turned_on() {
        let (_dir, control) = loaded();
        let status = control.status();
        assert!(!status.enabled);
        assert!(!status.running);
        assert_eq!(status.port, None);
        assert!(status.file.ends_with("api.json"));
    }

    #[test]
    fn turning_it_on_serves_and_records_the_port() {
        let (dir, control) = loaded();
        let status = control.set_enabled(true, echo(&control)).unwrap();
        assert!(status.enabled && status.running);
        let port = status.port.unwrap();

        let file = connection::load_or_create(&dir.path().join("app")).unwrap();
        assert!(file.enabled);
        assert_eq!(file.port, port);

        let response = get_status(port, &control.token()).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with(r#"{"path":"/v1/status"}"#), "{response}");
    }

    #[test]
    fn turning_it_off_stops_serving_and_is_recorded() {
        let (dir, control) = loaded();
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();

        let status = control.set_enabled(false, echo(&control)).unwrap();
        assert!(!status.enabled && !status.running);
        assert!(
            !connection::load_or_create(&dir.path().join("app"))
                .unwrap()
                .enabled
        );

        // Turning off returns only once the listener is closed.
        assert!(
            get_status(port, &control.token()).is_err(),
            "the port still answers after the API was turned off"
        );
    }

    /// Off then straight back on must not find DFAI's own old listener still
    /// holding the port, take it for a squatter, move and replace the token.
    #[test]
    fn turning_it_off_and_straight_back_on_keeps_the_port_and_the_token() {
        let (_dir, control) = loaded();
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let token = control.token();

        for toggle in 0..50 {
            control.set_enabled(false, echo(&control)).unwrap();
            let status = control.set_enabled(true, echo(&control)).unwrap();
            assert_eq!(status.port, port, "moved port on toggle {toggle}");
            assert_eq!(control.token(), token, "replaced token on toggle {toggle}");
        }
        assert!(get_status(port.unwrap(), &token)
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    /// A copy of the socket listening on `port`, as a child process that was
    /// being spawned at that moment holds one of every descriptor until it has
    /// exec'd. While any copy is open the port is not free, though DFAI has
    /// closed its own.
    #[cfg(unix)]
    fn copy_of_the_listener_on(port: u16) -> std::os::fd::OwnedFd {
        use std::os::fd::{FromRawFd, OwnedFd};
        for fd in 0..4096 {
            let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
            let mut length = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
            // SAFETY: `address` is a sockaddr_in and `length` says so; a
            // descriptor that is not a socket only makes the call fail.
            let named = unsafe {
                libc::getsockname(fd, std::ptr::addr_of_mut!(address).cast(), &mut length)
            };
            let is_it = named == 0
                && libc::c_int::from(address.sin_family) == libc::AF_INET
                && u16::from_be(address.sin_port) == port;
            if is_it {
                // SAFETY: duplicating a descriptor touches no memory.
                let copy = unsafe { libc::dup(fd) };
                assert!(copy >= 0, "dup: {}", std::io::Error::last_os_error());
                // SAFETY: `copy` was just opened by `dup`; nothing else owns it.
                return unsafe { OwnedFd::from_raw_fd(copy) };
            }
        }
        panic!("nothing in this process is listening on {port}");
    }

    /// Turning it off closes DFAI's listener, but a child being spawned at
    /// that moment (git, the model) still holds a copy for a few milliseconds
    /// — longer under load. Turning straight back on must wait that out, not
    /// take the copy for a squatter, move and replace the token (#89).
    #[cfg(unix)]
    #[test]
    fn turning_it_back_on_waits_for_a_child_s_copy_of_the_listener_to_close() {
        let held = Arc::new(Mutex::new(None));
        let tries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_dir, control) = waiting(ReleaseWait {
            within: std::time::Duration::from_secs(60),
            between_tries: {
                let (held, tries) = (held.clone(), tries.clone());
                // The child execs between the first try and the second.
                Arc::new(move || {
                    tries.fetch_add(1, Ordering::SeqCst);
                    held.lock().unwrap().take();
                })
            },
        });
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let token = control.token();
        *held.lock().unwrap() = Some(copy_of_the_listener_on(port.unwrap()));

        control.set_enabled(false, echo(&control)).unwrap();
        let status = control.set_enabled(true, echo(&control)).unwrap();

        assert_eq!(
            tries.load(Ordering::SeqCst),
            1,
            "the copy was never waited for"
        );
        assert_eq!(status.port, port, "moved port");
        assert_eq!(control.token(), token, "replaced token");
        assert!(get_status(port.unwrap(), &token)
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    /// Something that keeps the port DFAI let go of is a squatter: once the
    /// wait is over, DFAI listens elsewhere, under a new token.
    #[cfg(unix)]
    #[test]
    fn a_port_still_held_after_the_wait_is_replaced_with_the_token() {
        let (_dir, control) = waiting(ReleaseWait {
            within: std::time::Duration::from_millis(20),
            ..ReleaseWait::default()
        });
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let token = control.token();
        let _squatter = copy_of_the_listener_on(port.unwrap());

        control.set_enabled(false, echo(&control)).unwrap();
        let status = control.set_enabled(true, echo(&control)).unwrap();

        assert_ne!(status.port, port);
        assert_ne!(control.token(), token);
        assert!(get_status(status.port.unwrap(), &control.token())
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    /// A token rotated while turning on waits for its port is the one served
    /// and recorded: the file is read again after the wait, not before it.
    #[cfg(unix)]
    #[test]
    fn a_token_rotated_during_the_wait_is_kept() {
        let held = Arc::new(Mutex::new(None));
        let rotated = Arc::new(Mutex::new(None));
        let control_for_hook = Arc::new(std::sync::OnceLock::<std::sync::Weak<ApiControl>>::new());
        let (dir, control) = waiting(ReleaseWait {
            within: std::time::Duration::from_secs(60),
            between_tries: {
                let (held, rotated, control) =
                    (held.clone(), rotated.clone(), control_for_hook.clone());
                // Settings rotates the token, then the child execs.
                Arc::new(move || {
                    if let Some(control) = control.get().and_then(std::sync::Weak::upgrade) {
                        rotated
                            .lock()
                            .unwrap()
                            .get_or_insert_with(|| control.rotate_token().unwrap());
                    }
                    held.lock().unwrap().take();
                })
            },
        });
        control_for_hook.set(Arc::downgrade(&control)).unwrap();
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();
        *held.lock().unwrap() = Some(copy_of_the_listener_on(port));

        control.set_enabled(false, echo(&control)).unwrap();
        let status = control.set_enabled(true, echo(&control)).unwrap();

        let rotated = rotated.lock().unwrap().clone().expect("never rotated");
        assert_eq!(status.port, Some(port));
        assert_eq!(control.token(), rotated);
        assert_eq!(
            connection::load_or_create(&dir.path().join("app"))
                .unwrap()
                .token,
            rotated
        );
        assert!(get_status(port, &rotated)
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    /// A port released longer ago than the wait is not waited for: whatever
    /// holds it now is someone else, and turning on moves at once.
    #[cfg(unix)]
    #[test]
    fn a_release_older_than_the_wait_is_not_waited_for() {
        let tries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_dir, control) = waiting(ReleaseWait {
            within: std::time::Duration::ZERO,
            between_tries: {
                let tries = tries.clone();
                Arc::new(move || {
                    tries.fetch_add(1, Ordering::SeqCst);
                })
            },
        });
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let _squatter = copy_of_the_listener_on(port.unwrap());

        control.set_enabled(false, echo(&control)).unwrap();
        let status = control.set_enabled(true, echo(&control)).unwrap();

        assert_eq!(tries.load(Ordering::SeqCst), 0, "waited for an old release");
        assert_ne!(status.port, port);
    }

    #[test]
    fn rotating_the_token_refuses_the_old_one_at_once() {
        let (dir, control) = loaded();
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();
        let old = control.token();

        let new = control.rotate_token().unwrap();
        assert_ne!(new, old);
        assert_eq!(control.token(), new);
        assert_eq!(
            connection::load_or_create(&dir.path().join("app"))
                .unwrap()
                .token,
            new
        );

        assert!(get_status(port, &old).unwrap().starts_with("HTTP/1.1 401"));
        assert!(get_status(port, &new).unwrap().starts_with("HTTP/1.1 200"));
    }

    /// A file left on, as the app would find it at launch.
    fn left_on_at(dir: &std::path::Path, port: u16) {
        let file = ConnectionFile {
            port,
            enabled: true,
            ..ConnectionFile::fresh().unwrap()
        };
        connection::save(dir, &file).unwrap();
    }

    #[test]
    fn resumes_on_the_recorded_port_when_left_on() {
        let dir = tempfile::tempdir().unwrap();
        let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        left_on_at(dir.path(), port);

        let control = Arc::new(ApiControl::load(dir.path().to_path_buf()).unwrap());
        let recorded = control.token();
        control.resume(echo(&control)).unwrap();

        let status = control.status();
        assert!(status.running);
        assert_eq!(status.port, Some(port));
        assert_eq!(control.token(), recorded, "a free port keeps the token");
        assert!(get_status(port, &control.token())
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn a_taken_port_is_replaced_by_one_the_os_chooses_and_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = squatter.local_addr().unwrap().port();
        left_on_at(dir.path(), taken);

        let control = Arc::new(ApiControl::load(dir.path().to_path_buf()).unwrap());
        control.resume(echo(&control)).unwrap();

        let port = control.status().port.unwrap();
        assert_ne!(port, taken);
        assert_eq!(connection::load_or_create(dir.path()).unwrap().port, port);
        assert!(get_status(port, &control.token())
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn a_taken_port_replaces_the_token_before_anything_is_served() {
        let dir = tempfile::tempdir().unwrap();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        left_on_at(dir.path(), squatter.local_addr().unwrap().port());
        let control = Arc::new(ApiControl::load(dir.path().to_path_buf()).unwrap());
        let collected = control.token();

        control.resume(echo(&control)).unwrap();

        let token = control.token();
        assert_ne!(token, collected);
        assert_eq!(connection::load_or_create(dir.path()).unwrap().token, token);
        let port = control.status().port.unwrap();
        assert!(get_status(port, &collected)
            .unwrap()
            .starts_with("HTTP/1.1 401"));
        assert!(get_status(port, &token)
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    #[cfg(unix)]
    fn set_mode(path: &std::path::Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Runs `during` with `dir` read-only, so any save in it fails.
    #[cfg(unix)]
    fn with_read_only<T>(dir: &std::path::Path, during: impl FnOnce() -> T) -> T {
        set_mode(dir, 0o500);
        let result = during();
        set_mode(dir, 0o700);
        result
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_turn_on_on_a_taken_port_keeps_the_token_the_file_holds() {
        let dir = tempfile::tempdir().unwrap();
        let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        left_on_at(dir.path(), squatter.local_addr().unwrap().port());
        let control = Arc::new(ApiControl::load(dir.path().to_path_buf()).unwrap());
        let recorded = control.token();

        let resumed = with_read_only(dir.path(), || control.resume(echo(&control)));

        assert!(resumed.is_err());
        assert!(!control.status().running);
        assert_eq!(control.token(), recorded);
        assert_eq!(*control.token.read().unwrap(), recorded);
        assert_eq!(
            connection::load_or_create(dir.path()).unwrap().token,
            recorded
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_turn_off_leaves_it_on_and_serving_as_the_file_says() {
        let (dir, control) = loaded();
        let app = dir.path().join("app");
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();

        let turned_off = with_read_only(&app, || control.set_enabled(false, echo(&control)));

        assert!(turned_off.is_err());
        let status = control.status();
        assert!(status.enabled && status.running, "{status:?}");
        assert!(connection::load_or_create(&app).unwrap().enabled);
        assert!(get_status(port, &control.token())
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    fn router_is_ready(control: &ApiControl) -> bool {
        control.router_ready.load(Ordering::SeqCst)
    }

    /// React StrictMode mounts the router twice: the abandoned first listener
    /// says it stopped after the second has said it listens. That must not
    /// leave the API refusing everything while the second is still listening.
    #[test]
    fn a_listener_stopping_leaves_the_api_ready_while_another_listens() {
        let (_dir, control) = loaded();
        let first = control.register_router();
        let second = control.register_router();

        control.set_router_ready(first, true);
        control.set_router_ready(second, true);
        control.set_router_ready(first, false);

        assert!(
            router_is_ready(&control),
            "the live listener lost its readiness"
        );
        control.set_router_ready(second, false);
        assert!(!router_is_ready(&control), "ready with nothing listening");
    }

    #[test]
    fn is_not_ready_until_a_router_listens() {
        let (_dir, control) = loaded();
        assert!(!router_is_ready(&control));
        let never_listened = control.register_router();
        control.set_router_ready(never_listened, false);
        assert!(!router_is_ready(&control));
    }

    /// A router saying it listens twice is still one router: its one stop
    /// leaves nothing listening.
    #[test]
    fn a_router_that_says_it_listens_twice_stops_once() {
        let (_dir, control) = loaded();
        let only = control.register_router();
        control.set_router_ready(only, true);
        control.set_router_ready(only, true);
        control.set_router_ready(only, false);
        assert!(!router_is_ready(&control));
    }

    #[test]
    fn a_page_load_forgets_every_router() {
        let (_dir, control) = loaded();
        let first = control.register_router();
        let second = control.register_router();
        control.set_router_ready(first, true);
        control.set_router_ready(second, true);

        control.forget_routers();
        assert!(!router_is_ready(&control));

        // A router from the gone page saying late that it stopped changes
        // nothing, and the new page's router makes the API ready again.
        control.set_router_ready(first, false);
        assert!(!router_is_ready(&control), "a gone page's router came back");
        let next_page = control.register_router();
        control.set_router_ready(next_page, true);
        assert!(router_is_ready(&control));
    }

    /// #161: page A's "I listen" can reach the host after the reload has
    /// begun. Nothing of A listens by then, so the API must stay not ready
    /// (requests refused at once) until page B's own router says it listens.
    #[test]
    fn a_reloaded_page_s_late_ready_never_marks_the_api_ready() {
        let (_dir, control) = loaded();
        let page_a = control.register_router();

        control.forget_routers(); // the reload starts: page B is loading
        control.set_router_ready(page_a, true);
        assert!(!router_is_ready(&control), "ready with only page A's ghost");

        let page_b = control.register_router();
        control.set_router_ready(page_a, true);
        assert!(!router_is_ready(&control), "page A's ghost beat page B");

        control.set_router_ready(page_b, true);
        assert!(router_is_ready(&control), "page B listens");
        control.set_router_ready(page_b, false);
        assert!(!router_is_ready(&control), "page A's ghost kept it ready");
    }

    /// The same when page B has gone too — reloaded again, say — before
    /// either page's late "I listen" lands.
    #[test]
    fn late_readies_from_two_gone_pages_never_mark_the_api_ready() {
        let (_dir, control) = loaded();
        let page_a = control.register_router();
        control.set_router_ready(page_a, true);

        control.forget_routers(); // page B starts
        let page_b = control.register_router();
        control.forget_routers(); // page B goes before it said it listens

        control.set_router_ready(page_a, true);
        control.set_router_ready(page_b, true);
        assert!(!router_is_ready(&control), "a gone page's router came back");
    }

    /// Only the host hands out ids: one it never gave is nobody's.
    #[test]
    fn an_id_the_host_never_gave_never_marks_the_api_ready() {
        let (_dir, control) = loaded();
        let given = control.register_router();
        control.set_router_ready(given + 1, true);
        assert!(!router_is_ready(&control));
    }

    #[test]
    fn stays_off_when_left_off() {
        let (_dir, control) = loaded();
        control.resume(echo(&control)).unwrap();
        assert!(!control.status().running);
    }

    #[test]
    fn an_answer_nobody_waits_for_is_ignored() {
        let (_dir, control) = loaded();
        control.respond(
            "never-asked",
            Answer {
                status: 200,
                body: serde_json::Value::Null,
            },
        );
        assert_eq!(control.broker.waiting(), 0);
    }

    /// While turning on waits out a copy of the listener it released, the
    /// Settings page still asks for the status: it must be answered, not held
    /// for the whole wait behind the lock the toggle keeps (#89).
    #[cfg(unix)]
    #[test]
    fn the_status_is_answered_while_turning_on_waits_for_the_released_port() {
        let held = Arc::new(Mutex::new(None));
        let answered = Arc::new(Mutex::new(None));
        let control_for_hook = Arc::new(std::sync::OnceLock::<std::sync::Weak<ApiControl>>::new());
        let (_dir, control) = waiting(ReleaseWait {
            within: std::time::Duration::from_secs(60),
            between_tries: {
                let (held, answered, control) =
                    (held.clone(), answered.clone(), control_for_hook.clone());
                // Mid-wait, with the toggle's lock held: Settings asks for the
                // status from another thread, then the child execs.
                Arc::new(move || {
                    let mut answered = answered.lock().unwrap();
                    if answered.is_none() {
                        let control = control.get().and_then(std::sync::Weak::upgrade).unwrap();
                        let (tell, told) = std::sync::mpsc::channel();
                        std::thread::spawn(move || {
                            control.status();
                            // Gone only if the test already failed: nothing to tell.
                            let _ = tell.send(());
                        });
                        *answered = Some(told.recv_timeout(STATUS_HANG_GUARD).is_ok());
                    }
                    held.lock().unwrap().take();
                })
            },
        });
        control_for_hook.set(Arc::downgrade(&control)).unwrap();
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        *held.lock().unwrap() = Some(copy_of_the_listener_on(port.unwrap()));

        control.set_enabled(false, echo(&control)).unwrap();
        control.set_enabled(true, echo(&control)).unwrap();

        assert_eq!(
            *answered.lock().unwrap(),
            Some(true),
            "status() was held behind the release wait (None: never waited)"
        );
    }

    /// Only a hang guard: status() answers, and a release wait begins, in
    /// microseconds, so a test that reaches it would otherwise wait for ever.
    const STATUS_HANG_GUARD: std::time::Duration = std::time::Duration::from_secs(30);

    /// Off, on, off, on in quick succession, a child's copy of the listener
    /// open across the first off and closing during the wait, keeps the port
    /// and the token every time.
    #[cfg(unix)]
    #[test]
    fn quick_toggles_with_a_child_s_copy_keep_the_port_and_the_token() {
        let (_dir, control) = loaded();
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let token = control.token();
        for _ in 0..3 {
            let held = copy_of_the_listener_on(port.unwrap());
            control.set_enabled(false, echo(&control)).unwrap();
            let child_execs = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(30));
                drop(held);
            });
            let status = control.set_enabled(true, echo(&control)).unwrap();
            child_execs.join().unwrap();
            assert_eq!(status.port, port, "moved port");
            assert_eq!(control.token(), token, "replaced token");
        }
        assert!(get_status(port.unwrap(), &token)
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    /// Off pressed while on is still waiting for the released port ends off:
    /// the last choice wins, and the file says so.
    #[cfg(unix)]
    #[test]
    fn turning_off_during_the_wait_ends_off() {
        let (began, waiting_began) = std::sync::mpsc::channel();
        let began = Mutex::new(Some(began));
        let (dir, control) = waiting(ReleaseWait {
            between_tries: Arc::new(move || {
                if let Some(began) = began.lock().unwrap().take() {
                    began.send(()).unwrap();
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }),
            ..ReleaseWait::default()
        });
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let held = copy_of_the_listener_on(port.unwrap());
        control.set_enabled(false, echo(&control)).unwrap();

        let toggling = control.clone();
        let forward = echo(&control);
        let turning_on = std::thread::spawn(move || toggling.set_enabled(true, forward));
        waiting_began
            .recv_timeout(STATUS_HANG_GUARD)
            .expect("the release wait never began");
        let off = control.set_enabled(false, echo(&control)).unwrap();
        turning_on.join().unwrap().unwrap();
        drop(held);

        assert!(!off.enabled && !off.running);
        assert!(!control.status().running);
        let file = connection::load_or_create(&dir.path().join("app")).unwrap();
        assert!(!file.enabled);
    }

    /// Something that takes the port in the moment between a child's copy
    /// closing and DFAI trying again is a squatter: if DFAI did not get its
    /// port, the token is replaced and the old one is refused where DFAI now
    /// listens. DFAI getting it first keeps both. Either way, port moved if
    /// and only if token replaced.
    #[cfg(unix)]
    #[test]
    fn a_squatter_that_binds_during_the_wait_never_inherits_the_token() {
        let (_dir, control) = loaded();
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();
        let token = control.token();
        let held = copy_of_the_listener_on(port);
        control.set_enabled(false, echo(&control)).unwrap();

        let squatting = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(held);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while std::time::Instant::now() < deadline {
                if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
                    return Some(listener);
                }
                // Faster than DFAI's 5 ms, without exhausting the socket table.
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            None
        });
        let status = control.set_enabled(true, echo(&control)).unwrap();
        let squatter = squatting.join().unwrap();

        let now_on = status.port.unwrap();
        assert_eq!(
            squatter.is_some(),
            now_on != port,
            "squatter and DFAI share {port}"
        );
        assert_eq!(
            now_on != port,
            control.token() != token,
            "port moved without the token"
        );
        if now_on != port {
            assert!(get_status(now_on, &token)
                .unwrap()
                .starts_with("HTTP/1.1 401"));
        }
    }

    /// Two threads toggling against each other, a child's copy closing during
    /// the first wait: what runs and what the file says agree at the end, and
    /// the port and token are never given up with nobody else on the port.
    #[cfg(unix)]
    #[test]
    fn concurrent_toggles_never_give_up_the_port() {
        let (dir, control) = loaded();
        let port = control.set_enabled(true, echo(&control)).unwrap().port;
        let token = control.token();
        let held = copy_of_the_listener_on(port.unwrap());
        let child_execs = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(held);
        });
        let togglers: Vec<_> = [true, false]
            .into_iter()
            .map(|first| {
                let control = control.clone();
                let forward = echo(&control);
                std::thread::spawn(move || {
                    for step in 0..40 {
                        let on = (step % 2 == 0) == first;
                        let status = control.set_enabled(on, forward.clone()).unwrap();
                        if status.running {
                            assert_eq!(status.port, port, "moved port");
                        }
                    }
                })
            })
            .collect();
        for toggler in togglers {
            toggler.join().unwrap();
        }
        child_execs.join().unwrap();

        assert_eq!(control.token(), token, "replaced token");
        let status = control.status();
        let file = connection::load_or_create(&dir.path().join("app")).unwrap();
        assert_eq!(file.enabled, status.running);
        assert_eq!(status.enabled, status.running);
    }

    /// `released` is this run's memory: a new launch with the recorded port
    /// held does not wait for it, but moves at once under a new token.
    #[test]
    fn a_new_launch_does_not_wait_for_the_port_the_last_one_released() {
        let (dir, control) = loaded();
        let port = control
            .set_enabled(true, echo(&control))
            .unwrap()
            .port
            .unwrap();
        control.set_enabled(false, echo(&control)).unwrap();
        let token = control.token();
        let mut file = connection::load_or_create(&dir.path().join("app")).unwrap();
        file.enabled = true;
        connection::save(&dir.path().join("app"), &file).unwrap();
        drop(control);
        let _squatter = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();

        let relaunched = Arc::new(
            ApiControl::load(dir.path().join("app"))
                .unwrap()
                .waiting_for_released_ports(ReleaseWait {
                    within: std::time::Duration::from_secs(60),
                    between_tries: Arc::new(|| {
                        panic!("waited for the port the last launch released")
                    }),
                }),
        );
        relaunched.resume(echo(&relaunched)).unwrap();

        assert_ne!(relaunched.status().port, Some(port));
        assert_ne!(relaunched.token(), token);
    }
}
