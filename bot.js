import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { Resend } from "resend";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "Marcos de XORA <marcos@xora-studio.com>";
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
  ? parseInt(process.env.ALLOWED_USER_ID)
  : null;

// Memoria persistente con Redis (Railway)
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const MEMORY_KEY = "xora:memory";

async function loadMemory() {
  if (!redis) return {};
  try {
    const data = await redis.get(MEMORY_KEY);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

async function saveMemory(memory) {
  if (!redis) return;
  await redis.set(MEMORY_KEY, JSON.stringify(memory));
}

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Faltan TELEGRAM_TOKEN o ANTHROPIC_API_KEY en el .env");
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Emails pendientes de confirmación: userId → { to, subject, body }
const pendingEmails = new Map();

// Historial de conversación por usuario
const history = new Map();
const MAX_HISTORY = 20;

const SYSTEM_PROMPT = `Eres el asistente personal de Marcos, fundador de XORA, una agencia de contenido con IA especializada en creación de fotos y vídeos para marcas.

## Sobre XORA
- Crea contenido visual (fotos y vídeos) con IA de calidad profesional para marcas y negocios.
- Tienen a Enzo, su influencer IA (modelo masculino), para contenido de lifestyle, moda y producto.
- También transforman imágenes existentes del cliente elevándolas con IA.
- Email de XORA: contacto@xoralab.com

## Tarifas
- 1 vídeo: desde 200€ | Pack 3: desde 400€ | Pack 5: desde 600€
- Pack 3 fotos: 120€ | Pack 5: 190€ | Pack 8: 300€
- Extras: derechos anuncios +30-50%, raw +50%, uso ilimitado 250€ fijo

## Herramientas disponibles

### search_web
Busca negocios potenciales en internet. Para cada negocio encontrado analiza:
- ¿Tienen web? ¿Email visible?
- ¿Redes sociales activas? ¿Qué calidad tiene su contenido visual?
- ¿Encajan con los servicios de XORA?
Presenta los resultados con nombre, descripción, canal de contacto recomendado y por qué encajan.

### prepare_email
Úsala cuando Marcos quiera contactar a un negocio por email.
- Redacta un email profesional, cercano y personalizado presentando XORA.
- El email debe ser corto (máx 150 palabras), directo y orientado al beneficio del negocio.
- Menciona algo específico del negocio para que no parezca spam.
- Firma siempre como Marcos, de XORA.
- Tras usar esta herramienta, dile a Marcos que revise el email y escriba /enviar para enviarlo o /cancelar para descartarlo.

### save_memory
Guarda información importante de forma permanente. Úsala cuando Marcos te diga algo relevante sobre la agencia: nuevos clientes, proyectos, precios actualizados, preferencias, notas importantes, etc. También úsala proactivamente cuando detectes info valiosa que convenga recordar.

### get_memory
Recupera toda la información guardada. Úsala al inicio de conversaciones importantes o cuando Marcos pregunte por algo que podría estar guardado.

## Para Instagram y otras redes
Si el contacto es por Instagram u otra red social, redacta el mensaje directamente en el chat (no uses herramienta) y díselo a Marcos para que lo envíe manualmente. El mensaje debe ser informal, breve y con gancho.

Responde siempre en español, de forma clara y directa.`;

const TOOLS = [
  {
    name: "search_web",
    description: "Busca negocios e información en internet.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Búsqueda específica, ej: 'gimnasios Madrid email contacto'",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "prepare_email",
    description: "Prepara un email de presentación de XORA pendiente de confirmación.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Email del destinatario" },
        business_name: { type: "string", description: "Nombre del negocio" },
        subject: { type: "string", description: "Asunto del email" },
        body: {
          type: "string",
          description: "Cuerpo del email, máximo 150 palabras, personalizado",
        },
      },
      required: ["to", "business_name", "subject", "body"],
    },
  },
  {
    name: "save_memory",
    description: "Guarda información importante de forma permanente (clientes, proyectos, precios, notas).",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Categoría de la información, ej: 'clientes', 'proyectos', 'precios', 'notas'",
        },
        value: {
          type: "string",
          description: "Información a guardar",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_memory",
    description: "Recupera toda la información guardada permanentemente.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function searchWeb(query) {
  if (!BRAVE_API_KEY) {
    return "Búsqueda no disponible: falta BRAVE_API_KEY en el .env";
  }
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=es&country=ES`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`Brave API error: ${res.status}`);
    const data = await res.json();
    const results = data.web?.results || [];
    if (results.length === 0) return "No se encontraron resultados.";
    return results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\nURL: ${r.url}\n${r.description || ""}`
      )
      .join("\n\n");
  } catch (err) {
    console.error("Error Brave Search:", err.message);
    return `Error al buscar: ${err.message}`;
  }
}

function prepareEmail(userId, { to, business_name, subject, body }) {
  pendingEmails.set(userId, { to, business_name, subject, body });
  return `Email preparado para ${business_name} (${to}). Pendiente de confirmación del usuario.`;
}

