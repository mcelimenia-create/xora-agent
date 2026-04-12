import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { Resend } from "resend";
import Redis from "ioredis";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import OpenAI, { toFile } from "openai";
import { createHash } from "crypto";

dotenv.config();

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BRAVE_API_KEY     = process.env.BRAVE_API_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const FROM_EMAIL        = process.env.FROM_EMAIL || "XORA <contacto@xoralab.com>";
const SITE_URL          = process.env.SITE_URL   || "https://xoralab.com";
const ALLOWED_USER_ID   = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : null;
const AUTO_FOLLOWUP     = process.env.AUTO_FOLLOWUP === "true";
const AUTO_FOLLOWUP_DAYS = parseInt(process.env.AUTO_FOLLOWUP_DAYS || "5");

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Faltan TELEGRAM_TOKEN o ANTHROPIC_API_KEY");
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot    = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const redis  = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ── REDIS KEYS ────────────────────────────────────────────

const MEMORY_KEY        = "xora:memory";
const CLIENTS_KEY       = "xora:clients";
const PRICES_KEY        = "xora:prices";
const TEMPLATES_KEY     = "xora:templates";

// ── PRICE HELPERS ─────────────────────────────────────────

const DEFAULT_PRICES = {
  "1_video":        { price: 200, label: "1 vídeo" },
  "pack3_videos":   { price: 400, label: "Pack 3 vídeos" },
  "pack5_videos":   { price: 600, label: "Pack 5 vídeos" },
  "pack3_fotos":    { price: 120, label: "Pack 3 fotos" },
  "pack5_fotos":    { price: 190, label: "Pack 5 fotos" },
  "pack8_fotos":    { price: 300, label: "Pack 8 fotos" },
  "uso_ilimitado":  { price: 250, label: "Uso ilimitado (fijo)" }
};

async function loadPrices() {
  if (!redis) return { ...DEFAULT_PRICES };
  try {
    const saved = JSON.parse(await redis.get(PRICES_KEY) || "{}");
    return { ...DEFAULT_PRICES, ...saved };
  } catch { return { ...DEFAULT_PRICES }; }
}
async function savePricesData(data) {
  if (redis) await redis.set(PRICES_KEY, JSON.stringify(data));
}

// ── TEMPLATE HELPERS ──────────────────────────────────────

async function loadTemplates() {
  if (!redis) return {};
  try { return JSON.parse(await redis.get(TEMPLATES_KEY) || "{}"); } catch { return {}; }
}
async function saveTemplatesData(data) {
  if (redis) await redis.set(TEMPLATES_KEY, JSON.stringify(data));
}

// ── REDIS HELPERS ─────────────────────────────────────────

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

// ── SYSTEM PROMPT ─────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente personal de Marcos, fundador de XORA, una agencia de contenido con IA especializada en creación de fotos y vídeos para marcas.

## Sobre XORA
- Crea contenido visual (fotos y vídeos) con IA de calidad profesional.
- Tienen a Enzo, su influencer IA masculino, para lifestyle, moda y producto.
- Email: contacto@xoralab.com | Web: ${SITE_URL}

## Precios (usa get_prices para ver los actuales, update_price para modificar)
Los precios son dinámicos y pueden cambiar. Consulta siempre get_prices antes de calcular o presupuestar.
Para calcular presupuestos usa la herramienta calculate_budget.

## Regla de oro para todos los emails
Los emails NO son sobre lo que hace XORA — son sobre lo que el cliente va a conseguir.
Siempre incluir:
1. El resultado real que van a lograr (más clientes, más ventas, más seguidores, más reservas)
2. Que hoy en día las redes sociales y el contenido visual bien hecho genera muchísimos clientes nuevos y da valor a la empresa
3. Que si te contratan, tu contenido les va a repercutir directamente en números
Ejemplo: en vez de "creamos fotos con IA", escribir "con el contenido visual adecuado, empresas como la tuya consiguen un 30-40% más de interacciones y captan nuevos clientes desde Instagram cada semana".

## Plantillas de email
Usa get_templates para ver plantillas guardadas. Usa save_template para guardar nuevas.
Sectores base: gimnasio, moda, restaurante, ecommerce, default.

## CRM
- Estados: "contactado", "interesado", "negociando", "cliente", "descartado"
- Cuando el estado pase a "cliente", se enviará un email de bienvenida automáticamente.
- Usa save_client / update_client / get_clients para gestionar.

## Contenido para redes sociales
Genera directamente sin herramientas:
- Post Instagram: gancho + cuerpo (3-4 líneas) + CTA + 5 hashtags
- Guión Reel: intro gancho (3s) + escenas con texto en pantalla + voz en off + CTA
- Stories: 3-5 slides, texto corto e impactante
- Copy publicitario: headline + descripción + CTA
- Calendario editorial: tabla por semanas con fecha, formato, tema y caption

## Análisis de negocios
Cuando Marcos pase el nombre y/o web de una empresa, usa analyze_business para:
1. Leer el contenido real de su web
2. Buscar su presencia en redes sociales
3. Identificar sus puntos débiles en contenido visual
4. Proponer servicios concretos de XORA que les vendrían bien

Estructura siempre el análisis así:
🔍 **Qué hace [empresa]** — resumen breve
📉 **Puntos débiles detectados** — lista concreta (fotos de baja calidad, sin vídeo, sin presencia en Instagram, fotos genéricas de stock, etc.)
💡 **Cómo puede ayudar XORA** — servicios específicos con precio orientativo
📧 **Ángulo de contacto** — el hook perfecto para el email de presentación

