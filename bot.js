import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { Resend } from "resend";
import Redis from "ioredis";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import OpenAI, { toFile } from "openai";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "XORA <contacto@xoralab.com>";
const SITE_URL = process.env.SITE_URL || "https://xoralab.com";
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : null;
const AUTO_FOLLOWUP = process.env.AUTO_FOLLOWUP === "true";
const AUTO_FOLLOWUP_DAYS = parseInt(process.env.AUTO_FOLLOWUP_DAYS || "5");

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Faltan TELEGRAM_TOKEN o ANTHROPIC_API_KEY");
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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
  // Convert all messages to string content for storage (skip images/tool blocks)
  const clean = messages
    .map(m => {
      if (typeof m.content === "string") return m;
      if (Array.isArray(m.content)) {
        const text = m.content.filter(b => b.type === "text").map(b => b.text).join(" ");
        return text ? { role: m.role, content: text } : null;
      }
      return null;
    })
    .filter(Boolean)
    .slice(-MAX_HISTORY);
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

## Plantillas por sector
- gimnasio, moda, restaurante, ecommerce, default
Úsalas cuando redactes emails adaptando [Nombre] y [Empresa] al negocio real.

## CRM de clientes
Usa save_client para guardar cada negocio que contactes o que muestre interés.
Estados posibles: "contactado", "interesado", "negociando", "cliente", "descartado"
Actualiza el estado con update_client cuando Marcos te informe de cambios.

## Búsqueda de emails
Usa search_email para encontrar el email de contacto de un negocio específico antes de preparar el email.

## Generación de contenido para redes sociales
Cuando Marcos pida contenido, genera directamente:
- Post Instagram: gancho potente (1 línea) + cuerpo (3-4 líneas) + CTA + 5 hashtags relevantes
- Guión Reel: intro gancho (3s) + desarrollo escena a escena con texto en pantalla + voz en off + CTA final
- Stories: secuencia de 3-5 slides, texto corto e impactante por slide
- Copy publicitario: headline + descripción + CTA optimizado para conversión
Adapta siempre el tono al sector y a la marca del cliente.

## Análisis de imágenes
Cuando Marcos mande una foto, analiza: qué negocio es, qué tipo de contenido visual podría necesitar, cómo contactarles y qué propuesta hacerles desde XORA.

## Herramientas disponibles
- search_web: busca información general
- search_businesses: búsqueda masiva de 10 negocios potenciales
- search_email: busca el email de contacto de un negocio específico
- prepare_email: prepara email pendiente de confirmación (puede incluir PDF)
- save_client / update_client / get_clients: gestión CRM
- generate_proposal: genera propuesta comercial completa
- save_memory / get_memory: memoria permanente

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
    description: "Búsqueda masiva de negocios potenciales. Devuelve hasta 10 resultados.",
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
    name: "search_email",
    description: "Busca el email de contacto de un negocio específico.",
    input_schema: {
      type: "object",
      properties: {
        business_name: { type: "string" },
        website: { type: "string", description: "Web del negocio si se conoce" },
        location: { type: "string" }
      },
      required: ["business_name"]
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
        sector: { type: "string" },
        attach_proposal: { type: "boolean", description: "Si adjuntar propuesta PDF al email" }
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
        name: { type: "string" },
        email: { type: "string" },
        sector: { type: "string" },
        status: { type: "string", description: "contactado | interesado | negociando | cliente | descartado" },
        notes: { type: "string" }
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
        name: { type: "string" },
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
    description: "Genera una propuesta comercial completa para un cliente.",
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

async function searchEmail(input) {
  const query = `"${input.business_name}" ${input.location || ""} email contacto`;
  const results = await searchWeb(query, 5);
  return `Resultados para encontrar email de "${input.business_name}":\n\n${results}`;
}

function prepareEmail(userId, input) {
  pendingEmails.set(userId, {
    to: input.to,
    business_name: input.business_name,
    subject: input.subject,
    body: input.body,
    sector: input.sector || "default",
    attach_proposal: input.attach_proposal || false
  });
  return `Email preparado para ${input.business_name}${input.attach_proposal ? " (con propuesta PDF adjunta)" : ""}. Pendiente de confirmación.`;
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
    const days = c.contacted_at ? Math.floor((Date.now() - new Date(c.contacted_at)) / 86400000) : null;
    const followup = c.status === "contactado" && days >= 3 ? ` ⚠️ Sin respuesta hace ${days} días` : "";
    return `• ${c.name} [${c.status.toUpperCase()}]${followup}\n  Email: ${c.email || "—"} | Sector: ${c.sector || "—"}\n  Notas: ${c.notes || "—"}`;
  }).join("\n\n");
}

