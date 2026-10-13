import {gatewaySystem} from "./nomad_gateways";
import { formatEndpoint } from "./nomad_ingress";
import http from "http";
import net from "net";
import { WebSocketServer, WebSocket } from "ws";
import { nomadCatalog } from "./catalog_system";
import { systemConfig } from "../setting";
import userSystem from "./user_service";
import { ROLE } from "../entity/user";
import { CatalogError } from "./nomad_catalog";
import type { ExecutorGrant } from "../../../../shared/nomad-hosting";
interface RoomRelay {
  epoch: number;
  waitingForHandover: boolean;
  grant: ExecutorGrant;
  server: net.Server;
  slots: Set<WebSocket>;
  players: Set<net.Socket>;
  address: string;
}
const rooms = new Map<string, RoomRelay>();
const key = (grant: ExecutorGrant) => grant.instanceId + "/" + grant.saveId;
function clearConnections(room:RoomRelay){for(const slot of room.slots)slot.terminate();for(const player of room.players)player.destroy();room.slots.clear();room.players.clear();}
function closeRoom(room: RoomRelay) {clearConnections(room);room.server.close();}

export function closeHostRelay(grant: ExecutorGrant, preserveForHandover=false, expectedEpoch?:number) {
  const room = rooms.get(key(grant));
  if (room) {
    if(room.grant.id!==grant.id||(expectedEpoch!==undefined&&room.epoch!==expectedEpoch))return;
    if(preserveForHandover){clearConnections(room);room.waitingForHandover=true;return;}
    closeRoom(room);
    rooms.delete(key(grant));
    void gatewaySystem().stop(grant.instanceId,grant.saveId).catch(()=>{});
  }
}
export function hostRelayStatus(instanceId: string, saveId: string) {
  const room = rooms.get(instanceId + "/" + saveId);
  const gateway=gatewaySystem().enabled(instanceId,saveId)?gatewaySystem().status(instanceId,saveId):undefined;
  return {
    active: !!room,
    holding: room?.waitingForHandover??false,
    address: room?.address ?? null,
    ready: !!room && room.slots.size > 0 && (!gateway||gateway.state==="ready"),
    gateway,
    slots: room?.slots.size ?? 0
  };
}
export async function prepareHostRelay(grant: ExecutorGrant, epoch: number) {
  const previous = rooms.get(key(grant));
  if (previous?.epoch === epoch) return previous.address;
  if(previous?.waitingForHandover){await nomadCatalog.executorPlan(grant,epoch);previous.grant=grant;previous.epoch=epoch;previous.waitingForHandover=false;return previous.address;}
  if (previous) closeHostRelay(previous.grant,false,previous.epoch);
  const plan = await nomadCatalog.executorPlan(grant, epoch),
    profile = plan.save.ingress;
  const gateway=await gatewaySystem().prepare(grant.instanceId,grant.saveId,plan.release,plan.save);
  const host = profile?.publicHost || systemConfig?.nomadRelayPublicHost || "127.0.0.1",
    bind = profile?.bindHost || systemConfig?.nomadRelayBindIp || "127.0.0.1";
  if (!/^[a-z0-9.\-:]+$/i.test(host)) throw new CatalogError(400, "invalid_server_address");
  const room: RoomRelay = {
    epoch,
    waitingForHandover:false,
    grant,
    server: net.createServer(),
    slots: new Set(),
    players: new Set(),
    address: ""
  };
  room.server.on("connection", async (player) => {
    player.pause();
    try {
      const user = userSystem.getInstance(room.grant.actor.id);
      if (
        !user ||
        user.permission < ROLE.USER ||
        !(await nomadCatalog.relayAllowed(room.grant, room.epoch, {
          id: user.uuid,
          name: user.userName,
          admin: user.permission === ROLE.ADMIN
        }))
      ) {
        player.destroy();
        return;
      }
      const slot = [...room.slots].find((s) => s.readyState === WebSocket.OPEN);
      if (!slot) {
        player.destroy();
        return;
      }
      room.slots.delete(slot);
      room.players.add(player);
      slot.send(JSON.stringify({ connect: true }));
      slot.on("message", (data, binary) => {
        if (binary && !player.destroyed) {
          if (!player.write(data as Buffer)) {
            (slot as any)._socket?.pause();
            player.once("drain", () => (slot as any)._socket?.resume());
          }
        }
      });
      player.on("data", (chunk) => {
        if (slot.readyState !== WebSocket.OPEN) {
          player.destroy();
          return;
        }
        player.pause();
        slot.send(chunk, { binary: true }, () => player.resume());
      });
      player.on("close", () => {
        room.players.delete(player);
        slot.close();
      });
      player.on("error", () => player.destroy());
      slot.on("close", () => player.destroy());
      slot.on("error", () => player.destroy());
      player.resume();
    } catch {
      player.destroy();
    }
  });
  try {
  await new Promise<void>((resolve, reject) => {
    room.server.once("error", reject);
    room.server.listen(
      { port: gateway?.backendPort??profile?.bindPort ?? 0, host: gateway?"127.0.0.1":bind, ipv6Only: !gateway&&profile?.family === "ipv6" },
      () => {
        room.server.removeListener("error", reject);
        resolve();
      }
    );
  });
  } catch(error) {
    clearConnections(room);
    if(room.server.listening)room.server.close();
    if(gateway)await gatewaySystem().stop(grant.instanceId,grant.saveId).catch(()=>{});
    throw error;
  }
  room.server.on("error", () => closeHostRelay(room.grant,false,room.epoch));
  const port = (room.server.address() as net.AddressInfo).port;
  room.address = gateway?.address??formatEndpoint(host, profile?.publicPort ?? port);
  rooms.set(key(grant), room);
  return room.address;
}
async function retireRelayGeneration(room:RoomRelay,observedEpoch:number){
  if(room.epoch!==observedEpoch||room.waitingForHandover)return;
  let preserve=false;
  try {preserve=await nomadCatalog.pendingHandover(room.grant.instanceId,room.grant.saveId);}catch{}
  if(room.epoch!==observedEpoch||room.waitingForHandover)return;
  closeHostRelay(room.grant,preserve,observedEpoch);
}
export function initHostRelay(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", async (request, socket, head) => {
    const prefix = (systemConfig?.prefix ?? "").replace(/\/$/, "");
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = new RegExp(
      "^" +
        prefix.replace(/[.*+?^$()|[\]\\]/g, "\\$&") +
        "/api/nomad/hosting/agent/([a-f0-9-]+)/tunnel$"
    ).exec(url.pathname);
    if (!match) return;
    try {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
        epoch = Number(request.headers["x-nomad-epoch"]);
      const grant = await nomadCatalog.executor(match[1], token),
        user = userSystem.getInstance(grant.actor.id);
      if (
        !user ||
        user.permission < ROLE.USER ||
        !(await nomadCatalog.relayAllowed(grant, epoch, {
          id: user.uuid,
          name: user.userName,
          admin: user.permission === ROLE.ADMIN
        }))
      )
        throw new Error("forbidden");
      const room = rooms.get(key(grant));
      if (!room || room.epoch !== epoch || room.slots.size >= 16) throw new Error("unavailable");
      wss.handleUpgrade(request, socket, head, (ws) => {
        room.slots.add(ws);
        ws.on("close", () => room.slots.delete(ws));
        ws.on("error", () => ws.terminate());
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  const sweep = setInterval(() => {
    for (const room of rooms.values()) {
      if(room.waitingForHandover){void nomadCatalog.pendingHandover(room.grant.instanceId,room.grant.saveId).then(pending=>{if(!pending&&room.waitingForHandover)closeHostRelay(room.grant);}).catch(()=>{if(room.waitingForHandover)closeHostRelay(room.grant);});continue;}
      const observedEpoch=room.epoch;
      const user = userSystem.getInstance(room.grant.actor.id);
      if (!user || user.permission < ROLE.USER) {
        closeHostRelay(room.grant);
        continue;
      }
      nomadCatalog
        .relayAllowed(room.grant, room.epoch, {
          id: user.uuid,
          name: user.userName,
          admin: user.permission === ROLE.ADMIN
        },true)
        .then((ok) => {
          if (!ok) return retireRelayGeneration(room,observedEpoch);
        })
        .catch(() => retireRelayGeneration(room,observedEpoch));
    }
  }, 3000);
  sweep.unref();
  server.on("close", () => {
    clearInterval(sweep);
    for (const room of rooms.values()) closeRoom(room);
    rooms.clear();
    void gatewaySystem().close().catch(()=>{});
    wss.close();
  });
}
