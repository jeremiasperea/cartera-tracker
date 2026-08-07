// Sin framework, sin bundler: módulos de scope usando closures + IIFE
const invoke = window.__TAURI__.core.invoke;

// ============ CONFIG (cargado dinámicamente desde Rust) ============
const Config = (() => {
  let instrumentTypes = [];
  let tipoPanel = {};
  let tipoLabel = {};

  return {
    async load() {
      instrumentTypes = await invoke("get_instrument_types");
      for (const type of instrumentTypes) {
        tipoLabel[type.id] = type.label;
        tipoPanel[type.id] = type.panel || null;
      }
    },
    getPanelForTipo(tipo) {
      return tipoPanel[tipo] || null;
    },
    getLabelForTipo(tipo) {
      return tipoLabel[tipo] || tipo;
    },
    getInstrumentTypes() {
      return instrumentTypes;
    },
    isValidTipo(tipo) {
      return tipo in tipoPanel;
    },
  };
})();

// ============ STATE (gestión centralizada de estado) ============
const State = (() => {
  const data = {
    positions: [],
    snapshot: null, // último MarketSnapshot devuelto por fetch_quotes
    cooldownRemaining: 0,
    cooldownTimer: null,
  };

  return {
    getPositions() {
      return data.positions;
    },
    setPositions(positions) {
      data.positions = positions;
    },
    getSnapshot() {
      return data.snapshot;
    },
    setSnapshot(snapshot) {
      data.snapshot = snapshot;
    },
    getCooldownRemaining() {
      return data.cooldownRemaining;
    },
    setCooldownRemaining(seconds) {
      data.cooldownRemaining = seconds;
    },
    getCooldownTimer() {
      return data.cooldownTimer;
    },
    setCooldownTimer(timer) {
      data.cooldownTimer = timer;
    },
  };
})();

// ============ MARKET (lógica de negocio: cotizaciones y cálculos) ============
const Market = (() => {
  function getQuoteForPosition(position, snapshot) {
    if (!snapshot) return null;
    const panel = Config.getPanelForTipo(position.tipo);
    if (!panel) return null;
    return snapshot.panels[panel]?.[position.ticker] ?? null;
  }

  function computeRowMetrics(position, snapshot) {
    const quote = getQuoteForPosition(position, snapshot);
    const precioActual = position.precio_manual ?? quote?.c ?? null;
    const esManual = position.precio_manual != null;
    const sinCotizacion = precioActual == null;

    const valorizado = sinCotizacion ? null : position.cantidad * precioActual;
    const gasto = position.cantidad * position.precio_compra;
    const rendimientoMonto = sinCotizacion ? null : valorizado - gasto;
    const rendimientoPct =
      sinCotizacion || position.precio_compra <= 0
        ? null
        : (precioActual / position.precio_compra - 1) * 100;

    return {
      precioActual,
      esManual,
      sinCotizacion,
      variacionDiaria: quote?.pct_change ?? null,
      valorizado,
      rendimientoMonto,
      rendimientoPct,
    };
  }

  return {
    getQuoteForPosition,
    computeRowMetrics,
  };
})();