async function sendEmail({ to, subject, body }) {
  if (!RESEND_API_KEY) {
    throw new Error("Falta RESEND_API_KEY en las variables de entorno");
  }
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject,
    text: body,
    reply_to: process.env.REPLY_TO_EMAIL,
  });
  if (error) throw new Error(error.message);
}

async function runTool(name, input, userId) {
  if (name === "search_web") return await searchWeb(input.query);
  if (name === "prepare_email") return prepareEmail(userId, input);
  if (name === "save_memory") {
    const memory = await loadMemory();
    const existing = memory[input.key] ? memory[input.key] + "\n" : "";
    memory[input.key] = existing + `[${new Date().toLocaleDateString("es-ES")}] ${input.value}`;
    await saveMemory(memory);
    return `Guardado en '${input.key}': ${input.value}`;
  }
  if (name === "get_memory") {
    const memory = await loadMemory();
    if (Object.keys(memory).length === 0) return "No hay nada guardado aún.";
    return Object.entries(memory)
      .map(([k, v]) => `**${k}:**\n${v}`)
      .join("\n\n");
  }
  return "Herramienta no reconocida.";
}

async function askClaude(messages, userId) {
  let currentMessages = [...messages];

  while (true) {
    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: currentMessages,
    });

    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      currentMessages.push({ role: "assistant", content: response.content });
      return { text, messages: currentMessages };
    }

    if (response.stop_reason === "tool_use") {
      currentMessages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`Herramienta: ${block.name}`, block.input);
          const result = await runTool(block.name, block.input, userId);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      currentMessages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return { text: "No pude completar la tarea.", messages: currentMessages };
}

function isAuthorized(userId) {
  if (!ALLOWED_USER_ID) return true;
  return userId === ALLOWED_USER_ID;
}

function getHistory(userId) {
  if (!history.has(userId)) history.set(userId, []);
  return history.get(userId);
}

// ── COMANDOS ──────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(
    msg.chat.id,
    "Hola Marcos! Soy tu asistente de XORA.\n\n" +
    "Puedo:\n" +
    "🔍 Buscar negocios potenciales en internet\n" +
    "📧 Enviar emails de presentación por ti\n" +
    "✍️ Redactar mensajes para Instagram (tú los envías)\n" +
    "💼 Ayudarte con cualquier tarea de la agencia\n\n" +
    "Prueba: \"Búscame gimnasios en Madrid y contáctalos\""
  );
});

bot.onText(/\/reset/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  pendingEmails.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, "Conversación reiniciada.");
});

bot.onText(/\/enviar/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const pending = pendingEmails.get(msg.from.id);
  if (!pending) {
    bot.sendMessage(msg.chat.id, "No hay ningún email pendiente de envío.");
    return;
  }
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    await sendEmail(pending);
    pendingEmails.delete(msg.from.id);
    bot.sendMessage(
      msg.chat.id,
      `✅ Email enviado a ${pending.business_name} (${pending.to})`
    );
  } catch (err) {
    console.error("Error enviando email:", err.message);
    bot.sendMessage(
      msg.chat.id,
      `❌ Error al enviar: ${err.message}`
    );
  }
});

bot.onText(/\/cancelar/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  if (pendingEmails.has(msg.from.id)) {
    pendingEmails.delete(msg.from.id);
    bot.sendMessage(msg.chat.id, "Email cancelado.");
  } else {
    bot.sendMessage(msg.chat.id, "No hay ningún email pendiente.");
  }
});

// ── MENSAJES ──────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!isAuthorized(msg.from.id)) {
    bot.sendMessage(msg.chat.id, "No tienes acceso a este bot.");
    return;
  }

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const userHistory = getHistory(userId);

  userHistory.push({ role: "user", content: msg.text });

  if (userHistory.length > MAX_HISTORY) {
    userHistory.splice(0, userHistory.length - MAX_HISTORY);
  }

  await bot.sendChatAction(chatId, "typing");

  try {
    const { text, messages } = await askClaude(userHistory, userId);
    history.set(userId, messages);

    if (!text) {
      bot.sendMessage(chatId, "No obtuve respuesta. Inténtalo de nuevo.");
      return;
    }

    // Mostrar email pendiente si existe
    const pending = pendingEmails.get(userId);
    let fullReply = text;
    if (pending) {
      fullReply +=
        `\n\n─────────────────\n` +
        `📧 EMAIL LISTO PARA ENVIAR\n` +
        `Para: ${pending.to}\n` +
        `Asunto: ${pending.subject}\n\n` +
        `${pending.body}\n` +
        `─────────────────\n` +
        `Escribe /enviar para enviarlo o /cancelar para descartarlo.`;
    }

    if (fullReply.length > 4096) {
      for (let i = 0; i < fullReply.length; i += 4096) {
        await bot.sendMessage(chatId, fullReply.slice(i, i + 4096));
      }
    } else {
      bot.sendMessage(chatId, fullReply);
    }
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Hubo un error. Inténtalo de nuevo.");
  }
});

console.log("Bot XORA iniciado con búsqueda web y envío de emails...");
