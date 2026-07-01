// Клієнтська логіка адмін-панелі VARTA

const $ = (id) => document.getElementById(id);

const ROLE_LABELS = {
  guest: "Гість",
  admin: "Адмін",
  methodist: "Методист",
  zavuch: "Завуч",
  teacher: "Вчитель",
  student: "Учень",
  jury: "Журі",
  system: "Система",
};
const STATUS_LABELS = { active: "Активний", pending: "Очікує", blocked: "Заблокований" };
const REQ_STATUS_LABELS = { pending: "Очікує", approved: "Схвалено", rejected: "Відхилено" };
const PAGE_TITLES = {
  dashboard: "Dashboard",
  regions: "Управління областями",
  cities: "Управління містами",
  schools: "Управління школами",
  users: "Управління користувачами",
  requests: "Запити на підтвердження ролей",
  notifications: "Центр сповіщень",
  settings: "Налаштування системи",
  logs: "Логи системи",
};

const NOTIF_TYPE_LABELS = {
  system: "Системне",
  info: "Інформаційне",
  urgent: "Термінове",
  reminder: "Нагадування",
  result: "Результати конкурсу",
  registration: "Відкриття реєстрації",
};
const CHANNEL_LABELS = { platform: "На платформі", email: "Email", push: "Push", telegram: "Telegram" };
const NOTIF_STATUS_LABELS = { draft: "Чернетка", scheduled: "Заплановано", sent: "Надіслано", archived: "Архів" };

const ROLES = Object.keys(ROLE_LABELS);

// ---- HTTP-хелпери -----------------------------------------------------------
async function getJSON(url) {
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    window.location.href = "/";
    throw new Error("unauthorized");
  }
  return res.json();
}
async function send(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function toast(type, text) {
  const t = $("toast");
  t.className = `toast show ${type}`;
  t.textContent = text;
  setTimeout(() => (t.className = "toast"), 2800);
}

function fmtDate(s) {
  return new Date(s).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  regions: loadRegions,
  cities: loadCities,
  schools: loadSchools,
  users: loadUsers,
  requests: loadRequests,
  notifications: loadNotifications,
  settings: loadSettings,
  logs: loadLogs,
};

function switchPage(page) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((s) => s.classList.toggle("hidden", s.dataset.page !== page));
  $("pageTitle").textContent = PAGE_TITLES[page];
  loaders[page]?.();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.onclick = () => switchPage(btn.dataset.page);
});

$("logoutBtn").onclick = async () => {
  await send("POST", "/api/logout", {});
  window.location.href = "/";
};

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats, byRole } = await getJSON("/api/admin/stats");
  const cards = [
    ["Користувачів", stats.users],
    ["Гостей", stats.guests],
    ["Областей", stats.regions],
    ["Міст", stats.cities],
    ["Шкіл", stats.schools],
    ["Запитів на ролі", stats.pendingRequests],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");

  const max = Math.max(1, ...byRole.map((r) => r.c));
  $("roleBreakdown").innerHTML = byRole
    .map(
      (r) => `<div class="role-bar">
        <span>${ROLE_LABELS[r.role] || r.role}</span>
        <span class="track"><span class="fill" style="width:${(r.c / max) * 100}%"></span></span>
        <span>${r.c}</span></div>`
    )
    .join("");
}

// ---- Області ----------------------------------------------------------------
async function loadRegions() {
  const { regions } = await getJSON("/api/admin/regions");
  $("regionsBody").innerHTML = regions.length
    ? regions
        .map(
          (r) => `<tr><td>${esc(r.name)}</td><td>${r.cities_count}</td>
          <td class="actions"><button class="btn sm danger" data-del-region="${r.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Областей ще немає</td></tr>`;
}
$("regionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/regions", { name: $("regionName").value.trim() });
  if (!ok) return toast("err", data.error || "Помилка");
  $("regionForm").reset();
  toast("ok", "Область додано");
  loadRegions();
});
$("regionsBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-region");
  if (!id) return;
  if (!confirm("Видалити область разом з її містами та школами?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/regions/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadRegions();
});

