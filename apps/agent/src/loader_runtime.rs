//! Launch only pinned official runtimes; generated shell scripts are never executed.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{path::Path, time::Duration, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tokio::{process::Command, sync::watch};

pub fn launch_arguments(release: &Value, windows: bool) -> Result<Vec<String>> {
    let runtime = &release["server"];
    let loader = runtime["type"].as_str().context("Missing server type")?;
    let version = runtime["version"].as_str().unwrap_or("");
    let mc = release["profile"]["mcVersion"].as_str().context("Missing Minecraft version")?;
    if !version.bytes().all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c)) || !mc.bytes().all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c)) || mc.is_empty() {
        bail!("Invalid pinned runtime version");
    }
    match loader {
        "vanilla" | "fabric" | "paper" => Ok(vec!["-jar".into(), "server.jar".into(), "nogui".into()]),
        "forge" | "neoforge" => {
            if version.is_empty() { bail!("Missing loader version"); }
            let id = if loader == "forge" || mc == "1.20.1" { "forge" } else { "neoforge" };
            let coordinate = if loader == "forge" { format!("{mc}-{version}") } else { version.to_owned() };
            let modern = mc.split('.').nth(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) >= 17 || mc.split('.').next().and_then(|s|s.parse::<u32>().ok()).unwrap_or(0) >= 26;
            if !modern {
                if loader != "forge" { bail!("Unsupported legacy NeoForge runtime"); }
                return Ok(vec!["-jar".into(), format!("forge-{coordinate}.jar"), "nogui".into()]);
            }
            let group = if loader == "forge" { "net/minecraftforge" } else { "net/neoforged" };
            let platform = if windows { "win" } else { "unix" };
            Ok(vec![format!("@libraries/{group}/{id}/{coordinate}/{platform}_args.txt"), "nogui".into()])
        }
        _ => bail!("Unsupported server loader: {loader}"),
    }
}

pub fn artifact_name(release: &Value) -> Result<&'static str> {
    match release["server"]["type"].as_str() {
        Some("forge" | "neoforge") => Ok("installer.jar"),
        Some("vanilla" | "fabric" | "paper") => Ok("server.jar"),
        _ => bail!("Unsupported server loader"),
    }
}

/// The Mojang source jar is verified separately; only this fixed, signed deployment output may replace launch input.
pub fn forwarded_launch(directory: &Path, release: &Value, deployment: &Value) -> Result<Option<Vec<String>>> {
    let Some(runtime) = deployment.get("forwardingRuntime").filter(|v| !v.is_null()) else { return Ok(None); };
    if release["server"]["type"] != "vanilla" || release["profile"]["loader"] != "vanilla" || !["1.20.1", "1.21.1"].contains(&release["profile"]["mcVersion"].as_str().unwrap_or("")) || deployment["gateway"].is_null() { bail!("Unexpected forwarded runtime"); }
    let filename = runtime["fileName"].as_str().context("Missing forwarded runtime name")?;
    if filename != "server-forwarded.jar" || runtime["sourceSha1"].as_str() != release["serverArtifact"]["sha1"].as_str() || runtime["sourceSha1"].as_str().is_none() { bail!("Forwarded runtime does not match official source"); }
    for key in ["sha256", "patcherSha256"] { let value=runtime[key].as_str().context("Missing forwarded checksum")?; if value.len()!=64 || !value.bytes().all(|c|c.is_ascii_hexdigit()) { bail!("Invalid forwarded checksum"); } }
    let file=directory.join(filename);let meta=std::fs::symlink_metadata(&file)?;
    if !meta.is_file() || meta.file_type().is_symlink() || Some(meta.len())!=runtime["size"].as_u64() || meta.len()==0 || crate::hosting::file_hash(&file)?!=runtime["sha256"].as_str().unwrap() { bail!("Forwarded runtime checksum mismatch"); }
    if deployment["managedFiles"].as_array().and_then(|files|files.iter().find(|f|f["path"]=="vanillacord.txt")).is_none() { bail!("Forwarded runtime configuration missing"); }
    println!("NOMAD_VANILLA_FORWARDING_READY source=verified_official");
    Ok(Some(vec!["-jar".into(),filename.into(),"nogui".into()]))
}

