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

const menuKeyboard = Markup.keyboard([["👤 Мій профіль", "🔔 Сповіщення"], ["🚪 Вийти"]])
  .resize();

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
        ...menuKeyboard,
      });
    }

    // Не в процесі входу
    if (session.step === "authorized") {
      return ctx.reply("Скористайтеся меню нижче або командою /start.", menuKeyboard);
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
  // Перевірка з'єднання з базою
  await pool.query("SELECT 1");
  console.log("[v0] Підключення до бази даних успішне.");

  await bot.launch();
  console.log("[v0] Telegram-бот VARTA запущено.");
}

main().catch((err) => {
  console.error("[v0] Не вдалося запустити бота:", err.message);
  process.exit(1);
});

// Коректне завершення
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