function generateProposalText(input) {
  const date = new Date().toLocaleDateString("es-ES");
  return `PROPUESTA COMERCIAL — XORA
Fecha: ${date} | Para: ${input.client_name} | Sector: ${input.sector}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

¿QUÉ HACEMOS?
XORA es una agencia de contenido visual con IA. Creamos fotos y vídeos de calidad profesional para marcas, sin los costes ni tiempos de una producción tradicional.

SERVICIOS PROPUESTOS:
${input.services}

INVERSIÓN ESTIMADA:
${input.budget || "A definir según alcance final"}

PROCESO:
1. Brief — nos cuentas qué necesitas (1 día)
2. Producción con IA (2-5 días)
3. Revisión hasta tu aprobación
4. Entrega de archivos finales

GARANTÍAS:
✓ Revisiones incluidas hasta tu aprobación
✓ Derechos de uso según paquete elegido
✓ Entrega en los plazos acordados

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Marcos — Fundador de XORA
contacto@xoralab.com | ${SITE_URL}`;
}

// ── PDF GENERATOR ─────────────────────────────────────────

async function generateProposalPDF(input) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: "A4" });
    const buffers = [];

    doc.on("data", buf => buffers.push(buf));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    // Header
    doc.rect(0, 0, 595, 110).fill("#030d1a");
    doc.fillColor("#ffffff").fontSize(30).font("Helvetica-Bold").text("XORA", 60, 35);
    doc.fontSize(11).font("Helvetica").text("Agencia de Contenido con IA", 60, 72);
    doc.fillColor("#1a1a1a");

    doc.moveDown(4);

    // Title
    doc.fontSize(20).font("Helvetica-Bold").text(`Propuesta para ${input.client_name}`);
    doc.fontSize(11).font("Helvetica").fillColor("#666666")
      .text(`Sector: ${input.sector}  ·  Fecha: ${new Date().toLocaleDateString("es-ES")}`);
    doc.fillColor("#1a1a1a").moveDown(0.8);

    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#e0e0e0").stroke();
    doc.moveDown(0.8);

    // Services
    doc.fontSize(13).font("Helvetica-Bold").text("Servicios propuestos");
    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica").text(input.services, { lineGap: 5 });
    doc.moveDown(0.8);

    // Budget
    doc.fontSize(13).font("Helvetica-Bold").text("Inversión estimada");
    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica").text(input.budget || "A definir según alcance final");
    doc.moveDown(0.8);

    // Process
    doc.fontSize(13).font("Helvetica-Bold").text("Proceso de trabajo");
    doc.moveDown(0.4);
    ["1. Brief — nos cuentas qué necesitas (1 día)",
      "2. Producción con IA (2-5 días)",
      "3. Revisión hasta tu aprobación",
      "4. Entrega de archivos finales"].forEach(step => {
      doc.fontSize(11).font("Helvetica").text(step, { lineGap: 4 });
    });
    doc.moveDown(0.8);

    // Guarantees
    doc.fontSize(13).font("Helvetica-Bold").text("Garantías");
    doc.moveDown(0.4);
    ["✓ Revisiones incluidas hasta tu aprobación",
      "✓ Derechos de uso según paquete elegido",
      "✓ Entrega en los plazos acordados"].forEach(g => {
      doc.fontSize(11).font("Helvetica").text(g, { lineGap: 4 });
    });

    // Footer
    doc.moveDown(3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#e0e0e0").stroke();
    doc.moveDown(0.6);
    doc.fontSize(10).fillColor("#666666")
      .text(`Marcos — Fundador de XORA  ·  contacto@xoralab.com  ·  ${SITE_URL}`, { align: "center" });

    doc.end();
  });
}

