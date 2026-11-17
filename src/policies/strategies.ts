import type { Strategy } from "./schema";

/**
 * Estrategias de seleccion: dados `n` SMS de un periodo ordenados por
 * edr_date, cuales `k` se visitan. Puras y deterministas (salvo
 * "aleatorio"): la ingesta, la vista previa y la web usan las mismas.
 *
 * Todas salvo primeros/ultimos/aleatorio se definen como posiciones
 * "ideales" en [0, 1) que despues se llevan a indices distintos.
 */

export const STRATEGY_INFO: Record<Strategy, { label: string; description: string }> = {
  intercalado: {
    label: "Intercalado",
    description: "Reparte las visitas parejo a lo largo de todo el periodo (uno cada N).",
  },
  aleatorio: {
    label: "Aleatorio",
    description: "Al azar entre todos los SMS del periodo.",
  },
  primeros: {
    label: "Primeros",
    description: "Los mas viejos del periodo.",
  },
  ultimos: {
    label: "Ultimos",
    description: "Los mas nuevos del periodo.",
  },
  progresivo: {
    label: "Progresivo",
    description: "Cada vez mas seguidos: pocos al principio del periodo y mas hacia el final.",
  },
  regresivo: {
    label: "Regresivo",
    description: "El inverso del progresivo: mas seguidos al principio y cada vez mas espaciados.",
  },
  fibonacci: {
    label: "Fibonacci",
    description: "Saltos de 1, 1, 2, 3, 5, 8 (escalados al periodo) que vuelven a empezar: rafagas que se van espaciando.",
  },
};

const FIB = [1, 1, 2, 3, 5, 8];

/** Posiciones ideales en [0, 1), crecientes, para las estrategias "de forma". */
function shape(strategy: Strategy, k: number): number[] {
  const at = (j: number) => (j + 0.5) / k;
  switch (strategy) {
    case "progresivo":
      // Densidad proporcional a x: la acumulada es x^2, se invierte con la raiz.
      return Array.from({ length: k }, (_, j) => Math.sqrt(at(j)));
    case "regresivo":
      return Array.from({ length: k }, (_, j) => 1 - Math.sqrt(1 - at(j)));
    case "fibonacci": {
      // El primer SMS va siempre; despues los saltos del ciclo, escalados
      // para que el ultimo salto termine en el final del periodo.
      const gaps = Array.from({ length: k }, (_, j) => FIB[j % FIB.length]);
      const total = gaps.reduce((a, b) => a + b, 0);
      const out: number[] = [];
      let acc = 0;
      for (let j = 0; j < k; j++) {
        out.push(acc / total);
        acc += gaps[j];
      }
      return out;
    }
    default:
      return Array.from({ length: k }, (_, j) => at(j));
  }
}

/**
 * Indices (0..n-1, crecientes, sin repetir) de los `k` elementos a visitar.
 * Si dos posiciones ideales caen en el mismo indice, la segunda se corre al
 * siguiente libre (y nunca tan adelante que no entren las que faltan).
 */
export function pickIndices(n: number, k: number, strategy: Strategy, random: () => number = Math.random): number[] {
  const count = Math.max(0, Math.min(n, Math.round(k)));
  if (count === 0) return [];
  if (count === n) return Array.from({ length: n }, (_, i) => i);
  if (strategy === "primeros") return Array.from({ length: count }, (_, i) => i);
  if (strategy === "ultimos") return Array.from({ length: count }, (_, i) => n - count + i);
  if (strategy === "aleatorio") {
    // Fisher-Yates parcial sobre los indices.
    const pool = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(random() * (n - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count).sort((a, b) => a - b);
  }
  const out: number[] = [];
  let prev = -1;
  shape(strategy, count).forEach((x, j) => {
    const latest = n - (count - j); // deja lugar para las que faltan
    const idx = Math.min(latest, Math.max(prev + 1, Math.floor(x * n)));
    out.push(idx);
    prev = idx;
  });
  return out;
}

/** Elige `k` de `items` (ya ordenados por edr_date) con la estrategia. */
export function pick<T>(items: T[], k: number, strategy: Strategy, random?: () => number): T[] {
  return pickIndices(items.length, k, strategy, random).map((i) => items[i]);
}

/**
 * Para repartir una cantidad diaria entre las ventanas del dia: fraccion
 * acumulada que deberia estar visitada al llegar a `x` (0 = inicio del dia,
 * 1 = fin). primeros/ultimos no usan curva (ver policies/windowSelect.ts).
 */
export function dayCurve(strategy: Strategy, x: number, slot: number, slots: number): number {
  const t = Math.max(0, Math.min(1, x));
  switch (strategy) {
    case "progresivo":
      return t * t;
    case "regresivo":
      return 1 - (1 - t) * (1 - t);
    case "fibonacci": {
      // Peso de cada ventana del dia segun el ciclo 1,1,2,3,5,8.
      let done = 0;
      let total = 0;
      for (let i = 0; i < slots; i++) {
        const w = FIB[i % FIB.length];
        total += w;
        if (i <= slot) done += w;
      }
      return total === 0 ? t : done / total;
    }
    default:
      return t;
  }
}
