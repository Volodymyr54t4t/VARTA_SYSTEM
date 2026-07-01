// ============================================================================
//  VARTA — Telegram-бот платформи
//  Авторизація по email + пароль зі звіркою з базою даних (PostgreSQL / Neon).
//  Після успішного входу бот показує інформацію відповідно до ролі користувача.
//  Стек: Node.js + Telegraf + pg + bcryptjs
// ============================================================================

import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

// ----------------------------------------------------------------------------
//  Конфігурація
// ----------------------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error(
    "[v0] Не задано TELEGRAM_BOT_TOKEN. Додайте змінну середовища з токеном від @BotFather."
  );
  process.exit(1);
}

// Та сама база даних, що й у платформі (src/server.js)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Людські назви ролей для відображення
const ROLE_LABELS = {
  guest: "Гість",
  admin: "Адміністратор",
  methodist: "Методист",
  zavuch: "Завуч",
  teacher: "Вчитель",
  student: "Учень",
  jury: "Журі",
  system: "Система",
};

const bot = new Telegraf(BOT_TOKEN);

// ----------------------------------------------------------------------------
//  Стан діалогу (у пам'яті процесу).
//  sessions[chatId] = {
//    step: "idle" | "await_email" | "await_password" | "authorized",
//    email, user: { id, email, role, status }
//  }
// ----------------------------------------------------------------------------
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: "idle" });
  return sessions.get(chatId);
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ----------------------------------------------------------------------------
//  Перевірка облікових даних у базі (та сама логіка, що й /api/login)
// ----------------------------------------------------------------------------
async function authenticate(email, password) {
  const r = await pool.query("SELECT * FROM users WHERE email = $1", [
    String(email).toLowerCase(),
  ]);
  const user = r.rows[0];
  if (!user) return { ok: false, error: "Невірний email або пароль." };

  const passwordOk = await bcrypt.compare(password, user.password);
  if (!passwordOk) return { ok: false, error: "Невірний email або пароль." };

  if (user.status !== "active") {
    return { ok: false, error: "Акаунт не активовано. Спочатку підтвердіть email на платформі." };
  }

  return {
    ok: true,
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
  };
}

