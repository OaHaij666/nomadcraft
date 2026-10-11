// @vitest-environment jsdom
import {flushPromises,mount} from "@vue/test-utils";
import {ref} from "vue";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import InstanceDetail from "../InstanceDetail.vue";
import {DEFAULT_PROFILE,DEFAULT_RULES} from "../../../../../shared/nomad-catalog";
const mocks=vi.hoisted(()=>({list:vi.fn(),push:vi.fn()}));
vi.mock("@/config/router",()=>({router:{push:mocks.push}}));
vi.mock("@/lang/i18n",()=>({t:(key:string,args?:Record<string,unknown>)=>key+" "+Object.values(args??{}).join(" ")}));
vi.mock("vue-router",async original=>({...await original<any>(),useRoute:()=>({query:{id:"logical"}})}));
vi.mock("@/stores/useAppStateStore",()=>({useAppStateStore:()=>({isAdmin:ref(false),state:{userInfo:{uuid:"reader"}}})}));
vi.mock("@/services/apis/catalog",async original=>{const actual=await original<any>();return {...actual,catalogApi:{...actual.catalogApi,list:mocks.list}};});
let wrapper:ReturnType<typeof mount>;
function view(phase="ready",address:string|null="127.0.0.1:25566"){return {canCreate:false,instances:[{id:"logical",name:"Friends",description:"",ownerId:"owner",ownerName:"Owner",profile:DEFAULT_PROFILE,releases:[],mods:[],grants:[],events:[],createdAt:1,updatedAt:1,revision:1,permissions:["instance.read"],savePermissions:{world:["save.read"]},hostingScopes:[],saves:[{id:"world",name:"World",description:"",rules:DEFAULT_RULES,players:[],releaseId:null,createdAt:1,updatedAt:1,room:{id:"room",name:"Room",desiredState:"open",revision:1,createdAt:1,updatedAt:1},hosting:{phase,epoch:1,nodeName:"Host PC",holderName:"Owner",leaseExpiresAt:Date.now()+90000,joinAddress:address,checkpoint:{sha256:"a".repeat(64),size:2097152,at:1,epoch:1},error:""}}]}]};}
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers({toFake:["setInterval","clearInterval"]});Object.defineProperty(window,"matchMedia",{configurable:true,value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();});
async function render(){wrapper=mount(InstanceDetail,{global:{stubs:{InstanceEditor:true,CloudImport:true,ReleaseEditor:true,SaveEditor:true,AccessEditor:true,ModManifest:true,PlayerPolicy:true}}});await flushPromises();}
describe("real hosting status presentation",()=>{
 it("keeps the join address and host identity visible during checkpointing without exposing hosting permissions",async()=>{mocks.list.mockResolvedValue(view("checkpointing"));await render();expect(wrapper.text()).toContain("127.0.0.1:25566");expect(wrapper.text()).toContain("Host PC");expect(wrapper.text()).toContain("TXT_CODE_CATALOG_HOST_READY");expect(wrapper.text()).toContain("2.0 MiB");expect(wrapper.text()).not.toContain("TXT_CODE_CATALOG_CLOSE_ROOM");});
 it("polls for shutdown and clears stale addresses after a failed refresh",async()=>{mocks.list.mockResolvedValue(view());await render();expect(wrapper.text()).toContain("127.0.0.1:25566");mocks.list.mockRejectedValueOnce(new Error("center unreachable"));await vi.advanceTimersByTimeAsync(5000);await flushPromises();expect(wrapper.text()).not.toContain("127.0.0.1:25566");mocks.list.mockResolvedValue(view("stopping",null));await vi.advanceTimersByTimeAsync(5000);await flushPromises();expect(wrapper.text()).toContain("TXT_CODE_CATALOG_HOST_STOPPING");});
});