// ============ FORMAT (utilidades de formato) ============
const Format = (() => {
  return {
    money(n) {
      return n == null || Number.isNaN(n)
        ? "—"
        : n.toLocaleString("es-AR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
    },
    percentage(n) {
      return n == null || Number.isNaN(n)
        ? "—"
        : `${n >= 0 ? "+" : ""}${n.toLocaleString("es-AR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}%`;
    },
    cooldown(s) {
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${String(r).padStart(2, "0")}`;
    },
    escapeHtml(s) {
      const div = document.createElement("div");
      div.textContent = s ?? "";
      return div.innerHTML;
    },
  };
})();

// ============ UI (renderizado e interacción con DOM) ============
const UI = (() => {
  function renderPortfolioTable() {
    const tbody = document.getElementById("tbody-cartera");
    const tablaVacia = document.getElementById("tabla-vacia");
    const tabla = document.getElementById("tabla-cartera");

    const positions = State.getPositions();
    const snapshot = State.getSnapshot();

    tbody.innerHTML = "";

    if (positions.length === 0) {
      tabla.hidden = true;
      tablaVacia.hidden = false;
      document.getElementById("total-valorizado").textContent = "—";
      document.getElementById("total-rendimiento").textContent = "—";
      return;
    }

    tabla.hidden = false;
    tablaVacia.hidden = true;

    let totalValorizado = 0;
    let totalGasto = 0;
    let huboSinCotizacion = false;

    for (const p of positions) {
      const r = Market.computeRowMetrics(p, snapshot);
      if (!r.sinCotizacion) {
        totalValorizado += r.valorizado;
        totalGasto += p.cantidad * p.precio_compra;
      } else {
        huboSinCotizacion = true;
      }

      const tr = document.createElement("tr");
      const claseRend =
        r.rendimientoMonto == null
          ? ""
          : r.rendimientoMonto >= 0
            ? "gain"
            : "loss";
      const claseVar =
        r.variacionDiaria == null
          ? ""
          : r.variacionDiaria >= 0
            ? "gain"
            : "loss";

      tr.innerHTML = `
        <td>${Format.escapeHtml(p.ticker)}</td>
        <td class="nombre">${Format.escapeHtml(p.nombre)}</td>
        <td>${Config.getLabelForTipo(p.tipo)}</td>
        <td class="num">${Format.money(p.cantidad)}</td>
        <td class="num">${Format.money(p.precio_compra)}</td>
        <td class="num">${
          r.sinCotizacion
            ? "sin datos"
            : Format.money(r.precioActual) +
              (r.esManual ? ' <span class="tag">manual</span>' : "")
        }</td>
        <td class="num ${claseVar}">${Format.percentage(r.variacionDiaria)}</td>
        <td class="num">${Format.money(r.valorizado)}</td>
        <td class="num ${claseRend}">${Format.money(r.rendimientoMonto)} (${Format.percentage(r.rendimientoPct)})</td>
        <td class="row-actions">
          <button data-action="editar" data-id="${p.id}">Editar</button>
          <button data-action="borrar" data-id="${p.id}">Borrar</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    document.getElementById("total-valorizado").textContent = Format.money(
      totalValorizado
    );
    const rendTotalMonto = totalValorizado - totalGasto;
    const rendTotalPct =
      totalGasto > 0 ? (totalValorizado / totalGasto - 1) * 100 : null;
    document.getElementById("total-rendimiento").textContent =
      `${Format.money(rendTotalMonto)} (${Format.percentage(rendTotalPct)})`;

    const warning = document.getElementById("market-warning");
    if (huboSinCotizacion) {
      warning.hidden = false;
      warning.textContent =
        "Hay posiciones sin cotizacion automatica (no cubiertas por data912, o todavia no actualizaste). " +
        "El total valorizado no las incluye salvo que cargues un precio manual.";
    } else {
      warning.hidden = true;
    }
  }

  function renderMarketMeta() {
    const meta = document.getElementById("market-meta");
    const snapshot = State.getSnapshot();

    if (!snapshot) {
      meta.textContent = "Todavia no trajiste cotizaciones en esta sesion.";
      return;
    }
    const fecha = new Date(snapshot.fetched_at_ms);
    let texto = `Ultima actualizacion: ${fecha.toLocaleString("es-AR")}.`;
    if (snapshot.errores?.length) {
      texto += ` Fallaron ${snapshot.errores.length} panel(es): ${snapshot.errores.join(" / ")}`;
    }
    meta.textContent = texto;
  }

  function setCooldownButtonState(seconds) {
    const btn = document.getElementById("btn-refresh");
    if (seconds > 0) {
      btn.disabled = true;
      btn.textContent = `Actualizar cotizaciones (${Format.cooldown(seconds)})`;
    } else {
      btn.disabled = false;
      btn.textContent = "Actualizar cotizaciones";
    }
  }

  return {
    render() {
      renderPortfolioTable();
    },
    renderMarketMeta,
    setCooldownButtonState,
    showDialog(dialogId) {
      document.getElementById(dialogId).showModal();
    },
    closeDialog(dialogId) {
      document.getElementById(dialogId).close();
    },
  };
})();

// ============ COOLDOWN (manejo del cooldown con UI) ============
const Cooldown = (() => {
  const COOLDOWN_SECONDS = 300;

  function startCooldownCountdown(initialSeconds) {
    const timer = State.getCooldownTimer();
    if (timer) clearInterval(timer);

    State.setCooldownRemaining(initialSeconds);
    UI.setCooldownButtonState(initialSeconds);

    const newTimer = setInterval(() => {
      const next = State.getCooldownRemaining() - 1;
      State.setCooldownRemaining(Math.max(next, 0));
      UI.setCooldownButtonState(Math.max(next, 0));
      if (next <= 0) clearInterval(newTimer);
    }, 1000);

    State.setCooldownTimer(newTimer);
  }

  return {
    COOLDOWN_SECONDS,
    startCooldownCountdown,
  };
})();

// ============ PERSISTENCE (carga/guardar de datos) ============
const Persistence = (() => {
  async function loadPortfolio() {
    const positions = await invoke("load_portfolio");
    State.setPositions(positions);
  }

  async function savePortfolio() {
    const positions = State.getPositions();
    await invoke("save_portfolio", { positions });
  }

  async function fetchQuotesFromBackend() {
    const snapshot = await invoke("fetch_quotes");
    State.setSnapshot(snapshot);
  }

  // El backend persiste el snapshot al traerlo, así que acá solo lo leemos.
  async function loadSnapshot() {
    const snapshot = await invoke("read_snapshot");
    if (snapshot) State.setSnapshot(snapshot);
  }

  async function getCooldownStatus() {
    return await invoke("get_cooldown_status");
  }

  return {
    loadPortfolio,
    savePortfolio,
    fetchQuotesFromBackend,
    loadSnapshot,
    getCooldownStatus,
  };
})();

// ============ MARKET OPERATIONS (refresh, import/export) ============
const MarketOps = (() => {
  async function refreshQuotes() {
    if (State.getCooldownRemaining() > 0) return;

    const btn = document.getElementById("btn-refresh");
    btn.disabled = true;
    btn.textContent = "Actualizando...";

    try {
      await Persistence.fetchQuotesFromBackend();
      UI.renderMarketMeta();
      UI.render();
      Cooldown.startCooldownCountdown(Cooldown.COOLDOWN_SECONDS);
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("COOLDOWN:")) {
        const restantes = parseInt(msg.split(":")[1], 10) || 0;
        Cooldown.startCooldownCountdown(restantes);
      } else {
        State.setCooldownRemaining(0);
        UI.setCooldownButtonState(0);
        alert(`No pude traer cotizaciones: ${msg}`);
      }
    }
  }

  return {
    refreshQuotes,
  };
})();

// ============ PORTFOLIO OPERATIONS (CRUD de posiciones) ============
const PortfolioOps = (() => {
  function generateId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function normalizarPosicion(raw) {
    const tipo = String(raw.tipo ?? "otro").trim().toLowerCase();
    if (!Config.isValidTipo(tipo)) {
      throw new Error(
        `tipo invalido "${raw.tipo}". Usa: ${Config.getInstrumentTypes()
          .map((t) => t.id)
          .join(", ")}`
      );
    }
    const cantidad = parseFloat(raw.cantidad);
    const precioCompra = parseFloat(raw.precio_compra);
    if (Number.isNaN(cantidad) || Number.isNaN(precioCompra)) {
      throw new Error(`cantidad/precio_compra invalidos para el ticker "${raw.ticker}"`);
    }
    const precioManualRaw = raw.precio_manual;
    const precioManual =
      precioManualRaw === "" || precioManualRaw == null
        ? null
        : parseFloat(precioManualRaw);

    return {
      id: raw.id || generateId(),
      ticker: String(raw.ticker ?? "").trim().toUpperCase(),
      nombre: String(raw.nombre ?? "").trim(),
      tipo,
      cantidad,
      precio_compra: precioCompra,
      precio_manual: Number.isNaN(precioManual) ? null : precioManual,
    };
  }

  function parsePositionsJson(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data))
      throw new Error("el JSON debe ser un array de posiciones");
    return data.map((raw) => normalizarPosicion(raw));
  }

  function parsePositionsCsv(text) {
    const lineas = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lineas.length === 0) return [];

    const header = lineas[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = (col) => header.indexOf(col);
    const iTicker = idx("ticker");
    const iNombre = idx("nombre");
    const iTipo = idx("tipo");
    const iCantidad = idx("cantidad");
    const iPrecioCompra = idx("precio_compra");
    const iPrecioManual = idx("precio_manual");

    if ([iTicker, iNombre, iTipo, iCantidad, iPrecioCompra].some((i) => i === -1)) {
      throw new Error(
        "el CSV necesita header: ticker,nombre,tipo,cantidad,precio_compra[,precio_manual]"
      );
    }

    return lineas.slice(1).map((linea) => {
      const cols = linea.split(",");
      return normalizarPosicion({
        ticker: cols[iTicker],
        nombre: cols[iNombre],
        tipo: cols[iTipo],
        cantidad: cols[iCantidad],
        precio_compra: cols[iPrecioCompra],
        precio_manual: iPrecioManual >= 0 ? cols[iPrecioManual] : "",
      });
    });
  }

  async function addPosition(position) {
    const positions = State.getPositions();
    const idx = positions.findIndex((x) => x.id === position.id);
    if (idx >= 0) {
      positions[idx] = position;
    } else {
      positions.push(position);
    }
    State.setPositions(positions);
    await Persistence.savePortfolio();
    UI.render();
  }

  async function deletePosition(id) {
    if (!confirm("¿Borrar esta posicion de la cartera?")) return;
    const positions = State.getPositions().filter((x) => x.id !== id);
    State.setPositions(positions);
    await Persistence.savePortfolio();
    UI.render();
  }

  return {
    normalizarPosicion,
    parsePositionsJson,
    parsePositionsCsv,
    addPosition,
    deletePosition,
  };
})();

