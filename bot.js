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
const FROM_EMAIL = process.env.FROM_EMAIL || "XORA <contacto@xoralab.com>";
const SITE_URL = process.env.SITE_URL || "https://xoralab.com";
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : null;

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Faltan TELEGRAM_TOKEN o ANTHROPIC_API_KEY");
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

// ── REDIS HELPERS ─────────────────────────────────────────

const MEMORY_KEY = "xora:memory";
const CLIENTS_KEY = "xora:clients";

async function loadMemory() {
  if (!redis) return {};
  try { return JSON.parse(await redis.get(MEMORY_KEY) || "{}"); } catch { return {}; }
}
async function saveMemory(data) {
  if (redis) await redis.set(MEMORY_KEY, JSON.stringify(data));
}
async function loadClients() {
  if (!redis) return {};
  try { return JSON.parse(await redis.get(CLIENTS_KEY) || "{}"); } catch { return {}; }
}
async function saveClients(data) {
  if (redis) await redis.set(CLIENTS_KEY, JSON.stringify(data));
}

// ── CONVERSATION HISTORY ──────────────────────────────────

const history = new Map();
const MAX_HISTORY = 40;

async function getHistory(userId) {
  if (!history.has(userId)) {
    if (redis) {
      try {
        const saved = JSON.parse(await redis.get(`xora:history:${userId}`) || "[]");
        history.set(userId, saved);
      } catch { history.set(userId, []); }
    } else {
      history.set(userId, []);
    }
  }
  return history.get(userId);
}
async function persistHistory(userId, messages) {
  const clean = messages.filter(m => typeof m.content === "string").slice(-MAX_HISTORY);
  history.set(userId, messages);
  if (redis) await redis.set(`xora:history:${userId}`, JSON.stringify(clean));
}

// ── PENDING EMAILS ────────────────────────────────────────

const pendingEmails = new Map();

// ── SECTOR TEMPLATES ──────────────────────────────────────

const SECTOR_TEMPLATES = {
  gimnasio: `Asunto: Contenido visual para [Nombre] que convierte en ventas
Cuerpo: Hola [Nombre], vi que [Gimnasio] tiene una gran comunidad pero el contenido visual puede ser lo que marque la diferencia para captar nuevos socios. En XORA creamos vídeos y fotos con IA de alta calidad — desde entrenamientos hasta ambiente de sala — a una fracción del coste de una producción tradicional. ¿Te gustaría ver ejemplos de lo que hacemos para gimnasios?`,

  moda: `Asunto: Fotos y vídeos de producto para [Marca] sin sesión fotográfica
Cuerpo: Hola [Nombre], el contenido de [Marca] tiene potencial pero las sesiones fotográficas tradicionales son caras y lentas. En XORA generamos fotos y vídeos de producto con IA de calidad editorial, con nuestro modelo virtual Enzo especializado en moda masculina. Entrega en 48h. ¿Te mando algunos ejemplos?`,

  restaurante: `Asunto: Contenido que hace que tu restaurante llene mesas
Cuerpo: Hola [Nombre], vi [Restaurante] y creo que con el contenido visual adecuado podríais llenar muchas más mesas. En XORA creamos fotos y vídeos de platos, ambiente y experiencia con IA — el tipo de contenido que funciona en Instagram y Google. Sin sesiones largas ni costes de producción. ¿Hablamos?`,

  ecommerce: `Asunto: Fotos de producto profesionales para [Tienda] en 48h
Cuerpo: Hola [Nombre], las fotos de producto son lo que más impacta en la conversión de una tienda online. En XORA las generamos con IA a nivel de estudio fotográfico — fondos limpios, lifestyle, diferentes ángulos — todo en 48h y sin necesidad de sesión física. ¿Te interesa ver ejemplos con productos similares a los tuyos?`,

  default: `Asunto: Contenido visual con IA para [Empresa]
Cuerpo: Hola [Nombre], me llamo Marcos y soy el fundador de XORA, una agencia de contenido visual con IA. Creamos fotos y vídeos de calidad profesional para marcas como la tuya, sin los costes de una producción tradicional. ¿Te gustaría ver ejemplos de nuestro trabajo?`
};

// ── SYSTEM PROMPT ─────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente personal de Marcos, fundador de XORA, una agencia de contenido con IA especializada en creación de fotos y vídeos para marcas.

