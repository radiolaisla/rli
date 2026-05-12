const defaultConfig = {
  workerUrl: "https://rli-github-api.tu-subdominio.workers.dev",
  schedulePath: "programacion.csv",
  podcastsPath: "podcasts.json"
};

const githubTarget = {
  owner: "rariolaisla",
  repo: "rli",
  branch: "main"
};

const days = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
const state = {
  config: loadConfig(),
  schedule: [],
  podcasts: [],
  scheduleSha: null,
  podcastsSha: null,
  hasUnsavedChanges: false,
  currentStatus: "idle",
  scheduleView: "week"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

document.addEventListener("DOMContentLoaded", () => {
  fillConfigForm();
  bindEvents();
  renderAll();
  setStatus("idle", "Sin cargar");
});

function bindEvents() {
  $("#openConfig").addEventListener("click", () => $("#configDialog").showModal());
  $("#configForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.config = readConfigForm();
    saveConfig(state.config);
    updateRepoSummary();
    $("#configDialog").close();
    setStatus("success", "Configuracion guardada");
  });
  $("#testConnection").addEventListener("click", testConnection);

  $("#loadAll").addEventListener("click", loadAllFiles);
  $("#saveAll").addEventListener("click", saveAllChanges);
  $("#addSchedule").addEventListener("click", () => openScheduleDialog());
  $("#addPodcast").addEventListener("click", () => openPodcastDialog());
  $("#dayFilter").addEventListener("change", renderSchedule);
  $("#scheduleSearch").addEventListener("input", renderSchedule);
  $("#weeklyView").addEventListener("click", () => setScheduleView("week"));
  $("#tableView").addEventListener("click", () => setScheduleView("table"));
  $("#podcastWeb").addEventListener("input", updateRssPreview);

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.remove("active"));
      $$(".tab-panel").forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.tab}Panel`).classList.add("active");
    });
  });

  $$("[data-close]").forEach((button) => {
    button.addEventListener("click", () => $(`#${button.dataset.close}`).close());
  });

  $("#scheduleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    upsertScheduleItem();
  });

  $("#podcastForm").addEventListener("submit", (event) => {
    event.preventDefault();
    upsertPodcastFromForm();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.hasUnsavedChanges) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function loadConfig() {
  try {
    return { ...defaultConfig, ...JSON.parse(localStorage.getItem("radioGithubPanelConfig") || "{}") };
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  localStorage.setItem("radioGithubPanelConfig", JSON.stringify(config));
}

function fillConfigForm() {
  $("#workerUrl").value = state.config.workerUrl;
  $("#schedulePath").value = state.config.schedulePath;
  $("#podcastsPath").value = state.config.podcastsPath;
}

function readConfigForm() {
  return {
    workerUrl: $("#workerUrl").value.trim(),
    schedulePath: $("#schedulePath").value.trim() || "programacion.csv",
    podcastsPath: $("#podcastsPath").value.trim() || "podcasts.json"
  };
}

function renderAll() {
  updateRepoSummary();
  renderDayFilter();
  renderScheduleOptions();
  renderSchedule();
  renderPodcasts();
  updateSaveButton();
}

function updateRepoSummary() {
  const summary = $("#repoSummary");
  const workerStatus = state.config.workerUrl ? "Worker configurado" : "Worker sin configurar";
  summary.textContent = `Repositorio: ${githubTarget.owner}/${githubTarget.repo} - Rama: ${githubTarget.branch} - ${workerStatus}`;
}

async function loadAllFiles() {
  state.config = readConfigForm();
  saveConfig(state.config);
  updateRepoSummary();
  setStatus("loading", "Cargando");

  try {
    const [scheduleFile, podcastsFile] = await Promise.all([
      getGithubFileOrDefault(state.config.schedulePath, "dia,inicio,fin,programa,locutor,descripcion\n"),
      getGithubFileOrDefault(state.config.podcastsPath, "[]\n")
    ]);

    state.scheduleSha = scheduleFile.sha;
    state.podcastsSha = podcastsFile.sha;
    state.schedule = parseCsv(scheduleFile.content);
    state.podcasts = normalizePodcasts(JSON.parse(podcastsFile.content || "[]"));
    setUnsavedChanges(false);
    renderAll();

    const missingFiles = [scheduleFile, podcastsFile].filter((file) => file.missing).map((file) => file.path);
    setStatus(
      missingFiles.length ? "warning" : "connected",
      missingFiles.length ? `Se crearan al guardar: ${missingFiles.join(", ")}` : "Conectado"
    );
  } catch (error) {
    setStatus("error", friendlyError(error));
  }
}

async function testConnection() {
  state.config = readConfigForm();
  saveConfig(state.config);
  updateRepoSummary();
  setStatus("loading", "Probando conexion");
  try {
    await getGithubFileOrDefault(state.config.schedulePath, "dia,inicio,fin,programa,locutor,descripcion\n");
    setStatus("connected", "Conexion correcta");
  } catch (error) {
    setStatus("error", friendlyError(error));
  }
}

async function saveAllChanges() {
  state.config = readConfigForm();
  saveConfig(state.config);
  updateRepoSummary();
  setStatus("saving", "Guardando");

  try {
    state.scheduleSha = await putGithubFile(
      state.config.schedulePath,
      toCsv(state.schedule),
      state.scheduleSha,
      "Actualizar programacion de radio"
    );
    state.podcastsSha = await putGithubFile(
      state.config.podcastsPath,
      `${JSON.stringify(state.podcasts, null, 2)}\n`,
      state.podcastsSha,
      "Actualizar podcasts"
    );
    setUnsavedChanges(false);
    setStatus("saved", "Guardado");
  } catch (error) {
    setStatus("error", friendlyError(error, true));
  }
}

async function getGithubFile(path) {
  const data = await workerRequest(`/api/file?path=${encodeURIComponent(path)}`);
  return { path, sha: data.sha, content: data.content || "" };
}

async function getGithubFileOrDefault(path, defaultContent) {
  try {
    return await getGithubFile(path);
  } catch (error) {
    if (error.status === 404 || /not found/i.test(error.message)) {
      return { path, sha: null, content: defaultContent, missing: true };
    }
    throw error;
  }
}

async function putGithubFile(path, content, sha, message) {
  const data = await workerRequest("/api/file", {
    method: "PUT",
    body: JSON.stringify({ path, content, sha, message })
  });
  return data.sha;
}

async function workerRequest(path, options = {}) {
  const baseUrl = state.config.workerUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("missing_worker_url");
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers
    });
  } catch (error) {
    const workerError = new Error("worker_network_error");
    workerError.cause = error;
    throw workerError;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || "worker_error");
    error.status = response.status;
    error.path = data.path;
    throw error;
  }
  return data;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted && char === '"' && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header = [], ...dataRows] = rows.filter((item) => item.some((cell) => cell.trim() !== ""));
  const keys = header.map((item) => item.trim().toLowerCase());
  return dataRows.map((cells) => ({
    dia: canonicalDay(cells[keys.indexOf("dia")] || ""),
    inicio: cells[keys.indexOf("inicio")] || "",
    fin: cells[keys.indexOf("fin")] || "",
    programa: cells[keys.indexOf("programa")] || "",
    locutor: cells[keys.indexOf("locutor")] || "",
    descripcion: cells[keys.indexOf("descripcion")] || ""
  }));
}

