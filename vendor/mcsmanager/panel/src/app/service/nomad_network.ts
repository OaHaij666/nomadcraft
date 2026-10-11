import net from "net";
import dns from "dns";
import os from "os";
import type { NetworkIngress, NetworkReport, NetworkCheck } from "../../../../shared/nomad-compute";
import { formatEndpoint } from "./nomad_ingress";
function varint(value: number) {
  const bytes: number[] = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function vint(bytes: Buffer, start = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (start + i >= bytes.length) return null;
    const b = bytes[start + i];
    value |= (b & 127) << (7 * i);
    if (!(b & 128)) return { value, size: i + 1 };
  }
  throw new Error("invalid_varint");
}
function string(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(bytes.length), bytes]);
}
function packet(id: number, body: Buffer) {
  const bytes = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(bytes.length), bytes]);
}
export function probeMinecraft(
  address: string,
  port: number,
  handshakeHost: string,
  timeoutMs = 2500
): Promise<{ latencyMs: number; protocol: number; version: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now(),
      socket = new net.Socket();
    let bytes = Buffer.alloc(0),
      done = false;
    const finish = (error?: Error, value?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("connection_timeout")), timeoutMs);
    socket.once("error", () => finish(new Error("connection_failed")));
    socket.once("close", () => {
      if (!done) finish(new Error("connection_closed"));
    });
    socket.on("data", (chunk) => {
      try {
        if (bytes.length + chunk.length > 1048576) throw new Error("status_too_large");
        bytes = Buffer.concat([bytes, chunk]);
        const frame = vint(bytes);
        if (!frame) return;
        if (frame.value < 1 || frame.value > 1048576) throw new Error("invalid_status");
        if (bytes.length < frame.size + frame.value) return;
        const data = bytes.subarray(frame.size, frame.size + frame.value),
          id = vint(data);
        if (!id || id.value !== 0) throw new Error("not_minecraft_status");
        const len = vint(data, id.size);
        if (
          !len ||
          len.value < 2 ||
          len.value > 1048576 ||
          id.size + len.size + len.value !== data.length
        )
          throw new Error("invalid_status");
        const status = JSON.parse(data.subarray(id.size + len.size).toString());
        if (!Number.isInteger(status?.version?.protocol) || typeof status.version.name !== "string")
          throw new Error("not_minecraft_status");
        finish(undefined, {
          latencyMs: Date.now() - started,
          protocol: status.version.protocol,
          version: status.version.name.slice(0, 100)
        });
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.connect(port, address, () => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      socket.write(packet(0, Buffer.concat([varint(767), string(handshakeHost), p, varint(1)])));
      socket.write(packet(0, Buffer.alloc(0)));
    });
  });
}
async function lookup(host: string) {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dns.promises.lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), 2500);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function inspectNetwork(
  ingress: NetworkIngress | undefined,
  runtime: { active: boolean; address: string | null; ready: boolean; slots: number }
): Promise<NetworkReport> {
  const report: NetworkReport = {
    at: Date.now(),
    vantage: "center",
    publicReachability: "unverified",
    interfaces: [],
    checks: []
  };
  for (const [name, items] of Object.entries(os.networkInterfaces()))
    for (const item of items ?? [])
      report.interfaces.push({
        name,
        address: item.address,
        family: String(item.family),
        internal: item.internal
      });
  const add = (check: NetworkCheck) => report.checks.push(check);
  add({
    key: "interfaces",
    status: report.interfaces.some((i) => !i.internal) ? "ok" : "warning",
    message: "network_interfaces"
  });
  add({
    key: "ipv4",
    status: report.interfaces.some((i) => !i.internal && i.family === "IPv4") ? "ok" : "unverified",
    message: "local_address_does_not_prove_public_access"
  });
  add({
    key: "ipv6",
    status: report.interfaces.some(
      (i) => !i.internal && i.family === "IPv6" && !i.address.toLowerCase().startsWith("fe80:")
    )
      ? "ok"
      : "unverified",
    message: "ipv6_route_requires_external_verification"
  });
  add({
    key: "listener",
    status: runtime.active ? "ok" : "unverified",
    message: runtime.active ? "room_listener_active" : "room_not_running"
  });
  add({
    key: "tunnel",
    status: runtime.ready && runtime.slots > 0 ? "ok" : "unverified",
    message: runtime.ready && runtime.slots > 0 ? "executor_tunnel_ready" : "executor_not_ready"
  });
  if (!ingress) {
    add({ key: "profile", status: "unverified", message: "network_profile_missing" });
    return report;
  }
  add({
    key: "client",
    status:
      ingress.kind === "client-assisted" || ingress.kind === "private-network" ? "warning" : "ok",
    message:
      ingress.kind === "client-assisted"
        ? "client_helper_required"
        : ingress.kind === "private-network"
        ? "private_network_required"
        : "native_tcp_endpoint"
  });
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(ingress.publicHost);
    add({
      key: "dns",
      status: addresses.length ? "ok" : "failed",
      message: "public_host_resolution"
    });
  } catch {
    add({ key: "dns", status: "failed", message: "public_host_resolution_failed" });
    addresses = [];
  }
  const filtered = addresses
    .filter((a) => ingress.family === "auto" || a.family === (ingress.family === "ipv4" ? 4 : 6))
    .slice(0, 4);
  if (!filtered.length && addresses.length)
    add({ key: "family", status: "failed", message: "configured_address_family_unavailable" });
  await Promise.all(
    filtered.map(async (address) => {
      try {
        const result = await probeMinecraft(
          address.address,
          ingress.publicPort,
          ingress.publicHost
        );
        add({
          key: "minecraft",
          status: "ok",
          message: "minecraft_status_reachable_from_center",
          address: formatEndpoint(address.address, ingress.publicPort),
          family: address.family,
          ...result
        });
      } catch (error) {
        add({
          key: "minecraft",
          status: runtime.ready ? "failed" : "unverified",
          message: runtime.ready ? (error as Error).message : "room_not_ready_for_protocol_probe",
          address: formatEndpoint(address.address, ingress.publicPort),
          family: address.family
        });
      }
    })
  );
  add({ key: "external", status: "unverified", message: "external_probe_required" });
  return report;
}

