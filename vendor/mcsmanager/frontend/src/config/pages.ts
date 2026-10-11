import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";

// Product pages are fixed. Persisted dashboard layouts are intentionally ignored.
const pages: Record<string, LayoutCard[]> = {
  "/compute": [{id:"compute-nodes",type:"ComputeNodes",title:"TXT_CODE_COMPUTE_TITLE",width:12,height:"unset",meta:{}}],
  "/catalog": [
    {
      id: "catalog-center",
      type: "InstanceCenter",
      title: "TXT_CODE_CATALOG_CENTER",
      width: 12,
      height: "unset",
      meta: {}
    }
  ],
  "/catalog/detail": [
    {
      id: "catalog-detail",
      type: "CatalogInstanceDetail",
      title: "TXT_CODE_CATALOG_INSTANCE_DETAIL",
      width: 12,
      height: "unset",
      meta: {}
    }
  ],
  "/overview": [
    {
      id: "/overview/0",
      type: "StatusBlock",
      title: "TXT_CODE_e627e546",
      meta: {
        type: "node"
      },
      width: 3,
      description: "TXT_CODE_55ade942",
      height: "200px"
    },
    {
      id: "/overview/1",
      type: "StatusBlock",
      title: "TXT_CODE_88e9361a",
      meta: {
        type: "instance"
      },
      width: 3,
      description: "TXT_CODE_55ade942",
      height: "200px"
    },
    {
      id: "/overview/2",
      type: "StatusBlock",
      title: "TXT_CODE_db64faf6",
      meta: {
        type: "users"
      },
      width: 3,
      description: "TXT_CODE_55ade942",
      height: "200px"
    },
    {
      id: "/overview/3",
      type: "StatusBlock",
      title: "TXT_CODE_66056676",
      meta: {
        type: "system"
      },
      width: 3,
      description: "TXT_CODE_55ade942",
      height: "200px"
    },
    {
      id: "/overview/4",
      meta: {},
      type: "DataOverview",
      title: "TXT_CODE_721157a3",
      width: 12,
      description: "TXT_CODE_55ade942",
      height: "400px"
    },
    {
      id: "/overview/5",
      meta: {},
      type: "OperationLogCard",
      title: "TXT_CODE_6a444b79",
      width: 4,
      description: "TXT_CODE_9e8c176e",
      height: "400px"
    },
    {
      id: "/overview/6",
      meta: {},
      type: "NodeOverview",
      title: "TXT_CODE_bfb50126",
      width: 8,
      description: "TXT_CODE_55ade942",
      height: "400px"
    },
    {
      id: "/overview/7",
      meta: {},
      type: "RequestChart",
      title: "TXT_CODE_a4037a98",
      width: 6,
      description: "TXT_CODE_55ade942",
      height: "200px"
    },
    {
      id: "/overview/8",
      meta: {},
      type: "InstanceChart",
      title: "TXT_CODE_d6d9c42c",
      width: 6,
      description: "TXT_CODE_55ade942",
      height: "200px"
    }
  ],
  "/instances": [
    {
      id: "/instances/0",
      meta: {},
      type: "InstanceList",
      title: "TXT_CODE_e21473bc",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/instances/terminal": [
    {
      id: "/instances/terminal/0",
      meta: {
        viewType: "inner"
      },
      type: "Terminal",
      title: "TXT_CODE_4ccdd3a0",
      width: 12,
      height: "600px",
      disableDelete: true
    },
    {
      id: "/instances/terminal/1",
      meta: {},
      type: "InstanceBaseInfo",
      title: "TXT_CODE_eadb4f60",
      width: 4,
      height: "200px"
    },
    {
      id: "/instances/terminal/2",
      meta: {},
      type: "InstanceManagerBtns",
      title: "TXT_CODE_efd37c48",
      width: 8,
      height: "200px",
      disableDelete: true
    }
  ],
  "/instances/terminal/files": [
    {
      id: "/instances/terminal/files/0",
      meta: {},
      type: "InstanceFileManager",
      title: "TXT_CODE_ae533703",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/instances/terminal/mods": [
    {
      id: "/instances/terminal/mods/0",
      meta: {},
      type: "InstanceModManager",
      title: "TXT_CODE_MOD_MANAGER",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/instances/terminal/serverConfig": [
    {
      id: "/instances/terminal/serverConfig/0",
      meta: {},
      type: "InstanceServerConfigOverview",
      title: "TXT_CODE_d07742fe",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/instances/terminal/serverConfig/fileEdit": [
    {
      id: "/instances/terminal/serverConfig/fileEdit/0",
      meta: {},
      type: "InstanceServerConfigFile",
      title: "TXT_CODE_1c45f7fe",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/instances/schedule": [
    {
      id: "/instances/schedule/0",
      meta: {},
      type: "Schedule",
      title: "TXT_CODE_b7d026f8",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/users": [
    {
      id: "/users/0",
      meta: {},
      type: "UserList",
      title: "TXT_CODE_97d17cce",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/users/resources": [
    {
      id: "/users/resources/0",
      meta: {},
      type: "UserAccessSettings",
      title: "TXT_CODE_eb579d63",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/preferences": [{id:"personal-settings",type:"PersonalSettings",title:"TXT_CODE_HOSTING_PREF_PERSONAL",width:12,height:"unset",meta:{}}],
  "/settings": [
    {
      id: "/settings/0",
      meta: {},
      type: "Settings",
      title: "TXT_CODE_3fe97dcc",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/audit": [
    {
      id: "/audit/0",
      meta: {},
      type: "AuditLog",
      title: "TXT_CODE_ea1600d2",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/node": [
    {
      id: "/node/0",
      meta: {},
      type: "NodeList",
      title: "TXT_CODE_20509fa0",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/node/image": [
    {
      id: "/node/image/0",
      meta: {},
      type: "ImageManager",
      title: "TXT_CODE_e6c30866",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/node/image/new": [
    {
      id: "/node/image/new/0",
      meta: {},
      type: "NewImage",
      title: "TXT_CODE_3d09f0ac",
      width: 12,
      height: "unset",
      disableDelete: true
    }
  ],
  "/customer": [
    {
      id: "my-worlds",
      type: "UserInstanceList",
      title: "TXT_CODE_WORLD_LIST",
      width: 12,
      height: "unset",
      meta: {}
    }
  ],
  "/404": [
    {
      id: "/404/0",
      meta: {},
      type: "Page404",
      title: "TXT_CODE_6aa286df",
      width: 6,
      height: "100px",
      disableDelete: true
    }
  ],
  "/worlds/new": [
    {
      id: "new-world",
      type: "NewWorld",
      title: "TXT_CODE_WORLD_CREATE",
      width: 12,
      height: "unset",
      meta: {}
    }
  ]
};

export function getPageCards(page: string): LayoutCard[] {
  return (pages[page] ?? []).map((card) => ({
    ...card,
    meta: { ...card.meta },
    title: t(card.title)
  }));
}