## Análisis de negocios — flujo completo
Cuando uses analyze_business, SIEMPRE termina tu respuesta con estas dos secciones adicionales:

📸 **Caption de Instagram listo**
Un caption real listo para publicar dirigido a ese tipo de cliente. Con gancho, cuerpo de 2-3 líneas y CTA. Incluye 5 hashtags.

📧 **Email de presentación listo**
Asunto + cuerpo completo del email, listo para copiar y enviar. Enfocado en resultados, no en lo que hace XORA.

## Análisis de competencia
Cuando Marcos pida analizar a un competidor, usa search_web para buscar su web/Instagram y luego analiza: qué tipo de contenido hace, con qué frecuencia, qué funciona, y cómo diferenciarse desde XORA.

## Actualizar precios en la web
Cuando Marcos pida cambiar un precio en la web, usa update_web_price.
Nombres exactos de servicios: "1 vídeo", "Pack 3 vídeos", "Pack 5 vídeos", "Pack 3 fotos", "Pack 5 fotos", "Pack 8 fotos".
Después de actualizar la web, usa también update_price para mantener el CRM sincronizado.

## Herramientas disponibles
- search_web, search_businesses, search_email, analyze_business
- prepare_email, save_client, update_client, get_clients
- generate_proposal
- update_price, get_prices, update_web_price
- save_template, get_templates
- calculate_budget
- save_memory, get_memory

## Estilo de respuesta
Sé directo y conciso. Máximo 3-4 párrafos salvo que te pidan más detalle o sea un análisis completo. Usa listas cuando estructuren mejor la información. Nunca rellenes con frases vacías.

