// Electron entry point for the existing local development profile.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const profile=path.join(root,'.nomad/runtime/desktop');
fs.mkdirSync(path.join(profile,'appdata'),{recursive:true});
fs.mkdirSync(path.join(profile,'profile'),{recursive:true});
process.chdir(profile);
app.setPath('appData',path.join(profile,'appdata'));
app.setPath('userData',path.join(profile,'profile'));
require(path.join(root,'vendor/kamucl/out/main/index.js'));
