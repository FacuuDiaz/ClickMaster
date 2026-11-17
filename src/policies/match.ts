import { extractLink } from "../parser/extractLink";
import type { Policy } from "./schema";

/** Lo que se mira de cada SMS para decidir que politica le toca. */
export interface SmsFacts {
  client: string;
  sender: string;
  country: string;
  network: string;
  mccmnc: string;
  vendor: string;
  link: string | null;
  // Host del link en minusculas (sin www.), o null si no hay link.
  domain: string | null;
}

export function domainOf(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

interface FactSource {
  client?: unknown;
  sender_name?: unknown;
  country?: unknown;
  network?: unknown;
  mccmnc?: unknown;
  vendor?: unknown;
  text?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/**
 * Sirve para un registro ya validado (SmsRecord), una fila de sms_content
 * o un registro crudo de la API (algunas keys vienen con prefijo "t#").
 */
export function factsOf(record: FactSource | Record<string, unknown>): SmsFacts {
  const r = record as Record<string, unknown>;
  const get = (key: string) => str(r[key] ?? r[`t#${key}`]);
  const link = extractLink(get("text"));
  return {
    client: get("client"),
    sender: get("sender_name"),
    country: get("country"),
    network: get("network"),
    mccmnc: get("mccmnc"),
    vendor: get("vendor"),
    link,
    domain: domainOf(link),
  };
}

function inList(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  const v = value.trim().toLowerCase();
  return list.some((item) => item.trim().toLowerCase() === v);
}

function domainMatches(patterns: string[], domain: string | null): boolean {
  if (patterns.length === 0) return true;
  if (!domain) return false;
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^www\./, "");
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return domain === base || domain.endsWith(`.${base}`);
    }
    return domain === p;
  });
}

export function policyMatches(policy: Policy, facts: SmsFacts): boolean {
  const m = policy.rules.match;
  return (
    inList(m.clients, facts.client) &&
    inList(m.senders, facts.sender) &&
    inList(m.countries, facts.country) &&
    inList(m.networks, facts.network) &&
    inList(m.mccmnc, facts.mccmnc) &&
    inList(m.vendors, facts.vendor) &&
    domainMatches(m.domains, facts.domain)
  );
}

/** Primera politica activa que coincide (ya vienen ordenadas por prioridad). */
export function matchPolicy(policies: Policy[], facts: SmsFacts): Policy | null {
  for (const policy of policies) {
    if (policy.enabled && policyMatches(policy, facts)) return policy;
  }
  return null;
}
