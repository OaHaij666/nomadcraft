//! Persistent authenticated compute node. Server nodes do not need a game client.
use crate::hosting::{run_host, HostTicket, HostingOptions};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use sysinfo::System;
use tokio::task::JoinSet;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    panel: String,
    node_id: String,
    token: String,
}
pub struct WorkerOptions {
    pub credential_file: PathBuf,
    pub data_dir: PathBuf,
    pub java: PathBuf,
    pub checkpoint_seconds: u64,
    pub stop_file: Option<PathBuf>,
}
pub async fn run_worker(options: WorkerOptions) -> Result<()> {
    let credential: Credential =
        serde_json::from_slice(&tokio::fs::read(&options.credential_file).await?)?;
    let validator = HostTicket {
        panel: credential.panel.clone(),
        grant_id: credential.node_id.clone(),
        token: credential.token.clone(),
    };
    let base = validator.validate()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()?;
    let url = base.join(&format!(
        "api/nomad/hosting/nodes/{}/poll",
        credential.node_id
    ))?;
    tokio::fs::create_dir_all(&options.data_dir).await?;
    let mut system = System::new();
    let mut jobs = JoinSet::new();
    let mut stops: HashMap<String, PathBuf> = HashMap::new();
    let mut last_error = String::new();
    let mut authorization_lost = false;
    println!("NOMAD_NODE_RUNNING {}", credential.node_id);
    loop {
        tokio::select! {
         _=tokio::signal::ctrl_c()=>break,
         result=jobs.join_next(),if !jobs.is_empty()=>{if let Some(result)=result {match result {Ok((id,outcome))=>{stops.remove(&id);if let Err(error)=outcome {last_error=format!("{error:#}").chars().take(500).collect();eprintln!("NOMAD_NODE_TASK_FAILED {last_error}");}else{last_error.clear();}},Err(error)=>{last_error=format!("Worker task failed: {error}");}}}},
         _=tokio::time::sleep(Duration::from_secs(5))=>{
           if options.stop_file.as_ref().is_some_and(|file|file.exists()){break;}
           system.refresh_memory();let metrics=json!({"cpuCores":std::thread::available_parallelism().map(|v|v.get()).unwrap_or(1),"totalMemoryMb":(system.total_memory()/1048576).max(1),"availableMemoryMb":system.available_memory()/1048576});
           let response=match client.post(url.clone()).bearer_auth(&credential.token).json(&json!({"metrics":metrics,"lastError":last_error})).send().await {Ok(r)=>r,Err(error)=>{tracing::warn!("Compute poll unavailable: {}",error.without_url());continue;}};
           if response.status()==401||response.status()==403 {for stop in stops.values(){let _=tokio::fs::write(stop,b"stop").await;}authorization_lost=true;break;}
           if !response.status().is_success(){tracing::warn!("Compute poll refused ({})",response.status());continue;}
           let envelope:Value=response.json().await?;if envelope["status"]!=200{continue;}
           let assignment=&envelope["data"]["assignment"];if assignment.is_null(){continue;}
           let id=assignment["grantId"].as_str().context("Invalid assignment id")?.to_owned();uuid::Uuid::parse_str(&id)?;
           if stops.contains_key(&id){continue;}
           let ticket_file=options.data_dir.join(format!("{id}.ticket.json"));let stop_file=options.data_dir.join(format!("{id}.stop"));
           let ticket=HostTicket{panel:credential.panel.clone(),grant_id:id.clone(),token:assignment["token"].as_str().context("Missing task token")?.to_owned()};ticket.validate()?;
           tokio::fs::write(&ticket_file,serde_json::to_vec(&ticket)?).await?;
           #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;tokio::fs::set_permissions(&ticket_file,std::fs::Permissions::from_mode(0o600)).await?;}
           stops.insert(id.clone(),stop_file.clone());let opts=HostingOptions{ticket_file,data_dir:options.data_dir.clone(),java:options.java.clone(),checkpoint_seconds:options.checkpoint_seconds,stop_file:Some(stop_file)};
           println!("NOMAD_NODE_ASSIGNED {id}");jobs.spawn(async move{let result=run_host(opts).await;(id,result)});
         }
        }
    }
    for file in stops.values() {
        tokio::fs::write(file, b"stop").await?;
    }
    tokio::time::timeout(Duration::from_secs(660), async {
        while jobs.join_next().await.is_some() {}
    })
    .await
    .context("Node stop timed out; local worlds retained")?;
    println!("NOMAD_NODE_STOPPED");
    if authorization_lost {
        bail!("Compute node credential or owner is no longer authorized");
    }
    Ok(())
}