## Sobre XORA
- Crea contenido visual (fotos y vídeos) con IA de calidad profesional.
- Tienen a Enzo, su influencer IA masculino, para lifestyle, moda y producto.
- Transforman imágenes existentes del cliente elevándolas con IA.
- Email: contacto@xoralab.com | Web: ${SITE_URL}

## Tarifas
- 1 vídeo: desde 200€ | Pack 3: desde 400€ | Pack 5: desde 600€
- Pack 3 fotos: 120€ | Pack 5: 190€ | Pack 8: 300€
- Extras: derechos anuncios +30-50%, raw +50%, uso ilimitado 250€ fijo

## Plantillas por sector disponibles
- gimnasio, moda, restaurante, ecommerce, default
Úsalas cuando redactes emails adaptando [Nombre] y [Empresa] al negocio real.

## CRM de clientes
Usa save_client para guardar cada negocio que contactes o que muestre interés.
Estados posibles: "contactado", "interesado", "negociando", "cliente", "descartado"
Actualiza el estado con update_client cuando Marcos te informe de cambios.

## Herramientas disponibles
- search_web: busca negocios en internet
- search_businesses: búsqueda masiva de negocios potenciales (devuelve 10 resultados)
- prepare_email: prepara email de contacto pendiente de confirmación
- save_client: guarda un cliente/prospecto en el CRM
- update_client: actualiza estado o notas de un cliente
- get_clients: obtiene lista de todos los clientes
- generate_proposal: genera una propuesta comercial completa
- save_memory: guarda info importante permanente
- get_memory: recupera info guardada

## Seguimiento automático
Cuando Marcos pregunte por seguimientos pendientes, usa get_clients y filtra los que tienen estado "contactado" con más de 3 días sin respuesta.

## Para Instagram
Redacta el mensaje directamente, informal y con gancho, para que Marcos lo copie.

Responde siempre en español, de forma clara y directa.`;

// ── TOOLS ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_web",
    description: "Busca información general en internet.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    }
  },
  {
    name: "search_businesses",
    description: "Búsqueda masiva de negocios potenciales. Devuelve hasta 10 resultados con nombre, web y descripción.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "ej: 'gimnasios Madrid email contacto'" },
        sector: { type: "string", description: "gimnasio, moda, restaurante, ecommerce u otro" }
      },
      required: ["query", "sector"]
    }
  },
  {
    name: "prepare_email",
    description: "Prepara email de presentación pendiente de confirmación.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        business_name: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Máx 150 palabras, personalizado al negocio" },
        sector: { type: "string", description: "sector del negocio para usar la plantilla correcta" }
      },
      required: ["to", "business_name", "subject", "body"]
    }
  },
  {
    name: "save_client",
    description: "Guarda un cliente o prospecto en el CRM.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre del negocio o persona" },
        email: { type: "string" },
        sector: { type: "string" },
        status: { type: "string", description: "contactado | interesado | negociando | cliente | descartado" },
        notes: { type: "string", description: "Notas adicionales" }
      },
      required: ["name", "status"]
    }
  },
  {
    name: "update_client",
    description: "Actualiza el estado o notas de un cliente existente.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre del cliente a actualizar" },
        status: { type: "string" },
        notes: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "get_clients",
    description: "Obtiene todos los clientes y prospectos del CRM.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: { type: "string", description: "Filtrar por estado (opcional)" }
      },
      required: []
    }
  },
  {
    name: "generate_proposal",
    description: "Genera una propuesta comercial completa y profesional para un cliente.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        sector: { type: "string" },
        services: { type: "string", description: "Servicios específicos que necesita" },
        budget: { type: "string", description: "Presupuesto aproximado si se conoce" }
      },
      required: ["client_name", "sector", "services"]
    }
  },
  {
    name: "save_memory",
    description: "Guarda información importante de forma permanente.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "get_memory",
    description: "Recupera toda la información guardada permanentemente.",
    input_schema: { type: "object", properties: {}, required: [] }
  }
];

// ── TOOL IMPLEMENTATIONS ──────────────────────────────────

async function searchWeb(query, count = 5) {
  if (!BRAVE_API_KEY) return "Falta BRAVE_API_KEY.";
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=es&country=ES`,
      { headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_API_KEY } }
    );
    const data = await res.json();
    const results = data.web?.results || [];
    if (!results.length) return "No se encontraron resultados.";
    return results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\n${r.description || ""}`).join("\n\n");
  } catch (err) {
    return `Error al buscar: ${err.message}`;
  }
}

function prepareEmail(userId, input) {
  pendingEmails.set(userId, {
    to: input.to,
    business_name: input.business_name,
    subject: input.subject,
    body: input.body
  });
  return `Email preparado para ${input.business_name}. Pendiente de confirmación.`;
}

async function saveClient(input) {
  const clients = await loadClients();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  clients[id] = {
    name: input.name,
    email: input.email || "",
    sector: input.sector || "",
    status: input.status,
    notes: input.notes || "",
    created_at: clients[id]?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    contacted_at: input.status === "contactado" ? new Date().toISOString() : (clients[id]?.contacted_at || "")
  };
  await saveClients(clients);
  return `Cliente "${input.name}" guardado con estado "${input.status}".`;
}

async function updateClient(input) {
  const clients = await loadClients();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  if (!clients[id]) return `No encontré cliente con nombre "${input.name}".`;
  if (input.status) clients[id].status = input.status;
  if (input.notes) clients[id].notes = (clients[id].notes ? clients[id].notes + "\n" : "") + `[${new Date().toLocaleDateString("es-ES")}] ${input.notes}`;
  clients[id].updated_at = new Date().toISOString();
  await saveClients(clients);
  return `Cliente "${input.name}" actualizado.`;
}

async function getClients(statusFilter) {
  const clients = await loadClients();
  const list = Object.values(clients);
  if (!list.length) return "No hay clientes guardados aún.";
  const filtered = statusFilter ? list.filter(c => c.status === statusFilter) : list;
  if (!filtered.length) return `No hay clientes con estado "${statusFilter}".`;
  return filtered.map(c => {
    const days = c.contacted_at
      ? Math.floor((Date.now() - new Date(c.contacted_at)) / 86400000)
      : null;
    const followup = c.status === "contactado" && days >= 3 ? ` ⚠️ Sin respuesta hace ${days} días` : "";
    return `• ${c.name} [${c.status.toUpperCase()}]${followup}\n  Email: ${c.email || "—"} | Sector: ${c.sector || "—"}\n  Notas: ${c.notes || "—"}`;
  }).join("\n\n");
}

function generateProposal(input) {
  const date = new Date().toLocaleDateString("es-ES");
  return `PROPUESTA COMERCIAL — XORA
