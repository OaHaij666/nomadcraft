import { useDefineApi } from "@/stores/useDefineApi";

export const setUserApiKey = useDefineApi<
  {
    data: {
      enable: boolean;
    };
  },
  string
>({
  url: "/api/auth/api",
  method: "PUT"
});

export const updatePassword = useDefineApi<
  {
    data: {
      passWord: string;
    };
  },
  boolean
>({
  url: "/api/auth/update",
  method: "PUT"
});

export const bind2FA = useDefineApi<any, string>({
  url: "/api/auth/bind2fa",
  method: "POST"
});

export const confirm2FA = useDefineApi<
  {
    data: {
      enable: boolean;
      TOTPCode: string;
    };
  },
  undefined
>({
  url: "/api/auth/confirm2fa",
  method: "POST"
});

export const getHostingPreference = useDefineApi<
  {},
  import("../../../../shared/nomad-hosting-preference").HostingPreference
>({ url: "/api/auth/hosting-preference", method: "GET" });
export const setHostingPreference = useDefineApi<
  { data: import("../../../../shared/nomad-hosting-preference").HostingPreference },
  import("../../../../shared/nomad-hosting-preference").HostingPreference
>({ url: "/api/auth/hosting-preference", method: "PUT" });
