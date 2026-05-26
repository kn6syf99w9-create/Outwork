const DB_NAME = "outwork-db";
const DB_VERSION = 1;
const STORE = "appState";
const STATE_KEY = "state";
const todayKey = () => new Date().toISOString().slice(0, 10);

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const defaultState = () => ({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  exercises: [
    {
      id: uid(),
      name: "Liegestuetze",
      targetReps: 100,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: uid(),
      name: "Squats",
      targetReps: 100,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  dailyLogs: {},
  entries: []
});

let state = defaultState();
let activeView = "today";
let selectedHistoryDate = todayKey();

const app = document.querySelector("#app");

const icons = {
  today:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',
  list:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  backup:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  undo:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1-4.24 10.24"/></svg>'
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readState() {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      // Persistierte App-Daten werden hier aus IndexedDB gelesen.
      const request = tx.objectStore(STORE).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    const raw = localStorage.getItem("outwork-state");
    return raw ? JSON.parse(raw) : null;
  }
}

async function writeState(nextState) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      // Alle Fortschritte, Uebungen und Undo-Eintraege werden als ein Zustand lokal gespeichert.
      tx.objectStore(STORE).put(nextState, STATE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    localStorage.setItem("outwork-state", JSON.stringify(nextState));
  }
}

function ensureDay(date = todayKey()) {
  if (!state.dailyLogs[date]) {
    state.dailyLogs[date] = {
      date,
      totals: {},
      exerciseSnapshots: {},
      updatedAt: new Date().toISOString()
    };
  }
  if (!state.dailyLogs[date].exerciseSnapshots) state.dailyLogs[date].exerciseSnapshots = {};
  return state.dailyLogs[date];
}

function activeExercisesFor(date = todayKey()) {
  const log = state.dailyLogs[date];
  const snapshotIds = log ? Object.keys(log.exerciseSnapshots || log.totals || {}) : [];
  const current = state.exercises.filter((exercise) => exercise.active || snapshotIds.includes(exercise.id));
  const missingSnapshots = snapshotIds
    .filter((id) => !current.some((exercise) => exercise.id === id))
    .map((id) => ({
      id,
      name: log.exerciseSnapshots[id]?.name || "Geloeschte Uebung",
      targetReps: log.exerciseSnapshots[id]?.targetReps || 1,
      active: false
    }));

  return [...current, ...missingSnapshots].map((exercise) => ({
    ...exercise,
    name: log?.exerciseSnapshots?.[exercise.id]?.name || exercise.name,
    targetReps: log?.exerciseSnapshots?.[exercise.id]?.targetReps || exercise.targetReps
  }));
}

function completedFor(exercise, date = todayKey()) {
  return ensureDay(date).totals[exercise.id] || 0;
}

function snapshotExercise(exercise, date = todayKey()) {
  const log = ensureDay(date);
  if (!log.exerciseSnapshots[exercise.id]) {
    log.exerciseSnapshots[exercise.id] = {
      name: exercise.name,
      targetReps: exercise.targetReps
    };
  }
}

function dayStatus(date) {
  const exercises = activeExercisesFor(date);
  if (!exercises.length) return "missed";
  const totals = state.dailyLogs[date]?.totals || {};
  const doneCount = exercises.filter((exercise) => (totals[exercise.id] || 0) >= exercise.targetReps).length;
  const anyProgress = exercises.some((exercise) => (totals[exercise.id] || 0) > 0);
  if (doneCount === exercises.length) return "done";
  if (anyProgress) return "partial";
  return "missed";
}

async function persistAndRender() {
  await writeState(state);
  render();
}

function addReps(exerciseId, amount) {
  const date = todayKey();
  const log = ensureDay(date);
  const exercise = state.exercises.find((item) => item.id === exerciseId);
  snapshotExercise(exercise, date);
  const before = log.totals[exerciseId] || 0;
  const after = Math.min(before + amount, exercise.targetReps);

  log.totals[exerciseId] = after;
  log.updatedAt = new Date().toISOString();
  state.entries.push({
    id: uid(),
    type: "addReps",
    date,
    exerciseId,
    amount: after - before,
    before,
    after,
    createdAt: new Date().toISOString()
  });

  persistAndRender();
}

function undoLast(exerciseId) {
  const date = todayKey();
  const entry = [...state.entries]
    .reverse()
    .find((item) => item.date === date && item.exerciseId === exerciseId && !item.undoneAt);

  if (!entry) return;
  const log = ensureDay(date);
  log.totals[exerciseId] = entry.before;
  log.updatedAt = new Date().toISOString();
  entry.undoneAt = new Date().toISOString();
  persistAndRender();
}

function canUndo(exerciseId) {
  return state.entries.some(
    (entry) => entry.date === todayKey() && entry.exerciseId === exerciseId && !entry.undoneAt
  );
}

function addExercise(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const name = String(data.get("name") || "").trim();
  const targetReps = Number(data.get("targetReps"));
  if (!name || !Number.isFinite(targetReps) || targetReps < 1) return;

  state.exercises.push({
    id: uid(),
    name,
    targetReps: Math.round(targetReps),
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  event.currentTarget.reset();
  persistAndRender();
}

function editExercise(id) {
  const exercise = state.exercises.find((item) => item.id === id);
  const name = prompt("Uebungsname", exercise.name);
  if (name === null) return;
  const target = prompt("Tagesziel in Wiederholungen", String(exercise.targetReps));
  if (target === null) return;
  const targetReps = Number(target);
  if (!name.trim() || !Number.isFinite(targetReps) || targetReps < 1) return;

  exercise.name = name.trim();
  exercise.targetReps = Math.round(targetReps);
  exercise.updatedAt = new Date().toISOString();
  persistAndRender();
}

function toggleExercise(id) {
  const exercise = state.exercises.find((item) => item.id === id);
  exercise.active = !exercise.active;
  exercise.updatedAt = new Date().toISOString();
  persistAndRender();
}

function historyDates() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
}

function formatDate(date) {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }).format(
    new Date(`${date}T12:00:00`)
  );
}

