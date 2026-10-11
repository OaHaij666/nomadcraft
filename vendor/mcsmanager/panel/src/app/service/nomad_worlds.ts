import {openNomadZip} from "./nomad_zip";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as yauzl from "yauzl";
import {v4 as uuid} from "uuid";
import {CatalogError} from "./nomad_catalog";
import {safePackagePath} from "./nomad_packages";
import {uploadPolicy} from "./nomad_policy";
export async function inspectWorldArchive(file:string) {
  const policy=uploadPolicy(),stat=await fs.promises.stat(file);
  if(stat.size>policy.maxBytes)throw new CatalogError(413,"package_too_large");
  await new Promise<void>((resolve,reject)=>{
    openNomadZip(file,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
      if(error||!zip){reject(new CatalogError(400,"invalid_world_archive"));return;}
      const paths=new Set<string>();let expanded=0,level=false,done=false;
      const abort=(error:unknown)=>{if(!done){done=true;zip.close();reject(error);}};
      zip.on("error",()=>abort(new CatalogError(400,"invalid_world_archive")));
      zip.on("entry",(entry:yauzl.Entry)=>{
        try{
          safePackagePath(entry.fileName);
          const type=(entry.externalFileAttributes>>>16)&0xf000;
          if(!entry.fileName.startsWith("world/") || paths.has(entry.fileName.toLowerCase()) || (entry.generalPurposeBitFlag&1) || (type!==0&&type!==0x8000&&type!==0x4000))throw new CatalogError(400,"invalid_world_archive");
          paths.add(entry.fileName.toLowerCase());expanded+=entry.uncompressedSize;
          if(paths.size>50000 || expanded>policy.maxExpandedBytes)throw new CatalogError(413,"package_too_large");
          if(entry.fileName==="world/level.dat" && entry.uncompressedSize>0)level=true;
          if(entry.fileName.endsWith("/")){zip.readEntry();return;}
          zip.openReadStream(entry,(err,stream)=>{
            if(err||!stream){abort(new CatalogError(400,"invalid_world_archive"));return;}
            let size=0;stream.on("data",chunk=>{size+=chunk.length;if(size>entry.uncompressedSize){stream.destroy();abort(new CatalogError(400,"invalid_world_archive"));}});
            stream.on("error",()=>abort(new CatalogError(400,"invalid_world_archive")));
            stream.on("end",()=>zip.readEntry());
          });
        }catch(error){abort(error);}
      });
      zip.on("end",()=>{if(done)return;done=true;level?resolve():reject(new CatalogError(400,"world_level_missing"));});zip.readEntry();
    });
  });
  const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return {sha256:hash.digest("hex"),size:stat.size};
}
export class NomadWorlds {
  constructor(private directory=path.resolve("data","NomadWorlds")){}
  path(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw new CatalogError(400,"invalid_hash");return path.join(this.directory,hash+".zip");}
  async store(file:string){const result=await inspectWorldArchive(file);await fs.promises.mkdir(this.directory,{recursive:true});const target=this.path(result.sha256),stage=path.join(this.directory,uuid()+".part");try{await fs.promises.copyFile(file,stage,fs.constants.COPYFILE_EXCL);if(!(await fs.promises.stat(target).catch(()=>null)))await fs.promises.rename(stage,target);}finally{await fs.promises.unlink(stage).catch(()=>undefined);}return result;}
}