// ============ DIALOG MANAGEMENT (diálogos de edición) ============
const Dialogs = (() => {
  function openNewPositionDialog() {
    document.getElementById("dialog-titulo").textContent = "Nueva posicion";
    document.getElementById("form-posicion").reset();
    document.getElementById("f-id").value = "";
    UI.showDialog("dialog-posicion");
  }

  function openEditPositionDialog(id) {
    const p = State.getPositions().find((x) => x.id === id);
    if (!p) return;
    document.getElementById("dialog-titulo").textContent = "Editar posicion";
    document.getElementById("f-id").value = p.id;
    document.getElementById("f-ticker").value = p.ticker;
    document.getElementById("f-nombre").value = p.nombre;
    document.getElementById("f-tipo").value = p.tipo;
    document.getElementById("f-cantidad").value = p.cantidad;
    document.getElementById("f-precio-compra").value = p.precio_compra;
    document.getElementById("f-precio-manual").value = p.precio_manual ?? "";
    UI.showDialog("dialog-posicion");
  }

  async function savePositionFromDialog(ev) {
    ev.preventDefault();
    const id = document.getElementById("f-id").value || PortfolioOps.generateId?.() || "";
    const nueva = {
      id,
      ticker: document.getElementById("f-ticker").value.trim().toUpperCase(),
      nombre: document.getElementById("f-nombre").value.trim(),
      tipo: document.getElementById("f-tipo").value,
      cantidad: parseFloat(document.getElementById("f-cantidad").value),
      precio_compra: parseFloat(document.getElementById("f-precio-compra").value),
      precio_manual: document.getElementById("f-precio-manual").value
        ? parseFloat(document.getElementById("f-precio-manual").value)
        : null,
    };

    await PortfolioOps.addPosition(nueva);
    UI.closeDialog("dialog-posicion");
  }

  let pendingImport = null;

  function showImportConfirmation(nuevasPosiciones, origen) {
    pendingImport = nuevasPosiciones;
    document.getElementById("confirm-import-texto").textContent =
      `Vas a reemplazar las ${State.getPositions().length} posiciones actuales por ` +
      `${nuevasPosiciones.length} posiciones nuevas leidas desde ${origen}. Esta accion no se puede deshacer.`;
    UI.showDialog("dialog-confirm-import");
  }

  async function confirmImport() {
    if (!pendingImport) return;
    State.setPositions(pendingImport);
    pendingImport = null;
    await Persistence.savePortfolio();
    UI.render();
  }

  function cancelImport() {
    pendingImport = null;
    UI.closeDialog("dialog-confirm-import");
  }

  return {
    openNewPositionDialog,
    openEditPositionDialog,
    savePositionFromDialog,
    showImportConfirmation,
    confirmImport,
    cancelImport,
  };
})();

