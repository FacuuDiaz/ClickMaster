/**
 * Elige al azar el `percentage` % de los elementos (cantidad exacta,
 * redondeada), sin repetir. Fisher-Yates parcial sobre una copia: no toca
 * el array original.
 */
export function sampleByPercentage<T>(items: T[], percentage: number): T[] {
  const count = Math.round((items.length * percentage) / 100);
  const pool = [...items];

  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count);
}