// ---- Міста ------------------------------------------------------------------
async function loadCities() {
  const [{ cities }, { regions }] = await Promise.all([
    getJSON("/api/admin/cities"),
    getJSON("/api/admin/regions"),
  ]);
  $("cityRegion").innerHTML =
    `<option value="" disabled selected>Оберіть область</option>` +
    regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  $("citiesBody").innerHTML = cities.length
    ? cities
        .map(
          (c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.region_name)}</td><td>${c.schools_count}</td>
          <td class="actions"><button class="btn sm danger" data-del-city="${c.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Міст ще немає</td></tr>`;
}
$("cityForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/cities", {
    name: $("cityName").value.trim(),
    region_id: $("cityRegion").value,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("cityName").value = "";
  toast("ok", "Місто додано");
  loadCities();
});
$("citiesBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-city");
  if (!id) return;
  if (!confirm("Видалити місто разом зі школами?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/cities/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadCities();
});

// ---- Школи ------------------------------------------------------------------
async function loadSchools() {
  const [{ schools }, { cities }] = await Promise.all([
    getJSON("/api/admin/schools"),
    getJSON("/api/admin/cities"),
  ]);
  $("schoolCity").innerHTML =
    `<option value="" disabled selected>Оберіть місто</option>` +
    cities.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.region_name)})</option>`).join("");
  $("schoolsBody").innerHTML = schools.length
    ? schools
        .map(
          (s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.city_name)}</td><td>${esc(s.region_name)}</td>
          <td>${esc(s.address || "—")}</td>
          <td class="actions"><button class="btn sm danger" data-del-school="${s.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Шкіл ще немає</td></tr>`;
}
$("schoolForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/schools", {
    name: $("schoolName").value.trim(),
    city_id: $("schoolCity").value,
    address: $("schoolAddress").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("schoolName").value = "";
  $("schoolAddress").value = "";
  toast("ok", "Школу додано");
  loadSchools();
});
$("schoolsBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-school");
  if (!id) return;
  if (!confirm("Видалити школу?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/schools/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadSchools();
});

