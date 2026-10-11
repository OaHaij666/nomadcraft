import net from "net";
import { domainToASCII } from "url";
import { CatalogError } from "./nomad_catalog";
import type { NetworkIngress } from "../../../../shared/nomad-compute";
export function endpointHost(value: unknown) {
  if (typeof value !== "string") throw new CatalogError(400, "invalid_server_address");
  const raw = value.trim().replace(/^\[([^\]]+)\]$/, "$1");
  if (net.isIP(raw)) return raw;
  if (raw.length > 253 || !raw || raw.includes(":"))
    throw new CatalogError(400, "invalid_server_address");
  const host = domainToASCII(raw).toLowerCase();
  if (
    !host ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
    throw new CatalogError(400, "invalid_server_address");
  return host;
}
export function formatEndpoint(host: string, port: number) {
  return (net.isIP(host) === 6 ? "[" + host + "]" : host) + ":" + port;
}
export function validateIngress(input: any): NetworkIngress {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CatalogError(400, "invalid_network_ingress");
  const kinds = ["direct", "generic-tcp", "frp", "private-network", "client-assisted"],
    families = ["auto", "ipv4", "ipv6"];
  if (!kinds.includes(input.kind) || !families.includes(input.family))
    throw new CatalogError(400, "invalid_network_ingress");
  const bindHost = endpointHost(input.bindHost),
    publicHost = endpointHost(input.publicHost);
  if (bindHost !== "localhost" && !net.isIP(bindHost))
    throw new CatalogError(400, "invalid_bind_address");
  if (["0.0.0.0", "::"].includes(publicHost)) throw new CatalogError(400, "invalid_server_address");
  for (const port of [input.bindPort, input.publicPort])
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new CatalogError(400, "invalid_network_port");
  if (
    (input.family === "ipv4" && net.isIP(bindHost) === 6) ||
    (input.family === "ipv6" && net.isIP(bindHost) === 4)
  )
    throw new CatalogError(400, "network_family_mismatch");
  const tunnelHost = input.kind === "frp" ? endpointHost(input.tunnelHost) : "",
    tunnelPort = input.kind === "frp" ? input.tunnelPort : 0;
  if (
    input.kind === "frp" &&
    (!Number.isInteger(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535)
  )
    throw new CatalogError(400, "invalid_network_port");
  return {
    kind: input.kind,
    bindHost,
    bindPort: input.bindPort,
    publicHost,
    publicPort: input.publicPort,
    family: input.family,
    tunnelHost,
    tunnelPort
  };
}
export function frpConfiguration(ingress: NetworkIngress, name: string) {
  if (ingress.kind !== "frp") throw new CatalogError(400, "frp_profile_required");
  const localIP =
    ingress.bindHost === "0.0.0.0"
      ? "127.0.0.1"
      : ingress.bindHost === "::"
      ? "::1"
      : ingress.bindHost;
  return (
    "# Add the authentication required by your frps operator. No secret is included.\nserverAddr = " +
    JSON.stringify(ingress.tunnelHost) +
    "\nserverPort = " +
    ingress.tunnelPort +
    "\n\n[[proxies]]\nname = " +
    JSON.stringify(name) +
    '\ntype = "tcp"\nlocalIP = ' +
    JSON.stringify(localIP) +
    "\nlocalPort = " +
    ingress.bindPort +
    "\nremotePort = " +
    ingress.publicPort +
    "\n"
  );
}
