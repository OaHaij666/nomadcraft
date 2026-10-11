import ComputeNodes from "@/widgets/ComputeNodes.vue";
import AuditLog from "@/widgets/AuditLog.vue";
import ImageManager from "@/widgets/imageManager/index.vue";
import NewImage from "@/widgets/imageManager/NewImage.vue";
import InstanceBaseInfo from "@/widgets/instance/BaseInfo.vue";
import InstanceFileManager from "@/widgets/instance/FileManager.vue";
import InstanceManagerBtns from "@/widgets/instance/ManagerBtns.vue";
import InstanceModManager from "@/widgets/instance/ModManager.vue";
import Schedule from "@/widgets/instance/Schedule.vue";
import InstanceServerConfigFile from "@/widgets/instance/ServerConfigFile.vue";
import InstanceServerConfigOverview from "@/widgets/instance/ServerConfigOverview.vue";
import Terminal from "@/widgets/instance/Terminal.vue";
import InstanceChart from "@/widgets/InstanceChart.vue";
import InstanceList from "@/widgets/InstanceList.vue";
import NodeList from "@/widgets/NodeList.vue";
import NodeOverview from "@/widgets/NodeOverview.vue";
import OperationLogCard from "@/widgets/OperationLogCard.vue";
import Page404 from "@/widgets/Page404.vue";
import DataOverview from "@/widgets/PanelOverview.vue";
import RequestChart from "@/widgets/RequestChart.vue";
import Settings from "@/widgets/Settings.vue";
import StatusBlock from "@/widgets/StatusBlock.vue";
import PersonalSettings from "@/widgets/user/PersonalSettings.vue";
import UserAccessSettings from "@/widgets/user/AccessSettings.vue";
import UserInstanceList from "@/widgets/UserInstanceList.vue";
import UserList from "@/widgets/UserList.vue";
import NewWorld from "@/widgets/worlds/NewWorld.vue";

import InstanceCenter from "@/widgets/catalog/InstanceCenter.vue";
import CatalogInstanceDetail from "@/widgets/catalog/InstanceDetail.vue";

export const LAYOUT_CARD_TYPES: Record<string, any> = {
  ComputeNodes,
  InstanceCenter,
  CatalogInstanceDetail,
  StatusBlock,
  DataOverview,
  OperationLogCard,
  NodeOverview,
  RequestChart,
  InstanceChart,
  InstanceList,
  Terminal,
  InstanceBaseInfo,
  InstanceManagerBtns,
  InstanceFileManager,
  InstanceModManager,
  InstanceServerConfigOverview,
  InstanceServerConfigFile,
  Schedule,
  UserList,
  UserAccessSettings,
  PersonalSettings,
  Settings,
  AuditLog,
  NodeList,
  ImageManager,
  NewImage,
  UserInstanceList,
  Page404,
  NewWorld
};