Responde siempre en español, de forma clara y directa.`;

// ── TOOLS ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_web",
    description: "Busca información general en internet.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "search_businesses",
    description: "Búsqueda masiva de 10 negocios potenciales.",
    input_schema: {
      type: "object",
      properties: {
        query:  { type: "string" },
        sector: { type: "string" }
      },
      required: ["query", "sector"]
    }
  },
  {
    name: "analyze_business",
    description: "Analiza una empresa: lee su web, busca su presencia en redes y detecta puntos débiles en contenido visual para proponer servicios de XORA.",
    input_schema: {
      type: "object",
      properties: {
        business_name: { type: "string", description: "Nombre de la empresa" },
        website:       { type: "string", description: "URL de su web (ej: https://ejemplo.com)" },
        sector:        { type: "string", description: "Sector si se conoce" }
      },
      required: ["business_name"]
    }
  },
  {
    name: "search_email",
    description: "Busca el email de contacto de un negocio.",
    input_schema: {
      type: "object",
      properties: {
        business_name: { type: "string" },
        website:       { type: "string" },
        location:      { type: "string" }
      },
      required: ["business_name"]
    }
  },
  {
    name: "prepare_email",
    description: "Prepara email pendiente de confirmación.",
    input_schema: {
      type: "object",
      properties: {
        to:              { type: "string" },
        business_name:   { type: "string" },
        subject:         { type: "string" },
        body:            { type: "string" },
        sector:          { type: "string" },
        attach_proposal: { type: "boolean" }
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
        name:   { type: "string" },
        email:  { type: "string" },
        sector: { type: "string" },
        status: { type: "string", description: "contactado | interesado | negociando | cliente | descartado" },
        notes:  { type: "string" }
      },
      required: ["name", "status"]
    }
  },
  {
    name: "update_client",
    description: "Actualiza estado o notas de un cliente. Si el nuevo estado es 'cliente', se enviará email de bienvenida automáticamente.",
    input_schema: {
      type: "object",
      properties: {
        name:   { type: "string" },
        status: { type: "string" },
        notes:  { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "get_clients",
    description: "Obtiene todos los clientes del CRM.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: { type: "string" }
      },
      required: []
    }
  },
  {
    name: "generate_proposal",
    description: "Genera propuesta comercial completa.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        sector:      { type: "string" },
        services:    { type: "string" },
        budget:      { type: "string" }
      },
      required: ["client_name", "sector", "services"]
    }
  },
  {
    name: "update_price",
    description: "Actualiza el precio de un servicio.",
    input_schema: {
      type: "object",
      properties: {
        service_key: { type: "string", description: "ej: 1_video, pack3_videos, pack3_fotos, uso_ilimitado" },
        price:       { type: "number", description: "Nuevo precio en euros" },
        label:       { type: "string", description: "Nombre descriptivo del servicio" }
      },
      required: ["service_key", "price"]
    }
  },
  {
    name: "get_prices",
    description: "Obtiene la tabla de precios actualizada.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "save_template",
    description: "Guarda una plantilla de email personalizada.",
    input_schema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "Nombre de la plantilla" },
        sector:  { type: "string" },
        subject: { type: "string" },
        body:    { type: "string" }
      },
      required: ["name", "subject", "body"]
    }
  },
  {
    name: "get_templates",
    description: "Obtiene las plantillas de email guardadas.",
    input_schema: {
      type: "object",
      properties: {
        sector: { type: "string", description: "Filtrar por sector (opcional)" }
      },
      required: []
    }
  },
  {
    name: "update_web_price",
    description: "Actualiza el precio de un servicio en la web xoralab.com y redesplega automáticamente en Netlify.",
    input_schema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Nombre exacto: '1 vídeo', 'Pack 3 vídeos', 'Pack 5 vídeos', 'Pack 3 fotos', 'Pack 5 fotos', 'Pack 8 fotos'" },
        new_price:    { type: "number", description: "Nuevo precio en euros (sin símbolo €)" }
      },
      required: ["service_name", "new_price"]
    }
  },
  {
    name: "calculate_budget",
    description: "Calcula el presupuesto exacto según servicios seleccionados.",
    input_schema: {
      type: "object",
      properties: {
        videos:           { type: "number", description: "Número de vídeos (0, 1, 3 o 5)" },
        photos:           { type: "number", description: "Número de fotos (0, 3, 5 u 8)" },
        ad_rights:        { type: "boolean", description: "Incluir derechos de anuncios (+30-50%)" },
        unlimited_rights: { type: "boolean", description: "Incluir uso ilimitado (+250€ fijo)" },
        raw_files:        { type: "boolean", description: "Incluir archivos RAW (+50%)" }
      },
      required: ["videos", "photos"]
    }
  },
  {
    name: "save_memory",
    description: "Guarda información importante de forma permanente.",
    input_schema: {
      type: "object",
      properties: {
        key:   { type: "string" },
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

async function fetchWebContent(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; XORABot/1.0)",
        "Accept": "text/html"
      },
      signal: AbortSignal.timeout(8000)
    });
    const html = await res.text();
    // Strip tags, collapse whitespace, limit length
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    return text;
  } catch (err) {
    return `No se pudo leer la web: ${err.message}`;
  }
}

async function analyzeBusiness(input) {
  const parts = [];

  // 1. Fetch website content if provided
  if (input.website) {
    const content = await fetchWebContent(input.website);
    parts.push(`CONTENIDO WEB DE ${input.business_name}:\n${content}`);
  }

  // 2. Search for social presence and general info
  const socialResults = await searchWeb(`${input.business_name} ${input.sector || ""} Instagram redes sociales`, 5);
  parts.push(`PRESENCIA EN REDES SOCIALES:\n${socialResults}`);

  // 3. Search for reviews/reputation
  const repResults = await searchWeb(`${input.business_name} opiniones reseñas calidad`, 3);
  parts.push(`REPUTACIÓN ONLINE:\n${repResults}`);

  return parts.join("\n\n---\n\n");
}

async function searchEmail(input) {
  const query = `"${input.business_name}" ${input.location || ""} email contacto`;
  const results = await searchWeb(query, 5);
  return `Resultados para encontrar email de "${input.business_name}":\n\n${results}`;
}

function prepareEmail(userId, input) {
  pendingEmails.set(userId, {
    to:              input.to,
    business_name:   input.business_name,
    subject:         input.subject,
    body:            input.body,
    sector:          input.sector || "default",
    attach_proposal: input.attach_proposal || false
  });
  return `Email preparado para ${input.business_name}${input.attach_proposal ? " (con propuesta PDF adjunta)" : ""}. Usa /enviar para mandar o /cancelar para descartar.`;
}

async function saveClient(input) {
  const clients = await loadClients();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  const prevStatus = clients[id]?.status;
  clients[id] = {
    name:         input.name,
    email:        input.email  || clients[id]?.email  || "",
    sector:       input.sector || clients[id]?.sector || "",
    status:       input.status,
    notes:        input.notes  || clients[id]?.notes  || "",
    created_at:   clients[id]?.created_at   || new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    contacted_at: input.status === "contactado"
      ? (clients[id]?.contacted_at || new Date().toISOString())
      : (clients[id]?.contacted_at || ""),
    closed_at:    input.status === "cliente"
      ? (clients[id]?.closed_at || new Date().toISOString())
      : (clients[id]?.closed_at || ""),
    onboarding_sent: clients[id]?.onboarding_sent || false
  };
  await saveClients(clients);

  // Auto-onboarding when becoming a client
  if (input.status === "cliente" && prevStatus !== "cliente" && !clients[id].onboarding_sent && clients[id].email) {
    await sendOnboardingEmail(clients[id]);
    clients[id].onboarding_sent = true;
    await saveClients(clients);
  }

  return `Cliente "${input.name}" guardado con estado "${input.status}".`;
}

async function updateClient(input) {
  const clients = await loadClients();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  if (!clients[id]) return `No encontré cliente con nombre "${input.name}".`;
  const prevStatus = clients[id].status;
  if (input.status) {
    clients[id].status = input.status;
    if (input.status === "cliente" && !clients[id].closed_at) {
      clients[id].closed_at = new Date().toISOString();
    }
  }
  if (input.notes) {
    clients[id].notes = (clients[id].notes ? clients[id].notes + "\n" : "") +
      `[${new Date().toLocaleDateString("es-ES")}] ${input.notes}`;
  }
  clients[id].updated_at = new Date().toISOString();
  await saveClients(clients);

  // Auto-onboarding when status changes to cliente
  if (input.status === "cliente" && prevStatus !== "cliente" && !clients[id].onboarding_sent && clients[id].email) {
    await sendOnboardingEmail(clients[id]);
    clients[id].onboarding_sent = true;
    await saveClients(clients);
  }

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
1. Brief (1 día) → 2. Producción con IA (2-5 días) → 3. Revisión → 4. Entrega

GARANTÍAS:
✓ Revisiones hasta tu aprobación
✓ Derechos de uso según paquete
✓ Entrega en los plazos acordados

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Marcos — Fundador de XORA
contacto@xoralab.com | ${SITE_URL}`;
}

async function toolUpdatePrice(input) {
  const prices = await loadPrices();
  prices[input.service_key] = {
    price: input.price,
    label: input.label || prices[input.service_key]?.label || input.service_key
  };
  await savePricesData(prices);
  return `Precio actualizado: ${prices[input.service_key].label} → ${input.price}€`;
}