pub async fn prepare_runtime(java: &Path, directory: &Path, release: &Value, stop: &mut watch::Receiver<bool>, stop_file: Option<&Path>) -> Result<Vec<String>> {
    let args = launch_arguments(release, cfg!(windows))?;
    if artifact_name(release)? == "installer.jar" {
        let overall_deadline = tokio::time::Instant::now() + Duration::from_secs(900);
        for attempt in 1..=3 {
            if *stop.borrow() || stop_file.is_some_and(|p| p.exists()) { bail!("Hosting stopped before installation"); }
            println!("NOMAD_INSTALLING loader={} version={} attempt={}", release["server"]["type"], release["server"]["version"], attempt);
            let network = Arc::new(AtomicBool::new(false));
            let fatal = Arc::new(AtomicBool::new(false));
            let mut child = Command::new(java).args(["-jar", "installer.jar", "--installServer"]).current_dir(directory)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().context("Cannot start server installer")?;
            let stdout = child.stdout.take().context("Installer stdout missing")?;
            let stderr = child.stderr.take().context("Installer stderr missing")?;
            let out_network = network.clone(); let out_fatal = fatal.clone();
            let mut out = tokio::spawn(async move { if let Err(error)=crate::java_output::drain(stdout, |line| {
                note_installer_failure(&line, &out_network, &out_fatal);
                println!("[installer] {}", line.chars().take(2000).collect::<String>());
            }).await { tracing::warn!("Installer stdout read failed: {error}"); } });
            let err_network = network.clone(); let err_fatal = fatal.clone();
            let mut err = tokio::spawn(async move { if let Err(error)=crate::java_output::drain(stderr, |line| {
                note_installer_failure(&line, &err_network, &err_fatal);
                eprintln!("[installer] {}", line.chars().take(2000).collect::<String>());
            }).await { tracing::warn!("Installer stderr read failed: {error}"); } });
            let deadline = tokio::time::sleep_until(overall_deadline); tokio::pin!(deadline);
            let mut exited = false;
            let result: Result<()> = loop {
                tokio::select! {
                    status = child.wait() => { exited = true; break match status { Ok(status) if status.success() => Ok(()), Ok(status) => Err(anyhow::anyhow!("Server installer failed: {status}")), Err(error) => Err(error.into()) }; },
                    changed = stop.changed() => { if changed.is_err() || *stop.borrow() { break Err(anyhow::anyhow!("Hosting stopped during installation")); } },
                    _ = &mut deadline => { break Err(anyhow::anyhow!("Server installer timed out after 15 minutes")); },
                    _ = tokio::time::sleep(Duration::from_millis(300)) => { if *stop.borrow() || stop_file.is_some_and(|p|p.exists()) { break Err(anyhow::anyhow!("Hosting stopped during installation")); } },
                }
            };
            if result.is_err() { let _=child.kill().await; let _=child.wait().await; }
            // Drain final diagnostics before classifying the failed download; never leave readers behind.
            if tokio::time::timeout(Duration::from_secs(2), &mut out).await.is_err() { out.abort(); }
            if tokio::time::timeout(Duration::from_secs(2), &mut err).await.is_err() { err.abort(); }
            let cancelled = *stop.borrow() || stop_file.is_some_and(|p| p.exists());
            if result.is_err() && exited && retry_installer(attempt, network.load(Ordering::Relaxed), fatal.load(Ordering::Relaxed), cancelled, tokio::time::Instant::now() < overall_deadline) {
                // The original installer validates and reuses its partial Maven downloads in this same workspace.
                println!("NOMAD_INSTALL_RETRY attempt={} reason=network_download", attempt + 1);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(500 * attempt as u64)) => {},
                    changed = stop.changed() => { if changed.is_err() || *stop.borrow() { bail!("Hosting stopped during installer retry"); } },
                }
                continue;
            }
            result?;
            break;
        }
    }
    let output = if args[0] == "-jar" { &args[1] } else { args[0].strip_prefix('@').context("Invalid loader launch plan")? };
    let file = directory.join(output);
    let meta = tokio::fs::symlink_metadata(&file).await.context("Installer did not produce the expected launch file")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 { bail!("Invalid loader launch output"); }
    if *stop.borrow() || stop_file.is_some_and(|p|p.exists()) { bail!("Hosting stopped before launch"); }
    println!("NOMAD_RUNTIME_PREPARED loader={}", release["server"]["type"]);
    Ok(args)
}


fn note_installer_failure(line: &str, network: &AtomicBool, fatal: &AtomicBool) {
    let text = line.to_ascii_lowercase();
    if ["sockettimeoutexception", "connectexception", "unknownhostexception", "failed to establish connection", "connection reset"].iter().any(|hint| text.contains(hint)) { network.store(true, Ordering::Relaxed); }
    if ["unsupportedclassversionerror", "pkix path building failed", "certificateexception", "zipexception"].iter().any(|hint| text.contains(hint)) { fatal.store(true, Ordering::Relaxed); }
}
fn retry_installer(attempt: u32, network: bool, fatal: bool, cancelled: bool, time_left: bool) -> bool {
    attempt < 3 && network && !fatal && !cancelled && time_left
}