// ---- Користувачі ------------------------------------------------------------
async function loadUsers() {
  const { users } = await getJSON("/api/admin/users");
  $("usersBody").innerHTML = users.length
    ? users
        .map((u) => {
          const roleOpts = ROLES.map(
            (r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${ROLE_LABELS[r]}</option>`
          ).join("");
          const statusOpts = ["active", "pending", "blocked"]
            .map((s) => `<option value="${s}" ${s === u.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)
            .join("");
          return `<tr>
            <td>${esc(u.email)}</td>
            <td>${esc(u.full_name || "—")}</td>
            <td><select data-role-user="${u.id}">${roleOpts}</select></td>
            <td><select data-status-user="${u.id}">${statusOpts}</select></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="empty">Користувачів немає</td></tr>`;
}
$("usersBody").addEventListener("change", async (e) => {
  const roleId = e.target.getAttribute("data-role-user");
  const statusId = e.target.getAttribute("data-status-user");
  if (roleId) {
    const { ok, data } = await send("PATCH", `/api/admin/users/${roleId}/role`, { role: e.target.value });
    toast(ok ? "ok" : "err", ok ? "Роль оновлено" : data.error || "Помилка");
  } else if (statusId) {
    const { ok, data } = await send("PATCH", `/api/admin/users/${statusId}/status`, { status: e.target.value });
    toast(ok ? "ok" : "err", ok ? "Статус оновлено" : data.error || "Помилка");
  }
}); 

// ---- Запити на ролі ---------------------------------------------------------
async function loadRequests() {
  const { requests } = await getJSON("/api/admin/role-requests");
  $("requestsBody").innerHTML = requests.length
    ? requests
        .map((r) => {
          const actions =
            r.status === "pending"
              ? `<div class="actions">
                   <button class="btn sm ok" data-approve="${r.id}">Схвалити</button>
                   <button class="btn sm danger" data-reject="${r.id}">Відхилити</button></div>`
              : "—";
          return `<tr>
            <td>${esc(r.full_name || r.email)}<br><small>${esc(r.email)}</small></td>
            <td>${ROLE_LABELS[r.role] || r.role}</td>
            <td><span class="status ${r.status}">${REQ_STATUS_LABELS[r.status] || r.status}</span></td>
            <td>${fmtDate(r.created_at)}</td>
            <td>${actions}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">Запитів немає</td></tr>`;
}
$("requestsBody").addEventListener("click", async (e) => {
  const approve = e.target.getAttribute("data-approve");
  const reject = e.target.getAttribute("data-reject");
  const id = approve || reject;
  if (!id) return;
  const decision = approve ? "approved" : "rejected";
  const { ok, data } = await send("PATCH", `/api/admin/role-requests/${id}`, { decision });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Рішення збережено");
  loadRequests();
}); 

// ---- Налаштування -----------------------------------------------------------
async function loadSettings() {
  const { settings } = await getJSON("/api/admin/settings");
  $("settingsBody").innerHTML = settings.length
    ? settings
        .map((s) => `<tr><td>${esc(s.key)}</td><td>${esc(s.value || "—")}</td><td>${fmtDate(s.updated_at)}</td></tr>`)
        .join("")
    : `<tr><td colspan="3" class="empty">Налаштувань ще немає</td></tr>`;
}
$("settingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("PUT", "/api/admin/settings", {
    key: $("settingKey").value.trim(),
    value: $("settingValue").value,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("settingForm").reset();
  toast("ok", "Збережено");
  loadSettings();
});

// ---- Логи -------------------------------------------------------------------
async function loadLogs() {
  const { logs } = await getJSON("/api/admin/logs");
  $("logsBody").innerHTML = logs.length
    ? logs
        .map(
          (l) => `<tr><td>${fmtDate(l.created_at)}</td><td>${esc(l.action)}</td>
          <td>${esc(l.details || "—")}</td><td>${esc(l.actor || "система")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Логів ще немає</td></tr>`;
}

// ---- Центр сповіщень --------------------------------------------------------
let notifMeta = null; // { types, channels, roles, users, roleCounts }
let notifAttachments = []; // накопичені файли для нового повідомлення

function roleCount(role) {
  const found = (notifMeta?.roleCounts || []).find((r) => r.role === role);
  return found ? found.c : 0;
}

// Побудова статичних елементів форми (типи, канали, ролі)
function buildNotifForm() {
  if (!notifMeta) return;
  $("notifType").innerHTML = notifMeta.types
    .map((t) => `<option value="${t}">${NOTIF_TYPE_LABELS[t] || t}</option>`)
    .join("");

  $("notifChannels").innerHTML = notifMeta.channels
    .map(
      (c) =>
        `<label class="check"><input type="checkbox" value="${c}" ${c === "platform" ? "checked" : ""} /> ${CHANNEL_LABELS[c] || c}</label>`
    )
    .join("");

  $("audienceRoles").innerHTML = notifMeta.roles
    .map(
      (r) =>
        `<label class="check"><input type="checkbox" value="${r}" /> ${ROLE_LABELS[r] || r} <small>(${roleCount(r)})</small></label>`
    )
    .join("");

  renderUserList("");
}

function renderUserList(filter) {
  const q = filter.trim().toLowerCase();
  const list = (notifMeta?.users || []).filter(
    (u) => !q || (u.email || "").toLowerCase().includes(q) || (u.full_name || "").toLowerCase().includes(q)
  );
  $("userList").innerHTML = list.length
    ? list
        .map(
          (u) =>
            `<label class="check"><input type="checkbox" value="${u.id}" /> ${esc(u.full_name || u.email)} <small>${ROLE_LABELS[u.role] || u.role}</small></label>`
        )
        .join("")
    : `<div class="empty">Нічого не знайдено</div>`;
}

function checkedValues(container) {
  return Array.from(container.querySelectorAll("input:checked")).map((i) => i.value);
}

async function loadNotifications() {
  if (!notifMeta) {
    notifMeta = await getJSON("/api/admin/notifications/meta");
    buildNotifForm();
    await loadNotifTemplates();
  }
  await loadNotifHistory();
}

async function loadNotifHistory() {
  const { notifications } = await getJSON("/api/admin/notifications");
  $("notifBody_history").innerHTML = notifications.length
    ? notifications
        .map((n) => {
          const total = n.recipients || 0;
          const read = n.read_count || 0;
          const canSend = n.status === "draft" || n.status === "scheduled";
          return `<tr>
            <td>${esc(n.title)}${n.files_count ? ` <small>📎${n.files_count}</small>` : ""}</td>
            <td><span class="badge type-${n.type}">${NOTIF_TYPE_LABELS[n.type] || n.type}</span></td>
            <td><span class="status ${n.status}">${NOTIF_STATUS_LABELS[n.status] || n.status}</span>${
              n.status === "scheduled" && n.scheduled_at ? `<br><small>${fmtDate(n.scheduled_at)}</small>` : ""
            }</td>
            <td>${total}</td>
            <td>${total ? `${read}/${total}` : "—"}</td>
            <td>${fmtDate(n.created_at)}</td>
            <td class="actions">
              <button class="btn sm ghost" data-view-notif="${n.id}">Деталі</button>
              ${canSend ? `<button class="btn sm ok" data-send-notif="${n.id}">Надіслати</button>` : ""}
              ${n.status !== "archived" ? `<button class="btn sm ghost" data-archive-notif="${n.id}">Архів</button>` : ""}
              <button class="btn sm danger" data-del-notif="${n.id}">✕</button>
            </td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">Повідомлень ще немає</td></tr>`;
}

async function loadNotifTemplates() {
  const { templates } = await getJSON("/api/admin/notification-templates");
  $("templatesBody").innerHTML = templates.length
    ? templates
        .map(
          (t) => `<tr>
            <td>${esc(t.name)}</td>
            <td><span class="badge type-${t.type}">${NOTIF_TYPE_LABELS[t.type] || t.type}</span></td>
            <td>${esc(t.title || "—")}</td>
            <td class="actions">
              <button class="btn sm ghost" data-use-template="${t.id}">Використати</button>
              <button class="btn sm danger" data-del-template="${t.id}">✕</button>
            </td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Шаблонів ще немає</td></tr>`;
  // Оновлюємо селект вибору шаблону у формі
  $("notifTemplatePick").innerHTML =
    `<option value="">— без шаблону —</option>` +
    templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  window.__notifTemplates = templates;
}

// Збір даних форми
function collectNotifPayload() {
  const audience = document.querySelector('input[name="audience"]:checked')?.value || "all";
  return {
    title: $("notifTitle").value.trim(),
    body: $("notifBody").value.trim(),
    type: $("notifType").value,
    channels: checkedValues($("notifChannels")),
    audience_mode: audience,
    audience_roles: audience === "roles" ? checkedValues($("audienceRoles")) : [],
    audience_users: audience === "users" ? checkedValues($("userList")).map(Number) : [],
    files: notifAttachments,
  };
}

function resetNotifForm() {
  $("notifForm").reset();
  notifAttachments = [];
  $("notifFileList").innerHTML = "";
  document.querySelector('input[name="audience"][value="all"]').checked = true;
  document.querySelector('input[name="when"][value="now"]').checked = true;
  $("audienceRoles").classList.add("hidden");
  $("audienceUsers").classList.add("hidden");
  $("notifSchedule").classList.add("hidden");
  $("notifSubmit").textContent = "Надіслати";
  // повертаємо канал platform за замовчуванням
  $("notifChannels").querySelectorAll("input").forEach((i) => (i.checked = i.value === "platform"));
}

// ---- Події центру сповіщень ----
function initNotifEvents() {
  // Перемикання вкладок
  document.querySelectorAll("#notifTabs .tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll("#notifTabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
      document
        .querySelectorAll('[data-page="notifications"] .tab-pane')
        .forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== tab.dataset.tab));
      if (tab.dataset.tab === "history") loadNotifHistory();
      if (tab.dataset.tab === "templates") loadNotifTemplates();
    };
  });

  // Перемикання аудиторії
  document.querySelectorAll('input[name="audience"]').forEach((r) => {
    r.onchange = () => {
      $("audienceRoles").classList.toggle("hidden", r.value !== "roles");
      $("audienceUsers").classList.toggle("hidden", r.value !== "users");
    };
  });

  // Перемикання часу надсилання
  document.querySelectorAll('input[name="when"]').forEach((r) => {
    r.onchange = () => {
      const later = document.querySelector('input[name="when"]:checked').value === "later";
      $("notifSchedule").classList.toggle("hidden", !later);
      $("notifSubmit").textContent = later ? "Запланувати" : "Надіслати";
    };
  });

  // Пошук користувачів
  $("userSearch").oninput = (e) => renderUserList(e.target.value);

  // Завантаження файлу
  $("notifFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/notifications/upload", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast("err", data.error || "Помилка завантаження");
    notifAttachments.push(data.file);
    renderAttachments();
    $("notifFile").value = "";
    toast("ok", "Файл додано");
  };

  // Вибір шаблону у формі
  $("notifTemplatePick").onchange = (e) => {
    const t = (window.__notifTemplates || []).find((x) => String(x.id) === e.target.value);
    if (!t) return;
    applyTemplateToForm(t);
    toast("ok", "Шаблон застосовано");
  };

  // Кнопки форми (draft / save-template / submit)
  $("notifForm").addEventListener("click", async (e) => {
    const action = e.target.getAttribute("data-action");
    if (action === "draft") {
      e.preventDefault();
      await submitNotif("draft");
    } else if (action === "save-template") {
      e.preventDefault();
      await saveTemplateFromForm();
    }
  });

  $("notifForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const later = document.querySelector('input[name="when"]:checked').value === "later";
    await submitNotif(later ? "schedule" : "send");
  });

  // Дії в історії
  $("notifBody_history").addEventListener("click", async (e) => {
    const view = e.target.getAttribute("data-view-notif");
    const send = e.target.getAttribute("data-send-notif");
    const archive = e.target.getAttribute("data-archive-notif");
    const del = e.target.getAttribute("data-del-notif");
    if (view) return openNotifModal(view);
    if (send) {
      const { ok, data } = await send2("POST", `/api/admin/notifications/${send}/send`);
      toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
      if (ok) loadNotifHistory();
    } else if (archive) {
      const { ok, data } = await send2("POST", `/api/admin/notifications/${archive}/archive`);
      toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
      if (ok) loadNotifHistory();
    } else if (del) {
      if (!confirm("Видалити повідомлення?")) return;
      const { ok, data } = await send2("DELETE", `/api/admin/notifications/${del}`);
      toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
      if (ok) loadNotifHistory();
    }
  });

  // Дії з шаблонами
  $("templatesBody").addEventListener("click", async (e) => {
    const use = e.target.getAttribute("data-use-template");
    const del = e.target.getAttribute("data-del-template");
    if (use) {
      const t = (window.__notifTemplates || []).find((x) => String(x.id) === use);
      if (t) {
        applyTemplateToForm(t);
        document.querySelector('#notifTabs .tab[data-tab="create"]').click();
        toast("ok", "Шаблон завантажено у форму");
      }
    } else if (del) {
      if (!confirm("Видалити шаблон?")) return;
      const { ok, data } = await send2("DELETE", `/api/admin/notification-templates/${del}`);
      toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
      if (ok) loadNotifTemplates();
    }
  });

  // Закриття модалки
  $("notifModalClose").onclick = () => $("notifModal").classList.add("hidden");
  $("notifModal").addEventListener("click", (e) => {
    if (e.target.id === "notifModal") $("notifModal").classList.add("hidden");
  });
}

function renderAttachments() {
  $("notifFileList").innerHTML = notifAttachments
    .map(
      (f, i) =>
        `<div class="file-chip"><span>${esc(f.file_name || "файл")}</span><button type="button" data-rm-file="${i}">✕</button></div>`
    )
    .join("");
}
$("notifFileList")?.addEventListener?.("click", (e) => {
  const i = e.target.getAttribute("data-rm-file");
  if (i === null) return;
  notifAttachments.splice(Number(i), 1);
  renderAttachments();
});

function applyTemplateToForm(t) {
  $("notifType").value = t.type;
  $("notifTitle").value = t.title || "";
  $("notifBody").value = t.body || "";
  const channels = Array.isArray(t.channels) ? t.channels : [];
  $("notifChannels").querySelectorAll("input").forEach((i) => (i.checked = channels.includes(i.value)));
}

async function submitNotif(action) {
  const payload = collectNotifPayload();
  if (!payload.title) return toast("err", "Вкажіть заголовок");
  if (action === "schedule") {
    const val = $("notifSchedule").value;
    if (!val) return toast("err", "Вкажіть дату та час надсилання");
    payload.scheduled_at = new Date(val).toISOString();
  }
  payload.action = action;
  const { ok, data } = await send2("POST", "/api/admin/notifications", payload);
  if (!ok) return toast("err", data.error || "Помилка");
  const msg =
    action === "send"
      ? `Надіслано ${data.delivered} отримувачам`
      : action === "schedule"
        ? "Повідомлення заплановано"
        : "Чернетку збережено";
  toast("ok", msg);
  resetNotifForm();
  loadNotifHistory();
}

async function saveTemplateFromForm() {
  const name = prompt("Назва шаблону:");
  if (!name) return;
  const { ok, data } = await send2("POST", "/api/admin/notification-templates", {
    name: name.trim(),
    type: $("notifType").value,
    title: $("notifTitle").value.trim(),
    body: $("notifBody").value.trim(),
    channels: checkedValues($("notifChannels")),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Шаблон збережено");
  loadNotifTemplates();
}

async function openNotifModal(id) {
  const { message, recipients, files, logs } = await getJSON(`/api/admin/notifications/${id}`);
  const channels = (Array.isArray(message.channels) ? message.channels : [])
    .map((c) => `<span class="chip">${CHANNEL_LABELS[c] || c}</span>`)
    .join("");
  const filesHtml = files.length
    ? files
        .map((f) => `<a class="chip" href="${f.file_url}" target="_blank" rel="noopener">📎 ${esc(f.file_name || "файл")}</a>`)
        .join("")
    : "<small>немає</small>";
  const recipientsHtml = recipients.length
    ? recipients
        .map(
          (r) =>
            `<tr><td>${esc(r.full_name || r.email)}<br><small>${esc(r.email)}</small></td>
             <td>${ROLE_LABELS[r.role] || r.role}</td>
             <td><span class="status ${r.is_read ? "active" : "pending"}">${r.is_read ? "Прочитано" : "Не прочитано"}</span></td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Отримувачів ще немає</td></tr>`;

  $("notifModalContent").innerHTML = `
    <h2>${esc(message.title)}</h2>
    <div class="meta-row">
      <span class="badge type-${message.type}">${NOTIF_TYPE_LABELS[message.type] || message.type}</span>
      <span class="status ${message.status}">${NOTIF_STATUS_LABELS[message.status] || message.status}</span>
    </div>
    <p class="modal-body-text">${esc(message.body || "—")}</p>
    <div class="modal-section"><strong>Канали:</strong> ${channels || "—"}</div>
    <div class="modal-section"><strong>Файли:</strong> ${filesHtml}</div>
    ${message.scheduled_at ? `<div class="modal-section"><strong>Заплановано на:</strong> ${fmtDate(message.scheduled_at)}</div>` : ""}
    ${message.sent_at ? `<div class="modal-section"><strong>Надіслано:</strong> ${fmtDate(message.sent_at)}</div>` : ""}
    <h3>Отримувачі (${recipients.length})</h3>
    <div class="modal-scroll">
      <table class="tbl"><thead><tr><th>Користувач</th><th>Роль</th><th>Статус</th></tr></thead>
      <tbody>${recipientsHtml}</tbody></table>
    </div>
    <h3>Журнал доставки</h3>
    <div class="modal-scroll">
      <table class="tbl"><thead><tr><th>Дата</th><th>Канал</th><th>Статус</th><th>Отримувач</th></tr></thead>
      <tbody>${
        logs.length
          ? logs
              .map(
                (l) =>
                  `<tr><td>${fmtDate(l.created_at)}</td><td>${CHANNEL_LABELS[l.channel] || l.channel}</td>
                   <td><span class="status active">${esc(l.status)}</span></td><td>${esc(l.email || "—")}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="4" class="empty">Записів немає</td></tr>`
      }</tbody></table>
    </div>`;
  $("notifModal").classList.remove("hidden");
}

// Окремий HTTP-хелпер, що повертає ok+data (щоб не плутати з локальною змінною send)
async function send2(method, url, body) {
  return send(method, url, body);
}

// ---- Старт ------------------------------------------------------------------
(async function init() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return (window.location.href = "/");
    const { user } = await res.json();
    if (user.role !== "admin" && user.role !== "system") return (window.location.href = "/");
    $("adminEmail").textContent = user.email;
    initNotifEvents();
    switchPage("dashboard");
  } catch {
    window.location.href = "/";
  }
})();