// ----------------------------------------------------------------------------
//  Збір інформації по користувачу залежно від ролі
// ----------------------------------------------------------------------------
async function buildProfileHeader(user) {
  const p = await pool.query(
    "SELECT full_name, phone FROM user_profiles WHERE user_id = $1 ORDER BY id LIMIT 1",
    [user.id]
  );
  const profile = p.rows[0] || {};
  const roleLabel = ROLE_LABELS[user.role] || user.role;

  return [
    "✅ *Вхід виконано*",
    "",
    `👤 *${profile.full_name || "Без імені"}*`,
    `📧 ${user.email}`,
    profile.phone ? `📞 ${profile.phone}` : null,
    `🔑 Роль: *${roleLabel}*`,
    `📌 Статус: ${user.status}`,
    `🆔 ID: ${user.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Кількість непрочитаних сповіщень — актуально для всіх ролей
async function unreadNotifications(userId) {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND is_read = false",
    [userId]
  );
  return r.rows[0]?.c || 0;
}

async function buildRoleDetails(user) {
  const lines = [];

  switch (user.role) {
    case "admin":
    case "system": {
      const totals = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users)         AS users,
          (SELECT COUNT(*)::int FROM schools)       AS schools,
          (SELECT COUNT(*)::int FROM competitions)  AS competitions,
          (SELECT COUNT(*)::int FROM user_roles_requests WHERE status = 'pending') AS pending_roles
      `);
      const t = totals.rows[0];
      const byRole = await pool.query(
        "SELECT role, COUNT(*)::int AS c FROM users GROUP BY role ORDER BY c DESC"
      );
      lines.push("*Огляд платформи*");
      lines.push(`• Користувачів: ${t.users}`);
      lines.push(`• Шкіл: ${t.schools}`);
      lines.push(`• Конкурсів: ${t.competitions}`);
      lines.push(`• Запитів на роль (очікують): ${t.pending_roles}`);
      lines.push("");
      lines.push("*Користувачі за ролями:*");
      for (const row of byRole.rows) {
        lines.push(`• ${ROLE_LABELS[row.role] || row.role}: ${row.c}`);
      }
      break;
    }

    case "methodist": {
      const comps = await pool.query(
        `SELECT id, title, status, starts_at, ends_at
         FROM competitions WHERE methodist_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [user.id]
      );
      lines.push(`*Ваші конкурси* (${comps.rowCount})`);
      if (comps.rowCount === 0) lines.push("• Поки що немає створених конкурсів.");
      for (const c of comps.rows) {
        lines.push(`• #${c.id} ${c.title} — _${c.status}_`);
      }
      const apps = await pool.query(
        `SELECT COUNT(*)::int AS c
         FROM applications a
         JOIN competitions comp ON comp.id = a.competition_id
         WHERE comp.methodist_id = $1`,
        [user.id]
      );
      lines.push("");
      lines.push(`Загалом заявок у ваших конкурсах: ${apps.rows[0].c}`);
      break;
    }

    case "zavuch": {
      const schools = await pool.query(
        "SELECT id, name, address FROM schools WHERE zavuch_id = $1 ORDER BY name",
        [user.id]
      );
      lines.push(`*Ваші школи* (${schools.rowCount})`);
      for (const s of schools.rows) {
        const teachers = await pool.query(
          "SELECT COUNT(*)::int AS c FROM teachers WHERE school_id = $1",
          [s.id]
        );
        const students = await pool.query(
          "SELECT COUNT(*)::int AS c FROM students WHERE school_id = $1",
          [s.id]
        );
        lines.push(
          `• #${s.id} ${s.name} — вчителів: ${teachers.rows[0].c}, учнів: ${students.rows[0].c}`
        );
      }
      if (schools.rowCount === 0) lines.push("• За вами не закріплено жодної школи.");
      break;
    }

    case "teacher": {
      const schools = await pool.query(
        `SELECT s.name, t.confirmed
         FROM teachers t JOIN schools s ON s.id = t.school_id
         WHERE t.user_id = $1`,
        [user.id]
      );
      lines.push("*Ваші школи:*");
      for (const s of schools.rows) {
        lines.push(`• ${s.name} — ${s.confirmed ? "підтверджено" : "очікує підтвердження"}`);
      }
      if (schools.rowCount === 0) lines.push("• Ви ще не закріплені за школою.");

      const students = await pool.query(
        "SELECT COUNT(*)::int AS c FROM students WHERE teacher_id = $1",
        [user.id]
      );
      lines.push("");
      lines.push(`Ваших учнів: ${students.rows[0].c}`);
      break;
    }

    case "student": {
      const info = await pool.query(
        `SELECT s.class, sc.name AS school
         FROM students s JOIN schools sc ON sc.id = s.school_id
         WHERE s.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (info.rowCount > 0) {
        lines.push(`*Школа:* ${info.rows[0].school}`);
        lines.push(`*Клас:* ${info.rows[0].class || "—"}`);
      } else {
        lines.push("Вас ще не закріплено за школою.");
      }
      const apps = await pool.query(
        `SELECT a.id, c.title, a.status
         FROM applications a JOIN competitions c ON c.id = a.competition_id
         WHERE a.student_id = $1 ORDER BY a.created_at DESC LIMIT 10`,
        [user.id]
      );
      lines.push("");
      lines.push(`*Ваші заявки* (${apps.rowCount})`);
      for (const a of apps.rows) lines.push(`• ${a.title || "конкурс"} — _${a.status}_`);

      const diplomas = await pool.query(
        "SELECT COUNT(*)::int AS c FROM diplomas WHERE student_id = $1",
        [user.id]
      );
      lines.push("");
      lines.push(`🏅 Дипломів: ${diplomas.rows[0].c}`);
      break;
    }

    case "jury": {
      const comps = await pool.query(
        `SELECT c.id, c.title, j.role
         FROM competition_judges j JOIN competitions c ON c.id = j.competition_id
         WHERE j.user_id = $1 ORDER BY c.created_at DESC`,
        [user.id]
      );
      lines.push(`*Конкурси, де ви в журі* (${comps.rowCount})`);
      for (const c of comps.rows) lines.push(`• #${c.id} ${c.title} — ${c.role}`);

      const scored = await pool.query(
        "SELECT COUNT(*)::int AS c FROM results WHERE judge_id = $1",
        [user.id]
      );
      lines.push("");
      lines.push(`Оцінено робіт: ${scored.rows[0].c}`);
      break;
    }

    default: {
      lines.push("Ваша роль ще не має розширеного доступу. Зверніться до адміністратора.");
    }
  }

  const unread = await unreadNotifications(user.id);
  lines.push("");
  lines.push(`🔔 Непрочитаних сповіщень: ${unread}`);

  return lines.join("\n");
}