function toCsv(items) {
  const header = ["dia", "inicio", "fin", "programa", "locutor", "descripcion"];
  const lines = [header.join(",")];
  items
    .slice()
    .sort(compareSchedule)
    .forEach((item) => {
      lines.push(header.map((key) => csvCell(item[key] || "")).join(","));
    });
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function setScheduleView(view) {
  state.scheduleView = view;
  renderSchedule();
}

function renderDayFilter() {
  const select = $("#dayFilter");
  const current = select.value;
  select.innerHTML = '<option value="">Todos</option>';
  days.forEach((day) => {
    const option = document.createElement("option");
    option.value = day;
    option.textContent = dayLabel(day);
    select.appendChild(option);
  });
  select.value = days.includes(current) ? current : "";
}

function renderScheduleOptions() {
  renderDatalist("programOptions", state.schedule.map((item) => item.programa));
  renderDatalist("hostOptions", state.schedule.map((item) => item.locutor));
}

function renderDatalist(id, values) {
  const list = $(`#${id}`);
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  list.innerHTML = "";
  uniqueValues.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    list.appendChild(option);
  });
}

function filteredSchedule() {
  const filter = $("#dayFilter").value;
  const search = normalizeText($("#scheduleSearch").value.trim());
  return state.schedule
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !filter || canonicalDay(item.dia) === filter)
    .filter(({ item }) => !search || normalizeText(Object.values(item).join(" ")).includes(search))
    .sort((a, b) => compareSchedule(a.item, b.item));
}

