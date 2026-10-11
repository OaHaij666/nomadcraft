//! Authenticated vanilla hosting against the catalog panel.
//! The panel, rather than a locally modified game process, owns grants and world commits.
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, watch, Mutex},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tokio_util::io::ReaderStream;
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTicket {
    pub panel: String,
    pub grant_id: String,
    pub token: String,
}
impl HostTicket {
    pub fn validate(&self) -> Result<Url> {
        let url = Url::parse(&(self.panel.trim_end_matches('/').to_owned() + "/"))?;
        let local = url
            .host_str()
            .map(|h| {
                h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|i| i.is_loopback())
            })
            .unwrap_or(false);
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            bail!("Remote panel connections require HTTPS");
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Invalid panel address");
        }
        uuid::Uuid::parse_str(&self.grant_id)?;
        if self.token.len() != 64 || !self.token.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Invalid executor ticket");
        }
        Ok(url)
    }
}
#[derive(Clone)]
struct Panel {
    ticket: HostTicket,
    client: Client,
    base: Url,
}
impl Panel {
    fn new(ticket: HostTicket) -> Result<Self> {
        let base = ticket.validate()?;
        Ok(Self {
            ticket,
            base,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(180))
                .build()?,
        })
    }
    fn url(&self, action: &str, epoch: Option<u64>) -> Result<Url> {
        let mut url = self.base.join(&format!(
            "api/nomad/hosting/agent/{}/{}",
            self.ticket.grant_id, action
        ))?;
        if let Some(epoch) = epoch {
            url.query_pairs_mut()
                .append_pair("epoch", &epoch.to_string());
        }
        Ok(url)
    }
    async fn json(&self, action: &str, epoch: Option<u64>, body: Value) -> Result<Value> {
        let r = self
            .client
            .request(Method::POST, self.url(action, epoch)?)
            .bearer_auth(&self.ticket.token)
            .json(&body)
            .send()
            .await
            .context("Panel request failed")?;
        let status = r.status();
        let envelope: Value = r.json().await.context("Invalid panel response")?;
        if !status.is_success() || envelope["status"] != 200 {
            bail!("Panel {} refused ({}) {}", action, status, envelope["data"]);
        }
        Ok(envelope["data"].clone())
    }
    async fn download(
        &self,
        action: &str,
        epoch: u64,
        path: &Path,
        max: u64,
    ) -> Result<Option<String>> {
        let mut r = self
            .client
            .get(self.url(action, Some(epoch))?)
            .bearer_auth(&self.ticket.token)
            .send()
            .await
            .context("Panel download failed")?;
        if r.status() == 204 {
            return Ok(None);
        }
        if !r.status().is_success() {
            bail!("Panel download {} refused ({})", action, r.status());
        }
        let expected = r
            .headers()
            .get("x-nomad-sha256")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut file = tokio::fs::File::create(path).await?;
        let mut hash = Sha256::new();
        let mut size = 0;
        while let Some(chunk) = r.chunk().await? {
            size += chunk.len() as u64;
            if size > max {
                bail!("Download exceeds cloud limit");
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        let actual = hex::encode(hash.finalize());
        if expected.as_ref().is_some_and(|e| *e != actual) {
            bail!("World snapshot SHA256 mismatch");
        }
        Ok(Some(actual))
    }
    async fn upload(&self, epoch: u64, file: &Path, final_save: bool) -> Result<Value> {
        let length = tokio::fs::metadata(file).await?.len();
        let stream = ReaderStream::new(tokio::fs::File::open(file).await?);
        let part = reqwest::multipart::Part::stream_with_length(
            reqwest::Body::wrap_stream(stream),
            length,
        )
        .file_name("world.zip")
        .mime_str("application/zip")?;
        let mut url = self.url("checkpoint", Some(epoch))?;
        url.query_pairs_mut()
            .append_pair("final", if final_save { "true" } else { "false" });
        let r = self
            .client
            .post(url)
            .bearer_auth(&self.ticket.token)
            .multipart(reqwest::multipart::Form::new().part("world", part))
            .send()
            .await
            .context("World upload failed")?;
        let status = r.status();
        let result: Value = r.json().await?;
        if !status.is_success() || result["status"] != 200 {
            bail!("World commit refused ({}) {}", status, result["data"]);
        }
        Ok(result["data"].clone())
    }
}

pub fn checked_zip_path(value: &str) -> Result<PathBuf> {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
    {
        bail!("Unsafe archive path");
    }
    for part in value.trim_end_matches('/').split('/') {
        let name = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&name.as_str())
        {
            bail!("Unsafe archive path");
        }
    }
    Ok(PathBuf::from(value))
}
pub fn extract_archive(archive: &Path, target: &Path, world: bool, max: u64) -> Result<()> {
    let mut zip = ZipArchive::new(File::open(archive)?)?;
    if zip.len() > 50000 {
        bail!("Too many archive entries");
    }
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut expanded = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let path = checked_zip_path(entry.name())?;
        let key = entry.name().to_ascii_lowercase();
        if !seen.insert(key) {
            bail!("Duplicate archive path");
        }
        if world && !entry.name().starts_with("world/") {
            bail!("World archive may not overwrite server policy");
        }
        if !world
            && !matches!(
                entry.name(),
                "server.jar"
                    | "server.properties"
                    | "eula.txt"
                    | "user_jvm_args.txt"
                    | "nomad-server.json"
                    | "whitelist.json"
                    | "ops.json"
                    | "banned-players.json"
                    | "README.txt"
            )
        {
            bail!("Unexpected deployment file");
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("Archive links are not allowed");
        }
        expanded = expanded
            .checked_add(entry.size())
            .context("Archive size overflow")?;
        if expanded > max {
            bail!("Archive exceeds expanded limit");
        }
        entries.push((i, path, entry.is_dir()));
    }
    std::fs::create_dir_all(target)?;
    for (i, relative, is_dir) in entries {
        let path = target.join(relative);
        if is_dir {
            std::fs::create_dir_all(path)?;
            continue;
        }
        std::fs::create_dir_all(path.parent().context("Missing parent")?)?;
        let mut entry = zip.by_index(i)?;
        let mut file = File::create(path)?;
        std::io::copy(&mut entry, &mut file)?;
        file.sync_all()?;
    }
    if world && !target.join("world/level.dat").is_file() {
        bail!("World level.dat is missing");
    }
    Ok(())
}
pub fn snapshot_world(server: &Path, target: &Path) -> Result<()> {
    if !server.join("world/level.dat").is_file() {
        bail!("World is not initialized; refusing an empty commit");
    }
    let mut zip = ZipWriter::new(File::create(target)?);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(1));
    for entry in WalkDir::new(server.join("world"))
        .follow_links(false)
        .sort_by_file_name()
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .strip_prefix(server)?
            .to_str()
            .context("Non-UTF8 world path")?
            .replace('\\', "/");
        checked_zip_path(&name)?;
        if name.ends_with("/session.lock") {
            continue;
        }
        zip.start_file(name, options)?;
        let mut input = File::open(entry.path())?;
        std::io::copy(&mut input, &mut zip)?;
    }
    zip.finish()?.sync_all()?;
    Ok(())
}
pub fn file_hash(path: &Path) -> Result<String> {
    let mut input = File::open(path)?;
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = input.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

pub struct HostingOptions {
    pub ticket_file: PathBuf,
    pub data_dir: PathBuf,
    pub java: PathBuf,
    pub checkpoint_seconds: u64,
    pub stop_file: Option<PathBuf>,
}
async fn command(
    stdin: &mut ChildStdin,
    logs: &broadcast::Sender<String>,
    text: &str,
    expected: &str,
) -> Result<()> {
    let mut receiver = logs.subscribe();
    stdin.write_all(format!("{text}\n").as_bytes()).await?;
    stdin.flush().await?;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            match receiver.recv().await {
                Ok(line) if line.contains(expected) => return Ok(()),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(e) => return Err(anyhow::Error::from(e)),
            }
        }
    })
    .await
    .context("Server did not confirm save command")?
}
async fn checkpoint(
    panel: &Panel,
    epoch: u64,
    server: &Path,
    stdin: Option<&mut ChildStdin>,
    logs: &broadcast::Sender<String>,
    phase: &Arc<Mutex<String>>,
) -> Result<()> {
    let file = server
        .parent()
        .context("Missing work directory")?
        .join("checkpoint.zip");
    *phase.lock().await = if stdin.is_some() {
        "checkpointing"
    } else {
        "stopping"
    }
    .into();
    if let Some(stdin) = stdin {
        command(stdin, logs, "save-off", "Automatic saving is now disabled").await?;
        let work = async {
            command(stdin, logs, "save-all flush", "Saved the game").await?;
            println!("NOMAD_CHECKPOINT_PACKING epoch={epoch}");
            let s = server.to_owned();
            let f = file.clone();
            tokio::task::spawn_blocking(move || snapshot_world(&s, &f)).await??;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let enabled = command(stdin, logs, "save-on", "Automatic saving is now enabled").await;
        work?;
        enabled?;
        println!(
            "NOMAD_CHECKPOINT_UPLOADING bytes={}",
            tokio::fs::metadata(&file).await?.len()
        );
        panel.upload(epoch, &file, false).await?;
    } else {
        let s = server.to_owned();
        let f = file.clone();
        tokio::task::spawn_blocking(move || snapshot_world(&s, &f)).await??;
        panel.upload(epoch, &file, true).await?;
    }
    if *phase.lock().await != "stopping" {
        *phase.lock().await = "ready".into();
    }
    println!("NOMAD_CHECKPOINT_COMMITTED epoch={epoch}");
    Ok(())
}
async fn heartbeat(panel: Panel, epoch: u64, phase: Arc<Mutex<String>>, stop: watch::Sender<bool>) {
    let mut deadline = Instant::now() + Duration::from_secs(80);
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let current = phase.lock().await.clone();
        match tokio::time::timeout(
            Duration::from_secs(10),
            panel.json("heartbeat", Some(epoch), json!({"phase":current})),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Heartbeat timed out")))
        {
            Ok(value) => {
                if value["stop"].as_bool() == Some(true) {
                    if !*stop.borrow() {
                        let _ = stop.send(true);
                    }
                }
                deadline = Instant::now() + Duration::from_secs(80);
            }
            Err(error) => {
                tracing::warn!("Heartbeat failed: {error}");
                if Instant::now() + Duration::from_secs(10) >= deadline {
                    let _ = stop.send(true);
                    return;
                }
            }
        }
    }
}
async fn tunnel_slot(
    panel: Panel,
    epoch: u64,
    local: std::net::SocketAddr,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    while !*stop.borrow() {
        let mut url = panel.url("tunnel", None)?;
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| anyhow::anyhow!("Invalid tunnel scheme"))?;
        let mut request = url.as_str().into_client_request()?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", panel.ticket.token).parse()?,
        );
        request
            .headers_mut()
            .insert("X-Nomad-Epoch", epoch.to_string().parse()?);
        match connect_async(request).await {
            Ok((socket, _)) => {
                let (mut sink, mut source) = socket.split();
                let announce =
                    tokio::select! {_ = stop.changed()=>None, message=source.next()=>message};
                if let Some(Ok(Message::Text(text))) = announce {
                    if serde_json::from_str::<Value>(&text)?["connect"] != true {
                        bail!("Unexpected tunnel frame");
                    }
                    let tcp = TcpStream::connect(local).await?;
                    let (mut read, mut write) = tcp.into_split();
                    let mut buf = [0u8; 65536];
                    loop {
                        tokio::select! {
                            _ = stop.changed()=>break,
                            data=read.read(&mut buf)=>{let n=data?;if n==0{break;}sink.send(Message::Binary(buf[..n].to_vec().into())).await?;}
                            data=source.next()=>{match data{Some(Ok(Message::Binary(bytes)))=>write.write_all(&bytes).await?,Some(Ok(Message::Ping(bytes)))=>sink.send(Message::Pong(bytes)).await?,Some(Ok(Message::Close(_)))|None=>break,Some(Err(error))=>return Err(error.into()),_=>{}}}
                        }
                    }
                }
                let _ = sink.close().await;
            }
            Err(error) => tracing::debug!("Tunnel reconnect: {error}"),
        }
        tokio::select! {_ = stop.changed()=>{},_ = tokio::time::sleep(Duration::from_millis(500))=>{}}
    }
    Ok(())
}
async fn stop_server(child: &mut Child, stdin: &mut ChildStdin) -> Result<()> {
    stdin.write_all(b"stop\n").await?;
    stdin.flush().await?;
    match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
        Ok(status) => {
            let status = status?;
            if !status.success() {
                bail!("Server exited unsuccessfully during stop: {status}; local world retained");
            }
            Ok(())
        }
        Err(_) => {
            child.kill().await?;
            bail!("Server did not stop cleanly; local world retained without committing")
        }
    }
}
pub async fn run_host(options: HostingOptions) -> Result<()> {
    let bytes = tokio::fs::read(&options.ticket_file).await?;
    let ticket: HostTicket = serde_json::from_slice(&bytes)?;
    ticket.validate()?;
    tokio::fs::remove_file(&options.ticket_file)
        .await
        .context("Could not consume single-use local ticket file")?;
    let panel = Panel::new(ticket)?;
    let claim = panel.json("claim", None, json!({})).await?;
    let epoch = claim["lease"]["epoch"]
        .as_u64()
        .context("Invalid host epoch")?;
    let (lease_stop, mut stop) = watch::channel(false);
    let phase = Arc::new(Mutex::new("starting".to_owned()));
    let heart = tokio::spawn(heartbeat(
        panel.clone(),
        epoch,
        phase.clone(),
        lease_stop.clone(),
    ));
    let result = run_claimed(&panel, epoch, &claim, &options, phase, &mut stop).await;
    let _ = lease_stop.send(true);
    heart.abort();
    result
}
async fn run_claimed(
    panel: &Panel,
    epoch: u64,
    claim: &Value,
    options: &HostingOptions,
    phase: Arc<Mutex<String>>,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    let session = options
        .data_dir
        .join("sessions")
        .join(format!("{}-{}", panel.ticket.grant_id, epoch));
    tokio::fs::create_dir_all(&session).await?;
    let server = session.join("server");
    let package = session.join("deployment.zip");
    panel
        .download("package", epoch, &package, 1024 * 1024 * 1024)
        .await?;
    let a = package.clone();
    let b = server.clone();
    tokio::task::spawn_blocking(move || extract_archive(&a, &b, false, 2 * 1024 * 1024 * 1024))
        .await??;
    let expected = claim["release"]["serverArtifact"]["sha256"].as_str();
    let expected1 = claim["release"]["serverArtifact"]["sha1"].as_str();
    if let Some(expected) = expected {
        let actual = file_hash(&server.join("server.jar"))?;
        if actual != expected {
            bail!("Server jar SHA256 mismatch");
        }
    }
    if let Some(expected) = expected1 {
        let mut input = File::open(server.join("server.jar"))?;
        let mut hash = sha1::Sha1::new();
        let mut chunk = [0u8; 65536];
        loop {
            let n = input.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            hash.update(&chunk[..n]);
        }
        if hex::encode(hash.finalize()) != expected {
            bail!("Server jar SHA1 mismatch");
        }
    }
    if expected.is_none() && expected1.is_none() {
        bail!("Server deployment has no source checksum");
    }
    let max_world = claim["worldLimits"]["maxBytes"]
        .as_u64()
        .unwrap_or(5 * 1024 * 1024 * 1024);
    let max_expanded = claim["worldLimits"]["maxExpandedBytes"]
        .as_u64()
        .unwrap_or(20 * 1024 * 1024 * 1024);
    let restore = session.join("restore.zip");
    if panel
        .download("restore", epoch, &restore, max_world)
        .await?
        .is_some()
    {
        let a = restore.clone();
        let b = server.clone();
        tokio::task::spawn_blocking(move || extract_archive(&a, &b, true, max_expanded)).await??;
        println!("NOMAD_WORLD_RESTORED epoch={epoch}");
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local = listener.local_addr()?;
    drop(listener);
    let properties = tokio::fs::read_to_string(server.join("server.properties")).await?;
    let filtered = properties
        .lines()
        .filter(|l| !l.starts_with("server-port=") && !l.starts_with("server-ip="))
        .collect::<Vec<_>>()
        .join("\n");
    tokio::fs::write(
        server.join("server.properties"),
        format!(
            "{filtered}\nserver-port={}\nserver-ip=127.0.0.1\n",
            local.port()
        ),
    )
    .await?;
    let memory = claim["release"]["server"]["memoryMb"]
        .as_u64()
        .context("Missing memory requirement")?;
    let args = claim["release"]["server"]["jvmArgs"].as_str().unwrap_or("");
    let extra = shlex::split(args).context("Unbalanced JVM arguments")?;
    if extra.iter().any(|v| {
        v.starts_with('@') || v.starts_with("-javaagent") || v == "-jar" || v.starts_with("-agent")
    }) {
        bail!("Disallowed JVM arguments");
    }
    if *stop.borrow() {
        bail!("Hosting lease stopped before server launch");
    }
    let mut child = Command::new(&options.java)
        .args([
            format!("-Xmx{memory}M"),
            format!("-Xms{}M", memory.min(512)),
        ])
        .args(extra)
        .args(["-jar", "server.jar", "nogui"])
        .current_dir(&server)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Could not launch Java server")?;
    println!(
        "NOMAD_GAME_PID {}",
        child.id().context("Missing Java process id")?
    );
    let mut stdin = child.stdin.take().context("Missing server stdin")?;
    let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (logs, _) = broadcast::channel::<String>(1024);
    let out = logs.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[minecraft] {line}");
            let _ = out.send(line);
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[minecraft] {line}");
        }
    });
    let mut ready = logs.subscribe();
    let mut tunnels = Vec::new();
    let outcome=async{
        let timeout=tokio::time::sleep(Duration::from_secs(180));tokio::pin!(timeout);
        loop{tokio::select!{
            _=&mut timeout=>bail!("Server readiness timed out"),
            _=stop.changed()=>bail!("Hosting cancelled during startup"),
            status=child.wait()=>{bail!("Java exited before ready: {}",status?);}
            line=ready.recv()=>{if let Ok(line)=line{if line.contains("Done (")&&line.contains("For help"){break;}}}
        }}
        *phase.lock().await="ready".into();let announcement=panel.json("ready",Some(epoch),json!({})).await?;
        println!("NOMAD_READY {}",announcement["joinAddress"].as_str().unwrap_or(""));
        for _ in 0..8{let p=panel.clone();let receiver=stop.clone();tunnels.push(tokio::spawn(async move{loop{match tunnel_slot(p.clone(),epoch,local,receiver.clone()).await{Ok(())=>break,Err(error)=>{tracing::warn!("Tunnel disconnected: {error}");tokio::time::sleep(Duration::from_secs(1)).await;}}}}));}
        let mut cadence=tokio::time::interval(Duration::from_secs(options.checkpoint_seconds.max(15)));cadence.tick().await;
        loop{tokio::select!{
            _=tokio::signal::ctrl_c()=>break,
            _=stop.changed()=>break,
            _=cadence.tick()=>{if options.stop_file.as_ref().is_some_and(|f|f.exists()){break;}checkpoint(panel,epoch,&server,Some(&mut stdin),&logs,&phase).await?;}
            status=child.wait()=>{bail!("Minecraft exited unexpectedly: {}",status?);}
            _=tokio::time::sleep(Duration::from_secs(1))=>{if options.stop_file.as_ref().is_some_and(|f|f.exists()){break;}}
        }}
        Ok::<_,anyhow::Error>(())
    }.await;
    *phase.lock().await = "stopping".into();
    let stopped = if child.try_wait()?.is_none() {
        stop_server(&mut child, &mut stdin).await
    } else {
        Err(anyhow::anyhow!(
            "Minecraft exited unexpectedly; retaining local world without a clean final commit"
        ))
    };
    for task in tunnels {
        task.abort();
    }
    stdout_task.abort();
    stderr_task.abort();
    stopped?;
    // Always retain checkpoint.zip and the local world if upload fails; do not claim a clean release.
    checkpoint(panel, epoch, &server, None, &logs, &phase).await?;
    panel
        .json("finish", Some(epoch), json!({"clean":true}))
        .await?;
    println!("NOMAD_STOPPED epoch={epoch} final_world_committed=true");
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn tickets_require_tls_remote_and_never_accept_credentials() {
        let id = uuid::Uuid::new_v4().to_string();
        let token = "a".repeat(64);
        for panel in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?x=1",
        ] {
            assert!(HostTicket {
                panel: panel.into(),
                grant_id: id.clone(),
                token: token.clone()
            }
            .validate()
            .is_err());
        }
        assert!(HostTicket {
            panel: "http://127.0.0.1:23333/community".into(),
            grant_id: id,
            token
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn archive_paths_reject_cross_scope_and_windows_aliases() {
        for path in [
            "../x",
            "/world/x",
            "world/../ops.json",
            "world\\x",
            "world/x:stream",
            "world/CON",
            "world/a.",
        ] {
            assert!(checked_zip_path(path).is_err(), "{path}");
        }
        assert!(checked_zip_path("world/region/r.0.0.mca").is_ok());
    }
    #[test]
    fn world_round_trip_preserves_bytes_and_excludes_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("server");
        std::fs::create_dir_all(source.join("world/region")).unwrap();
        std::fs::write(source.join("world/level.dat"), b"level").unwrap();
        std::fs::write(source.join("world/region/r.0.0.mca"), b"region").unwrap();
        std::fs::write(source.join("world/session.lock"), b"lock").unwrap();
        std::fs::write(source.join("ops.json"), b"admin").unwrap();
        let archive = tmp.path().join("world.zip");
        snapshot_world(&source, &archive).unwrap();
        let target = tmp.path().join("restored");
        extract_archive(&archive, &target, true, 1024).unwrap();
        assert_eq!(
            std::fs::read(target.join("world/level.dat")).unwrap(),
            b"level"
        );
        assert!(!target.join("ops.json").exists());
        assert!(!target.join("world/session.lock").exists());
    }
    #[test]
    fn world_archive_cannot_overwrite_cloud_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("bad.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("ops.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"[]").unwrap();
        zip.finish().unwrap();
        assert!(extract_archive(&archive, &tmp.path().join("target"), true, 1024).is_err());
    }
}