function probeTcp(address: string, port: number, timeoutMs = 2500): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now(),
      socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connection_timeout"));
    }, timeoutMs);
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("connection_failed"));
    });
    socket.connect(port, address, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Date.now() - started);
    });
  });
}
export async function inspectServerNetwork(): Promise<NetworkReport> {
  const report = await inspectNetwork(undefined, {
    active: false,
    address: null,
    ready: false,
    slots: 0
  });
  report.checks = report.checks.filter((c) => !["listener", "tunnel", "profile"].includes(c.key));
  report.checks.push({ key: "api", status: "ok", message: "center_api_responding" });
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await lookup("piston-meta.mojang.com");
    report.checks.push({ key: "dns", status: "ok", message: "official_source_dns_resolved" });
  } catch {
    report.checks.push({ key: "dns", status: "failed", message: "official_source_dns_failed" });
  }
  await Promise.all(
    [4, 6].map(async (family) => {
      const address = addresses.find((a) => a.family === family);
      if (!address) {
        report.checks.push({
          key: "outbound",
          status: "unverified",
          message: "official_source_family_unavailable",
          family
        });
        return;
      }
      try {
        const latencyMs = await probeTcp(address.address, 443);
        report.checks.push({
          key: "outbound",
          status: "ok",
          message: "official_source_tcp_reachable",
          address: formatEndpoint(address.address, 443),
          family,
          latencyMs
        });
      } catch {
        report.checks.push({
          key: "outbound",
          status: "failed",
          message: "official_source_tcp_failed",
          address: formatEndpoint(address.address, 443),
          family
        });
      }
    })
  );
  report.checks.push({ key: "external", status: "unverified", message: "external_probe_required" });
  return report;
}