function renderSchedule() {
  $("#weeklyView").classList.toggle("active-view", state.scheduleView === "week");
  $("#tableView").classList.toggle("active-view", state.scheduleView === "table");
  $("#scheduleWeek").classList.toggle("hidden", state.scheduleView !== "week");
  $("#scheduleTableWrap").classList.toggle("hidden", state.scheduleView !== "table");
  renderWeeklySchedule();
  renderScheduleTable();
  bindScheduleActionButtons();
}

function renderWeeklySchedule() {
  const container = $("#scheduleWeek");
  const rows = filteredSchedule();
  container.innerHTML = "";

  if (!rows.length && !state.schedule.length) {
    container.appendChild(emptyState("Todavia no hay programas cargados. Carga los archivos desde GitHub o anade el primer programa manualmente.", [
      { label: "Cargar archivos", action: loadAllFiles },
      { label: "Anadir programa", action: () => openScheduleDialog() }
    ]));
    return;
  }

  days.forEach((day) => {
    const dayRows = rows.filter(({ item }) => canonicalDay(item.dia) === day);
    if ($("#dayFilter").value && !dayRows.length) return;
    const column = document.createElement("section");
    column.className = "day-column";
    column.innerHTML = `
      <div class="day-heading">
        <h3>${escapeHtml(dayLabel(day))}</h3>
        <span>${dayRows.length}</span>
      </div>
    `;
    const list = document.createElement("div");
    list.className = "program-card-list";

    if (!dayRows.length) {
      list.innerHTML = '<div class="muted-card">Sin programas</div>';
    } else {
      dayRows.forEach(({ item, index }) => list.appendChild(programCard(item, index)));
    }

    column.appendChild(list);
    container.appendChild(column);
  });

}

function programCard(item, index) {
  const card = document.createElement("article");
  card.className = "program-card";
  card.innerHTML = `
    <div class="program-time">${escapeHtml(item.inicio)} - ${escapeHtml(item.fin)}</div>
    <h4>${escapeHtml(item.programa)}</h4>
    <p class="program-host">${escapeHtml(item.locutor || "Sin locutor")}</p>
    ${item.descripcion ? `<p class="program-description">${escapeHtml(item.descripcion)}</p>` : ""}
    <div class="card-actions">
      <button class="secondary" type="button" data-edit="${index}">Editar</button>
      <button class="secondary" type="button" data-duplicate="${index}">Duplicar</button>
      <button class="danger" type="button" data-delete="${index}">Eliminar</button>
    </div>
  `;
  return card;
}

