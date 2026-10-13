import userSystem from "./user_service";
import {ROLE} from "../entity/user";
import {nomadPublicBotRuntime} from "./nomad_bot_runtime";
import Storage from "../common/storage/sys_storage";
import { nomadCatalog } from "./catalog_system";
import { nomadModels } from "./nomad_models_system";
import { NomadBots } from "./nomad_bots";
export const nomadBots=new NomadBots(()=>Storage.getStorage(),nomadCatalog,nomadModels,nomadPublicBotRuntime,id=>{const user=userSystem.getInstance(id);return user&&user.permission>=ROLE.USER?{id:user.uuid,name:user.userName,admin:user.permission===ROLE.ADMIN}:null;});