// ── RUN TOOL ──────────────────────────────────────────────

async function runTool(name, input, userId) {
  switch (name) {
    case "search_web":        return await searchWeb(input.query, 5);
    case "search_businesses": return await searchWeb(`${input.query} email contacto web`, 10);
    case "search_email":      return await searchEmail(input);
    case "prepare_email":     return prepareEmail(userId, input);
    case "save_client":       return await saveClient(input);
    case "update_client":     return await updateClient(input);
    case "get_clients":       return await getClients(input.status_filter);
    case "generate_proposal": return generateProposalText(input);
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

async function sendEmail({ to, subject, body, pdfBuffer, pdfFilename }) {
  if (!RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY");
  const resend = new Resend(RESEND_API_KEY);
  const emailData = {
    from: FROM_EMAIL, to, subject,
    text: body, html: buildHtmlEmail(body),
    reply_to: process.env.REPLY_TO_EMAIL,
    headers: { "X-Entity-Ref-ID": `xora-${Date.now()}` }
  };
  if (pdfBuffer) {
    emailData.attachments = [{
      filename: pdfFilename || "propuesta-xora.pdf",
      content: pdfBuffer
    }];
  }
  const { error } = await resend.emails.send(emailData);
  if (error) throw new Error(error.message);
}

// ── VOICE TRANSCRIPTION ───────────────────────────────────

async function transcribeVoice(fileUrl) {
  if (!openai) return null;
  try {
    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    const audioFile = await toFile(buffer, "audio.ogg", { type: "audio/ogg" });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "es"
    });
    return transcription.text;
  } catch (err) {
    console.error("Error transcribiendo:", err.message);
    return null;
  }
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
      return days >= AUTO_FOLLOWUP_DAYS && days <= 14;
    });

    if (!pending.length) return;

    if (AUTO_FOLLOWUP) {
      // Auto-enviar emails de seguimiento
      for (const client of pending) {
        if (!client.email) continue;
        try {
          const days = Math.floor((now - new Date(client.contacted_at)) / 86400000);
          const body = `Hola,\n\nMe pongo en contacto de nuevo ya que hace ${days} días te escribí sobre XORA y no quería que se perdiera el mensaje.\n\nEn XORA creamos contenido visual con IA de calidad profesional — fotos y vídeos para marcas como la tuya, sin los costes de una producción tradicional.\n\n¿Tienes unos minutos para que te cuente cómo podemos ayudarte?\n\nUn saludo,\nMarcos\nFundador de XORA\ncontacto@xoralab.com`;
          await sendEmail({ to: client.email, subject: `Seguimiento — XORA`, body });
          await updateClient({ name: client.name, notes: `Seguimiento automático enviado (día ${days})` });
          await bot.sendMessage(ALLOWED_USER_ID, `📨 Seguimiento automático enviado a *${client.name}* (${client.email})`, { parse_mode: "Markdown" });
        } catch (err) {
          console.error(`Error seguimiento ${client.name}:`, err.message);
        }
      }
    } else {
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

setInterval(checkFollowUps, 24 * 60 * 60 * 1000);

// ── AUTH ──────────────────────────────────────────────────

function isAuthorized(userId) {
  if (!ALLOWED_USER_ID) return true;
  return userId === ALLOWED_USER_ID;
}

// ── HELPERS ───────────────────────────────────────────────

function sendLong(chatId, text) {
  if (text.length > 4096) {
    const parts = [];
    for (let i = 0; i < text.length; i += 4096) parts.push(text.slice(i, i + 4096));
    return parts.reduce((p, part) => p.then(() => bot.sendMessage(chatId, part)), Promise.resolve());
  }
  return bot.sendMessage(chatId, text);
}

// ── COMMANDS ──────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(msg.chat.id,
    "Hola Marcos! Soy tu asistente de XORA.\n\n" +
    "Comandos:\n" +
    "/ayuda — todo lo que puedo hacer\n" +
    "/clientes — CRM completo\n" +
    "/stats — estadísticas de ventas\n" +
    "/seguimiento — seguimientos pendientes\n" +
    "/exportar — exportar CRM a CSV\n" +
    "/contenido — generar contenido para redes sociales\n" +
    "/reset — reiniciar conversación\n\n" +
    "También puedo:\n" +
    "📸 Analizar fotos de negocios (mándame una imagen)\n" +
    `🎤 Transcribir mensajes de voz${openai ? " ✓" : " (activa con OPENAI_API_KEY)"}\n\n` +
    "¿Qué necesitas hoy?"
  );
});

