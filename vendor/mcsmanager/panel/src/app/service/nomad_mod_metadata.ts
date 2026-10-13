import {openNomadZip} from "./nomad_zip";
import {CatalogError} from "./nomad_catalog";
export async function modIds(file:string):Promise<string[]> {
 return new Promise((resolve,reject)=>openNomadZip(file,{lazyEntries:true},(error,zip)=>{
  if(error||!zip){reject(new CatalogError(422,"invalid_mod_archive"));return;}
  const ids:string[]=[];let entries=0;
  zip.on("error",reject);zip.on("end",()=>resolve(ids));zip.on("entry",entry=>{
   if(++entries>50000){zip.close();reject(new CatalogError(422,"mod_archive_too_large"));return;}
   if(!["fabric.mod.json","META-INF/mods.toml","META-INF/neoforge.mods.toml"].includes(entry.fileName)){zip.readEntry();return;}
   if(entry.uncompressedSize>1048576){zip.close();reject(new CatalogError(422,"mod_metadata_too_large"));return;}
   zip.openReadStream(entry,(error,stream)=>{if(error||!stream){zip.close();reject(error);return;}
    const chunks:Buffer[]=[];let size=0;stream.on("error",reject);stream.on("data",chunk=>{size+=chunk.length;if(size>1048576){stream.destroy();zip.close();reject(new CatalogError(422,"mod_metadata_too_large"));}else chunks.push(chunk);});
    stream.on("end",()=>{try{const text=Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");if(entry.fileName==="fabric.mod.json"){const json=JSON.parse(text);if(typeof json.id==="string")ids.push(json.id);}else{for(const block of text.split(/\[\[mods\]\]/).slice(1)){const id=/^\s*modId\s*=\s*["']([^"']+)["']/m.exec(block.split(/\[\[/)[0]);if(id)ids.push(id[1]);}}zip.readEntry();}catch(error){zip.close();reject(error);}});
   });
  });zip.readEntry();
 }));
}