function renderScheduleTable() {
  const body = $("#scheduleRows");
  const rows = filteredSchedule();
  body.innerHTML = "";

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="table-empty">No hay programas para mostrar.</td></tr>';
    return;
  }

  rows.forEach(({ item, index }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(dayLabel(item.dia))}</td>
      <td>${escapeHtml(item.inicio)}</td>
      <td>${escapeHtml(item.fin)}</td>
      <td>${escapeHtml(item.programa)}</td>
      <td>${escapeHtml(item.locutor)}</td>
      <td>${escapeHtml(item.descripcion)}</td>
      <td>
        <span class="row-actions">
          <button class="secondary" type="button" data-edit="${index}">Editar</button>
          <button class="secondary" type="button" data-duplicate="${index}">Duplicar</button>
          <button class="danger" type="button" data-delete="${index}">Eliminar</button>
        </span>
      </td>
    `;
    body.appendChild(tr);
  });
}

function bindScheduleActionButtons() {
  $$("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openScheduleDialog(Number(button.dataset.edit)));
  });
  $$("[data-duplicate]").forEach((button) => {
    button.addEventListener("click", () => duplicateScheduleItem(Number(button.dataset.duplicate)));
  });
  $$("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteScheduleItem(Number(button.dataset.delete)));
  });
}

function compareSchedule(a, b) {
  const dayA = dayOrder(a.dia);
  const dayB = dayOrder(b.dia);
  if (dayA !== dayB) return dayA - dayB;
  return (a.inicio || "").localeCompare(b.inicio || "");
}

function dayOrder(day) {
  const normalized = canonicalDay(day);
  const index = days.indexOf(normalized);
  return index === -1 ? 99 : index;
}

function canonicalDay(day) {
  const normalized = normalizeText(day);
  if (normalized === "miercoles") return "miercoles";
  if (normalized === "sabado") return "sabado";
  return days.includes(normalized) ? normalized : "";
}

function openScheduleDialog(index = null, baseItem = null) {
  const item = baseItem || (index === null ? {} : state.schedule[index]);
  renderScheduleOptions();
  hideFormError("scheduleError");
  $("#scheduleDialogTitle").textContent = index === null ? "Anadir programa" : "Editar programa";
  $("#scheduleIndex").value = index === null ? "" : String(index);
  $("#scheduleDay").value = canonicalDay(item.dia || "lunes");
  $("#scheduleStart").value = item.inicio || "";
  $("#scheduleEnd").value = item.fin || "";
  $("#scheduleProgram").value = item.programa || "";
  $("#scheduleHost").value = item.locutor || "";
  $("#scheduleDescription").value = item.descripcion || "";
  $("#scheduleDialog").showModal();
}

function upsertScheduleItem() {
  const item = {
    dia: $("#scheduleDay").value.trim(),
    inicio: $("#scheduleStart").value,
    fin: $("#scheduleEnd").value,
    programa: $("#scheduleProgram").value.trim(),
    locutor: $("#scheduleHost").value.trim(),
    descripcion: $("#scheduleDescription").value.trim()
  };
  const indexValue = $("#scheduleIndex").value;
  const index = indexValue === "" ? null : Number(indexValue);
  const validation = validateScheduleItem(item, index);
  if (!validation.valid) {
    showFormError("scheduleError", validation.message);
    return;
  }

  if (index === null) {
    state.schedule.push(item);
  } else {
    state.schedule[index] = item;
  }
  $("#scheduleDialog").close();
  markDataChanged();
  renderDayFilter();
  renderScheduleOptions();
  renderSchedule();
}

function validateScheduleItem(item, editingIndex) {
  if (!item.dia) return { valid: false, message: "Elige un dia de la semana." };
  if (!item.inicio) return { valid: false, message: "Indica la hora de inicio." };
  if (!item.fin) return { valid: false, message: "Indica la hora de fin." };
  if (!item.programa) return { valid: false, message: "Escribe el nombre del programa." };
  if (timeToMinutes(item.fin) <= timeToMinutes(item.inicio)) {
    return { valid: false, message: "La hora de fin debe ser posterior a la hora de inicio." };
  }

  const overlap = state.schedule.find((other, index) => {
    if (index === editingIndex) return false;
    if (canonicalDay(other.dia) !== canonicalDay(item.dia)) return false;
    return timeRangesOverlap(item.inicio, item.fin, other.inicio, other.fin);
  });

  if (overlap) {
    return {
      valid: false,
      message: `El horario se solapa con "${overlap.programa}" (${overlap.inicio}-${overlap.fin}).`
    };
  }
  return { valid: true };
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeRangesOverlap(startA, endA, startB, endB) {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(endA) > timeToMinutes(startB);
}

function duplicateScheduleItem(index) {
  const item = state.schedule[index];
  openScheduleDialog(null, { ...item });
}

function deleteScheduleItem(index) {
  state.schedule.splice(index, 1);
  markDataChanged();
  renderDayFilter();
  renderScheduleOptions();
  renderSchedule();
}

function normalizePodcasts(value) {
  const list = Array.isArray(value) ? value : value.podcasts || [];
  return list.map((item) => ({
    name: item.name || item.nombre || "",
    rssUrl: item.rssUrl || item.rss || item.enlace || item.url || ""
  }));
}

function renderPodcasts() {
  const list = $("#podcastList");
  list.innerHTML = "";
  if (!state.podcasts.length) {
    list.appendChild(emptyState("No hay podcasts cargados. Puedes cargar el archivo JSON desde GitHub o anadir un podcast de iVoox.", [
      { label: "Cargar archivos", action: loadAllFiles },
      { label: "Anadir podcast", action: () => openPodcastDialog() }
    ]));
    return;
  }

  state.podcasts.forEach((podcast, index) => {
    const item = document.createElement("article");
    item.className = "podcast-card";
    item.setAttribute("draggable", "false");
    item.innerHTML = `
      <div class="podcast-main">
        <span class="podcast-order">${index + 1}</span>
        <div>
          <h3>${escapeHtml(podcast.name)}</h3>
          <a href="${escapeAttribute(podcast.rssUrl)}" target="_blank" rel="noreferrer">${escapeHtml(podcast.rssUrl)}</a>
        </div>
      </div>
      <div class="card-actions">
        <button class="secondary" type="button" data-move-podcast="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}>Subir</button>
        <button class="secondary" type="button" data-move-podcast="${index}" data-direction="1" ${index === state.podcasts.length - 1 ? "disabled" : ""}>Bajar</button>
        <button class="secondary" type="button" data-edit-podcast="${index}">Editar</button>
        <button class="danger" type="button" data-remove-podcast="${index}">Eliminar</button>
      </div>
    `;
    list.appendChild(item);
  });

  $$("[data-move-podcast]").forEach((button) => {
    button.addEventListener("click", () => {
      movePodcast(Number(button.dataset.movePodcast), Number(button.dataset.direction));
    });
  });
  $$("[data-edit-podcast]").forEach((button) => {
    button.addEventListener("click", () => openPodcastDialog(Number(button.dataset.editPodcast)));
  });
  $$("[data-remove-podcast]").forEach((button) => {
    button.addEventListener("click", () => {
      state.podcasts.splice(Number(button.dataset.removePodcast), 1);
      markDataChanged();
      renderPodcasts();
    });
  });
}

function movePodcast(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.podcasts.length) return;
  const [podcast] = state.podcasts.splice(index, 1);
  state.podcasts.splice(targetIndex, 0, podcast);
  markDataChanged();
  renderPodcasts();
}

function openPodcastDialog(index = null) {
  const podcast = index === null ? {} : state.podcasts[index];
  hideFormError("podcastError");
  $("#podcastDialogTitle").textContent = index === null ? "Anadir podcast" : "Editar podcast";
  $("#podcastIndex").value = index === null ? "" : String(index);
  $("#podcastName").value = podcast.name || "";
  $("#podcastWeb").value = podcast.rssUrl || "";
  updateRssPreview();
  $("#podcastDialog").showModal();
}

function upsertPodcastFromForm() {
  const name = $("#podcastName").value.trim();
  const link = $("#podcastWeb").value.trim();
  if (!name) {
    showFormError("podcastError", "Escribe el nombre del podcast.");
    return;
  }
  if (!link) {
    showFormError("podcastError", "Pega el enlace web de iVoox o el RSS.");
    return;
  }

  let rssUrl = "";
  try {
    rssUrl = getPodcastRssUrl(link);
  } catch (error) {
    showFormError("podcastError", error.message);
    return;
  }

  const index = $("#podcastIndex").value;
  if (index === "") {
    state.podcasts.push({ name, rssUrl });
  } else {
    state.podcasts[Number(index)] = { name, rssUrl };
  }
  $("#podcastDialog").close();
  markDataChanged();
  renderPodcasts();
}

function getPodcastRssUrl(url) {
  if (/^https?:\/\/.+\/feed_fg_/i.test(url)) return url;
  return ivooxWebToRss(url);
}

function updateRssPreview() {
  const preview = $("#rssPreview");
  const value = $("#podcastWeb").value.trim();
  if (!value) {
    preview.classList.add("hidden");
    preview.textContent = "";
    return;
  }
  try {
    preview.classList.remove("hidden");
    preview.textContent = `RSS generado: ${getPodcastRssUrl(value)}`;
  } catch {
    preview.classList.remove("hidden");
    preview.textContent = "Pega un enlace de iVoox valido para generar el RSS.";
  }
}

function ivooxWebToRss(url) {
  const match = url.match(/_sq_f(\d+)_/i) || url.match(/f(\d+)/i);
  if (!match) throw new Error("No encuentro el identificador del podcast en el enlace de iVoox.");
  return `https://www.ivoox.com/feed_fg_f${match[1]}_filtro_1.xml`;
}

