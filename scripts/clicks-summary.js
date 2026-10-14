// Resumen del progreso de clicks (make clicks-summary). Corre con el Node
// del container de la app, leido por stdin: no hace falta rebuildear.
fetch("http://localhost:3000/clicks")
  .then((r) => r.json())
  .then((d) => {
    const c = d.current;
    const q = d.queued || [];
    const done = d.jobs.filter((j) => !c || j.id !== c.id);

    if (!c) {
      console.log("No hay clicks corriendo.");
    } else {
      const pct = ((100 * c.completed) / c.total).toFixed(1);
      const mins = (Date.now() - new Date(c.startedAt)) / 60000;
      const lote = c.batch ? `job ${c.batch.index}/${c.batch.size} del lote` : "job suelto";
      console.log(`Ahora:   ${lote} -> ${c.url}`);
      console.log(`         ${c.completed}/${c.total} (${pct}%) · ${c.ok} ok · ${c.failed} fallos · ${c.status}`);
      if (c.completed > 0) {
        const eta = (mins / c.completed) * (c.total - c.completed);
        console.log(`         ${(c.completed / mins).toFixed(1)} visitas/min · termina este job en ~${Math.round(eta)} min`);
      }
      if (c.lastError) console.log(`         ultimo error: ${c.lastError.split("\n")[0].slice(0, 100)}`);
    }

    const pend = q.reduce((s, j) => s + j.total, 0);
    console.log(`En cola: ${q.length} jobs · ${pend} visitas pendientes`);
    if (done.length) {
      const ok = done.reduce((s, j) => s + j.ok, 0);
      const ko = done.reduce((s, j) => s + j.failed, 0);
      console.log(`Hechos:  ${done.length} jobs (de los ultimos 20) · ${ok} ok · ${ko} fallos`);
    }
  })
  .catch((e) => {
    console.error("No se pudo consultar la app:", e.message);
    process.exit(1);
  });