bot.onText(/\/ayuda/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `🤖 *XORA Bot — Todo lo que puedo hacer*\n\n` +

    `*📋 COMANDOS*\n` +
    `/clientes — CRM completo con todos tus contactos y su estado\n` +
    `/stats — Estadísticas: tasa de conversión, respuesta, por sector\n` +
    `/seguimiento — Lista de clientes sin respuesta hace +3 días\n` +
    `/exportar — Descarga el CRM en Excel/CSV\n` +
    `/contenido — Genera posts, Reels, stories o copies para redes\n` +
    `/ayuda — Este mensaje\n` +
    `/reset — Borra el historial de conversación\n\n` +

    `*📧 EMAILS*\n` +
    `• Busco el email de un negocio automáticamente\n` +
    `• Redacto emails personalizados por sector (gimnasio, moda, restaurante, ecommerce)\n` +
    `• Te muestro el email para que lo revises antes de enviar\n` +
    `• /enviar para mandarlo · /cancelar para descartarlo\n` +
    `• Puedo adjuntar una propuesta en PDF al email\n` +
    `• Guardo el cliente en el CRM automáticamente al enviar\n\n` +

    `*🔍 BÚSQUEDA DE NEGOCIOS*\n` +
    `• "Búscame gimnasios en Madrid" → te doy 10 resultados con web\n` +
    `• "Encuentra el email de [negocio]" → busco su contacto\n` +
    `• Analizo cada negocio y te digo qué ofrecerles\n\n` +

    `*📄 PROPUESTAS*\n` +
    `• Genero propuestas comerciales completas en texto\n` +
    `• También en PDF profesional para adjuntar al email\n` +
    `• Incluye servicios, precio, proceso y garantías\n\n` +

    `*📱 CONTENIDO PARA REDES*\n` +
    `• Posts de Instagram con gancho + cuerpo + hashtags\n` +
    `• Guiones de Reel escena a escena con texto y voz en off\n` +
    `• Secuencias de Stories slide a slide\n` +
    `• Copy publicitario para anuncios\n\n` +

    `*🎤 VOZ*\n` +
    `• Mándame un audio de voz y lo transcribo y respondo\n` +
    `• Ideal cuando vas por la calle${openai ? " ✓ activo" : " (activa con OPENAI_API_KEY)"}\n\n` +

    `*📸 IMÁGENES*\n` +
    `• Mándame foto de un negocio y lo analizo\n` +
    `• Te digo qué tipo de empresa es, qué necesita y cómo contactarles\n\n` +

    `*🧠 MEMORIA*\n` +
    `• Recuerdo todo lo que me cuentas sobre XORA\n` +
    `• Guardo info permanente: "recuerda que mi precio mínimo es 200€"\n` +
    `• El historial de conversación persiste entre sesiones\n\n` +

    `*⏰ SEGUIMIENTO AUTOMÁTICO*\n` +
    `• Aviso cada día si hay clientes sin respuesta hace +3 días\n` +
    `• Con AUTO_FOLLOWUP=true envío los emails de seguimiento solo\n\n` +

    `_Ejemplo de uso completo:_\n` +
    `"Búscame 10 gimnasios en Barcelona, encuentra sus emails y mándales un email con propuesta PDF adjunta"`,
    { parse_mode: "Markdown" }
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
  const clients = await loadClients();
  const list = Object.values(clients);
  const stats = {
    contactado: list.filter(c => c.status === "contactado").length,
    interesado: list.filter(c => c.status === "interesado").length,
    negociando: list.filter(c => c.status === "negociando").length,
    cliente: list.filter(c => c.status === "cliente").length,
  };
  const header = `📊 CRM XORA — ${list.length} contactos\nContactados: ${stats.contactado} | Interesados: ${stats.interesado} | Negociando: ${stats.negociando} | Clientes: ${stats.cliente}\n\n`;
  const result = await getClients();
  sendLong(msg.chat.id, header + result);
});

