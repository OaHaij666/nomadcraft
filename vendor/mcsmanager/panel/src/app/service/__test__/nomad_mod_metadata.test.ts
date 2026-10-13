import fs from "fs/promises";
import os from "os";
import path from "path";
import {ZipFile} from "yazl";
import {describe,it,expect} from "vitest";
import {modIds} from "../nomad_mod_metadata";
async function metadata(name:string,text:string){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"nomad-mod-metadata-"));const file=path.join(dir,"mod.jar"),zip=new ZipFile();const bytes:Buffer[]=[];zip.addBuffer(Buffer.from(text),name);const done=new Promise<void>((resolve,reject)=>{zip.outputStream.on("data",chunk=>bytes.push(chunk));zip.outputStream.on("error",reject);zip.outputStream.on("end",resolve)});zip.end();await done;await fs.writeFile(file,Buffer.concat(bytes));return {file,close:()=>fs.rm(dir,{recursive:true,force:true})};}
describe("released MOD metadata",()=>{
 it("accepts the UTF-8 BOM used by real YSM Fabric releases",async()=>{const fixture=await metadata("fabric.mod.json",'\uFEFF{"schemaVersion":1,"id":"yes_steve_model"}');try{expect(await modIds(fixture.file)).toEqual(["yes_steve_model"])}finally{await fixture.close()}});
 it("does not hide malformed JSON behind BOM compatibility",async()=>{const fixture=await metadata("fabric.mod.json",'\uFEFF{"id":"ysm",');try{await expect(modIds(fixture.file)).rejects.toBeInstanceOf(SyntaxError)}finally{await fixture.close()}});
 it("retains the existing metadata size bound",async()=>{const fixture=await metadata("fabric.mod.json"," ".repeat(1048577));try{await expect(modIds(fixture.file)).rejects.toMatchObject({code:"mod_metadata_too_large"})}finally{await fixture.close()}});
});