async function toolGetPrices() {
  const prices = await loadPrices();
  return "TARIFAS XORA:\n" + Object.entries(prices)
    .map(([, v]) => `• ${v.label}: ${v.price}€`)
    .join("\n");
}

async function toolSaveTemplate(input) {
  const templates = await loadTemplates();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  templates[id] = {
    name:    input.name,
    sector:  input.sector || "default",
    subject: input.subject,
    body:    input.body,
    created_at: new Date().toISOString()
  };
  await saveTemplatesData(templates);
  return `Plantilla "${input.name}" guardada.`;
}

async function toolGetTemplates(sectorFilter) {
  const templates = await loadTemplates();
  const list = Object.values(templates);
  if (!list.length) return "No hay plantillas guardadas aún.";
  const filtered = sectorFilter ? list.filter(t => t.sector === sectorFilter) : list;
  if (!filtered.length) return `No hay plantillas para sector "${sectorFilter}".`;
  return filtered.map(t =>
    `📝 *${t.name}* [${t.sector}]\nAsunto: ${t.subject}\n${t.body.slice(0, 120)}...`
  ).join("\n\n");
}


async function updateWebPrice(input) {
  const NETLIFY_TOKEN   = process.env.NETLIFY_TOKEN;
  const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
  if (!NETLIFY_TOKEN || !NETLIFY_SITE_ID) return "Faltan NETLIFY_TOKEN o NETLIFY_SITE_ID en Railway.";

  const authHeader = { "Authorization": `Bearer ${NETLIFY_TOKEN}` };

  // 1. Get file list from latest deploy to preserve all files (logo.png etc.)
  let existingFiles = {};
  try {
    const deploysRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys?per_page=1`,
      { headers: authHeader }
    );
    const deploys = await deploysRes.json();
    if (Array.isArray(deploys) && deploys.length > 0) {
      const filesRes = await fetch(
        `https://api.netlify.com/api/v1/deploys/${deploys[0].id}/files`,
        { headers: authHeader }
      );
      const files = await filesRes.json();
      if (Array.isArray(files)) {
        for (const f of files) {
          // path like "/index.html" or "/logo.png", sha is the hash
          if (f.path && f.sha) existingFiles[f.path] = f.sha;
        }
      }
    }
  } catch (err) {
    console.error("Error obteniendo archivos del deploy anterior:", err.message);
  }

  // 2. Fetch current HTML
  let html;
  try {
    const r = await fetch("https://xoralab.com", { signal: AbortSignal.timeout(10000) });
    html = await r.text();
  } catch (err) {
    return `Error descargando la web: ${err.message}`;
  }

  // 3. Replace price in HTML
  const escaped = input.service_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(<div class="price-name">${escaped}<\\/div>\\s*<div[^>]*>(?:<span class="price-from">desde <\\/span>)?<span class="price-amount">)[^<]+(</span>)`,
    "i"
  );
  if (!regex.test(html)) {
    return `No encontré "${input.service_name}" en la web. Nombres válidos: "1 vídeo", "Pack 3 vídeos", "Pack 5 vídeos", "Pack 3 fotos", "Pack 5 fotos", "Pack 8 fotos"`;
  }
  html = html.replace(regex, `$1${input.new_price}€$2`);

  // 4. SHA1 of new HTML
  const htmlSha = createHash("sha1").update(html).digest("hex");

  // 5. Build manifest: all existing files + updated index.html
  const fileManifest = { ...existingFiles, "/index.html": htmlSha };

  // 6. Create deploy with full manifest
  let deploy;
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ files: fileManifest })
    });
    deploy = await r.json();
    if (!deploy.id) return `Error creando deploy: ${JSON.stringify(deploy)}`;
  } catch (err) {
    return `Error en Netlify API: ${err.message}`;
  }

  // 7. Upload only what Netlify requests (only index.html, logo.png ya está en su storage)
  if (Array.isArray(deploy.required) && deploy.required.length > 0) {
    for (const requiredSha of deploy.required) {
      if (requiredSha === htmlSha) {
        await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/index.html`, {
          method: "PUT",
          headers: { ...authHeader, "Content-Type": "application/octet-stream" },
          body: html
        });
      }
    }
  }

  return `✅ Precio de "${input.service_name}" actualizado a ${input.new_price}€ en xoralab.com. La web se actualiza en unos segundos.`;
}

async function toolCalculateBudget(input) {
  const prices = await loadPrices();
  let base = 0;
  let lines = [];

  // Videos
  if (input.videos === 1) {
    base += prices["1_video"]?.price || 200;
    lines.push(`1 vídeo: ${prices["1_video"]?.price || 200}€`);
  } else if (input.videos === 3) {
    base += prices["pack3_videos"]?.price || 400;
    lines.push(`Pack 3 vídeos: ${prices["pack3_videos"]?.price || 400}€`);
  } else if (input.videos >= 5) {
    base += prices["pack5_videos"]?.price || 600;
    lines.push(`Pack 5 vídeos: ${prices["pack5_videos"]?.price || 600}€`);
  }

  // Photos
  if (input.photos === 3) {
    base += prices["pack3_fotos"]?.price || 120;
    lines.push(`Pack 3 fotos: ${prices["pack3_fotos"]?.price || 120}€`);
  } else if (input.photos === 5) {
    base += prices["pack5_fotos"]?.price || 190;
    lines.push(`Pack 5 fotos: ${prices["pack5_fotos"]?.price || 190}€`);
  } else if (input.photos >= 8) {
    base += prices["pack8_fotos"]?.price || 300;
    lines.push(`Pack 8 fotos: ${prices["pack8_fotos"]?.price || 300}€`);
  }

  let extras = 0;

  if (input.ad_rights) {
    const adExtra = Math.round(base * 0.4);
    extras += adExtra;
    lines.push(`Derechos de anuncios (+40%): +${adExtra}€`);
  }
  if (input.raw_files) {
    const rawExtra = Math.round(base * 0.5);
    extras += rawExtra;
    lines.push(`Archivos RAW (+50%): +${rawExtra}€`);
  }
  if (input.unlimited_rights) {
    const unlimitedExtra = prices["uso_ilimitado"]?.price || 250;
    extras += unlimitedExtra;
    lines.push(`Uso ilimitado: +${unlimitedExtra}€`);
  }

  const total = base + extras;
  return `PRESUPUESTO XORA:\n${lines.join("\n")}\n───────────────\nTOTAL: ${total}€`;
}

