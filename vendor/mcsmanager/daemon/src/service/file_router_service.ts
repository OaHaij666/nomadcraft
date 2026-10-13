import {execFile} from "node:child_process";
import { $t } from "../i18n";
import InstanceSubsystem from "../service/system_instance";
import FileManager from "./system_file";
import os from "os";

export function getFileManager(instanceUuid: string) {
  // Initialize a file manager for the instance, and assign codes, restrictions, etc.
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  if (!instance)
    throw new Error($t("TXT_CODE_file_router_service.instanceNotExit", { uuid: instanceUuid }));
  const fileCode = instance.config?.fileCode;
  return new FileManager(instance.absoluteCwdPath(), fileCode);
}

let cacheDisks: string[] = [];
let diskScan: Promise<string[]> | undefined;
let scannedAt = 0;

/** A missing mapped drive must not block the daemon event loop or its other file requests. */
export async function getWindowsDisks(): Promise<string[]> {
  if (os.platform() !== "win32") return [];
  if (scannedAt && Date.now() - scannedAt < 5 * 60 * 1000) return [...cacheDisks];
  if (!diskScan) {
    // Native synchronous filesystem probes are isolated in our own short-lived helper.
    // execFile kills only this helper on timeout, retaining already reported local drives.
    const source = "const fs=require('node:fs');for(let i=65;i<=90;i++){const drive=String.fromCharCode(i);try{if(fs.existsSync(drive+':'+String.fromCharCode(92)))process.stdout.write(drive+'\\n');}catch{}}";
    diskScan = new Promise<string[]>(resolve => {
      execFile(process.execPath, ["--eval", source], {windowsHide:true, timeout:1000, maxBuffer:4096}, (_error, stdout) => {
        cacheDisks = [...new Set(String(stdout).split(/\r?\n/).filter(letter => /^[A-Z]$/.test(letter)))];
        scannedAt = Date.now();
        resolve([...cacheDisks]);
      });
    }).finally(() => { diskScan = undefined; });
  }
  return diskScan;
}