bot.onText(/\/stats/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const clients = await loadClients();
  const list = Object.values(clients);
  const total = list.length;
  const byStatus = {
    contactado: list.filter(c => c.status === "contactado").length,
    interesado: list.filter(c => c.status === "interesado").length,
    negociando: list.filter(c => c.status === "negociando").length,
    cliente: list.filter(c => c.status === "cliente").length,
    descartado: list.filter(c => c.status === "descartado").length,
  };
  const convRate = total > 0 ? ((byStatus.cliente / total) * 100).toFixed(1) : 0;
  const responseRate = total > 0 ? (((total - byStatus.contactado - byStatus.descartado) / total) * 100).toFixed(1) : 0;
  const bySector = {};
  list.forEach(c => { const s = c.sector || "sin sector"; bySector[s] = (bySector[s] || 0) + 1; });
  const sectorLines = Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`).join("\n");
  const now = Date.now();
  const pendingFU = list.filter(c => {
    if (c.status !== "contactado" || !c.contacted_at) return false;
    return Math.floor((now - new Date(c.contacted_at)) / 86400000) >= 3;
  }).length;

  bot.sendMessage(msg.chat.id,
    `📈 ESTADÍSTICAS XORA\n\n` +
    `Total contactos: ${total}\n` +
    `Tasa de conversión: ${convRate}%\n` +
    `Tasa de respuesta: ${responseRate}%\n\n` +
    `Por estado:\n` +
    `  📤 Contactados: ${byStatus.contactado}\n` +
    `  💬 Interesados: ${byStatus.interesado}\n` +
    `  🤝 Negociando: ${byStatus.negociando}\n` +
    `  ✅ Clientes: ${byStatus.cliente}\n` +
    `  ❌ Descartados: ${byStatus.descartado}\n\n` +
    `Por sector:\n${sectorLines || "  Sin datos"}\n\n` +
    `⏰ Seguimientos pendientes: ${pendingFU}`
  );
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
  const lines = pending.map(c => {
    const days = Math.floor((now - new Date(c.contacted_at)) / 86400000);
    return `• ${c.name} — ${days} días sin respuesta\n  ${c.email || "sin email"}`;
  }).join("\n\n");
  bot.sendMessage(msg.chat.id, `⏰ Seguimientos pendientes:\n\n${lines}\n\n¿Quieres que redacte un email de seguimiento para alguno?`);
});

bot.onText(/\/exportar/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "upload_document");
  const clients = await loadClients();
  const list = Object.values(clients);
  if (!list.length) { bot.sendMessage(msg.chat.id, "No hay clientes para exportar."); return; }
  const headers = "Nombre,Email,Sector,Estado,Notas,Fecha contacto\n";
  const rows = list.map(c =>
    `"${c.name}","${c.email || ""}","${c.sector || ""}","${c.status}","${(c.notes || "").replace(/"/g, "'").replace(/\n/g, " ")}","${c.contacted_at ? new Date(c.contacted_at).toLocaleDateString("es-ES") : ""}"`
  ).join("\n");
  const buffer = Buffer.from(headers + rows, "utf-8");
  await bot.sendDocument(msg.chat.id, buffer, {}, {
    filename: `xora-crm-${new Date().toISOString().split("T")[0]}.csv`,
    contentType: "text/csv"
  });
});