// ── RUN TOOL ──────────────────────────────────────────────

async function runTool(name, input, userId) {
  switch (name) {
    case "analyze_business":  return await analyzeBusiness(input);
    case "search_web":        return await searchWeb(input.query, 5);
    case "search_businesses": return await searchWeb(`${input.query} email contacto web`, 10);
    case "search_email":      return await searchEmail(input);
    case "prepare_email":     return prepareEmail(userId, input);
    case "save_client":       return await saveClient(input);
    case "update_client":     return await updateClient(input);
    case "get_clients":       return await getClients(input.status_filter);
    case "generate_proposal": return generateProposalText(input);
    case "update_price":      return await toolUpdatePrice(input);
    case "update_web_price":  return await updateWebPrice(input);
    case "get_prices":        return await toolGetPrices();
    case "save_template":     return await toolSaveTemplate(input);
    case "get_templates":     return await toolGetTemplates(input.sector);
    case "calculate_budget":  return await toolCalculateBudget(input);
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

async function buildSystemPrompt() {
  // Auto-inject saved memory and CRM summary into every call
  let extra = "";

  const memory = await loadMemory();
  if (Object.keys(memory).length > 0) {
    extra += "\n\n## MEMORIA GUARDADA (siempre disponible)\n";
    extra += Object.entries(memory).map(([k, v]) => `${k}:\n${v}`).join("\n\n");
  }

  const clients = await loadClients();
  const list = Object.values(clients);
  if (list.length > 0) {
    const byStatus = {};
    list.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
    const now = Date.now();
    const needFollowup = list.filter(c =>
      c.status === "contactado" && c.contacted_at &&
      Math.floor((now - new Date(c.contacted_at)) / 86400000) >= 3
    );
    extra += `\n\n## ESTADO ACTUAL DEL CRM\n`;
    extra += `Total contactos: ${list.length} | ` +
      Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(" | ");
    if (needFollowup.length > 0) {
      extra += `\nSeguimientos urgentes: ${needFollowup.map(c => c.name).join(", ")}`;
    }
  }

  const prices = await loadPrices();
  extra += "\n\n## PRECIOS ACTUALES\n";
  extra += Object.values(prices).map(v => `${v.label}: ${v.price}€`).join(" | ");

  return SYSTEM_PROMPT + extra;
}

async function askClaude(messages, userId) {
  let current = [...messages];
  const systemPrompt = await buildSystemPrompt();
  while (true) {
    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: systemPrompt,
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
  const { data, error } = await resend.emails.send(emailData);
  if (error) throw new Error(error.message);
  return data?.id;
}

// ── ONBOARDING EMAIL ──────────────────────────────────────

async function sendOnboardingEmail(client) {
  try {
    const body = `Hola ${client.name},\n\nBienvenido a XORA. Nos alegra tenerte a bordo.\n\nA partir de ahora así es como trabajamos:\n\n1. Brief — cuéntanos qué necesitas, tu estilo y referencias (1 día)\n2. Producción — generamos el contenido con IA (2-5 días)\n3. Revisión — ajustes hasta que estés 100% satisfecho\n4. Entrega — archivos optimizados listos para publicar\n\nPara arrancar, responde a este email con:\n• Qué tipo de contenido necesitas primero\n• Tu web o Instagram para ver tu estilo actual\n• Cualquier referencia visual que te guste\n\nEstamos aquí para cualquier duda.\n\nUn saludo,\nMarcos\nFundador de XORA`;
    await sendEmail({ to: client.email, subject: `Bienvenido a XORA, ${client.name}`, body });
    if (ALLOWED_USER_ID) {
      await bot.sendMessage(ALLOWED_USER_ID, `🎉 Email de bienvenida enviado a *${client.name}* (${client.email})`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error onboarding email:", err.message);
  }
}

// ── PDF GENERATOR ─────────────────────────────────────────

async function generateProposalPDF(input) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: "A4" });
    const buffers = [];
    doc.on("data", buf => buffers.push(buf));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    doc.rect(0, 0, 595, 110).fill("#030d1a");
    doc.fillColor("#ffffff").fontSize(30).font("Helvetica-Bold").text("XORA", 60, 35);
    doc.fontSize(11).font("Helvetica").text("Agencia de Contenido con IA", 60, 72);
    doc.fillColor("#1a1a1a").moveDown(4);

    doc.fontSize(20).font("Helvetica-Bold").text(`Propuesta para ${input.client_name}`);
    doc.fontSize(11).font("Helvetica").fillColor("#666666")
      .text(`Sector: ${input.sector}  ·  Fecha: ${new Date().toLocaleDateString("es-ES")}`);
    doc.fillColor("#1a1a1a").moveDown(0.8);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#e0e0e0").stroke();
    doc.moveDown(0.8);

    doc.fontSize(13).font("Helvetica-Bold").text("Servicios propuestos");
    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica").text(input.services, { lineGap: 5 });
    doc.moveDown(0.8);

    doc.fontSize(13).font("Helvetica-Bold").text("Inversión estimada");
    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica").text(input.budget || "A definir según alcance final");
    doc.moveDown(0.8);

    doc.fontSize(13).font("Helvetica-Bold").text("Proceso de trabajo");
    doc.moveDown(0.4);
    ["1. Brief — nos cuentas qué necesitas (1 día)",
     "2. Producción con IA (2-5 días)",
     "3. Revisión hasta tu aprobación",
     "4. Entrega de archivos finales"].forEach(step => {
      doc.fontSize(11).font("Helvetica").text(step, { lineGap: 4 });
    });
    doc.moveDown(0.8);

    doc.fontSize(13).font("Helvetica-Bold").text("Garantías");
    doc.moveDown(0.4);
    ["✓ Revisiones incluidas hasta tu aprobación",
     "✓ Derechos de uso según paquete elegido",
     "✓ Entrega en los plazos acordados"].forEach(g => {
      doc.fontSize(11).font("Helvetica").text(g, { lineGap: 4 });
    });

    doc.moveDown(3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor("#e0e0e0").stroke();
    doc.moveDown(0.6);
    doc.fontSize(10).fillColor("#666666")
      .text(`Marcos — Fundador de XORA  ·  contacto@xoralab.com  ·  ${SITE_URL}`, { align: "center" });

    doc.end();
  });
}

// ── VOICE TRANSCRIPTION ───────────────────────────────────

async function transcribeVoice(fileUrl) {
  if (!openai) return null;
  try {
    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    const audioFile = await toFile(buffer, "audio.ogg", { type: "audio/ogg" });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile, model: "whisper-1", language: "es"
    });
    return transcription.text;
  } catch (err) {
    console.error("Error transcribiendo:", err.message);
    return null;
  }
}

