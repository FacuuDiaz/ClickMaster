import { matchPolicy, type SmsFacts } from "./match";
import type { Policy } from "./schema";

export type SkipReason = "sin_link" | "fuera_de_muestra" | "politica" | "tope_politica" | "en_seleccion";

/**
 * Marca de "todavia no se eligio": el SMS esta guardado y asignado a su
 * politica, pero la seleccion se hace sobre el total del periodo (la ventana
 * entera, o el dia entero en "dia vencido"). Ver policies/windowSelect.ts.
 */
export const HELD: SkipReason = "en_seleccion";

export interface Decision {
  policyId: number | null;
  status: "skipped";
  skipReason: SkipReason;
}

/**
 * Asigna cada SMS nuevo a su politica, sin elegir todavia cuales se visitan.
 * Sin efectos en la base.
 *
 * - Sin link -> skipped (sin_link).
 * - Gana la primera politica activa que coincide; "no_visitar" -> skipped (politica).
 * - El resto queda en_seleccion hasta que llega todo el periodo.
 */
export function assign<K>(items: { key: K; facts: SmsFacts }[], policies: Policy[]): Map<K, Decision> {
  const out = new Map<K, Decision>();
  for (const item of items) {
    if (!item.facts.link) {
      out.set(item.key, { policyId: null, status: "skipped", skipReason: "sin_link" });
      continue;
    }
    const policy = matchPolicy(policies, item.facts);
    const policyId = policy?.id ?? null;
    out.set(item.key, {
      policyId,
      status: "skipped",
      skipReason: policy?.rules.selection.action === "no_visitar" ? "politica" : HELD,
    });
  }
  return out;
}