function renderShell(content) {
  const nav = [
    ["today", icons.today, "Heute"],
    ["manage", icons.list, "Uebungen"],
    ["backup", icons.backup, "Backup"]
  ];

  app.innerHTML = `
    <main class="screen">
      <header class="topbar">
        <div class="brand">
          <strong>Outwork</strong>
          <span>${new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "long" }).format(new Date())}</span>
        </div>
        <nav class="nav" aria-label="Navigation">
          ${nav
            .map(
              ([view, icon, label]) => `
                <button class="icon-btn ${activeView === view ? "active" : ""}" data-view="${view}" aria-label="${label}" title="${label}">
                  ${icon}
                </button>`
            )
            .join("")}
        </nav>
      </header>
      ${content}
    </main>
  `;

  app.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      render();
    });
  });
}

function renderToday() {
  const exercises = activeExercisesFor().filter((exercise) => exercise.active);
  const doneCount = exercises.filter((exercise) => completedFor(exercise) >= exercise.targetReps).length;
  const isComplete = exercises.length > 0 && doneCount === exercises.length;

  renderShell(`
    <section class="status-strip ${isComplete ? "status-done" : ""}">
      <div>
        <div class="micro">${isComplete ? "Tag geschafft" : "Heute offen"}</div>
        <strong>${doneCount}/${exercises.length} Challenges</strong>
      </div>
      <div class="status-number">${Math.round((doneCount / Math.max(exercises.length, 1)) * 100)}%</div>
    </section>
    <section class="dashboard" aria-label="Tagesuebersicht">
      ${
        exercises.length
          ? exercises.map(renderExerciseCard).join("")
          : '<div class="empty">Keine aktiven Challenges. Lege unter Uebungen eine neue Challenge an.</div>'
      }
    </section>
    ${renderWeek()}
  `);

  app.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => addReps(button.dataset.exercise, Number(button.dataset.add)));
  });
  app.querySelectorAll("[data-undo]").forEach((button) => {
    button.addEventListener("click", () => undoLast(button.dataset.exercise));
  });
  bindHistoryTiles();
}

function renderExerciseCard(exercise) {
  const done = completedFor(exercise);
  const remaining = Math.max(exercise.targetReps - done, 0);
  const progress = Math.min((done / exercise.targetReps) * 100, 100);
  const isDone = remaining === 0;

  return `
    <article class="exercise-card ${isDone ? "done" : ""}">
      <div class="exercise-main">
        <div class="exercise-line">
          <div class="exercise-name">${escapeHtml(exercise.name)}</div>
          <div class="progress-value">${done}/${exercise.targetReps}</div>
        </div>
        <div class="exercise-line">
          <div class="remaining">${isDone ? "erledigt" : `noch ${remaining}`}</div>
          <div class="micro">Wdh.</div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="--progress:${progress}%"></div></div>
      </div>
      <div class="quick-grid">
        ${[5, 10, 20].map((amount) => `<button class="quick-btn" data-exercise="${exercise.id}" data-add="${amount}">+${amount}</button>`).join("")}
        <button class="quick-btn undo" data-exercise="${exercise.id}" data-undo ${canUndo(exercise.id) ? "" : "disabled"} aria-label="Letzte Eingabe rueckgaengig">${icons.undo}</button>
      </div>
    </article>
  `;
}