// ── SCHEDULERS ────────────────────────────────────────────

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
          return `• *${c.name}* — hace ${days} días\n  ${c.email || "sin email"}`;
        }).join("\n\n") +
        "\n\n¿Quieres que redacte un email de seguimiento?";
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

bot.onText(/\/ayuda/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `🤖 *XORA Bot — Todo lo que puedo hacer*\n\n` +

    `*📋 COMANDOS*\n` +
    `/clientes — CRM completo\n` +
    `/clientes [nombre] — ficha detallada con historial completo\n` +
    `/stats — conversión, respuesta, valor del pipeline y revenue\n` +
    `/pipeline — embudo de ventas con días por etapa\n` +
    `/seguimiento — clientes sin respuesta hace +3 días\n` +
    `/exportar — descarga el CRM en CSV\n` +
    `/precios — ver y editar tarifas\n` +
    `/plantillas — gestionar plantillas de email\n` +
    `/presupuesto — calculadora de precios interactiva\n` +
    `/contenido — generar contenido para redes\n` +
    `/reset — borrar historial\n` +
    `/ayuda — este mensaje\n\n` +

    `*📧 EMAILS*\n` +
    `• Busco emails de negocios automáticamente\n` +
    `• Redacto y envío emails personalizados por sector\n` +
    `• Puedo adjuntar propuesta en PDF\n` +
    `• Seguimiento automático tras X días sin respuesta\n\n` +

    `*🛒 PRESUPUESTOS*\n` +
    `• Calculo el precio exacto con todos los extras\n` +
    `• Precios editables desde Telegram\n` +
    `• "Actualiza el vídeo unitario a 250€" y listo\n\n` +

    `*📄 PROPUESTAS*\n` +
    `• En texto o PDF profesional\n` +
    `• Adjuntadas automáticamente al email\n\n` +

    `*🎉 ONBOARDING*\n` +
    `• Al marcar un cliente como "cliente", envío automáticamente un email de bienvenida con el proceso\n\n` +

    `*🔔 RECORDATORIOS*\n` +
    `• "Recuérdame el jueves llamar a [cliente]"\n` +
    `• Te aviso a la hora exacta vía Telegram\n\n` +

    `*📱 CONTENIDO*\n` +
    `• Posts, Reels, Stories, copies publicitarios\n` +
    `• Calendarios editoriales mensuales\n` +
    `• Análisis de competencia\n` +
    `• Al analizar un negocio → caption de Instagram + email listos automáticamente\n\n` +

    `*🎤 VOZ & 📸 FOTOS*\n` +
    `• Audio → transcripción → respuesta automática\n` +
    `• "Nota para [cliente]: [texto]" → guarda en CRM directamente\n` +
    `• Foto de un negocio → análisis y propuesta\n\n` +

    `*🧠 MEMORIA & CRM*\n` +
    `• Recuerdo todo entre sesiones (Redis)\n` +
    `• Plantillas de email guardadas por ti\n` +
    `• Exporta el CRM a Excel con /exportar`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(msg.chat.id,
    "Hola Marcos! Soy tu asistente de XORA.\n\nUsa /ayuda para ver todo lo que puedo hacer."
  );
});

bot.onText(/\/reset/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  pendingEmails.delete(msg.from.id);
  if (redis) await redis.del(`xora:history:${msg.from.id}`);
  bot.sendMessage(msg.chat.id, "Conversación reiniciada.");
});