// ----------------------------------------------------------------------------
//  АДМІН-РЕЖИМ: перегляд усіх даних платформи (як в адмін-панелі)
// ----------------------------------------------------------------------------
const PAGE_SIZE = 10;

// Екранування для parse_mode: HTML
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAdmin(session) {
  return (
    session.step === "authorized" &&
    session.user &&
    ["admin", "system"].includes(session.user.role)
  );
}

// Опис кожного розділу: як отримати сторінку даних і як показати рядок.
// Запити повторюють ті самі, що й адмінські ендпоінти в src/server.js.
const ADMIN_SECTIONS = {
  users: {
    title: "👥 Користувачі",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM users")).rows[0].c;
      const r = await pool.query(
        `SELECT u.id, u.email, u.role, u.status, p.full_name
           FROM users u
           LEFT JOIN user_profiles p ON p.user_id = u.id
          ORDER BY u.created_at DESC
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (u) =>
      `#${u.id} <b>${esc(u.full_name || u.email)}</b>\n` +
      `   📧 ${esc(u.email)}\n` +
      `   🔑 ${esc(ROLE_LABELS[u.role] || u.role)} · ${esc(u.status)}`,
  },

  schools: {
    title: "🏫 Школи",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM schools")).rows[0].c;
      const r = await pool.query(
        `SELECT s.id, s.name, s.address, c.name AS city_name, r.name AS region_name
           FROM schools s
           JOIN cities c ON c.id = s.city_id
           JOIN regions r ON r.id = c.region_id
          ORDER BY r.name, c.name, s.name
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (s) =>
      `#${s.id} <b>${esc(s.name)}</b>\n` +
      `   📍 ${esc(s.region_name)}, ${esc(s.city_name)}` +
      (s.address ? ` · ${esc(s.address)}` : ""),
  },

  regions: {
    title: "🗺 Області",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM regions")).rows[0].c;
      const r = await pool.query(
        `SELECT r.id, r.name,
                (SELECT COUNT(*)::int FROM cities c WHERE c.region_id = r.id) AS cities_count
           FROM regions r
          ORDER BY r.name
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (r) => `#${r.id} <b>${esc(r.name)}</b> — міст: ${r.cities_count}`,
  },

  cities: {
    title: "🏙 Міста",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM cities")).rows[0].c;
      const r = await pool.query(
        `SELECT c.id, c.name, r.name AS region_name,
                (SELECT COUNT(*)::int FROM schools s WHERE s.city_id = c.id) AS schools_count
           FROM cities c
           JOIN regions r ON r.id = c.region_id
          ORDER BY r.name, c.name
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (c) =>
      `#${c.id} <b>${esc(c.name)}</b> (${esc(c.region_name)}) — шкіл: ${c.schools_count}`,
  },

  "role-requests": {
    title: "📋 Запити на ролі",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM user_roles_requests")).rows[0].c;
      const r = await pool.query(
        `SELECT rr.id, rr.role, rr.status, u.email, p.full_name
           FROM user_roles_requests rr
           JOIN users u ON u.id = rr.user_id
           LEFT JOIN user_profiles p ON p.user_id = u.id
          ORDER BY rr.created_at DESC
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (rr) =>
      `#${rr.id} <b>${esc(rr.full_name || rr.email)}</b>\n` +
      `   → ${esc(ROLE_LABELS[rr.role] || rr.role)} · <i>${esc(rr.status)}</i>`,
  },

  competitions: {
    title: "🏆 Конкурси",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM competitions")).rows[0].c;
      const r = await pool.query(
        `SELECT c.id, c.title, c.status, p.full_name AS methodist
           FROM competitions c
           LEFT JOIN user_profiles p ON p.user_id = c.methodist_id
          ORDER BY c.created_at DESC
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (c) =>
      `#${c.id} <b>${esc(c.title)}</b> · <i>${esc(c.status)}</i>` +
      (c.methodist ? `\n   👤 ${esc(c.methodist)}` : ""),
  },

  logs: {
    title: "📜 Логи системи",
    async page(offset) {
      const total = (await pool.query("SELECT COUNT(*)::int AS c FROM system_logs")).rows[0].c;
      const r = await pool.query(
        `SELECT l.id, l.action, l.details, l.created_at, u.email AS actor
           FROM system_logs l
           LEFT JOIN users u ON u.id = l.user_id
          ORDER BY l.created_at DESC
          LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, offset]
      );
      return { total, rows: r.rows };
    },
    format: (l) =>
      `<b>${esc(l.action)}</b>${l.details ? ` — ${esc(l.details)}` : ""}\n` +
      `   👤 ${esc(l.actor || "система")}`,
  },
};

// Формує текст сторінки розділу + інлайн-кнопки навігації
async function renderAdminSection(key, page) {
  const section = ADMIN_SECTIONS[key];
  const offset = page * PAGE_SIZE;
  const { total, rows } = await section.page(offset);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const header =
    `<b>${esc(section.title)}</b> — всього: ${total}\n` +
    `Сторінка ${page + 1}/${pages}`;
  const body = rows.length ? rows.map(section.format).join("\n\n") : "Порожньо.";

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Назад", `adm:${key}:${page - 1}`));
  if (page < pages - 1) nav.push(Markup.button.callback("Далі ➡️", `adm:${key}:${page + 1}`));

  return {
    text: `${header}\n\n${body}`,
    keyboard: nav.length ? Markup.inlineKeyboard([nav]) : undefined,
  };
}

async function sendAdminSection(ctx, key) {
  const session = getSession(ctx.chat.id);
  if (!isAdmin(session)) {
    return ctx.reply("Цей розділ доступний лише адміністратору.");
  }
  const { text, keyboard } = await renderAdminSection(key, 0);
  return ctx.reply(text, { parse_mode: "HTML", ...(keyboard || {}) });
}

// Меню для звичайних ролей
const menuKeyboard = Markup.keyboard([["👤 Мій профіль", "🔔 Сповіщення"], ["🚪 Вийти"]])
  .resize();

// Розширене меню адміністратора — перегляд усіх даних платформи
const adminMenuKeyboard = Markup.keyboard([
  ["👥 Користувачі", "🏫 Школи"],
  ["🗺 Області", "🏙 Міста"],
  ["📋 Запити ролей", "🏆 Конкурси"],
  ["📜 Логи", "📊 Статистика"],
  ["🔔 Сповіщення", "👤 Мій профіль"],
  ["🚪 Вийти"],
]).resize();

// Обирає меню відповідно до ролі користувача
function keyboardFor(user) {
  return ["admin", "system"].includes(user.role) ? adminMenuKeyboard : menuKeyboard;
}

// ----------------------------------------------------------------------------
//  Хендлери
// ----------------------------------------------------------------------------
bot.start(async (ctx) => {
  const session = getSession(ctx.chat.id);
  session.step = "await_email";
  session.email = null;
  session.user = null;
  await ctx.reply(
    "👋 Вітаю у боті платформи *VARTA*!\n\nДля входу введіть вашу *електронну пошту*:",
    { parse_mode: "Markdown" }
  );
});

bot.command("logout", async (ctx) => {
  sessions.set(ctx.chat.id, { step: "idle" });
  await ctx.reply("Ви вийшли із системи. Натисніть /start, щоб увійти знову.", Markup.removeKeyboard());
});

bot.hears("🚪 Вийти", async (ctx) => {
  sessions.set(ctx.chat.id, { step: "idle" });
  await ctx.reply("Ви вийшли із системи. Натисніть /start, щоб увійти знову.", Markup.removeKeyboard());
});

bot.hears("👤 Мій профіль", async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (session.step !== "authorized" || !session.user) {
    return ctx.reply("Спершу увійдіть: /start");
  }
  const header = await buildProfileHeader(session.user);
  const details = await buildRoleDetails(session.user);
  await ctx.reply(`${header}\n\n${details}`, { parse_mode: "Markdown" });
});

bot.hears("🔔 Сповіщення", async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (session.step !== "authorized" || !session.user) {
    return ctx.reply("Спершу увійдіть: /start");
  }
  const r = await pool.query(
    `SELECT message, is_read, created_at FROM notifications
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [session.user.id]
  );
  if (r.rowCount === 0) return ctx.reply("У вас немає сповіщень.");
  const text = r.rows
    .map((n) => `${n.is_read ? "▫️" : "🔹"} ${n.message}`)
    .join("\n\n");
  await ctx.reply(`*Останні сповіщення:*\n\n${text}`, { parse_mode: "Markdown" });
});

// --- Адмінські розділи (перегляд усіх даних платформи) ---
bot.hears("👥 Користувачі", (ctx) => sendAdminSection(ctx, "users"));
bot.hears("🏫 Школи", (ctx) => sendAdminSection(ctx, "schools"));
bot.hears("🗺 Області", (ctx) => sendAdminSection(ctx, "regions"));
bot.hears("🏙 Міста", (ctx) => sendAdminSection(ctx, "cities"));
bot.hears("📋 Запити ролей", (ctx) => sendAdminSection(ctx, "role-requests"));
bot.hears("🏆 Конкурси", (ctx) => sendAdminSection(ctx, "competitions"));
bot.hears("📜 Логи", (ctx) => sendAdminSection(ctx, "logs"));

bot.hears("📊 Статистика", async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (!isAdmin(session)) return ctx.reply("Цей розділ доступний лише адміністратору.");
  const details = await buildRoleDetails(session.user);
  await ctx.reply(details, { parse_mode: "Markdown" });
});

// Пагінація адмінських списків (інлайн-кнопки ⬅️ / ➡️)
bot.action(/^adm:([a-z-]+):(\d+)$/, async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (!isAdmin(session)) return ctx.answerCbQuery("Немає доступу");
  const key = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  if (!ADMIN_SECTIONS[key]) return ctx.answerCbQuery();
  try {
    const { text, keyboard } = await renderAdminSection(key, page);
    await ctx.answerCbQuery();
    await ctx.editMessageText(text, { parse_mode: "HTML", ...(keyboard || {}) });
  } catch (err) {
    console.error("[v0] Помилка пагінації:", err.message);
    await ctx.answerCbQuery("Помилка завантаження");
  }
});

// Головний обробник тексту — керує кроками авторизації
bot.on("text", async (ctx) => {
  const session = getSession(ctx.chat.id);
  const text = (ctx.message.text || "").trim();

  // Пропускаємо команди/кнопки — вони обробляються вище
  if (text.startsWith("/")) return;

  try {
    if (session.step === "await_email") {
      if (!isValidEmail(text)) {
        return ctx.reply("❌ Некоректний email. Спробуйте ще раз:");
      }
      session.email = text.toLowerCase();
      session.step = "await_password";
      return ctx.reply("🔒 Тепер введіть *пароль*:", { parse_mode: "Markdown" });
    }

    if (session.step === "await_password") {
      const password = text;
      // Прибираємо повідомлення з паролем задля безпеки
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      const result = await authenticate(session.email, password);
      if (!result.ok) {
        session.step = "await_email";
        session.email = null;
        return ctx.reply(`❌ ${result.error}\n\nВведіть email ще раз:`);
      }

      session.step = "authorized";
      session.user = result.user;

      const header = await buildProfileHeader(result.user);
      const details = await buildRoleDetails(result.user);
      return ctx.reply(`${header}\n\n${details}`, {
        parse_mode: "Markdown",
        ...keyboardFor(result.user),
      });
    }

    // Не в процесі входу
    if (session.step === "authorized") {
      return ctx.reply("Скористайтеся меню нижче або командою /start.", keyboardFor(session.user));
    }

    return ctx.reply("Натисніть /start, щоб увійти.");
  } catch (err) {
    console.error("[v0] Помилка обробки повідомлення:", err.message);
    return ctx.reply("⚠️ Сталася помилка. Спробуйте пізніше.");
  }
});

// ----------------------------------------------------------------------------
//  Запуск
// ----------------------------------------------------------------------------
async function main() {
  // 1) Перевірка з'єднання з базою
  try {
    await pool.query("SELECT 1");
    console.log("[v0] Підключення до бази даних успішне.");
  } catch (err) {
    console.error(
      "[v0] Не вдалося підключитися до бази даних. Перевірте DATABASE_URL у файлі .env.\n",
      err
    );
    process.exit(1);
  }

  // 2) Перевірка, що токен дійсний (getMe)
  try {
    const me = await bot.telegram.getMe();
    console.log(`[v0] Токен дійсний. Бот: @${me.username}`);
  } catch (err) {
    console.error(
      "[v0] Невірний TELEGRAM_BOT_TOKEN. Перевірте токен від @BotFather у файлі .env.\n",
      err
    );
    process.exit(1);
  }

  // 3) Запуск polling.
  //    bot.launch() у Telegraf блокує виконання, тому НЕ використовуємо await —
  //    інакше повідомлення про старт нижче не з'явиться.
  bot.launch();
  console.log("[v0] Telegram-бот VARTA запущено. Напишіть боту /start у Telegram.");
}

main().catch((err) => {
  console.error("[v0] Не вдалося запустити бота:", err);
  process.exit(1);
});

// Коректне завершення
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