// ============ EXPORT (descarga de datos) ============
const Export = (() => {
  function exportPositionsAsJson() {
    const blob = new Blob([JSON.stringify(State.getPositions(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cartera_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return {
    exportPositionsAsJson,
  };
})();

// ============ EVENT WIRING (conectar botones y eventos) ============
const EventWiring = (() => {
  function wireEvents() {
    // Botones principales
    document
      .getElementById("btn-refresh")
      .addEventListener("click", () => MarketOps.refreshQuotes());
    document
      .getElementById("btn-add")
      .addEventListener("click", () => Dialogs.openNewPositionDialog());
    document
      .getElementById("btn-cancelar")
      .addEventListener("click", () => UI.closeDialog("dialog-posicion"));

    // Formulario de posición
    document
      .getElementById("form-posicion")
      .addEventListener("submit", (ev) => Dialogs.savePositionFromDialog(ev));

    // Acciones en la tabla (editar/borrar)
    document
      .getElementById("tbody-cartera")
      .addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-action]");
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === "editar")
          Dialogs.openEditPositionDialog(id);
        if (btn.dataset.action === "borrar")
          PortfolioOps.deletePosition(id);
      });

    // Import JSON
    document
      .getElementById("btn-import-json")
      .addEventListener("click", () => {
        document.getElementById("file-json").click();
      });
    document
      .getElementById("file-json")
      .addEventListener("change", async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = "";
        if (!file) return;
        try {
          const texto = await file.text();
          const nuevas = PortfolioOps.parsePositionsJson(texto);
          Dialogs.showImportConfirmation(nuevas, `el archivo "${file.name}"`);
        } catch (err) {
          alert(`No pude leer el JSON: ${err.message}`);
        }
      });

    // Import CSV
    document
      .getElementById("btn-import-csv")
      .addEventListener("click", () => {
        document.getElementById("file-csv").click();
      });
    document
      .getElementById("file-csv")
      .addEventListener("change", async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = "";
        if (!file) return;
        try {
          const texto = await file.text();
          const nuevas = PortfolioOps.parsePositionsCsv(texto);
          Dialogs.showImportConfirmation(nuevas, `el archivo "${file.name}"`);
        } catch (err) {
          alert(`No pude leer el CSV: ${err.message}`);
        }
      });

    // Diálogo de confirmación de import
    document
      .getElementById("btn-import-cancelar")
      .addEventListener("click", () => Dialogs.cancelImport());
    document
      .getElementById("dialog-confirm-import")
      .querySelector("form")
      .addEventListener("submit", async (ev) => {
        ev.preventDefault();
        await Dialogs.confirmImport();
        UI.closeDialog("dialog-confirm-import");
      });

    // Export
    document
      .getElementById("btn-export")
      .addEventListener("click", () => Export.exportPositionsAsJson());
  }

  return {
    wireEvents,
  };
})();

// ============ APP (inicialización) ============
const App = (() => {
  async function initialize() {
    // Cargar configuración desde Rust
    await Config.load();

    // Cargar cartera y ultimas cotizaciones desde disco
    await Persistence.loadPortfolio();
    await Persistence.loadSnapshot();

    // Renderizar UI inicial
    UI.render();
    UI.renderMarketMeta();

    // Verificar cooldown
    const cooldownInicial = await Persistence.getCooldownStatus();
    if (cooldownInicial > 0) Cooldown.startCooldownCountdown(cooldownInicial);

    // Conectar eventos
    EventWiring.wireEvents();
  }

  return {
    initialize,
  };
})();

// Iniciar cuando el DOM esté listo
App.initialize();
