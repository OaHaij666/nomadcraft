import Storage from "../common/storage/sys_storage";
import { nomadCatalog } from "./catalog_system";
import { NomadModels } from "./nomad_models";
export const nomadModels = new NomadModels(() => Storage.getStorage(), nomadCatalog);
