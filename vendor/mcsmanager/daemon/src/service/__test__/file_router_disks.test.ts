import {it,expect,vi} from "vitest";
import os from "node:os";
vi.mock("../system_instance",()=>({default:{getInstance:()=>undefined}}));
vi.mock("../system_file",()=>({default:class {}}));
vi.mock("../../i18n",()=>({$t:(value:string)=>value}));
import {getWindowsDisks} from "../file_router_service";
const windowsTest=os.platform()==="win32"?it:it.skip;
windowsTest("native disk probing has a deadline, leaves the event loop responsive and caches its result",async()=>{
 let ticks=0;const timer=setInterval(()=>{ticks++;},10);const started=Date.now();
 try {
  const disks=await getWindowsDisks();
  expect(Date.now()-started).toBeLessThan(3500);expect(ticks).toBeGreaterThan(0);
  expect(Array.isArray(disks)).toBe(true);expect(disks.every(letter=>/^[A-Z]$/.test(letter))).toBe(true);
  const cachedAt=Date.now();expect(await getWindowsDisks()).toEqual(disks);expect(Date.now()-cachedAt).toBeLessThan(250);
 } finally {clearInterval(timer);}
},6000);