bot.onText(/\/contenido/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    "🎨 *Generador de contenido*\n\nDime:\n• Para qué cliente o sector\n• Tipo: post Instagram, guión Reel, stories, copy publicitario\n• Tema o producto específico\n• Tono: profesional, casual, motivacional\n\n_Ej: \"Genera un Reel para un gimnasio en Madrid, tema: clases de CrossFit, tono motivacional\"_",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/enviar/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const pending = pendingEmails.get(msg.from.id);
  if (!pending) { bot.sendMessage(msg.chat.id, "No hay ningún email pendiente."); return; }
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    let pdfBuffer = null;
    if (pending.attach_proposal) {
      pdfBuffer = await generateProposalPDF({
        client_name: pending.business_name,
        sector: pending.sector,
        services: "Contenido visual con IA personalizado para tu marca",
        budget: ""
      });
    }
    await sendEmail({ ...pending, pdfBuffer, pdfFilename: `propuesta-xora-${pending.business_name.toLowerCase().replace(/\s+/g, "-")}.pdf` });
    await saveClient({ name: pending.business_name, email: pending.to, status: "contactado" });
    pendingEmails.delete(msg.from.id);
    bot.sendMessage(msg.chat.id,
      `✅ Email enviado a ${pending.business_name} (${pending.to})` +
      (pdfBuffer ? "\n📎 Propuesta PDF adjunta" : "") +
      `\n📋 Guardado en CRM como "contactado".`
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/cancelar/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const had = pendingEmails.has(msg.from.id);
  pendingEmails.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, had ? "Email cancelado." : "No hay ningún email pendiente.");
});

// ── VOICE MESSAGES ────────────────────────────────────────

bot.on("voice", async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  if (!openai) {
    bot.sendMessage(msg.chat.id, "🎤 Para usar voz, añade OPENAI_API_KEY en las variables de Railway.");
    return;
  }
  await bot.sendChatAction(msg.chat.id, "typing");
  try {
    const file = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const text = await transcribeVoice(fileUrl);
    if (!text) { bot.sendMessage(msg.chat.id, "No pude transcribir el audio. Inténtalo de nuevo."); return; }

    await bot.sendMessage(msg.chat.id, `🎤 _"${text}"_`, { parse_mode: "Markdown" });

    const userId = msg.from.id;
    const userHistory = await getHistory(userId);
    userHistory.push({ role: "user", content: text });
    const { text: reply, messages } = await askClaude(userHistory, userId);
    await persistHistory(userId, messages);

    if (reply) {
      const pending = pendingEmails.get(userId);
      let finalReply = reply;
      if (pending) finalReply += `\n\n─────────────────\n📧 EMAIL LISTO\nPara: ${pending.to}\nAsunto: ${pending.subject}\n\n${pending.body}\n─────────────────\n/enviar · /cancelar`;
      sendLong(msg.chat.id, finalReply);
    }
  } catch (err) {
    console.error("Error en voz:", err.message);
    bot.sendMessage(msg.chat.id, "Error procesando el audio.");
  }
});

// ── PHOTO MESSAGES ────────────────────────────────────────

bot.on("photo", async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const res = await fetch(fileUrl);
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");

    const caption = msg.caption || "Analiza esta imagen. Si es un negocio, dime qué tipo de empresa es, qué contenido visual podría necesitar, cómo contactarles y qué propuesta hacerles desde XORA.";
    const userId = msg.from.id;
    const userHistory = await getHistory(userId);

    const messagesWithImage = [
      ...userHistory,
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: caption }
        ]
      }
    ];

    const { text: reply, messages } = await askClaude(messagesWithImage, userId);

    // Persistir sin la imagen (evitar overflow en Redis)
    const cleanMessages = messages.map(m => {
      if (Array.isArray(m.content) && m.content.some(b => b.type === "image")) {
        return { ...m, content: `[Imagen analizada] ${caption}` };
      }
      return m;
    });
    await persistHistory(userId, cleanMessages);

    if (reply) bot.sendMessage(msg.chat.id, reply);
  } catch (err) {
    console.error("Error en foto:", err.message);
    bot.sendMessage(msg.chat.id, "Error procesando la imagen.");
  }
});

// ── TEXT MESSAGES ─────────────────────────────────────────

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

    sendLong(chatId, reply);
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Error. Inténtalo de nuevo.");
  }
});

console.log(`Bot XORA iniciado — voz ${openai ? "✓" : "(sin Whisper)"} | visión ✓ | PDF ✓ | CRM ✓ | stats ✓ | exportar ✓`);
