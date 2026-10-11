import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { InstanceTarget } from '../../../shared/instanceCenter'
import { centerTarget, assertInstanceIdle } from '../instanceCenter'
import { importYsmAsset, listYsmAssets, ysmPreview, getDefaultYsm, setDefaultYsm } from './library'
import { installYsmAsset } from './install'
export function registerYsmIpc(getWin:()=>BrowserWindow|null):void{
  const handle=(name:string,fn:(...args:any[])=>unknown)=>ipcMain.handle('ysm:'+name,async(event,...args)=>{const win=getWin();if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许启动器主窗口操作 YSM 模型');return fn(...args)})
  handle('list',listYsmAssets);handle('preview',ysmPreview);handle('defaults',getDefaultYsm);handle('setDefaults',setDefaultYsm)
  handle('import',async()=>{const picked=await dialog.showOpenDialog(getWin()!,{title:'导入 YSM 模型',properties:['openFile'],filters:[{name:'YSM 模型 / 模型 ZIP',extensions:['ysm','zip']}]});if(picked.canceled||!picked.filePaths[0])return null;return importYsmAsset(picked.filePaths[0])})
  handle('install',async(target:InstanceTarget,id:string)=>{const context=centerTarget(target);await assertInstanceIdle(context.dir);return installYsmAsset(context.dir,id)})
}