Fecha: ${date}
Para: ${input.client_name}
Sector: ${input.sector}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

¿QUÉ HACEMOS?
XORA es una agencia de contenido visual con IA. Creamos fotos y vídeos de calidad profesional para marcas, sin los costes ni tiempos de una producción tradicional.

SERVICIOS PROPUESTOS PARA ${input.client_name.toUpperCase()}:
${input.services}

INVERSIÓN ESTIMADA:
${input.budget ? input.budget : "A definir según alcance final"}

PROCESO:
1. Brief — nos cuentas qué necesitas (1 día)
2. Producción — generamos el contenido con IA (2-5 días)
3. Revisión — ajustes hasta aprobación
4. Entrega — archivos optimizados listos para usar

GARANTÍAS:
✓ Revisiones incluidas hasta tu aprobación
✓ Derechos de uso según paquete elegido
✓ Entrega en los plazos acordados

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Marcos — Fundador de XORA
contacto@xoralab.com
${SITE_URL}`;
}

// ── RUN TOOL ──────────────────────────────────────────────

async function runTool(name, input, userId) {
  switch (name) {
    case "search_web":
      return await searchWeb(input.query, 5);
    case "search_businesses":
      return await searchWeb(`${input.query} email contacto web`, 10);
    case "prepare_email":
      return prepareEmail(userId, input);
    case "save_client":
      return await saveClient(input);
    case "update_client":
      return await updateClient(input);
    case "get_clients":
      return await getClients(input.status_filter);
    case "generate_proposal":
      return generateProposal(input);
    case "save_memory": {
      const memory = await loadMemory();
      const existing = memory[input.key] ? memory[input.key] + "\n" : "";
      memory[input.key] = existing + `[${new Date().toLocaleDateString("es-ES")}] ${input.value}`;
      await saveMemory(memory);
      return `Guardado: ${input.value}`;
    }
    case "get_memory": {
      const memory = await loadMemory();
      if (!Object.keys(memory).length) return "No hay nada guardado.";
      return Object.entries(memory).map(([k, v]) => `${k}:\n${v}`).join("\n\n");
    }
    default:
      return "Herramienta no reconocida.";
  }
}

// ── CLAUDE LOOP ───────────────────────────────────────────

async function askClaude(messages, userId) {
  let current = [...messages];
  while (true) {
    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: current
    });

    if (response.stop_reason === "end_turn") {
      const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      current.push({ role: "assistant", content: response.content });
      return { text, messages: current };
    }

    if (response.stop_reason === "tool_use") {
      current.push({ role: "assistant", content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`Tool: ${block.name}`, JSON.stringify(block.input).slice(0, 100));
          const result = await runTool(block.name, block.input, userId);
          results.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      current.push({ role: "user", content: results });
    } else {
      break;
    }
  }
  return { text: "No pude completar la tarea.", messages: current };
}

// ── EMAIL SENDER ──────────────────────────────────────────

function buildHtmlEmail(body) {
  const logoUrl = `${SITE_URL}/logo.png`;
  const lines = body.split("\n").map(l => `<p style="margin:0 0 10px 0">${l}</p>`).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="background:#030d1a;padding:28px 40px;text-align:center">
          <img src="${logoUrl}" width="52" height="52" alt="XORA" style="display:inline-block;vertical-align:middle;margin-right:12px"/>
          <span style="color:#fff;font-size:22px;font-weight:900;letter-spacing:3px;vertical-align:middle">XORA</span>
        </td></tr>
        <tr><td style="padding:40px;color:#1a1a1a;font-size:15px;line-height:1.7">${lines}</td></tr>
        <tr><td style="background:#f9f9f9;padding:20px 40px;text-align:center;font-size:12px;color:#999;border-top:1px solid #eee">
          <p style="margin:0">XORA · Agencia de contenido con IA · <a href="mailto:contacto@xoralab.com" style="color:#1d6fd4">contacto@xoralab.com</a></p>
          <p style="margin:6px 0 0"><a href="${SITE_URL}" style="color:#1d6fd4">${SITE_URL}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendEmail({ to, subject, body }) {
  if (!RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY");
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: FROM_EMAIL, to, subject,
    text: body, html: buildHtmlEmail(body),
    reply_to: process.env.REPLY_TO_EMAIL,
    headers: { "X-Entity-Ref-ID": `xora-${Date.now()}` }
  });
  if (error) throw new Error(error.message);
}

// ── FOLLOW-UP SCHEDULER ───────────────────────────────────

async function checkFollowUps() {
  if (!ALLOWED_USER_ID) return;
  try {
    const clients = await loadClients();
    const now = Date.now();
    const pending = Object.values(clients).filter(c => {
      if (c.status !== "contactado" || !c.contacted_at) return false;
      const days = Math.floor((now - new Date(c.contacted_at)) / 86400000);
      return days >= 3 && days <= 14; // entre 3 y 14 días
    });
    if (pending.length > 0) {
      const msg = `⏰ *Seguimientos pendientes* (${pending.length})\n\n` +
        pending.map(c => {
          const days = Math.floor((now - new Date(c.contacted_at)) / 86400000);
          return `• *${c.name}* — hace ${days} días sin respuesta\n  ${c.email || "sin email"}`;
        }).join("\n\n") +
        "\n\n¿Quieres que redacte un email de seguimiento para alguno?";
      await bot.sendMessage(ALLOWED_USER_ID, msg, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error en follow-ups:", err.message);
  }
}

// Revisar seguimientos cada 24h
setInterval(checkFollowUps, 24 * 60 * 60 * 1000);

// ── AUTH ──────────────────────────────────────────────────

function isAuthorized(userId) {
  if (!ALLOWED_USER_ID) return true;
  return userId === ALLOWED_USER_ID;
}

// ── COMMANDS ──────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(msg.chat.id,
    "Hola Marcos! Soy tu asistente de XORA.\n\n" +
    "Comandos disponibles:\n" +
    "/clientes — ver todos los clientes y prospectos\n" +
    "/seguimiento — ver quién necesita seguimiento\n" +
    "/reset — reiniciar conversación\n\n" +
    "O dime directamente qué necesitas:\n" +
    "• \"Búscame gimnasios en Madrid y contáctalos\"\n" +
    "• \"Genera una propuesta para [cliente]\"\n" +
    "• \"¿Qué clientes tengo interesados?\""
  );
});

bot.onText(/\/reset/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  pendingEmails.delete(msg.from.id);
  if (redis) await redis.del(`xora:history:${msg.from.id}`);
  bot.sendMessage(msg.chat.id, "Conversación reiniciada.");
});

bot.onText(/\/clientes/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const result = await getClients();
  const clients = await loadClients();
  const total = Object.values(clients).length;
  const stats = {
    contactado: Object.values(clients).filter(c => c.status === "contactado").length,
    interesado: Object.values(clients).filter(c => c.status === "interesado").length,
    negociando: Object.values(clients).filter(c => c.status === "negociando").length,
    cliente: Object.values(clients).filter(c => c.status === "cliente").length,
  };
  const header = `📊 CRM XORA — ${total} contactos\n` +
    `Contactados: ${stats.contactado} | Interesados: ${stats.interesado} | Negociando: ${stats.negociando} | Clientes: ${stats.cliente}\n\n`;
  const full = header + result;
  if (full.length > 4096) {
    for (let i = 0; i < full.length; i += 4096) await bot.sendMessage(msg.chat.id, full.slice(i, i + 4096));
  } else {
    bot.sendMessage(msg.chat.id, full);
  }
});

bot.onText(/\/seguimiento/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const clients = await loadClients();
  const now = Date.now();
  const pending = Object.values(clients).filter(c => {
    if (c.status !== "contactado" || !c.contacted_at) return false;
    return Math.floor((now - new Date(c.contacted_at)) / 86400000) >= 3;
  });
  if (!pending.length) {
    bot.sendMessage(msg.chat.id, "✅ No hay seguimientos pendientes.");
    return;
  }
  const list = pending.map(c => {
    const days = Math.floor((now - new Date(c.contacted_at)) / 86400000);
    return `• ${c.name} — ${days} días sin respuesta\n  ${c.email || "sin email"}`;
  }).join("\n\n");
  bot.sendMessage(msg.chat.id, `⏰ Seguimientos pendientes:\n\n${list}\n\n¿Quieres que redacte un email de seguimiento para alguno?`);
});

bot.onText(/\/enviar/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const pending = pendingEmails.get(msg.from.id);
  if (!pending) { bot.sendMessage(msg.chat.id, "No hay ningún email pendiente."); return; }
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    await sendEmail(pending);
    // Guardar en CRM automáticamente
    await saveClient({ name: pending.business_name, email: pending.to, status: "contactado" });
    pendingEmails.delete(msg.from.id);
    bot.sendMessage(msg.chat.id, `✅ Email enviado a ${pending.business_name} (${pending.to})\n📋 Guardado en el CRM como "contactado".`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/cancelar/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  pendingEmails.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, pendingEmails.has(msg.from.id) ? "Email cancelado." : "No hay ningún email pendiente.");
});

// ── MESSAGES ──────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!isAuthorized(msg.from.id)) { bot.sendMessage(msg.chat.id, "Sin acceso."); return; }

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const userHistory = await getHistory(userId);

  userHistory.push({ role: "user", content: msg.text });
  if (userHistory.length > MAX_HISTORY) userHistory.splice(0, userHistory.length - MAX_HISTORY);

  await bot.sendChatAction(chatId, "typing");

  try {
    const { text, messages } = await askClaude(userHistory, userId);
    await persistHistory(userId, messages);

    if (!text) { bot.sendMessage(chatId, "Sin respuesta. Inténtalo de nuevo."); return; }

    const pending = pendingEmails.get(userId);
    let reply = text;
    if (pending) {
      reply += `\n\n─────────────────\n📧 EMAIL LISTO\nPara: ${pending.to}\nAsunto: ${pending.subject}\n\n${pending.body}\n─────────────────\n/enviar para enviar · /cancelar para descartar`;
    }

    if (reply.length > 4096) {
      for (let i = 0; i < reply.length; i += 4096) await bot.sendMessage(chatId, reply.slice(i, i + 4096));
    } else {
      bot.sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Error. Inténtalo de nuevo.");
  }
});

console.log("Bot XORA iniciado — CRM, búsqueda masiva, propuestas y seguimiento activos.");
