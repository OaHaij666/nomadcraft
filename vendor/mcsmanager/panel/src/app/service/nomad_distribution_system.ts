import Storage from "../common/storage/sys_storage";
import {nomadCatalog} from "./catalog_system";
import {NomadDistribution} from "./nomad_distribution";
import {NomadFederation} from "./nomad_federation";
export const distribution=new NomadDistribution(()=>Storage.getStorage(),nomadCatalog);
export const federation=new NomadFederation(distribution);