function emptyState(message, actions) {
  const box = document.createElement("div");
  box.className = "empty-state";
  const text = document.createElement("p");
  text.textContent = message;
  box.appendChild(text);

  const row = document.createElement("div");
  row.className = "empty-actions";
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.className = action.label.includes("Cargar") ? "secondary" : "";
    button.addEventListener("click", action.action);
    row.appendChild(button);
  });
  box.appendChild(row);
  return box;
}

function markDataChanged() {
  setUnsavedChanges(true);
  setStatus("dirty", "Cambios sin guardar");
}

function setUnsavedChanges(value) {
  state.hasUnsavedChanges = value;
  updateSaveButton();
}

function updateSaveButton() {
  const button = $("#saveAll");
  button.disabled = !state.hasUnsavedChanges;
  button.textContent = state.hasUnsavedChanges ? "Guardar cambios" : "Sin cambios";
}

function setStatus(type, message) {
  state.currentStatus = type;
  const badge = $("#statusBadge");
  badge.textContent = message;
  badge.className = `status-badge ${type}`;
}

function friendlyError(error, saving = false) {
  if (error.message === "missing_worker_url") return "Configura primero la URL del Worker.";
  if (error.status === 401 || error.status === 403) {
    return "El Worker no tiene permiso para acceder a GitHub. Revisa el secret GITHUB_TOKEN y sus permisos.";
  }
  if (error.status === 404 && error.path) {
    return `No se ha encontrado ${error.path} en la rama ${githubTarget.branch}.`;
  }
  if (saving && (error.status === 409 || /sha/i.test(error.message))) {
    return "No se han podido guardar los cambios. Puede que el archivo haya cambiado en GitHub desde la ultima carga.";
  }
  if (/failed to fetch|worker_network_error/i.test(error.message)) {
    return "No se ha podido conectar con el Worker. Revisa la URL configurada y el despliegue.";
  }
  return saving ? "No se han podido guardar los cambios." : "No se han podido cargar los archivos.";
}

function showFormError(id, message) {
  const box = $(`#${id}`);
  box.textContent = message;
  box.classList.remove("hidden");
}

function hideFormError(id) {
  const box = $(`#${id}`);
  box.textContent = "";
  box.classList.add("hidden");
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function dayLabel(value) {
  const labels = {
    lunes: "Lunes",
    martes: "Martes",
    miercoles: "Mi\u00e9rcoles",
    jueves: "Jueves",
    viernes: "Viernes",
    sabado: "S\u00e1bado",
    domingo: "Domingo"
  };
  return labels[canonicalDay(value)] || capitalize(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
