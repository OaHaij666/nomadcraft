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
    io::{AsyncReadExt, AsyncWriteExt},
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
        let bytes = r.bytes().await.context("Cannot read panel response")?;
        if bytes.len() > 1024 * 1024 { bail!("Panel response exceeds limit"); }
        let envelope = serde_json::from_slice::<Value>(&bytes);
        if !status.is_success() {
            let reason = match &envelope {
                Ok(value) => value.get("data").unwrap_or(value).to_string(),
                Err(_) => String::from_utf8_lossy(&bytes).chars().take(512).collect(),
            };
            bail!("Panel {} refused ({}) {}", action, status, reason);
        }
        let envelope = envelope.context("Invalid panel response")?;
        if envelope["status"] != 200 {
            bail!("Panel {} refused ({}) {}", action, status, envelope["data"]);
        }
        Ok(envelope["data"].clone())
    }
    async fn download(&self, action: &str, epoch: u64, path: &Path, max: u64) -> Result<Option<String>> {
        self.download_query(action, epoch, path, max, std::iter::empty::<(&str, &str)>()).await
    }
    async fn download_query<I, K, V>(&self, action: &str, epoch: u64, path: &Path, max: u64, query: I) -> Result<Option<String>>
    where I: IntoIterator<Item=(K,V)>, K: AsRef<str>, V: AsRef<str> {
        let mut url = self.url(action, Some(epoch))?;
        for (key, value) in query { url.query_pairs_mut().append_pair(key.as_ref(), value.as_ref()); }
        let mut r = self.client.get(url).bearer_auth(&self.ticket.token).send().await.context("Panel download failed")?;
        if r.status() == 204 { return Ok(None); }
        if !r.status().is_success() { bail!("Panel download {} refused ({})", action, r.status()); }
        let expected = r.headers().get("x-nomad-sha256").and_then(|h| h.to_str().ok()).map(str::to_owned);
        let mut file = tokio::fs::File::create(path).await?;
        let mut hash = Sha256::new(); let mut size = 0;
        while let Some(chunk) = r.chunk().await? {
            size += chunk.len() as u64;
            if size > max { bail!("Download exceeds cloud limit"); }
            hash.update(&chunk); file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        let actual = hex::encode(hash.finalize());
        if expected.as_ref().is_some_and(|e| *e != actual) { bail!("Download SHA256 mismatch"); }
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
    let mut managed = std::collections::HashMap::new();
    if !world {
        if let Ok(mut meta) = zip.by_name("nomad-server.json") {
            if meta.size() > 2 * 1024 * 1024 { bail!("Deployment manifest too large"); }
            let mut bytes = Vec::new(); std::io::Read::read_to_end(&mut meta, &mut bytes)?;
            let data: Value = serde_json::from_slice(&bytes)?;
            if let Some(files) = data["managedFiles"].as_array() {
                for f in files {
                    let name = f["path"].as_str().context("Missing managed path")?;
                    checked_zip_path(name)?;
                    let top = name.split('/').next().unwrap_or("");
                    if name != "vanillacord.txt" && !["mods", "config", "defaultconfigs", "kubejs", "scripts", "datapacks"].contains(&top) { bail!("Unexpected managed deployment root"); }
                    let hash = f["sha256"].as_str().context("Missing managed digest")?;
                    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) { bail!("Invalid managed digest"); }
                    if managed.insert(name.to_string(), (hash.to_string(), f["size"].as_u64().context("Missing managed size")?)).is_some() { bail!("Duplicate managed deployment file"); }
                }
            }
        }
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
            && !managed.contains_key(entry.name())
            && !matches!(
                entry.name(),
                "server.jar"
                    | "server-forwarded.jar"
                    | "installer.jar"
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
    for (name, (digest, size)) in managed {
        let file = target.join(name);
        if std::fs::metadata(&file)?.len() != size || file_hash(&file)? != digest { bail!("Managed server file checksum mismatch"); }
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
    ready: std::sync::Arc<tokio::sync::Notify>,
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
                ready.notify_one();
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
fn has_ysm_mod(directory: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(directory.join("mods")) else { return false; };
    for entry in entries.flatten() {
        let file = entry.path();
        if file.extension().and_then(|e|e.to_str()) != Some("jar") { continue; }
        let Ok(stream) = File::open(&file) else { continue; };
        let Ok(mut archive) = ZipArchive::new(stream) else { continue; };
        for name in ["fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"] {
            let Ok(mut metadata) = archive.by_name(name) else { continue; };
            if metadata.size() > 1024*1024 { continue; }
            let mut text = String::new();
            if metadata.read_to_string(&mut text).is_err() { continue; }
            if name.ends_with("json") {
                if serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).is_ok_and(|v|matches!(v["id"].as_str(),Some("yes_steve_model"|"ysm"))) { return true; }
            } else {
                let compact: String = text.chars().filter(|c|!c.is_whitespace()).collect();
                if compact.contains("modId=\"yes_steve_model\"") || compact.contains("modId=\"ysm\"") { return true; }
            }
        }
    }
    false
}

/// Approved resources only. Model reload is requested through server stdin, never player OP.

#[derive(Deserialize)]
struct BotAdapterDiscovery { protocol:u32, port:u16, token:String }
struct BotJobs(Vec<tokio::task::JoinHandle<()>>);
impl Drop for BotJobs {fn drop(&mut self){for job in &self.0{job.abort();}}}
async fn install_bot_adapter(panel:&Panel,epoch:u64,directory:&Path,release:&Value)->Result<()> {
    let status=panel.json("bots/poll",Some(epoch),json!({"ready":false,"roster":[]})).await?;
    if status["policy"]["enabled"]!=true{return Ok(());}
    let Some(target)=crate::numen_targets::target_for(release) else { tracing::warn!(minecraft=%release["profile"]["mcVersion"], loader=%release["server"]["type"], "Numen adapter target is outside the supported matrix"); return Ok(()); };
    let mut supported=false;
    if let Ok(entries)=std::fs::read_dir(directory.join("mods")) {
        for entry in entries.flatten() {
            let path=entry.path();
            let Ok(meta)=std::fs::symlink_metadata(&path) else { continue; };
            if !meta.is_file() || meta.file_type().is_symlink() || path.extension().and_then(|x|x.to_str())!=Some("jar") { continue; }
            if file_hash(&path)?==target.numen_sha256 { supported=true;break; }
        }
    }
    if !supported{tracing::warn!(target=%target.id, "The matching upstream Numen release must be included in this cloud server release before enabling server bots");return Ok(());}
    let file=directory.join("mods").join(crate::numen_targets::adapter_file_name(target));
    if file.exists() {
        let relative=format!("mods/{}",crate::numen_targets::adapter_file_name(target));
        if let Some(expected)=release["manifest"]["files"].as_array().and_then(|files|files.iter().find(|entry|entry["path"].as_str()==Some(&relative))) {
            let expected_hash=expected["sha256"].as_str().context("Missing pinned adapter digest")?;
            if file_hash(&file)?!=expected_hash { bail!("Pinned Numen adapter digest mismatch"); }
            println!("NOMAD_NUMEN_ADAPTER_READY source=pinned_release");
            return Ok(());
        }
    }
    let temporary=file.with_extension("jar.nomad-part");
    let received=panel.download_query("bots/adapter",epoch,&temporary,1024*1024,[("target",target.id)]).await?;if received.is_none(){let _=tokio::fs::remove_file(&temporary).await;return Ok(());}
    if file.exists(){if file_hash(&file)?!=file_hash(&temporary)?{let _=tokio::fs::remove_file(&temporary).await;bail!("Existing Numen adapter differs from the control-plane package");}tokio::fs::remove_file(&temporary).await?;}else{tokio::fs::rename(&temporary,&file).await?;}println!("NOMAD_NUMEN_ADAPTER_READY");Ok(())
}
async fn adapter_request(client:&Client, discovery:&BotAdapterDiscovery, action:&str, args:Value, request_id:Option<&str>)->Result<Value>{
    let response=client.post(format!("http://127.0.0.1:{}/nomad/bots",discovery.port)).header("X-Nomad-Token",&discovery.token).json(&json!({"action":action,"args":args,"requestId":request_id.unwrap_or("policy")})).send().await?;
    if !response.status().is_success(){bail!("Numen adapter request rejected");}
    let bytes=response.bytes().await?;if bytes.len()>1024*1024{bail!("Numen receipt too large");}
    let result:Value=serde_json::from_slice(&bytes)?;if result["ok"]!=true{bail!("Numen adapter operation failed");}Ok(result["result"].clone())
}
async fn poll_bots(panel:&Panel, epoch:u64, directory:&Path, jobs:&mut Vec<tokio::task::JoinHandle<()>>, last_policy:&mut Value, links:&mut Value)->Result<()> {
    jobs.retain(|job|!job.is_finished());
    let file=directory.join(".nomad-numen-adapter.json");
    let discovery=if file.exists(){let meta=tokio::fs::symlink_metadata(&file).await?;if meta.file_type().is_symlink()||meta.len()>4096{bail!("Invalid bot adapter discovery");}let parsed:BotAdapterDiscovery=serde_json::from_slice(&tokio::fs::read(&file).await?)?;if parsed.protocol!=1||parsed.port==0||parsed.token.len()!=64||!parsed.token.bytes().all(|b|b.is_ascii_hexdigit()){bail!("Invalid bot adapter discovery");}Some(parsed)}else{None};
    let client=Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(115)).build()?;
    let mut report=json!({"ready":false,"links":links.clone(),"roster":[]});
    if let Some(ref d)=discovery {if let Ok(value)=tokio::time::timeout(Duration::from_secs(5),adapter_request(&client,d,"policy",last_policy.clone(),None)).await{if let Ok(value)=value{let mut pending=links.as_array().cloned().unwrap_or_default();if let Some(fresh)=value["links"].as_array(){pending.extend(fresh.iter().cloned());}*links=Value::Array(pending);report=value;report["links"]=links.clone();}}}
    let reply=panel.json("bots/poll",Some(epoch),report).await?;
    *links=json!([]);*last_policy=reply["policy"].clone();
    if let Some(discovery)=discovery {
        let state=tokio::time::timeout(Duration::from_secs(5),adapter_request(&client,&discovery,"policy",last_policy.clone(),None)).await??;
        *links=state["links"].clone();
        if let Some(list)=reply["jobs"].as_array(){for job in list.iter().take(10){if jobs.len()>=100{bail!("Bot adapter jobs full");}let id=job["id"].as_str().context("Missing bot job id")?.to_owned();let action=job["action"].as_str().context("Missing bot action")?.to_owned();let args=job["args"].clone();let local_client=client.clone();let d=BotAdapterDiscovery{protocol:discovery.protocol,port:discovery.port,token:discovery.token.clone()};let control=panel.clone();jobs.push(tokio::spawn(async move{
            let result=adapter_request(&local_client,&d,&action,args,Some(&id)).await;
            let receipt=match result{Ok(value)=>json!({"ok":true,"result":value}),Err(_)=>json!({"ok":false,"error":"adapter_operation_failed"})};
            if control.json(&format!("bots/{id}/receipt"),Some(epoch),receipt).await.is_err(){tracing::warn!("Bot receipt expired or host lease changed");}
        }));}}
    }
    Ok(())
}
fn ysm_reload_busy(line:&str)->bool{line.contains("another reloading task in progress")||line.contains("重载任务正在")||line.contains("重载任务进行")||line.contains("另一个重载任务") }
async fn deploy_models(panel: &Panel, epoch: u64, directory: &Path, stdin: &mut ChildStdin, applied: &mut HashSet<String>, logs: Option<&broadcast::Sender<String>>) -> Result<()> {
    let applications = panel.json("models", Some(epoch), json!({})).await?;
    for application in applications.as_array().context("Invalid approved model list")? {
        let id = application["id"].as_str().context("Missing model application id")?;
        uuid::Uuid::parse_str(id)?;
        if applied.contains(id) { continue; }
        let result = async {
            if !has_ysm_mod(directory) { bail!("YSM mod is not installed in this server runtime"); }
            let files = application["manifest"]["files"].as_array().context("Missing model files")?;
            if files.len() > 6000 { bail!("Too many model files"); }
            let mut size = 0u64;
            let mut staged = Vec::new();
            for file in files {
                let name = file["path"].as_str().context("Missing model path")?;
                if !name.starts_with("config/yes_steve_model/custom/") { bail!("Model path outside custom directory"); }
                let relative = checked_zip_path(name)?;
                let digest = file["sha256"].as_str().context("Missing model checksum")?;
                if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) { bail!("Invalid model checksum"); }
                let length = file["size"].as_u64().context("Missing model length")?;
                size = size.checked_add(length).context("Model length overflow")?;
                if length > 128*1024*1024 || size > 256*1024*1024 { bail!("Model exceeds resource limit"); }
                let dest = directory.join(relative);
                let mut ancestor = directory.to_path_buf();
                for component in checked_zip_path(name)?.components() {
                    ancestor.push(component);
                    if std::fs::symlink_metadata(&ancestor).is_ok_and(|s| s.file_type().is_symlink()) { bail!("Model path contains symlink"); }
                }
                if dest.exists() {
                    if !dest.is_file() || std::fs::metadata(&dest)?.len() != length || file_hash(&dest)? != digest { bail!("Existing YSM resource conflict: {name}"); }
                    continue;
                }
                tokio::fs::create_dir_all(dest.parent().context("Invalid model parent")?).await?;
                let temporary = dest.with_extension(format!("nc-{}-part", uuid::Uuid::new_v4()));
                let received = panel.download(&format!("models/{id}/{digest}"), epoch, &temporary, length).await;
                let verified = match received { Ok(Some(hash)) => hash == digest && tokio::fs::metadata(&temporary).await?.len() == length, _ => false };
                if !verified { let _ = tokio::fs::remove_file(&temporary).await; bail!("Model download validation failed"); }
                staged.push((temporary,dest));
            }
            for (temporary,dest) in staged {
                if dest.exists() { let _ = tokio::fs::remove_file(temporary).await; bail!("Model destination changed during deployment"); }
                tokio::fs::rename(temporary,dest).await?;
            }
            let mut reply=logs.map(|sender|sender.subscribe());
            stdin.write_all(b"ysm model reload\n").await?; stdin.flush().await?;
            if let Some(receiver)=reply.as_mut(){let deadline=tokio::time::Instant::now()+Duration::from_secs(3);loop{match tokio::time::timeout_at(deadline,receiver.recv()).await{Ok(Ok(line))=>{if ysm_reload_busy(&line){bail!("YSM_RELOAD_BUSY_RETRY");}if line.contains("Starting to reload")||line.contains("All models have been reloaded")||line.contains("重载完成"){break;}},_=>break,}}}
            println!("NOMAD_YSM_RELOAD_REQUESTED application={id}");
            Ok::<_,anyhow::Error>(())
        }.await;
        let retry_busy=result.as_ref().err().is_some_and(|error|error.to_string()=="YSM_RELOAD_BUSY_RETRY");
        let state = if result.is_ok() || retry_busy { "reload-requested" } else { "failed" };
        if let Err(error) = result { eprintln!("YSM model deployment failed: {error}"); }
        panel.json(&format!("models/{id}/receipt"),Some(epoch),json!({"state":state})).await?;
        // Failed applications are explicit; retry on a new hosting session rather than spam every tick.
        if !retry_busy { applied.insert(id.to_owned()); }
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
    let max_world = claim["worldLimits"]["maxBytes"]
        .as_u64()
        .unwrap_or(5 * 1024 * 1024 * 1024);
    let max_expanded = claim["worldLimits"]["maxExpandedBytes"]
        .as_u64()
        .unwrap_or(20 * 1024 * 1024 * 1024);
    let package = session.join("deployment.zip");
    panel
        .download("package", epoch, &package, max_world)
        .await?;
    let a = package.clone();
    let b = server.clone();
    tokio::task::spawn_blocking(move || extract_archive(&a, &b, false, max_expanded))
        .await??;
    let deployment: Value = serde_json::from_slice(&tokio::fs::read(server.join("nomad-server.json")).await?)?;
    let artifact_name = crate::loader_runtime::artifact_name(&claim["release"])?;
    if deployment["artifact"]["url"] != claim["release"]["serverArtifact"]["url"] || deployment["artifact"]["fileName"] != artifact_name || deployment["releaseId"] != claim["release"]["id"] { bail!("Deployment runtime does not match the pinned release"); }
    let expected = claim["release"]["serverArtifact"]["sha256"].as_str().or_else(||deployment["artifact"]["sha256"].as_str());
    let expected1 = claim["release"]["serverArtifact"]["sha1"].as_str();
    if let Some(expected) = expected {
        let actual = file_hash(&server.join(artifact_name))?;
        if actual != expected {
            bail!("Server jar SHA256 mismatch");
        }
    }
    if let Some(expected) = expected1 {
        let mut input = File::open(server.join(artifact_name))?;
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
    install_bot_adapter(panel,epoch,&server,&claim["release"]).await?;
    let mut policy = Vec::new();
    for name in ["server.properties", "eula.txt", "user_jvm_args.txt", "whitelist.json", "ops.json", "banned-players.json"] { policy.push((name, tokio::fs::read(server.join(name)).await?)); }
    let default_launch_args = crate::loader_runtime::prepare_runtime(&options.java, &server, &claim["release"], stop, options.stop_file.as_deref()).await?;
    let launch_args = crate::loader_runtime::forwarded_launch(&server, &claim["release"], &deployment)?.unwrap_or(default_launch_args);
    if claim["release"]["server"]["type"] == "vanilla" && !deployment["gateway"].is_null() && deployment["forwardingRuntime"].is_null() { bail!("Vanilla gateway deployment requires authenticated forwarding runtime"); }
    for (name, bytes) in policy { tokio::fs::write(server.join(name), bytes).await?; }
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
        .args(launch_args)
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
        if let Err(error) = crate::java_output::drain(stdout, |line| {
            println!("[minecraft] {line}");
            let _ = out.send(line);
        }).await { tracing::warn!("Minecraft stdout read failed: {error}"); }
    });
    let stderr_task = tokio::spawn(async move {
        if let Err(error) = crate::java_output::drain(stderr, |line| {
            eprintln!("[minecraft] {line}");
        }).await { tracing::warn!("Minecraft stderr read failed: {error}"); }
    });
    let mut ready = logs.subscribe();
    let mut tunnels = Vec::new();
    // Keep proxy traffic flowing until Minecraft has sent its normal shutdown kick.
    let (tunnel_stop, tunnel_receiver) = watch::channel(false);
    let outcome=async{
        let timeout=tokio::time::sleep(Duration::from_secs(180));tokio::pin!(timeout);
        loop{tokio::select!{
            _=&mut timeout=>bail!("Server readiness timed out"),
            _=stop.changed()=>bail!("Hosting cancelled during startup"),
            status=child.wait()=>{bail!("Java exited before ready: {}",status?);}
            line=ready.recv()=>{if let Ok(line)=line{if line.contains("Done (")&&line.contains("For help"){break;}}}
        }}
        panel.json("relay",Some(epoch),json!({})).await?;
        let tunnel_ready=std::sync::Arc::new(tokio::sync::Notify::new());
        for _ in 0..8{
            let p=panel.clone();let receiver=tunnel_receiver.clone();let ready=tunnel_ready.clone();
            tunnels.push(tokio::spawn(async move{
                loop {match tunnel_slot(p.clone(),epoch,local,receiver.clone(),ready.clone()).await{
                    Ok(())=>break,
                    Err(error)=>{tracing::warn!("Tunnel disconnected: {error}");if *receiver.borrow(){break;}tokio::time::sleep(Duration::from_secs(1)).await;}
                }}
            }));
        }
        tokio::select!{
            _=stop.changed()=>bail!("Hosting cancelled before tunnel readiness"),
            status=child.wait()=>bail!("Minecraft exited before tunnel readiness: {}",status?),
            result=tokio::time::timeout(Duration::from_secs(30),tunnel_ready.notified())=>{result.context("Game tunnel readiness timed out")?;}
        }
        let announcement=panel.json("ready",Some(epoch),json!({})).await?;
        *phase.lock().await="ready".into();
        println!("NOMAD_READY {}",announcement["joinAddress"].as_str().unwrap_or(""));
        let mut models_applied=HashSet::new();
        let mut model_cadence=tokio::time::interval(Duration::from_secs(15));
        let mut bot_cadence=tokio::time::interval(Duration::from_secs(2));
        let mut bot_jobs=BotJobs(Vec::new());let mut bot_policy=json!({"enabled":false,"bots":[]});let mut bot_links=json!([]);
        let mut cadence=tokio::time::interval(Duration::from_secs(options.checkpoint_seconds.max(15)));cadence.tick().await;
        loop{tokio::select!{
            _=tokio::signal::ctrl_c()=>break,
            _=stop.changed()=>break,
            _=bot_cadence.tick()=>{let result=tokio::select!{_=stop.changed()=>break,status=child.wait()=>{bail!("Minecraft exited during bot poll: {}",status?);},result=poll_bots(panel,epoch,&server,&mut bot_jobs.0,&mut bot_policy,&mut bot_links)=>result};if let Err(error)=result{tracing::warn!("Bot adapter poll failed: {error}");}}
            _=model_cadence.tick()=>{let result=tokio::select!{_=stop.changed()=>break,status=child.wait()=>{bail!("Minecraft exited during model deployment: {}",status?);},result=deploy_models(panel,epoch,&server,&mut stdin,&mut models_applied,Some(&logs))=>result};if let Err(error)=result{eprintln!("Model deployment poll failed: {error}");}}
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
    let _ = tunnel_stop.send(true);
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
    #[tokio::test]
    async fn plain_panel_errors_keep_the_actionable_failure_reason() {
        use axum::{routing::post, Router, http::StatusCode};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let app=Router::new().fallback(post(||async{(StatusCode::CONFLICT,"hosting_tunnel_not_ready")}));
        let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap(); });
        let panel=Panel::new(HostTicket{panel:format!("http://{address}"),grant_id:uuid::Uuid::new_v4().to_string(),token:"a".repeat(64)}).unwrap();
        let error=panel.json("ready",Some(1),json!({})).await.unwrap_err().to_string();
        assert!(error.contains("hosting_tunnel_not_ready"));
        assert!(error.contains("409"));
        assert!(!error.contains(&panel.ticket.token));
        server.abort();
    }
    #[test]
    fn busy_ysm_reload_is_retryable_not_success(){assert!(ysm_reload_busy("§eThere is one another reloading task in progress."));assert!(!ysm_reload_busy("All models have been reloaded"));}
    #[test]
    fn ysm_detection_uses_mod_metadata_not_the_filename() {
        let tmp=tempfile::tempdir().unwrap();std::fs::create_dir(tmp.path().join("mods")).unwrap();
        std::fs::write(tmp.path().join("mods/ysm.jar"),b"not a mod").unwrap();assert!(!has_ysm_mod(tmp.path()));
        let mut zip=ZipWriter::new(File::create(tmp.path().join("mods/renamed.jar")).unwrap());
        zip.start_file("fabric.mod.json",SimpleFileOptions::default()).unwrap();zip.write_all(br#"{"id":"yes_steve_model","version":"fixture"}"#).unwrap();zip.finish().unwrap();
        assert!(has_ysm_mod(tmp.path()));
    }
    #[test]
    fn ysm_detection_accepts_released_fabric_metadata_bom() {
        let tmp=tempfile::tempdir().unwrap();std::fs::create_dir(tmp.path().join("mods")).unwrap();
        let mut zip=ZipWriter::new(File::create(tmp.path().join("mods/renamed.jar")).unwrap());
        zip.start_file("fabric.mod.json",SimpleFileOptions::default()).unwrap();
        zip.write_all("\u{feff}{\"id\":\"yes_steve_model\",\"version\":\"fixture\"}".as_bytes()).unwrap();zip.finish().unwrap();
        assert!(has_ysm_mod(tmp.path()));
    }
    #[tokio::test]
    async fn approved_model_bytes_are_checked_and_reload_goes_to_server_stdin() {
        use axum::{routing::{get,post},Json,Router};
        let tmp=tempfile::tempdir().unwrap();std::fs::create_dir(tmp.path().join("mods")).unwrap();
        let mut zip=ZipWriter::new(File::create(tmp.path().join("mods/fixture.jar")).unwrap());zip.start_file("fabric.mod.json",SimpleFileOptions::default()).unwrap();zip.write_all(br#"{"id":"yes_steve_model"}"#).unwrap();zip.finish().unwrap();
        let content=b"model bytes".to_vec();let digest=hex::encode(Sha256::digest(&content));let model_id=uuid::Uuid::new_v4().to_string();let grant=uuid::Uuid::new_v4().to_string();
        let manifest=json!({"id":model_id,"manifest":{"files":[{"path":"config/yes_steve_model/custom/test.ysm","sha256":digest,"size":content.len()}]}});
        let list=vec![manifest];let requested=Arc::new(std::sync::atomic::AtomicBool::new(false));let receipt=requested.clone();
        let blob=content.clone();let hash=digest.clone();
        let app=Router::new()
          .route(&format!("/api/nomad/hosting/agent/{grant}/models"),post(move||{let list=list.clone();async move{Json(json!({"status":200,"data":list}))}}))
          .route(&format!("/api/nomad/hosting/agent/{grant}/models/{model_id}/{digest}"),get(move||{let blob=blob.clone();let hash=hash.clone();async move{([("x-nomad-sha256",hash)],blob)}}))
          .route(&format!("/api/nomad/hosting/agent/{grant}/models/{model_id}/receipt"),post(move|Json(body):Json<Value>|{let receipt=receipt.clone();async move{receipt.store(body["state"]=="reload-requested",std::sync::atomic::Ordering::SeqCst);Json(json!({"status":200,"data":{}}))}}));
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
        let panel=Panel::new(HostTicket{panel:format!("http://{address}"),grant_id:grant,token:"a".repeat(64)}).unwrap();
        #[cfg(windows)] let mut command={let mut c=Command::new("powershell.exe");c.args(["-NoProfile","-NonInteractive","-Command","[Console]::ReadLine()"]);c};
        #[cfg(not(windows))] let mut command={let mut c=Command::new("/bin/sh");c.args(["-c","read line; printf '%s' \"$line\""]);c};
        let mut child=command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();let mut stdin=child.stdin.take().unwrap();let mut applied=HashSet::new();
        deploy_models(&panel,1,tmp.path(),&mut stdin,&mut applied,None).await.unwrap();drop(stdin);let output=child.wait_with_output().await.unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("ysm model reload"));assert_eq!(std::fs::read(tmp.path().join("config/yes_steve_model/custom/test.ysm")).unwrap(),content);assert!(requested.load(std::sync::atomic::Ordering::SeqCst));assert!(applied.contains(&model_id));server.abort();
    }
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
    #[test]
    fn manifested_server_files_require_declared_hashes() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("server.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("nomad-server.json", SimpleFileOptions::default()).unwrap();
        zip.write_all(serde_json::to_string(&json!({"managedFiles":[{"path":"config/example.txt","size":4,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]})).unwrap().as_bytes()).unwrap();
        zip.start_file("config/example.txt", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"test").unwrap();zip.finish().unwrap();
        assert!(extract_archive(&archive, &tmp.path().join("server"), false, 4096).is_err());
        let archive = tmp.path().join("undeclared.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("config/example.txt", SimpleFileOptions::default()).unwrap();zip.write_all(b"test").unwrap();zip.finish().unwrap();
        assert!(extract_archive(&archive, &tmp.path().join("other"), false, 4096).is_err());
    }

}
