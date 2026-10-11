import Storage from "../common/storage/sys_storage";
import { NomadCatalog } from "./nomad_catalog";
export const nomadCatalog = new NomadCatalog(() => Storage.getStorage());
