// Seccion Operacion: estado de scheduler/worker/cola, acciones y clicks manuales.
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtNum, fmtDate, fmtAgo, kv, table } = CM;

  const FAST_MS = 3000; // con clicks corriendo
  const SLOW_MS = 10000;
  const JOB_STATUS = {
    queued: "En cola", running: "Corriendo", cancelling: "Cancelando",
    cancelled: "Cancelado", done: "Terminado", failed: "Fallo",
  };
  let timer = null;
  let status = null;

  function pill(node, ok, text) {
    node.className = `pill ${ok ? "ok" : "bad"}`;
    node.textContent = text;
  }

  function fmtDuration(s) {
    if (s === null || s === undefined) return "—";
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  }

  function renderStatus(data) {
    status = data;
    const sch = data.scheduler;
    const waiting = !data.policy || !data.policy.active;
    pill($("ops-sched-state"), sch.enabled && sch.running && !waiting, waiting ? "En espera: sin politica activa" : sch.enabled ? (sch.running ? "Activa" : "Activa (detenida)") : "Pausada");
    const last = sch.lastTick;
    const run = data.lastRun;
    kv($("ops-sched"), [
      ["Ventanas de", `${sch.windowMinutes ?? "—"} min`],
      ["Chequea cada", `${sch.tickSeconds ?? "—"} s`],
      ["Ultimo chequeo", last ? `${fmtAgo(last.at)}${last.error ? ` · error: ${last.error}` : ""}` : "—"],
      ["Ultima ingesta", run ? `${run.status} · ${fmtDate(run.windowStart)} → ${fmtDate(run.windowEnd)}` : "—"],
      ["SMS recibidos", run ? fmtNum(run.recordsReceived) : "—"],
    ]);
    $("ops-sched-toggle").textContent = sch.enabled ? "Pausar ingesta" : "Reanudar ingesta";
    $("ops-sched-toggle").className = `btn${sch.enabled ? " danger" : " primary"}`;

    const w = data.worker;
    const clicking = Boolean(data.clicks.current) || data.clicks.queued > 0;
    pill(
      $("ops-worker-state"),
      w.enabled && w.running && !w.paused,
      !w.enabled ? "Pausado" : w.paused ? (clicking ? "En pausa por clicks manuales" : "En pausa") : !w.running ? "Detenido" : w.waiting === "sin_politica" ? "En espera: sin politica activa" : w.outsideHours ? "Fuera del horario de visitas" : "Activo"
    );
    const t = w.totals || {};
    kv($("ops-worker"), [
      ["Visitas abiertas", `${w.active} de ${w.concurrency}`],
      ["En buffer", fmtNum(w.buffered)],
      ["Chromium", w.browserOpen ? "abierto" : "cerrado"],
      ["Desde el arranque", `${fmtNum(t.success)} ok · ${fmtNum(t.failed)} fallidos · ${fmtNum(t.retry)} reintentos`],
    ]);
    $("ops-worker-toggle").textContent = w.enabled ? "Pausar worker" : "Reanudar worker";
    $("ops-worker-toggle").className = `btn${w.enabled ? " danger" : " primary"}`;

    const q = data.queue;
    kv($("ops-queue"), q
      ? [
          ["Pendientes", fmtNum(q.pending)],
          ["Para reintentar", fmtNum(q.retry)],
          ["En proceso", fmtNum(q.processing)],
          ["Atraso", fmtDuration(q.lagSeconds)],
        ]
      : [["Estado", "no se pudo leer la cola"]]);
    $("ops-updated").textContent = `Actualizado ${fmtDate(data.generatedAt)}`;
  }

  function renderClicks(data) {
    const box = $("clicks-current");
    box.replaceChildren();
    const c = data.current;
    if (c) {
      const pct = c.total ? Math.round((100 * c.completed) / c.total) : 0;
      const head = el("div", { class: "form-row", style: "justify-content:space-between;margin-top:0" });
      const lote = c.batch ? ` · job ${c.batch.index}/${c.batch.size} del lote` : "";
      head.append(el("b", null, `${JOB_STATUS[c.status] || c.status}${lote}`));
      const cancel = el("button", { type: "button", class: "btn danger" }, "Cancelar");
      cancel.disabled = c.status !== "running";
      cancel.addEventListener("click", cancelClicks);
      head.append(cancel);
      const bar = el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) });
      const fill = el("div");
      fill.style.width = `${pct}%`;
      bar.append(fill);
      box.append(
        head,
        el("div", { class: "muted", style: "overflow-wrap:anywhere" }, c.url),
        bar,
        el("div", { class: "muted" }, `${fmtNum(c.completed)}/${fmtNum(c.total)} (${pct}%) · ${fmtNum(c.ok)} ok · ${fmtNum(c.failed)} fallos${data.queued.length ? ` · ${data.queued.length} jobs en cola` : ""}`)
      );
      if (c.lastError) box.append(el("div", { class: "err" }, `Ultimo error: ${c.lastError.split("\n")[0].slice(0, 160)}`));
    } else if (data.queued.length) {
      box.append(el("div", { class: "muted" }, `${data.queued.length} jobs en cola, esperando que el worker suelte Chromium…`));
    }

    table(
      $("clicks-history"),
      [
        { label: "Inicio", cls: "time", render: (j) => fmtDate(j.startedAt) },
        { label: "Estado", render: (j) => JOB_STATUS[j.status] || j.status },
        { label: "URL", cls: "link", render: (j) => j.url },
        { label: "Hechas", num: true, render: (j) => `${fmtNum(j.completed)}/${fmtNum(j.total)}` },
        { label: "OK", num: true, render: (j) => fmtNum(j.ok) },
        { label: "Fallos", num: true, render: (j) => fmtNum(j.failed) },
      ],
      data.jobs,
      "Todavia no se lanzaron clicks desde que arranco el proceso"
    );
  }

  async function refresh() {
    clearTimeout(timer);
    let fast = false;
    try {
      const [st, clicks] = await Promise.all([api("/admin/status"), api("/clicks")]);
      renderStatus(st);
      renderClicks(clicks);
      fast = Boolean(clicks.current) || clicks.queued.length > 0;
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
    if (CM.currentView() === "operacion") timer = setTimeout(refresh, fast ? FAST_MS : SLOW_MS);
  }

  async function toggle(target, enabled) {
    const op = enabled ? "pause" : "resume";
    const what = target === "scheduler" ? "la ingesta automatica" : "el worker";
    if (enabled && !confirm(`¿Pausar ${what}? Queda guardado hasta que lo reanudes.`)) return;
    try {
      await api(`/admin/actions/${target}/${op}`, { method: "POST" });
      await refresh();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  async function cancelClicks() {
    if (!confirm("¿Cancelar el job en curso y los que esperan en cola?")) return;
    try {
      await api("/clicks/cancel", { method: "POST" });
      await refresh();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  function result(id, text, bad) {
    $(id).textContent = text;
    $(id).className = `result${bad ? " bad" : ""}`;
  }

  $("ops-sched-toggle").addEventListener("click", () => status && toggle("scheduler", status.scheduler.enabled));
  $("ops-worker-toggle").addEventListener("click", () => status && toggle("worker", status.worker.enabled));

  $("ops-recover").addEventListener("click", async () => {
    const force = $("ops-recover-force").checked;
    if (force && !confirm("Forzar devuelve a la cola tambien las reservas vigentes. Solo usarlo con UNA instancia. ¿Seguir?")) return;
    result("ops-recover-result", "Recuperando…");
    try {
      const r = await api("/processing/recover", { method: "POST", body: { force } });
      result("ops-recover-result", `${fmtNum(r.recovered)} trabajos devueltos a la cola`);
      refresh();
    } catch (err) {
      result("ops-recover-result", errorText(err), true);
    }
  });

  $("ops-sync").addEventListener("submit", async (e) => {
    e.preventDefault();
    const start = new Date($("ops-sync-start").value);
    const end = new Date($("ops-sync-end").value);
    if (!(end > start)) return result("ops-sync-result", "El fin tiene que ser posterior al inicio", true);
    result("ops-sync-result", "Pidiendo la ventana a Alaris (puede tardar varios minutos)…");
    try {
      const run = await api("/sync", { method: "POST", body: { start: start.toISOString(), end: end.toISOString() } });
      result("ops-sync-result", `${run.status}: ${fmtNum(run.recordsReceived)} SMS recibidos, ${fmtNum(run.smsNew)} nuevos, ${fmtNum(run.jobsCreated)} a visitar`);
    } catch (err) {
      const run = err.data && err.data.runId ? err.data : null;
      result("ops-sync-result", run ? `Fallo la ventana: ${run.error}` : errorText(err), true);
    }
    refresh();
  });

  $("clicks-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/clicks", { method: "POST", body: { url: $("clicks-url").value.trim(), count: Number($("clicks-count").value) } });
      result("clicks-result", "Job lanzado");
      refresh();
    } catch (err) {
      result("clicks-result", errorText(err), true);
    }
  });

  $("clicks-batch-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) $("clicks-batch-text").value = await file.text();
  });

  $("clicks-batch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("clicks-batch-text").value;
    if (!text.trim()) return result("clicks-result", "El lote esta vacio", true);
    try {
      const r = await api("/clicks/batch", { method: "POST", body: text });
      result("clicks-result", `Lote encolado: ${r.jobs} jobs, ${fmtNum(r.totalVisits)} visitas`);
      refresh();
    } catch (err) {
      result("clicks-result", errorText(err), true);
    }
  });

  function toLocalInput(d) {
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  }

  CM.onEnter("operacion", () => {
    if (!$("ops-sync-start").value) {
      const end = new Date(Math.floor(Date.now() / 1800000) * 1800000);
      $("ops-sync-start").value = toLocalInput(new Date(end.getTime() - 1800000));
      $("ops-sync-end").value = toLocalInput(end);
    }
    refresh();
  });
  CM.onLeave("operacion", () => clearTimeout(timer));
})();
