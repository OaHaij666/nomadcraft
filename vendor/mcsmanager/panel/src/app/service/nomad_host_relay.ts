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
  grant: ExecutorGrant;
  server: net.Server;
  slots: Set<WebSocket>;
  players: Set<net.Socket>;
  address: string;
}
const rooms = new Map<string, RoomRelay>();
const key = (grant: ExecutorGrant) => grant.instanceId + "/" + grant.saveId;
function closeRoom(room: RoomRelay) {
  for (const slot of room.slots) slot.terminate();
  for (const player of room.players) player.destroy();
  room.server.close();
}
export function closeHostRelay(grant: ExecutorGrant) {
  const room = rooms.get(key(grant));
  if (room) {
    closeRoom(room);
    rooms.delete(key(grant));
  }
}
export function hostRelayStatus(instanceId: string, saveId: string) {
  const room = rooms.get(instanceId + "/" + saveId);
  return {
    active: !!room,
    address: room?.address ?? null,
    ready: !!room && room.slots.size > 0,
    slots: room?.slots.size ?? 0
  };
}
export async function prepareHostRelay(grant: ExecutorGrant, epoch: number) {
  const previous = rooms.get(key(grant));
  if (previous?.epoch === epoch) return previous.address;
  if (previous) closeHostRelay(grant);
  const plan = await nomadCatalog.executorPlan(grant, epoch),
    profile = plan.save.ingress;
  const host = profile?.publicHost || systemConfig?.nomadRelayPublicHost || "127.0.0.1",
    bind = profile?.bindHost || systemConfig?.nomadRelayBindIp || "127.0.0.1";
  if (!/^[a-z0-9.\-:]+$/i.test(host)) throw new CatalogError(400, "invalid_server_address");
  const room: RoomRelay = {
    epoch,
    grant,
    server: net.createServer(),
    slots: new Set(),
    players: new Set(),
    address: ""
  };
  room.server.on("connection", async (player) => {
    player.pause();
    try {
      const user = userSystem.getInstance(grant.actor.id);
      if (
        !user ||
        user.permission < ROLE.USER ||
        !(await nomadCatalog.relayAllowed(grant, epoch, {
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
  await new Promise<void>((resolve, reject) => {
    room.server.once("error", reject);
    room.server.listen(
      { port: profile?.bindPort ?? 0, host: bind, ipv6Only: profile?.family === "ipv6" },
      () => {
        room.server.removeListener("error", reject);
        resolve();
      }
    );
  });
  room.server.on("error", () => closeHostRelay(grant));
  const port = (room.server.address() as net.AddressInfo).port;
  room.address = formatEndpoint(host, profile?.publicPort ?? port);
  rooms.set(key(grant), room);
  return room.address;
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
        })
        .then((ok) => {
          if (!ok) closeHostRelay(room.grant);
        })
        .catch(() => closeHostRelay(room.grant));
    }
  }, 3000);
  sweep.unref();
  server.on("close", () => {
    clearInterval(sweep);
    for (const room of rooms.values()) closeRoom(room);
    rooms.clear();
    wss.close();
  });
}
