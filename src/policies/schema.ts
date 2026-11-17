import { z } from "zod";

/**
 * Politicas: reglas que deciden que SMS se visitan, en que proporcion,
 * con que estrategia, en que horario, con que topes y como. Se evaluan por
 * prioridad y gana la primera que coincide; un SMS sin politica usa el
 * porcentaje por defecto (CLICK_PERCENTAGE) sobre la ventana, al azar.
 *
 * Todo lo que no es identidad (match, seleccion, horario, topes, visita)
 * vive en un solo JSON validado aca: agregar un campo no requiere ALTER.
 */

const textList = z.array(z.string().trim().min(1).max(128)).max(500).default([]);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const matchSchema = z
  .object({
    clients: textList,
    senders: textList,
    countries: textList,
    networks: textList,
    mccmnc: textList,
    vendors: textList,
    // Dominio del link: "ejemplo.com" exacto, "*.ejemplo.com" incluye subdominios.
    domains: textList,
  })
  .default({});

const percentage = z.number().min(0).max(100);

/**
 * Como se elige que SMS visitar entre todos los del periodo (ventana o dia),
 * ordenados por edr_date. Ver src/policies/strategies.ts.
 */
export const STRATEGIES = ["intercalado", "aleatorio", "primeros", "ultimos", "progresivo", "regresivo", "fibonacci"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * Sobre que total se calcula la cantidad a visitar:
 * - ventana: X % de los SMS de cada ventana, elegidos cuando la ventana
 *   llego entera.
 * - dia_vencido: X % de los SMS del dia anterior, elegidos entre los SMS de
 *   ese dia cuando cerro (los de hoy no se visitan hasta manana).
 * - semana_anterior: X % del total del mismo dia de la semana anterior (o
 *   el promedio de las ultimas N semanas); esa cantidad se reparte entre las
 *   ventanas de hoy segun la estrategia.
 */
export const BASES = ["ventana", "dia_vencido", "semana_anterior"] as const;
export type SelectionBase = (typeof BASES)[number];

export const selectionSchema = z.preprocess(
  // Formato anterior ({ percentage: { mode, value, ... } }): se convierte.
  (raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const r = raw as Record<string, unknown>;
    const pct = r.percentage;
    if (!pct || typeof pct !== "object") return raw;
    const old = pct as Record<string, unknown>;
    return {
      ...r,
      percentage: typeof old.value === "number" ? Math.min(100, old.value) : 100,
      base: old.mode === "historico" && old.reference === "semana_anterior" ? "semana_anterior" : "ventana",
      strategy: r.strategy ?? "aleatorio",
    };
  },
  z
    .object({
      action: z.enum(["visitar", "no_visitar"]).default("visitar"),
      percentage: percentage.default(20),
      base: z.enum(BASES).default("ventana"),
      // Solo semana_anterior: promedio del mismo dia de las ultimas N semanas.
      weeks: z.number().int().min(1).max(4).default(1),
      strategy: z.enum(STRATEGIES).default("intercalado"),
    })
    .default({})
);

export const scheduleSchema = z
  .object({
    // 0 = domingo ... 6 = sabado, en la hora de Alaris.
    days: z.array(z.number().int().min(0).max(6)).min(1, "elegi al menos un dia").default([0, 1, 2, 3, 4, 5, 6]),
    // Vacio = todo el dia. Cada franja va de from a to (sin cruzar la medianoche).
    ranges: z
      .array(
        z
          .object({ from: z.string().regex(HHMM, "formato HH:MM"), to: z.string().regex(HHMM, "formato HH:MM") })
          .refine((r) => r.from < r.to, "la franja tiene que terminar despues de empezar (partila en dos si cruza la medianoche)")
      )
      .max(12)
      .default([]),
  })
  .default({});

export const limitsSchema = z
  .object({
    perHour: z.number().int().min(0).nullable().default(null),
    perDay: z.number().int().min(0).nullable().default(null),
  })
  .default({});

export const visitSchema = z
  .object({
    dwellMinMs: z.number().int().min(0).max(120_000).nullable().default(null),
    dwellMaxMs: z.number().int().min(0).max(120_000).nullable().default(null),
    blockResources: z.boolean().nullable().default(null),
    timeoutMs: z.number().int().min(1000).max(120_000).nullable().default(null),
    maxAttempts: z.number().int().min(1).max(20).nullable().default(null),
  })
  .default({})
  .refine(
    (v) => v.dwellMinMs === null || v.dwellMaxMs === null || v.dwellMinMs <= v.dwellMaxMs,
    "la permanencia minima no puede superar a la maxima"
  );

export const rulesSchema = z.object({
  match: matchSchema,
  selection: selectionSchema,
  schedule: scheduleSchema,
  limits: limitsSchema,
  visit: visitSchema,
});

export const policyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Apagada si no se dice: activarla cambia lo que corre (pasa por el aviso).
  enabled: z.boolean().default(false),
  rules: rulesSchema,
});

export type PolicyRules = z.infer<typeof rulesSchema>;
export type PolicyInput = z.infer<typeof policyInputSchema>;
export type SelectionRule = z.infer<typeof selectionSchema>;
export type ScheduleRule = z.infer<typeof scheduleSchema>;

export interface Policy {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  rules: PolicyRules;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}