function renderWeek() {
  return `
    <section class="week" aria-label="Letzte sieben Tage">
      ${historyDates()
        .map((date) => {
          const status = dayStatus(date);
          return `
            <button class="day-tile ${status}" data-history-date="${date}" title="${date}">
              <strong>${formatDate(date).split(",")[0]}</strong>
              <span>${new Date(`${date}T12:00:00`).getDate()}</span>
            </button>
          `;
        })
        .join("")}
    </section>
  `;
}

function bindHistoryTiles() {
  app.querySelectorAll("[data-history-date]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedHistoryDate = button.dataset.historyDate;
      activeView = "history";
      render();
    });
  });
}

function renderManage() {
  renderShell(`
    <section class="panel">
      <h1 class="section-title">Uebungen</h1>
      <form class="form" id="exercise-form">
        <input name="name" autocomplete="off" placeholder="Name" required />
        <input name="targetReps" type="number" min="1" step="1" inputmode="numeric" placeholder="Ziel" required />
        <button class="primary" type="submit">Hinzufuegen</button>
      </form>
      <div class="exercise-list">
        ${state.exercises
          .map(
            (exercise) => `
              <article class="manage-row ${exercise.active ? "" : "inactive"}">
                <div>
                  <strong>${escapeHtml(exercise.name)}</strong>
                  <div class="micro">${exercise.targetReps} Wiederholungen pro Tag · ${exercise.active ? "aktiv" : "inaktiv"}</div>
                </div>
                <div class="row-actions">
                  <button class="secondary" data-edit="${exercise.id}">Edit</button>
                  <button class="danger" data-toggle="${exercise.id}">${exercise.active ? "Aus" : "An"}</button>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
    <div></div>
    <div></div>
  `);

  app.querySelector("#exercise-form").addEventListener("submit", addExercise);
  app.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => editExercise(button.dataset.edit));
  });
  app.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleExercise(button.dataset.toggle));
  });
}

function renderHistory() {
  const date = selectedHistoryDate;
  const status = dayStatus(date);
  const exercises = activeExercisesFor(date);
  const label = status === "done" ? "geschafft" : status === "partial" ? "teilweise geschafft" : "nicht geschafft";

  renderShell(`
    <section class="status-strip">
      <div>
        <div class="micro">${formatDate(date)}</div>
        <strong>${label}</strong>
      </div>
      <button class="secondary" data-view="today">Heute</button>
    </section>
    <section class="panel history-detail">
      ${exercises
        .map((exercise) => {
          const done = state.dailyLogs[date]?.totals?.[exercise.id] || 0;
          return `
            <article class="history-card">
              <strong>${escapeHtml(exercise.name)}</strong>
              <div class="micro">${done}/${exercise.targetReps} Wiederholungen · noch ${Math.max(exercise.targetReps - done, 0)}</div>
            </article>
          `;
        })
        .join("") || '<div class="empty">Keine Daten fuer diesen Tag.</div>'}
    </section>
    ${renderWeek()}
  `);
  bindHistoryTiles();
}

function renderBackup() {
  renderShell(`
    <section class="panel backup-box">
      <h1 class="section-title">Backup</h1>
      <p class="micro">Exportiert werden Uebungen, Tagesfortschritte und Undo-Aktionen als JSON-Datei.</p>
      <div class="backup-actions">
        <button class="primary" id="export-btn">Export</button>
        <button class="secondary" id="import-btn">Import</button>
      </div>
      <input class="file-input" id="import-file" type="file" accept="application/json,.json" />
    </section>
    <div></div>
    <div></div>
  `);

  app.querySelector("#export-btn").addEventListener("click", exportData);
  app.querySelector("#import-btn").addEventListener("click", () => app.querySelector("#import-file").click());
  app.querySelector("#import-file").addEventListener("change", importData);
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `outwork-backup-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm("Import ersetzt alle lokalen Outwork-Daten. Fortfahren?")) return;

  const imported = JSON.parse(await file.text());
  if (!imported.exercises || !imported.dailyLogs || !imported.entries) {
    alert("Diese JSON-Datei sieht nicht wie ein Outwork-Backup aus.");
    return;
  }

  state = imported;
  await persistAndRender();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function render() {
  if (activeView === "manage") renderManage();
  else if (activeView === "backup") renderBackup();
  else if (activeView === "history") renderHistory();
  else renderToday();
}

async function boot() {
  const saved = await readState();
  state = saved || defaultState();
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {});
  }
}

boot();