bot.onText(/\/clientes(?:\s+(.+))?/, async (msg, match) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const clients = await loadClients();

  // Si se pasa nombre, mostrar ficha detallada del cliente
  const search = match?.[1]?.trim();
  if (search) {
    const found = Object.values(clients).find(c =>
      c.name.toLowerCase().includes(search.toLowerCase())
    );
    if (!found) {
      bot.sendMessage(msg.chat.id, `No encontré ningún cliente llamado "${search}".`);
      return;
    }
    const now = Date.now();
    const daysInPipeline = found.contacted_at
      ? Math.floor((now - new Date(found.contacted_at)) / 86400000)
      : null;
    const daysSinceUpdate = found.updated_at
      ? Math.floor((now - new Date(found.updated_at)) / 86400000)
      : null;
    const detail =
      `👤 *${found.name}*\n\n` +
      `Estado: *${found.status.toUpperCase()}*\n` +
      `Email: ${found.email || "—"}\n` +
      `Sector: ${found.sector || "—"}\n` +
      `En pipeline: ${daysInPipeline !== null ? `${daysInPipeline} días` : "—"}\n` +
      `Última actualización: ${daysSinceUpdate !== null ? `hace ${daysSinceUpdate} días` : "—"}\n` +
      `Contactado: ${found.contacted_at ? new Date(found.contacted_at).toLocaleDateString("es-ES") : "—"}\n` +
      `Cerrado: ${found.closed_at ? new Date(found.closed_at).toLocaleDateString("es-ES") : "—"}\n` +
      `Onboarding enviado: ${found.onboarding_sent ? "Sí" : "No"}\n\n` +
      `📝 *Notas:*\n${found.notes || "Sin notas aún"}`;
    bot.sendMessage(msg.chat.id, detail, { parse_mode: "Markdown" });
    return;
  }

  // Sin argumento: listar todos
  const list = Object.values(clients);
  const stats = {
    contactado: list.filter(c => c.status === "contactado").length,
    interesado: list.filter(c => c.status === "interesado").length,
    negociando: list.filter(c => c.status === "negociando").length,
    cliente:    list.filter(c => c.status === "cliente").length,
  };
  const header = `📊 CRM XORA — ${list.length} contactos\n` +
    `Contactados: ${stats.contactado} | Interesados: ${stats.interesado} | Negociando: ${stats.negociando} | Clientes: ${stats.cliente}\n\n`;
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
    cliente:    list.filter(c => c.status === "cliente").length,
    descartado: list.filter(c => c.status === "descartado").length,
  };
  const convRate     = total > 0 ? ((byStatus.cliente / total) * 100).toFixed(1) : 0;
  const responseRate = total > 0 ? (((total - byStatus.contactado - byStatus.descartado) / total) * 100).toFixed(1) : 0;
  const bySector = {};
  list.forEach(c => { const s = c.sector || "sin sector"; bySector[s] = (bySector[s] || 0) + 1; });
  const sectorLines = Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`).join("\n");

  // Average time to close
  const closed = list.filter(c => c.status === "cliente" && c.contacted_at && c.closed_at);
  let avgClose = "—";
  if (closed.length > 0) {
    const avg = closed.reduce((sum, c) =>
      sum + Math.floor((new Date(c.closed_at) - new Date(c.contacted_at)) / 86400000), 0) / closed.length;
    avgClose = `${Math.round(avg)} días`;
  }

  const now = Date.now();
  const pendingFU = list.filter(c => {
    if (c.status !== "contactado" || !c.contacted_at) return false;
    return Math.floor((now - new Date(c.contacted_at)) / 86400000) >= 3;
  }).length;

  // Pipeline value: avg ticket × clients in interesado + negociando
  const prices = await loadPrices();
  const priceValues = Object.values(prices).map(p => p.price);
  const avgTicket = Math.round(priceValues.reduce((s, p) => s + p, 0) / priceValues.length);
  const pipelineCount = byStatus.interesado + byStatus.negociando;
  const pipelineValue = pipelineCount * avgTicket;

  // Revenue from closed clients (estimated)
  const revenueEstimated = byStatus.cliente * avgTicket;

  bot.sendMessage(msg.chat.id,
    `📈 ESTADÍSTICAS XORA\n\n` +
    `Total contactos: ${total}\n` +
    `Tasa de conversión: ${convRate}%\n` +
    `Tasa de respuesta: ${responseRate}%\n` +
    `Tiempo medio de cierre: ${avgClose}\n\n` +
    `Por estado:\n` +
    `  📤 Contactados: ${byStatus.contactado}\n` +
    `  💬 Interesados: ${byStatus.interesado}\n` +
    `  🤝 Negociando: ${byStatus.negociando}\n` +
    `  ✅ Clientes: ${byStatus.cliente}\n` +
    `  ❌ Descartados: ${byStatus.descartado}\n\n` +
    `💰 Valor del pipeline: ~${pipelineValue}€ (${pipelineCount} oportunidades × ${avgTicket}€ ticket medio)\n` +
    `💵 Ingresos estimados: ~${revenueEstimated}€ (${byStatus.cliente} clientes)\n\n` +
    `Por sector:\n${sectorLines || "  Sin datos"}\n\n` +
    `⏰ Seguimientos pendientes: ${pendingFU}`
  );
});

bot.onText(/\/pipeline/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const clients = await loadClients();
  const now = Date.now();
  const stages = ["contactado", "interesado", "negociando", "cliente"];
  const emojis = { contactado: "📤", interesado: "💬", negociando: "🤝", cliente: "✅" };
  let out = "🔄 *PIPELINE DE VENTAS*\n\n";
  for (const stage of stages) {
    const list = Object.values(clients).filter(c => c.status === stage);
    if (!list.length) continue;
    out += `${emojis[stage]} *${stage.toUpperCase()}* (${list.length})\n`;
    list.forEach(c => {
      const ref = c.contacted_at ? Math.floor((now - new Date(c.contacted_at)) / 86400000) : null;
      const daysStr = ref !== null ? ` · ${ref}d` : "";
      out += `  • ${c.name}${daysStr}${c.email ? ` — ${c.email}` : ""}\n`;
    });
    out += "\n";
  }
  bot.sendMessage(msg.chat.id, out, { parse_mode: "Markdown" });
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
  if (!pending.length) { bot.sendMessage(msg.chat.id, "✅ No hay seguimientos pendientes."); return; }
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
  const headers = "Nombre,Email,Sector,Estado,Notas,Fecha contacto,Fecha cierre\n";
  const rows = list.map(c =>
    `"${c.name}","${c.email || ""}","${c.sector || ""}","${c.status}","${(c.notes || "").replace(/"/g, "'").replace(/\n/g, " ")}","${c.contacted_at ? new Date(c.contacted_at).toLocaleDateString("es-ES") : ""}","${c.closed_at ? new Date(c.closed_at).toLocaleDateString("es-ES") : ""}"`
  ).join("\n");
  const buffer = Buffer.from(headers + rows, "utf-8");
  await bot.sendDocument(msg.chat.id, buffer, {}, {
    filename: `xora-crm-${new Date().toISOString().split("T")[0]}.csv`,
    contentType: "text/csv"
  });
});

