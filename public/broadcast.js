// ============================================================================
//  VARTA — спільний модуль "Розсилка" (Центр сповіщень для всіх ролей)
//  Самодостатній скрипт: додає пункт навігації, сторінку та модалку в
//  будь-яку панель (завуч, вчитель, учень, журі, методист) і працює через
//  спільні маршрути /api/broadcast/*.
// ============================================================================
(function () {
  "use strict";

  const API = "/api/broadcast";

  const TYPE_LABELS = {
    system: "Системне",
    info: "Інформаційне",
    urgent: "Термінове",
    reminder: "Нагадування",
    result: "Результати конкурсу",
    registration: "Відкриття реєстрації",
  };
  const CHANNEL_LABELS = { platform: "На платформі", email: "Email", push: "Push", telegram: "Telegram" };
  const STATUS_LABELS = { draft: "Чернетка", scheduled: "Заплановано", sent: "Надіслано", archived: "Архів" };
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

  // ---- Стан ----
  let meta = null; // { types, channels, roles, users, roleCounts }
  let attachments = [];
  let templates = [];

  // ---- Хелпери ----
  const el = (id) => document.getElementById(id);
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function fmtDate(s) {
    if (!s) return "—";
    return new Date(s).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
  }
  function toast(type, text) {
    const t = el("toast");
    if (!t) return;
    t.className = `toast show ${type}`;
    t.textContent = text;
    setTimeout(() => (t.className = "toast"), 2800);
  }
  async function getJSON(url) {
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) {
      window.location.href = "/";
      throw new Error("unauthorized");
    }
    return res.json();
  }
  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }
  function checkedValues(container) {
    return Array.from(container.querySelectorAll("input:checked")).map((i) => i.value);
  }
  function roleCount(role) {
    const f = (meta?.roleCounts || []).find((r) => r.role === role);
    return f ? f.c : 0;
  }

  // ---- Розмітка ----
  function pageMarkup() {
    return `
      <div class="bc-tabs" id="bcTabs">
        <button class="bc-tab active" data-tab="create">Створити повідомлення</button>
        <button class="bc-tab" data-tab="history">Історія</button>
        <button class="bc-tab" data-tab="templates">Шаблони</button>
      </div>

      <div class="bc-pane" data-tab="create">
        <div class="bc-panel">
          <h2>Нове повідомлення</h2>
          <form id="bcForm" class="bc-form">
            <div class="bc-row">
              <label class="bc-field">
                <span>Тип повідомлення</span>
                <select id="bcType"></select>
              </label>
              <label class="bc-field">
                <span>Заповнити з шаблону</span>
                <select id="bcTemplatePick"><option value="">— без шаблону —</option></select>
              </label>
            </div>

            <label class="bc-field">
              <span>Заголовок</span>
              <input type="text" id="bcTitle" placeholder="Напр. Важливе оголошення" required />
            </label>

            <label class="bc-field">
              <span>Текст повідомлення</span>
              <textarea id="bcBody" rows="4" placeholder="Деталі повідомлення..."></textarea>
            </label>

            <fieldset class="bc-group">
              <legend>Канали доставки</legend>
              <div id="bcChannels" class="bc-checks"></div>
            </fieldset>

            <fieldset class="bc-group">
              <legend>Отримувачі</legend>
              <div class="bc-checks">
                <label class="bc-radio"><input type="radio" name="bcAudience" value="all" checked /> Усі користувачі</label>
                <label class="bc-radio"><input type="radio" name="bcAudience" value="roles" /> За ролями</label>
                <label class="bc-radio"><input type="radio" name="bcAudience" value="users" /> Окремі користувачі</label>
              </div>
              <div id="bcAudienceRoles" class="bc-checks bc-sub hidden"></div>
              <div id="bcAudienceUsers" class="bc-sub hidden">
                <input type="text" id="bcUserSearch" class="bc-search" placeholder="Пошук користувача..." />
                <div id="bcUserList" class="bc-userlist"></div>
              </div>
            </fieldset>

            <fieldset class="bc-group">
              <legend>Прикріплені файли</legend>
              <input type="file" id="bcFile" />
              <div id="bcFileList" class="bc-filelist"></div>
            </fieldset>

            <fieldset class="bc-group">
              <legend>Час надсилання</legend>
              <label class="bc-radio"><input type="radio" name="bcWhen" value="now" checked /> Надіслати миттєво</label>
              <label class="bc-radio"><input type="radio" name="bcWhen" value="later" /> Відкладене надсилання</label>
              <input type="datetime-local" id="bcSchedule" class="hidden bc-schedule" />
            </fieldset>

            <div class="bc-actions">
              <button type="button" class="btn ghost" data-action="draft">Зберегти чернетку</button>
              <button type="button" class="btn" data-action="save-template">Зберегти як шаблон</button>
              <button type="submit" class="btn ok" id="bcSubmit">Надіслати</button>
            </div>
          </form>
        </div>
      </div>

      <div class="bc-pane hidden" data-tab="history">
        <div class="bc-panel">
          <h2>Історія повідомлень</h2>
          <div class="bc-tablewrap">
            <table class="tbl bc-tbl">
              <thead><tr>
                <th>Заголовок</th><th>Тип</th><th>Статус</th><th>Отримувачі</th><th>Прочитано</th><th>Дата</th><th></th>
              </tr></thead>
              <tbody id="bcHistoryBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="bc-pane hidden" data-tab="templates">
        <div class="bc-panel">
          <h2>Збережені шаблони</h2>
          <div class="bc-tablewrap">
            <table class="tbl bc-tbl">
              <thead><tr><th>Назва</th><th>Тип</th><th>Заголовок</th><th></th></tr></thead>
              <tbody id="bcTemplatesBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function modalMarkup() {
    return `
      <div class="bc-modal-card">
        <button class="bc-modal-close" id="bcModalClose" aria-label="Закрити">&times;</button>
        <div id="bcModalContent"></div>
      </div>`;
  }

  // ---- Ін'єкція у DOM ----
  function inject() {
    const nav = document.querySelector(".nav");
    const main = document.querySelector("main.content");
    if (!nav || !main) return false;

    // Пункт навігації
    const navBtn = document.createElement("button");
    navBtn.className = "nav-item";
    navBtn.dataset.page = "broadcast";
    navBtn.textContent = "Розсилка";
    const notifItem = nav.querySelector('.nav-item[data-page="notifications"]');
    if (notifItem && notifItem.nextSibling) nav.insertBefore(navBtn, notifItem.nextSibling);
    else nav.appendChild(navBtn);

    // Сторінка
    const page = document.createElement("section");
    page.className = "page hidden";
    page.dataset.page = "broadcast";
    page.innerHTML = pageMarkup();
    main.appendChild(page);

    // Модалка
    const modal = document.createElement("div");
    modal.id = "bcModal";
    modal.className = "bc-modal hidden";
    modal.innerHTML = modalMarkup();
    document.body.appendChild(modal);

    navBtn.addEventListener("click", showBroadcast);
    return true;
  }

  function showBroadcast() {
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.page === "broadcast")
    );
    document.querySelectorAll(".page").forEach((s) =>
      s.classList.toggle("hidden", s.dataset.page !== "broadcast")
    );
    const title = el("pageTitle");
    if (title) title.textContent = "Розсилка";
    loadAll();
  }

  // ---- Побудова форми ----
  function buildForm() {
    if (!meta) return;
    el("bcType").innerHTML = meta.types
      .map((t) => `<option value="${t}">${TYPE_LABELS[t] || t}</option>`)
      .join("");
    el("bcChannels").innerHTML = meta.channels
      .map(
        (c) =>
          `<label class="bc-check"><input type="checkbox" value="${c}" ${c === "platform" ? "checked" : ""} /> ${CHANNEL_LABELS[c] || c}</label>`
      )
      .join("");
    el("bcAudienceRoles").innerHTML = meta.roles
      .map(
        (r) =>
          `<label class="bc-check"><input type="checkbox" value="${r}" /> ${ROLE_LABELS[r] || r} <small>(${roleCount(r)})</small></label>`
      )
      .join("");
    renderUsers("");
  }

  function renderUsers(filter) {
    const q = (filter || "").trim().toLowerCase();
    const list = (meta?.users || []).filter(
      (u) => !q || (u.email || "").toLowerCase().includes(q) || (u.full_name || "").toLowerCase().includes(q)
    );
    el("bcUserList").innerHTML = list.length
      ? list
          .map(
            (u) =>
              `<label class="bc-check"><input type="checkbox" value="${u.id}" /> ${esc(u.full_name || u.email)} <small>${ROLE_LABELS[u.role] || u.role}</small></label>`
          )
          .join("")
      : `<div class="bc-empty">Нічого не знайдено</div>`;
  }

  function renderAttachments() {
    el("bcFileList").innerHTML = attachments
      .map(
        (f, i) =>
          `<div class="bc-chip"><span>${esc(f.file_name || "файл")}</span><button type="button" data-rm-file="${i}">&times;</button></div>`
      )
      .join("");
  }

  // ---- Завантаження даних ----
  async function loadAll() {
    if (!meta) {
      meta = await getJSON(`${API}/meta`);
      buildForm();
      await loadTemplates();
    }
    await loadHistory();
  }

  async function loadHistory() {
    const { notifications } = await getJSON(API);
    el("bcHistoryBody").innerHTML = notifications.length
      ? notifications
          .map((n) => {
            const total = n.recipients || 0;
            const read = n.read_count || 0;
            const canSend = n.status === "draft" || n.status === "scheduled";
            return `<tr>
              <td>${esc(n.title)}${n.files_count ? ` <small>(${n.files_count} файл.)</small>` : ""}</td>
              <td><span class="bc-badge type-${n.type}">${TYPE_LABELS[n.type] || n.type}</span></td>
              <td><span class="bc-status ${n.status}">${STATUS_LABELS[n.status] || n.status}</span>${
                n.status === "scheduled" && n.scheduled_at ? `<br><small>${fmtDate(n.scheduled_at)}</small>` : ""
              }</td>
              <td>${total}</td>
              <td>${total ? `${read}/${total}` : "—"}</td>
              <td>${fmtDate(n.created_at)}</td>
              <td class="bc-cell-actions">
                <button class="btn sm ghost" data-view="${n.id}">Деталі</button>
                ${canSend ? `<button class="btn sm ok" data-send="${n.id}">Надіслати</button>` : ""}
                ${n.status !== "archived" ? `<button class="btn sm ghost" data-archive="${n.id}">Архів</button>` : ""}
                <button class="btn sm danger" data-del="${n.id}">&times;</button>
              </td></tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="bc-empty">Повідомлень ще немає</td></tr>`;
  }

  async function loadTemplates() {
    const data = await getJSON(`${API}/templates`);
    templates = data.templates || [];
    el("bcTemplatesBody").innerHTML = templates.length
      ? templates
          .map(
            (t) => `<tr>
              <td>${esc(t.name)}</td>
              <td><span class="bc-badge type-${t.type}">${TYPE_LABELS[t.type] || t.type}</span></td>
              <td>${esc(t.title || "—")}</td>
              <td class="bc-cell-actions">
                <button class="btn sm ghost" data-use-tpl="${t.id}">Використати</button>
                <button class="btn sm danger" data-del-tpl="${t.id}">&times;</button>
              </td></tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="bc-empty">Шаблонів ще немає</td></tr>`;
    el("bcTemplatePick").innerHTML =
      `<option value="">— без шаблону —</option>` +
      templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  }

  // ---- Дії форми ----
  function collectPayload() {
    const audience = document.querySelector('input[name="bcAudience"]:checked')?.value || "all";
    return {
      title: el("bcTitle").value.trim(),
      body: el("bcBody").value.trim(),
      type: el("bcType").value,
      channels: checkedValues(el("bcChannels")),
      audience_mode: audience,
      audience_roles: audience === "roles" ? checkedValues(el("bcAudienceRoles")) : [],
      audience_users: audience === "users" ? checkedValues(el("bcUserList")).map(Number) : [],
      files: attachments,
    };
  }

  function resetForm() {
    el("bcForm").reset();
    attachments = [];
    el("bcFileList").innerHTML = "";
    document.querySelector('input[name="bcAudience"][value="all"]').checked = true;
    document.querySelector('input[name="bcWhen"][value="now"]').checked = true;
    el("bcAudienceRoles").classList.add("hidden");
    el("bcAudienceUsers").classList.add("hidden");
    el("bcSchedule").classList.add("hidden");
    el("bcSubmit").textContent = "Надіслати";
    el("bcChannels").querySelectorAll("input").forEach((i) => (i.checked = i.value === "platform"));
  }

  function applyTemplate(t) {
    el("bcType").value = t.type;
    el("bcTitle").value = t.title || "";
    el("bcBody").value = t.body || "";
    const channels = Array.isArray(t.channels) ? t.channels : [];
    el("bcChannels").querySelectorAll("input").forEach((i) => (i.checked = channels.includes(i.value)));
  }

  async function submit(action) {
    const payload = collectPayload();
    if (!payload.title) return toast("err", "Вкажіть заголовок");
    if (action === "schedule") {
      const val = el("bcSchedule").value;
      if (!val) return toast("err", "Вкажіть дату та час надсилання");
      payload.scheduled_at = new Date(val).toISOString();
    }
    payload.action = action;
    const { ok, data } = await req("POST", API, payload);
    if (!ok) return toast("err", data.error || "Помилка");
    const msg =
      action === "send"
        ? `Надіслано ${data.delivered} отримувачам`
        : action === "schedule"
          ? "Повідомлення заплановано"
          : "Чернетку збережено";
    toast("ok", msg);
    resetForm();
    loadHistory();
  }

  async function saveTemplate() {
    const name = prompt("Назва шаблону:");
    if (!name) return;
    const { ok, data } = await req("POST", `${API}/templates`, {
      name: name.trim(),
      type: el("bcType").value,
      title: el("bcTitle").value.trim(),
      body: el("bcBody").value.trim(),
      channels: checkedValues(el("bcChannels")),
    });
    if (!ok) return toast("err", data.error || "Помилка");
    toast("ok", "Шаблон збережено");
    loadTemplates();
  }

  async function openModal(id) {
    const { message, recipients, files, logs } = await getJSON(`${API}/${id}`);
    const channels = (Array.isArray(message.channels) ? message.channels : [])
      .map((c) => `<span class="bc-pill">${CHANNEL_LABELS[c] || c}</span>`)
      .join("");
    const filesHtml = files.length
      ? files
          .map((f) => `<a class="bc-pill" href="${f.file_url}" target="_blank" rel="noopener">${esc(f.file_name || "файл")}</a>`)
          .join("")
      : "<small>немає</small>";
    const recipientsHtml = recipients.length
      ? recipients
          .map(
            (r) =>
              `<tr><td>${esc(r.full_name || r.email)}<br><small>${esc(r.email)}</small></td>
               <td>${ROLE_LABELS[r.role] || r.role}</td>
               <td><span class="bc-status ${r.is_read ? "sent" : "scheduled"}">${r.is_read ? "Прочитано" : "Не прочитано"}</span></td></tr>`
          )
          .join("")
      : `<tr><td colspan="3" class="bc-empty">Отримувачів ще немає</td></tr>`;

    el("bcModalContent").innerHTML = `
      <h2>${esc(message.title)}</h2>
      <div class="bc-metarow">
        <span class="bc-badge type-${message.type}">${TYPE_LABELS[message.type] || message.type}</span>
        <span class="bc-status ${message.status}">${STATUS_LABELS[message.status] || message.status}</span>
      </div>
      <p class="bc-modalbody">${esc(message.body || "—")}</p>
      <div class="bc-modalsec"><strong>Канали:</strong> ${channels || "—"}</div>
      <div class="bc-modalsec"><strong>Файли:</strong> ${filesHtml}</div>
      ${message.scheduled_at ? `<div class="bc-modalsec"><strong>Заплановано на:</strong> ${fmtDate(message.scheduled_at)}</div>` : ""}
      ${message.sent_at ? `<div class="bc-modalsec"><strong>Надіслано:</strong> ${fmtDate(message.sent_at)}</div>` : ""}
      <h3>Отримувачі (${recipients.length})</h3>
      <div class="bc-modalscroll">
        <table class="tbl bc-tbl"><thead><tr><th>Користувач</th><th>Роль</th><th>Статус</th></tr></thead>
        <tbody>${recipientsHtml}</tbody></table>
      </div>
      <h3>Журнал доставки</h3>
      <div class="bc-modalscroll">
        <table class="tbl bc-tbl"><thead><tr><th>Дата</th><th>Канал</th><th>Статус</th><th>Отримувач</th></tr></thead>
        <tbody>${
          logs.length
            ? logs
                .map(
                  (l) =>
                    `<tr><td>${fmtDate(l.created_at)}</td><td>${CHANNEL_LABELS[l.channel] || l.channel}</td>
                     <td><span class="bc-status sent">${esc(l.status)}</span></td><td>${esc(l.email || "—")}</td></tr>`
                )
                .join("")
            : `<tr><td colspan="4" class="bc-empty">Записів немає</td></tr>`
        }</tbody></table>
      </div>`;
    el("bcModal").classList.remove("hidden");
  }

  // ---- Події ----
  function initEvents() {
    // Вкладки
    document.querySelectorAll("#bcTabs .bc-tab").forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll("#bcTabs .bc-tab").forEach((t) => t.classList.toggle("active", t === tab));
        document
          .querySelectorAll('[data-page="broadcast"] .bc-pane')
          .forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== tab.dataset.tab));
        if (tab.dataset.tab === "history") loadHistory();
        if (tab.dataset.tab === "templates") loadTemplates();
      };
    });

    // Аудиторія
    document.querySelectorAll('input[name="bcAudience"]').forEach((r) => {
      r.onchange = () => {
        el("bcAudienceRoles").classList.toggle("hidden", r.value !== "roles");
        el("bcAudienceUsers").classList.toggle("hidden", r.value !== "users");
      };
    });

    // Час надсилання
    document.querySelectorAll('input[name="bcWhen"]').forEach((r) => {
      r.onchange = () => {
        const later = document.querySelector('input[name="bcWhen"]:checked').value === "later";
        el("bcSchedule").classList.toggle("hidden", !later);
        el("bcSubmit").textContent = later ? "Запланувати" : "Надіслати";
      };
    });

    el("bcUserSearch").oninput = (e) => renderUsers(e.target.value);

    el("bcFile").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast("err", data.error || "Помилка завантаження");
      attachments.push(data.file);
      renderAttachments();
      el("bcFile").value = "";
      toast("ok", "Файл додано");
    };

    el("bcFileList").addEventListener("click", (e) => {
      const i = e.target.getAttribute("data-rm-file");
      if (i === null) return;
      attachments.splice(Number(i), 1);
      renderAttachments();
    });

    el("bcTemplatePick").onchange = (e) => {
      const t = templates.find((x) => String(x.id) === e.target.value);
      if (!t) return;
      applyTemplate(t);
      toast("ok", "Шаблон застосовано");
    };

    el("bcForm").addEventListener("click", async (e) => {
      const action = e.target.getAttribute("data-action");
      if (action === "draft") {
        e.preventDefault();
        await submit("draft");
      } else if (action === "save-template") {
        e.preventDefault();
        await saveTemplate();
      }
    });

    el("bcForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const later = document.querySelector('input[name="bcWhen"]:checked').value === "later";
      await submit(later ? "schedule" : "send");
    });

    el("bcHistoryBody").addEventListener("click", async (e) => {
      const view = e.target.getAttribute("data-view");
      const send = e.target.getAttribute("data-send");
      const archive = e.target.getAttribute("data-archive");
      const del = e.target.getAttribute("data-del");
      if (view) return openModal(view);
      if (send) {
        const { ok, data } = await req("POST", `${API}/${send}/send`);
        toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
        if (ok) loadHistory();
      } else if (archive) {
        const { ok, data } = await req("POST", `${API}/${archive}/archive`);
        toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
        if (ok) loadHistory();
      } else if (del) {
        if (!confirm("Видалити повідомлення?")) return;
        const { ok, data } = await req("DELETE", `${API}/${del}`);
        toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
        if (ok) loadHistory();
      }
    });

    el("bcTemplatesBody").addEventListener("click", async (e) => {
      const use = e.target.getAttribute("data-use-tpl");
      const del = e.target.getAttribute("data-del-tpl");
      if (use) {
        const t = templates.find((x) => String(x.id) === use);
        if (t) {
          applyTemplate(t);
          document.querySelector('#bcTabs .bc-tab[data-tab="create"]').click();
          toast("ok", "Шаблон завантажено у форму");
        }
      } else if (del) {
        if (!confirm("Видалити шаблон?")) return;
        const { ok, data } = await req("DELETE", `${API}/templates/${del}`);
        toast(ok ? "ok" : "err", ok ? data.message : data.error || "Помилка");
        if (ok) loadTemplates();
      }
    });

    el("bcModalClose").onclick = () => el("bcModal").classList.add("hidden");
    el("bcModal").addEventListener("click", (e) => {
      if (e.target.id === "bcModal") el("bcModal").classList.add("hidden");
    });
  }

  // ---- Старт ----
  function start() {
    if (!inject()) return;
    initEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