#[cfg(test)]
mod tests {
 use super::*;use serde_json::json;
 #[test] fn forwarded_runtime_is_fenced_to_official_source_and_separate_digest() {
  let dir=tempfile::tempdir().unwrap();let file=dir.path().join("server-forwarded.jar");std::fs::write(&file,b"derived").unwrap();
  let source="1".repeat(40);let release=json!({"server":{"type":"vanilla"},"profile":{"loader":"vanilla","mcVersion":"1.20.1"},"serverArtifact":{"sha1":source}});
  let deployment=json!({"gateway":{"id":"room"},"managedFiles":[{"path":"vanillacord.txt"}],"forwardingRuntime":{"fileName":"server-forwarded.jar","sourceSha1":source,"sha256":crate::hosting::file_hash(&file).unwrap(),"patcherSha256":"2".repeat(64),"size":7}});
  assert_eq!(forwarded_launch(dir.path(),&release,&deployment).unwrap().unwrap(),vec!["-jar","server-forwarded.jar","nogui"]);
  let mut wrong=deployment.clone();wrong["forwardingRuntime"]["sourceSha1"]=json!("3".repeat(40));assert!(forwarded_launch(dir.path(),&release,&wrong).is_err());
  let mut wrong=deployment.clone();wrong["forwardingRuntime"]["fileName"]=json!("../outside.jar");assert!(forwarded_launch(dir.path(),&release,&wrong).is_err());
  let mut wrong=release.clone();wrong["server"]["type"]=json!("fabric");assert!(forwarded_launch(dir.path(),&wrong,&deployment).is_err());
  std::fs::write(&file,b"changed").unwrap();assert!(forwarded_launch(dir.path(),&release,&deployment).is_err());
  assert!(forwarded_launch(dir.path(),&release,&json!({})).unwrap().is_none());
 }
 #[test] fn installer_retry_is_bounded_and_does_not_override_stop_or_integrity_failures() {
  assert!(retry_installer(1,true,false,false,true));assert!(retry_installer(2,true,false,false,true));
  for state in [(3,true,false,false,true),(1,false,false,false,true),(1,true,true,false,true),(1,true,false,true,true),(1,true,false,false,false)] { assert!(!retry_installer(state.0,state.1,state.2,state.3,state.4)); }
  let network=AtomicBool::new(false);let fatal=AtomicBool::new(false);
  note_installer_failure("java.net.SocketTimeoutException: Read timed out",&network,&fatal);assert!(network.load(Ordering::Relaxed));assert!(!fatal.load(Ordering::Relaxed));
  note_installer_failure("Caused by: PKIX path building failed",&network,&fatal);assert!(fatal.load(Ordering::Relaxed));
 }
 fn release(loader:&str,mc:&str,v:&str)->Value{json!({"server":{"type":loader,"version":v},"profile":{"mcVersion":mc}})}
 #[test] fn pinned_launch_paths_cover_platform_and_legacy(){
  assert_eq!(launch_arguments(&release("fabric","1.20.1","0.16.10"),true).unwrap(),vec!["-jar","server.jar","nogui"]);
  assert_eq!(launch_arguments(&release("forge","1.20.1","47.4.0"),true).unwrap()[0],"@libraries/net/minecraftforge/forge/1.20.1-47.4.0/win_args.txt");
  assert_eq!(launch_arguments(&release("neoforge","1.21.1","21.1.172"),false).unwrap()[0],"@libraries/net/neoforged/neoforge/21.1.172/unix_args.txt");
  assert_eq!(launch_arguments(&release("neoforge","1.20.1","47.1.106"),false).unwrap()[0],"@libraries/net/neoforged/forge/47.1.106/unix_args.txt");
  assert_eq!(launch_arguments(&release("forge","1.16.5","36.2.39"),true).unwrap()[1],"forge-1.16.5-36.2.39.jar");
 }
 #[test] fn rejects_unsafe_and_unsupported_versions(){for (loader,mc,v) in [("forge","1.20.1","../x"),("neoforge","1.21.1","21.1.1;bad"),("unknown","1.20.1","1")]{assert!(launch_arguments(&release(loader,mc,v),true).is_err());}}
}