bot.onText(/\/precios/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const prices = await loadPrices();
  const lines = Object.entries(prices).map(([key, v]) => `• ${v.label}: *${v.price}€* (\`${key}\`)`).join("\n");
  bot.sendMessage(msg.chat.id,
    `💶 *Tarifas XORA*\n\n${lines}\n\n_Para cambiar un precio escríbeme:_\n"Actualiza el precio de pack3\\_videos a 450€"`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/plantillas/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  await bot.sendChatAction(msg.chat.id, "typing");
  const templates = await loadTemplates();
  const list = Object.values(templates);
  if (!list.length) {
    bot.sendMessage(msg.chat.id, "No hay plantillas guardadas aún.\n\nPídeme que guarde una: \"Guarda esta plantilla para gimnasios: [asunto y cuerpo]\"");
    return;
  }
  const lines = list.map(t => `📝 *${t.name}* [${t.sector}]\nAsunto: ${t.subject}`).join("\n\n");
  bot.sendMessage(msg.chat.id, `📋 *Plantillas guardadas*\n\n${lines}\n\n_Pídeme una para usarla en el siguiente email._`, { parse_mode: "Markdown" });
});

bot.onText(/\/presupuesto/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    "💶 *Calculadora de presupuesto*\n\nDime qué necesita el cliente y te calculo el precio exacto.\n\n_Ejemplos:_\n• \"Presupuesto para 3 vídeos y 5 fotos con derechos de anuncios\"\n• \"Cuánto es un pack de 5 vídeos con uso ilimitado y RAW\"\n• \"Precio de 1 vídeo solo\"",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/contenido/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    "🎨 *Generador de contenido*\n\nDime:\n• Tipo: post, Reel, Stories, copy, calendario editorial\n• Sector o cliente\n• Tema y tono\n\n_Ej: \"Genera un calendario editorial de abril para un gimnasio en Madrid, 3 posts por semana, tono motivacional\"_",
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
        sector:      pending.sector,
        services:    "Contenido visual con IA personalizado para tu marca",
        budget:      ""
      });
    }
    await sendEmail({
      ...pending, pdfBuffer,
      pdfFilename: `propuesta-xora-${pending.business_name.toLowerCase().replace(/\s+/g, "-")}.pdf`
    });

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
    bot.sendMessage(msg.chat.id, "🎤 Añade OPENAI_API_KEY en Railway para activar los mensajes de voz.");
    return;
  }
  await bot.sendChatAction(msg.chat.id, "typing");
  try {
    const file    = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const text    = await transcribeVoice(fileUrl);
    if (!text) { bot.sendMessage(msg.chat.id, "No pude transcribir el audio. Inténtalo de nuevo."); return; }

    await bot.sendMessage(msg.chat.id, `🎤 _"${text}"_`, { parse_mode: "Markdown" });

    // Detectar "nota para [cliente]: [texto]" y guardar directamente en CRM
    const notaMatch = text.match(/^nota para ([^:]+?):\s*(.+)/i);
    if (notaMatch) {
      const clientName = notaMatch[1].trim();
      const noteText   = notaMatch[2].trim();
      const result = await updateClient({ name: clientName, notes: noteText });
      bot.sendMessage(msg.chat.id, `📋 ${result}`);
      return;
    }

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
    const photo   = msg.photo[msg.photo.length - 1];
    const file    = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const res     = await fetch(fileUrl);
    const base64  = Buffer.from(await res.arrayBuffer()).toString("base64");

    const caption = msg.caption || "Analiza esta imagen. Si es un negocio, dime qué tipo de empresa es, qué contenido visual podría necesitar, cómo contactarles y qué propuesta hacerles desde XORA.";
    const userId  = msg.from.id;
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

console.log(`Bot XORA iniciado — voz ${openai ? "✓" : "(sin Whisper)"} | visión ✓ | PDF ✓ | CRM ✓ | precios ✓ | plantillas ✓ | presupuestos ✓`);
