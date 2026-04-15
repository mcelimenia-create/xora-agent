import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import { Resend } from "resend";
import Redis from "ioredis";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import OpenAI, { toFile } from "openai";


dotenv.config();

const TELEGRAM_TOKEN     = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const BRAVE_API_KEY      = process.env.BRAVE_API_KEY;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const GOOGLE_PLACES_KEY  = process.env.GOOGLE_PLACES_KEY;
const HUNTER_API_KEY     = process.env.HUNTER_API_KEY;
const FROM_EMAIL         = process.env.FROM_EMAIL || "XORA <contacto@xoralab.com>";
const SITE_URL           = process.env.SITE_URL   || "https://xoralab.com";
const ALLOWED_USER_ID    = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID) : null;
const AUTO_FOLLOWUP      = process.env.AUTO_FOLLOWUP === "true";
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
  "1_video":       { price: 499,  price_usd: 599,  label: "1 vídeo" },
  "pack3_videos":  { price: 1199, price_usd: 1399, label: "Pack 3 vídeos" },
  "campana_fotos": { price: 299,  price_usd: 349,  label: "Campaña de fotos (máx. 20 fotos)" }
};

async function loadPrices() {
  if (!redis) return { ...DEFAULT_PRICES };
  try {
    const saved = JSON.parse(await redis.get(PRICES_KEY) || "{}");
    // Solo aplicar overrides de Redis para keys que existen en DEFAULT_PRICES
    // (evita que precios viejos como pack5_videos aparezcan)
    const filtered = {};
    for (const key of Object.keys(DEFAULT_PRICES)) {
      if (saved[key]) filtered[key] = { ...DEFAULT_PRICES[key], ...saved[key] };
    }
    return { ...DEFAULT_PRICES, ...filtered };
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
const MAX_HISTORY = 15;

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

// ── PROSPECT QUEUE ────────────────────────────────────────
// { items: [{name, website, sector, instagram, score}], index: 0 }

const prospectQueues = new Map();

// ── SYSTEM PROMPT ─────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente personal de Marcos, fundador de XORA, una agencia de contenido visual con IA para marcas y negocios.

## REGLAS FUNDAMENTALES
1. NUNCA preguntes a Marcos qué hace XORA ni quiénes son sus clientes. Ya lo sabes. Actúa directamente.
2. SIEMPRE llama a prepare_email con el email completo. La herramienta ya muestra automáticamente la vista previa en español para que Marcos lo revise. NO escribas el email como texto — llama al tool y deja que él lo muestre.
3. Si el email se envía en inglés: rellena body_es y subject_es con la versión en español para que Marcos la entienda.
4. Después de llamar a prepare_email NO repitas el contenido del email en tu respuesta de texto — el tool ya lo ha mostrado.

## Sobre XORA
XORA es una agencia de contenido visual con IA fundada por Marcos. Crea fotos y vídeos de calidad profesional usando inteligencia artificial, a una fracción del coste y tiempo de una producción tradicional. El cliente recibe el contenido listo para publicar en redes sociales (Instagram, TikTok, web).

**Figura estrella:** Enzo (@enzowalkerr en Instagram), el influencer masculino virtual de XORA. Aparece en fotos y vídeos de lifestyle, moda masculina, deporte y producto. Cara y cuerpo realistas, adaptable a cualquier estética de marca.

**Importante sobre Enzo y el género:**
- Enzo es un chico. Es ideal para marcas de moda masculina, fitness, lifestyle, producto neutro.
- Para marcas de moda FEMENINA: NO ofrecer Enzo como modelo. En su lugar, ofrecer la opción de que el cliente mande sus propias fotos/modelos y XORA las trata con IA para elevar la calidad visual.
- Cuando no está claro si la marca es femenina o masculina, ofrecer AMBAS opciones: usar a Enzo O enviar sus propias fotos.

**Dos modalidades de trabajo (mencionarlas siempre en el email):**
1. Con Enzo: XORA crea el contenido completo con el influencer virtual
2. Con sus propias fotos: el cliente manda sus fotos/modelos y XORA las eleva con IA (más info en xoralab.com)

**Clientes ideales de XORA** (ya lo sabes, no lo preguntes):
- Marcas de moda masculina → Enzo encaja perfecto
- Marcas de moda femenina → opción de enviar sus propias fotos
- Marcas mixtas/neutras → ofrecer ambas opciones
- Gimnasios boutique, entrenadores personales, centros fitness
- Restaurantes, cafeterías, bares con presencia en Instagram
- Ecommerce de cualquier producto físico
- Clínicas de belleza, estética, peluquerías
- Inmobiliarias y agencias de lujo

**Diferenciadores clave de XORA:**
- Producción 10× más rápida que una sesión fotográfica real
- Sin modelos, fotógrafos ni localizaciones — solo brief y entrega
- Contenido ilimitado y escalable para campañas de cualquier volumen
- Derechos de uso incluidos para redes sociales

Email: contacto@xoralab.com | Web: ${SITE_URL}

## Servicios y precios
Tres servicios. Precios fijos (no preguntes, ya los sabes):
- **1 vídeo**: 499€ / $599
- **Pack 3 vídeos**: 1.199€ / $1.399
- **Campaña de fotos** (máx. 20 fotos): 299€ / $349

Usa siempre el precio en € para clientes de España/Europa y $ para clientes de EEUU/UK/Latinoamérica anglófona.
Para calcular presupuestos usa calculate_budget. Para actualizar precios en la web usa update_web_price + update_price.

**Tiempos de entrega** (para cuando Marcos pregunte, NO para los emails):
- 1 vídeo: 14 días
- Pack de fotos: 7 días

**REGLAS IMPORTANTES para los emails de prospección — sin excepciones:**
- NUNCA incluyas precios ni tiempos de entrega.
- NUNCA ofrezcas enviar ejemplos de contenido en el email. Los ejemplos ya están en xoralab.com — dirige ahí al cliente.
El objetivo del email es que visiten xoralab.com. Precios, tiempos y ejemplos se gestionan después. Si el cliente pregunta directamente, entonces sí responde.

## Estructura OBLIGATORIA de todos los emails de prospección
Cada email que redactes DEBE seguir exactamente este orden. Sin excepciones.

**0. Asunto — personalizado y con gancho**
NUNCA usar asuntos genéricos como "Colaboración" o "Propuesta XORA".
El asunto debe mencionar algo específico del negocio y generar curiosidad. Ejemplos:
- "Una idea para el Instagram de [Nombre negocio]"
- "[Nombre negocio] — esto podría duplicar tu engagement"
- "Vi tu perfil de Instagram, [Nombre negocio]"
- "Contenido que vende para [Nombre negocio]"

**1. Saludo personalizado**
Dirigido al nombre del responsable si se conoce, o al nombre del negocio si no. Nunca "Hola," a secas.
Ej: "Hola María," o "Hola equipo de [Nombre negocio],"

**2. Análisis breve de su empresa (2-3 frases)**
Demuestra que conoces su negocio específicamente. Menciona algo real de su web o Instagram.
Ej: "He visto vuestro perfil de Instagram — tenéis buen producto pero las fotos parecen hechas con móvil y se pierden entre la competencia."

**3. Cómo XORA les ayuda + cifras + modalidad correcta según el género de la marca**
Cifras a usar:
- Marcas con contenido visual profesional consiguen un 40-60% más de interacciones
- Coste de una sesión fotográfica tradicional (500-2.000€) frente a XORA (desde 299€)
- Negocios con contenido consistente generan hasta un 3× más de visitas al perfil
- El 78% de los consumidores decide comprar según el contenido visual de una marca

Según el tipo de marca adapta el mensaje:
- Moda MASCULINA o fitness: menciona a Enzo (@enzowalkerr) como el modelo virtual y que se puede ver en xoralab.com
- Moda FEMENINA: NO menciones a Enzo. Di que pueden mandar sus propias fotos o modelos y XORA las eleva con IA. Más info en xoralab.com
- Marca MIXTA o producto neutro: ofrece ambas opciones (Enzo o fotos propias)

**4. Llamada a la acción — una sola, concreta**
Debe invitar a visitar xoralab.com para ver los ejemplos. NUNCA ofrecer enviar ni mostrar un ejemplo personalizado — los ejemplos ya están en la web.
Ej: "Si te interesa, puedes ver ejemplos reales en xoralab.com — y si quieres hablarlo, aquí estoy."
Ej: "Echa un vistazo a lo que hacemos en xoralab.com — creo que te va a gustar."

**5. Firma — SIEMPRE exactamente así:**
Marcos
Xora - Agencia de contenido con IA
xoralab.com | contacto@xoralab.com

## Plantillas de email
Usa get_templates para ver plantillas guardadas. Usa save_template para guardar nuevas.
Sectores: gimnasio, moda, restaurante, ecommerce, belleza, inmobiliaria, default.

## CRM
- Estados: "contactado", "interesado", "negociando", "cliente", "descartado"
- Al pasar a "cliente" → email de bienvenida automático.
- Usa save_client / update_client / get_clients para gestionar.

## Idioma por cliente — regla crítica
Cada cliente tiene un campo "language" en el CRM: "es" (español) o "en" (inglés).
- Si el negocio está en EEUU, UK, Australia, Canadá, Irlanda → language: "en"
- Si está en España, México, Latinoamérica → language: "es"
- Al guardar un cliente nuevo con save_client, SIEMPRE asigna el idioma correcto según su país.
- Al redactar un email o propuesta, consulta SIEMPRE el idioma del cliente y escribe el contenido en ese idioma.
- Si Marcos dice "manda el email en inglés" → usa inglés y actualiza el idioma del cliente a "en".

## Búsqueda de negocios — flujo en lote (NUEVO)

**Cuando Marcos diga "busca X empresas":**
1. Actúa DIRECTAMENTE. Sin preguntar nada.
2. Usa search_businesses para buscarlas.
3. Para cada resultado haz una puntuación rápida (lead score) solo con la info del search — NO hagas analyze_business aquí todavía.
4. Llama a save_prospect_list con la lista completa ordenada por score.
5. Muestra la lista numerada con este formato por empresa:
   "N. Nombre — Score: X/10 — @instagram (si se encontró) — web (si se tiene)"
6. Di: "Lista guardada. Di 'empieza' para analizar la primera."

**Cuando Marcos diga "empieza", "siguiente" o "empieza con la primera/siguiente":**
1. Toma el primer/siguiente prospecto de la cola.
2. Usa analyze_business para analizarlo en profundidad.
3. Busca el email de contacto. Si NO se encuentra ningún email → salta esta empresa automáticamente, avisa a Marcos ("No encontré email para X, paso a la siguiente") y analiza la siguiente.
4. Si SÍ hay email → llama a prepare_email UNA SOLA VEZ con el email completo. Solo un email, nunca varios.
5. Muestra el análisis + el email en español (ya preparado) + DM con @handle.
6. **PARA AQUÍ. No analices la siguiente empresa. Espera a que Marcos pulse /enviar o /saltar.**
7. El sistema avanza automáticamente tras cada /enviar.

**REGLA CRÍTICA — UNA EMPRESA POR TURNO:**
Cada vez que se te pide analizar una empresa, analiza ESA empresa y ninguna más. Aunque el historial tenga análisis de otras empresas anteriores, cada petición "Analiza [empresa]" es independiente. Llama a analyze_business, busca email, llama a prepare_email, y PARA. No sigas con la siguiente.

**Comandos disponibles tras mostrar cada empresa:**
- /enviar → envía el email y pasa automáticamente a la siguiente
- /saltar → salta esta empresa y pasa a la siguiente
- /cancelar → cancela sin avanzar

Si Marcos da nombres sin webs → usa search_email para encontrar su contacto.

## Análisis de negocios — flujo completo
Antes de analizar en profundidad, puntúa el lead del 1 al 10 según estos criterios:
- ¿Tiene Instagram activo y con publicaciones recientes? (+3)
- ¿Su contenido visual actual es mejorable (fotos de móvil, sin coherencia)? (+2)
- ¿Tiene web o tienda online? (+2)
- ¿Es un sector donde XORA tiene impacto directo (moda, fitness, restauración, ecommerce, belleza)? (+2)
- ¿Se ha encontrado email o contacto directo? (+1)

Muestra la puntuación así: "📊 Lead score: 7/10" con una línea breve de justificación.
Si el score es menor de 5, avisa a Marcos: "Lead poco cualificado, ¿continúo igualmente?"
Si es 5 o más, procede directamente con el análisis completo.

Estructura del análisis:
🔍 Qué hace | 📉 Puntos débiles en contenido visual | 👤 Responsable/decisor encontrado | 💡 Cómo ayuda XORA (con precios)

Termina SIEMPRE con estas dos secciones:

📧 **EMAIL — vista previa en español**
Muestra SIEMPRE el email en español para que Marcos lo entienda, independientemente del idioma en que se vaya a enviar. Indica al final: "(se enviará en [idioma] al ejecutar /enviar)".
Dirígelo al responsable/decisor encontrado si lo hay — no al email genérico.
Sigue la estructura obligatoria: asunto con gancho → saludo → análisis → mejora con cifras + Enzo + xoralab.com → llamada a la acción → firma exacta.

📱 **DM de Instagram — desde la cuenta de Enzo**
Indica SIEMPRE el @handle de Instagram del negocio al que hay que enviar el DM, así:
"Enviar a: @handle_del_negocio"
Si no se encontró el handle exacto, indica: "Handle no encontrado — búscalo manualmente"

El mensaje:
- Primera persona como si fuera Enzo (influencer/creador real, no agencia)
- Tono humano, cercano, casual — máximo 4-5 líneas, sin emojis de relleno
- NO mencionar que es una agencia — que lo descubran al entrar a la web
- Termina con pregunta o invitación a ver xoralab.com
- Si la marca es FEMENINA: Enzo puede igualmente enviar el DM desde su cuenta, pero el mensaje debe enfocarse en "trabajo con marcas para mejorar su contenido visual" sin mencionar que es el modelo
- Si la marca es MASCULINA o fitness: puede mencionar que trabaja como modelo/creador de contenido para marcas

Ej moda masculina: "Hola! Vi tu marca y me encaja mucho tu estilo. Trabajo creando contenido visual para marcas y creo que podría quedar muy bien juntos. Si tienes curiosidad echa un vistazo → xoralab.com ¿Te interesa?"
Ej moda femenina: "Hola! Vi vuestro perfil y me parece que tenéis un producto muy bueno pero creo que el contenido visual podría llevaros mucho más lejos. Llevo tiempo colaborando con marcas en esto. Si queréis echar un vistazo → xoralab.com"

## Análisis de competencia
Usa search_web para buscar web/Instagram del competidor. Analiza: tipo de contenido, frecuencia, qué funciona, cómo diferenciarse desde XORA.

## Actualizar precios en la web
Cuando Marcos pida cambiar un precio en la web, usa update_web_price.
Nombres exactos de servicios: "1 vídeo", "Pack 3 vídeos", "Campaña de fotos".
Después usa también update_price para mantener el CRM sincronizado.

## Contenido para redes sociales
Genera directamente sin herramientas: posts, Reels, Stories, copies publicitarios, calendarios editoriales.

## Herramientas disponibles
search_web, search_businesses (Google Maps + anti-duplicados), search_email (Hunter.io), analyze_business (Instagram incluido), prepare_email, save_client (con language), update_client (con language), get_clients, generate_proposal (es/en), update_price, update_web_price, save_template (con language), get_templates (filtro language), calculate_budget, save_memory

## Estilo de respuesta
Sé directo y conciso. Máximo 3-4 párrafos salvo análisis completo. Usa listas cuando estructuren mejor la información. Sin frases de relleno.

Responde siempre en español, de forma clara y directa.`;

// ── TOOLS ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_web",
    description: "Busca en internet.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "search_businesses",
    description: "Busca negocios potenciales como clientes de XORA. Incluye siempre ciudad en el query (ej: 'gimnasios boutique Madrid', 'tiendas ropa Barcelona'). Devuelve webs e info de contacto para analizar y contactar.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tipo de negocio + ciudad. Ej: 'gimnasios Madrid', 'tiendas de ropa Barcelona', 'restaurantes veganos Valencia'" },
        sector: { type: "string", description: "gimnasio|moda|restaurante|ecommerce|belleza|inmobiliaria" }
      },
      required: ["query", "sector"]
    }
  },
  {
    name: "analyze_business",
    description: "Lee la web de una empresa, busca sus redes y detecta puntos débiles para proponer XORA.",
    input_schema: {
      type: "object",
      properties: {
        business_name: { type: "string" },
        website:       { type: "string" },
        sector:        { type: "string" }
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
    description: "OBLIGATORIO llamar siempre antes de mostrar un email. Guarda el email para enviarlo con /enviar y devuelve la vista previa en español para que Marcos lo revise. NUNCA muestres un email como texto sin llamar primero a esta herramienta.",
    input_schema: {
      type: "object",
      properties: {
        to:              { type: "string", description: "Email del destinatario" },
        business_name:   { type: "string" },
        subject:         { type: "string", description: "Asunto en el idioma de envío" },
        body:            { type: "string", description: "Cuerpo del email en el idioma de envío" },
        subject_es:      { type: "string", description: "Asunto en español para que Marcos lo revise (si el email se envía en inglés)" },
        body_es:         { type: "string", description: "Cuerpo en español para que Marcos lo revise (si el email se envía en inglés)" },
        language:        { type: "string", description: "'es' o 'en'" },
        sector:          { type: "string" },
        attach_proposal: { type: "boolean" }
      },
      required: ["to", "business_name", "subject", "body"]
    }
  },
  {
    name: "save_client",
    description: "Guarda un prospecto o cliente en el CRM.",
    input_schema: {
      type: "object",
      properties: {
        name:     { type: "string" },
        email:    { type: "string" },
        sector:   { type: "string" },
        language: { type: "string", description: "Idioma del cliente: 'es' (español) o 'en' (inglés). Detecta por el país/nombre del negocio. EEUU/UK/Australia = 'en', España/Latinoamérica = 'es'." },
        status:   { type: "string", description: "contactado|interesado|negociando|cliente|descartado" },
        notes:    { type: "string" }
      },
      required: ["name", "status"]
    }
  },
  {
    name: "update_client",
    description: "Actualiza estado, notas o idioma de un cliente. Estado 'cliente' envía onboarding automático.",
    input_schema: {
      type: "object",
      properties: {
        name:     { type: "string" },
        status:   { type: "string" },
        language: { type: "string", description: "'es' o 'en'" },
        notes:    { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "get_clients",
    description: "Lista clientes del CRM, opcionalmente filtrados por estado.",
    input_schema: {
      type: "object",
      properties: { status_filter: { type: "string" } },
      required: []
    }
  },
  {
    name: "generate_proposal",
    description: "Genera propuesta comercial en texto y PDF. Consulta el idioma del cliente en el CRM antes de llamar.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        sector:      { type: "string" },
        services:    { type: "string" },
        budget:      { type: "string" },
        language:    { type: "string", description: "'es' (español, por defecto) o 'en' (inglés)" }
      },
      required: ["client_name", "sector", "services"]
    }
  },
  {
    name: "update_price",
    description: "Actualiza el precio de un servicio en el CRM.",
    input_schema: {
      type: "object",
      properties: {
        service_key: { type: "string", description: "1_video|pack3_videos|campana_fotos" },
        price:       { type: "number" },
        label:       { type: "string" }
      },
      required: ["service_key", "price"]
    }
  },
  {
    name: "update_web_price",
    description: "Cambia un precio en xoralab.com y redesplega en Cloudflare Pages.",
    input_schema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "'1 vídeo'|'Pack 3 vídeos'|'Campaña de fotos'" },
        new_price:    { type: "number" }
      },
      required: ["service_name", "new_price"]
    }
  },
  {
    name: "save_template",
    description: "Guarda una plantilla de email.",
    input_schema: {
      type: "object",
      properties: {
        name:     { type: "string" },
        sector:   { type: "string" },
        language: { type: "string", description: "'es' o 'en'" },
        subject:  { type: "string" },
        body:     { type: "string" }
      },
      required: ["name", "subject", "body"]
    }
  },
  {
    name: "get_templates",
    description: "Obtiene plantillas de email guardadas, opcionalmente filtradas por sector e idioma.",
    input_schema: {
      type: "object",
      properties: {
        sector:   { type: "string" },
        language: { type: "string", description: "'es' o 'en'" }
      },
      required: []
    }
  },
  {
    name: "calculate_budget",
    description: "Calcula presupuesto exacto con extras.",
    input_schema: {
      type: "object",
      properties: {
        videos:      { type: "number", description: "0, 1 (vídeo suelto) o 3 (pack)" },
        photos:      { type: "boolean", description: "true si quieren campaña de fotos (299€)" },
        ad_rights:   { type: "boolean" },
        raw_files:   { type: "boolean" }
      },
      required: ["videos", "photos"]
    }
  },
  {
    name: "save_memory",
    description: "Guarda información permanente entre sesiones.",
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
    name: "save_prospect_list",
    description: "Guarda la lista de prospectos encontrados para procesarlos en orden uno a uno. Llama esto siempre después de buscar empresas y mostrar la lista numerada.",
    input_schema: {
      type: "object",
      properties: {
        prospects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name:      { type: "string" },
              website:   { type: "string" },
              sector:    { type: "string" },
              instagram: { type: "string", description: "@handle si se encontró" },
              score:     { type: "number", description: "Lead score 1-10" }
            },
            required: ["name"]
          }
        }
      },
      required: ["prospects"]
    }
  }
];

// ── TOOL IMPLEMENTATIONS ──────────────────────────────────

// ── GOOGLE PLACES ─────────────────────────────────────────

async function searchPlaces(query) {
  if (!GOOGLE_PLACES_KEY) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_PLACES_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (!data.results?.length) return null;
    return data.results.slice(0, 8).map((p, i) => {
      const website = p.website ? `🌐 ${p.website}` : "";
      const phone   = p.formatted_phone_number ? `📞 ${p.formatted_phone_number}` : "";
      const rating  = p.rating ? `⭐ ${p.rating}/5 (${p.user_ratings_total || 0} reseñas)` : "";
      const address = p.formatted_address || "";
      const info    = [address, rating, phone, website].filter(Boolean).join(" | ");
      return `${i + 1}. ${p.name}\n   ${info}`;
    }).join("\n\n");
  } catch (err) {
    console.error("Error Google Places:", err.message);
    return null;
  }
}

// ── HUNTER.IO EMAIL FINDER ────────────────────────────────

async function findEmailHunter(domainOrUrl) {
  if (!HUNTER_API_KEY || !domainOrUrl) return null;
  try {
    const domain = domainOrUrl
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${HUNTER_API_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    if (!data.data?.emails?.length) return null;
    return data.data.emails
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .map(e => `${e.value} (${e.type || "email"}, confianza: ${e.confidence || "?"}%)`)
      .join("\n");
  } catch (err) {
    console.error("Error Hunter.io:", err.message);
    return null;
  }
}

// ── WEB SEARCH ────────────────────────────────────────────

async function searchWeb(query, count = 5) {
  if (!BRAVE_API_KEY) return "Falta BRAVE_API_KEY.";
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
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

  // 2. General info + social presence
  const socialResults = await searchWeb(`${input.business_name} ${input.sector || ""} Instagram redes sociales`, 5);
  parts.push(`PRESENCIA ONLINE:\n${socialResults}`);

  // 3. Instagram handle specifically
  const igResults = await searchWeb(`"${input.business_name}" site:instagram.com OR "${input.business_name}" instagram`, 4);
  parts.push(`INSTAGRAM (busca el @handle exacto):\n${igResults}`);

  // 4. Decision maker — owner or marketing responsible
  const ownerResults = await searchWeb(`"${input.business_name}" fundador dueño propietario responsable marketing LinkedIn`, 4);
  parts.push(`RESPONSABLE/DECISOR:\n${ownerResults}`);

  // 5. Reviews/reputation
  const repResults = await searchWeb(`${input.business_name} opiniones reseñas calidad`, 3);
  parts.push(`REPUTACIÓN ONLINE:\n${repResults}`);

  // 6. Email via Hunter.io if we have a website
  if (input.website) {
    const hunterEmail = await findEmailHunter(input.website);
    if (hunterEmail) parts.push(`EMAIL ENCONTRADO (Hunter.io):\n${hunterEmail}`);
  }

  return parts.join("\n\n---\n\n");
}

async function searchEmail(input) {
  const parts = [];

  // 1. Hunter.io if website provided
  if (input.website) {
    const hunterResult = await findEmailHunter(input.website);
    if (hunterResult) parts.push(`EMAILS ENCONTRADOS (Hunter.io):\n${hunterResult}`);
  }

  // 2. Web search as fallback / complement
  const query = `"${input.business_name}" ${input.location || ""} email contacto`;
  const webResults = await searchWeb(query, 5);
  parts.push(`BÚSQUEDA WEB:\n${webResults}`);

  return parts.join("\n\n---\n\n");
}

function prepareEmail(userId, input) {
  pendingEmails.set(userId, {
    to:              input.to,
    business_name:   input.business_name,
    subject:         input.subject,
    body:            input.body,
    language:        input.language || "es",
    sector:          input.sector || "default",
    attach_proposal: input.attach_proposal || false
  });

  // Vista previa siempre en español — enviar directamente a Telegram
  const previewSubject = input.subject_es || input.subject;
  const previewBody    = input.body_es    || input.body;
  const langNote = (input.language === "en")
    ? "\n_(el email se enviará en inglés al ejecutar /enviar)_"
    : "";

  const preview = `📧 *EMAIL LISTO — VISTA EN ESPAÑOL*${langNote}\n\n*Para:* ${input.to}\n*Asunto:* ${previewSubject}\n\n${previewBody}\n\n─────────────────\n/enviar · /saltar · /cancelar`;

  // Enviar la vista previa directamente (efecto colateral) para que Marcos la vea siempre
  bot.sendMessage(userId, preview, { parse_mode: "Markdown" }).catch(() => {});

  // Devolver acuse simple a Claude (no repitas el email)
  return `Email preparado y enviado a Marcos para revisión. Para: ${input.to}. Asunto: ${input.subject}`;
}

async function saveClient(input) {
  const clients = await loadClients();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  const prevStatus = clients[id]?.status;
  clients[id] = {
    name:         input.name,
    email:        input.email    || clients[id]?.email    || "",
    sector:       input.sector   || clients[id]?.sector   || "",
    language:     input.language || clients[id]?.language || "es",
    status:       input.status,
    notes:        input.notes    || clients[id]?.notes    || "",
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
  if (input.language) clients[id].language = input.language;
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
    const langFlag = c.language === "en" ? " 🇬🇧" : "";
    return `• ${c.name} [${c.status.toUpperCase()}]${followup}${langFlag}\n  Email: ${c.email || "—"} | Sector: ${c.sector || "—"}\n  Notas: ${c.notes || "—"}`;
  }).join("\n\n");
}

function generateProposalText(input) {
  const lang = input.language || "es";
  if (lang === "en") {
    const date = new Date().toLocaleDateString("en-US");
    return `COMMERCIAL PROPOSAL — XORA
Date: ${date} | For: ${input.client_name} | Sector: ${input.sector}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT WE DO
XORA is an AI-powered visual content agency. We create professional-quality photos and videos for brands — without the cost or timeline of a traditional production.

PROPOSED SERVICES:
${input.services}

ESTIMATED INVESTMENT:
${input.budget || "To be defined based on final scope"}

PROCESS:
1. Brief (1 day) → 2. AI Production (2-5 days) → 3. Review → 4. Delivery

GUARANTEES:
✓ Revisions included until your approval
✓ Usage rights according to chosen package
✓ Delivery within agreed timeline

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Marcos — Founder of XORA
contacto@xoralab.com | ${SITE_URL}`;
  }

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
    .map(([, v]) => `• ${v.label}: ${v.price}€ / $${v.price_usd || "—"}`)
    .join("\n");
}

async function toolSaveTemplate(input) {
  const templates = await loadTemplates();
  const id = input.name.toLowerCase().replace(/\s+/g, "_");
  templates[id] = {
    name:       input.name,
    sector:     input.sector   || "default",
    language:   input.language || "es",
    subject:    input.subject,
    body:       input.body,
    created_at: new Date().toISOString()
  };
  await saveTemplatesData(templates);
  return `Plantilla "${input.name}" guardada (${input.language === "en" ? "inglés" : "español"}).`;
}

async function toolGetTemplates(sectorFilter, langFilter) {
  const templates = await loadTemplates();
  let list = Object.values(templates);
  if (!list.length) return "No hay plantillas guardadas aún.";
  if (sectorFilter) list = list.filter(t => t.sector === sectorFilter);
  if (langFilter)   list = list.filter(t => (t.language || "es") === langFilter);
  if (!list.length) return `No hay plantillas para los filtros indicados.`;
  return list.map(t =>
    `📝 *${t.name}* [${t.sector}] [${t.language || "es"}]\nAsunto: ${t.subject}\n${t.body.slice(0, 120)}...`
  ).join("\n\n");
}


async function updateWebPrice(input) {
  const CF_TOKEN   = process.env.CF_PAGES_TOKEN;
  const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || "48eeec3c9d7c5da09b90bb50778c1a67";
  const CF_PROJECT = process.env.CF_PAGES_PROJECT || "xoralab";

  const VALID_NAMES = ["1 vídeo", "Pack 3 vídeos", "Campaña de fotos"];
  if (!VALID_NAMES.includes(input.service_name)) {
    return `Nombre de servicio no válido: "${input.service_name}". Usa uno de: ${VALID_NAMES.map(n => `"${n}"`).join(", ")}`;
  }

  if (!CF_TOKEN) {
    return `Falta CF_PAGES_TOKEN en Railway. Crea un token en dash.cloudflare.com/profile/api-tokens con permiso "Cloudflare Pages:Edit" y añádelo como variable de entorno CF_PAGES_TOKEN.`;
  }

  // 1. Fetch current HTML from live site
  let html;
  try {
    const r = await fetch("https://xoralab.com", { signal: AbortSignal.timeout(10000) });
    html = await r.text();
  } catch (err) {
    return `Error descargando la web: ${err.message}`;
  }

  // 2. Update data-es attribute and visible text for the matching price card
  // HTML structure: <span class="price-amount" data-es="499€" data-en="$599">499€</span>
  // We find the service name in the surrounding context and update the euro price
  const escaped = input.service_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Find the price card containing this service name
  const cardRegex = new RegExp(
    `(${escaped}[\\s\\S]{0,300}?<span[^>]*class="price-amount"[^>]*data-es=")[^"]*("\\s+data-en="[^"]*"[^>]*>)[0-9.,]+€`,
    "i"
  );

  if (!cardRegex.test(html)) {
    return `No encontré "${input.service_name}" en la web. Comprueba que el nombre es exactamente uno de: "1 vídeo", "Pack 3 vídeos", "Campaña de fotos"`;
  }
  html = html.replace(cardRegex, `$1${input.new_price}€$2${input.new_price}€`);

  // 3. Fetch all static assets to include in the deployment
  let logoPng, faviconSvg;
  try {
    const [logoRes, faviconRes] = await Promise.all([
      fetch("https://xoralab.com/logo.png",    { signal: AbortSignal.timeout(8000) }),
      fetch("https://xoralab.com/favicon.svg", { signal: AbortSignal.timeout(8000) })
    ]);
    logoPng    = Buffer.from(await logoRes.arrayBuffer());
    faviconSvg = await faviconRes.text();
  } catch (err) {
    console.error("Aviso: no se pudieron obtener assets estáticos:", err.message);
  }

  // 4. Upload to Cloudflare Pages via Direct Upload API
  try {
    const formData = new FormData();
    formData.append("/index.html",  new Blob([html],        { type: "text/html" }),              "index.html");
    if (logoPng)    formData.append("/logo.png",    new Blob([logoPng],    { type: "image/png" }),             "logo.png");
    if (faviconSvg) formData.append("/favicon.svg", new Blob([faviconSvg], { type: "image/svg+xml" }),        "favicon.svg");

    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/deployments`,
      {
        method:  "POST",
        headers: { "Authorization": `Bearer ${CF_TOKEN}` },
        body:    formData,
        signal:  AbortSignal.timeout(30000)
      }
    );
    const data = await r.json();
    if (!data.success) {
      return `Error CF Pages: ${JSON.stringify(data.errors)}`;
    }
    return `✅ Precio de "${input.service_name}" actualizado a ${input.new_price}€ en xoralab.com. Deploy en progreso (15-30 segundos).`;
  } catch (err) {
    return `Error subiendo a Cloudflare Pages: ${err.message}`;
  }
}

async function toolCalculateBudget(input) {
  const prices = await loadPrices();
  let base = 0;
  const lines = [];

  // Videos
  if (input.videos === 1) {
    const p = prices["1_video"]?.price || 499;
    base += p;
    lines.push(`1 vídeo: ${p}€`);
  } else if (input.videos >= 3) {
    const p = prices["pack3_videos"]?.price || 1199;
    base += p;
    lines.push(`Pack 3 vídeos: ${p}€`);
  }

  // Photos (boolean — campaña de fotos)
  if (input.photos === true || input.photos === 1) {
    const p = prices["campana_fotos"]?.price || 299;
    base += p;
    lines.push(`Campaña de fotos: ${p}€`);
  }

  if (!lines.length) return "No has seleccionado ningún servicio.";

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

  const total = base + extras;
  return `PRESUPUESTO XORA:\n${lines.join("\n")}\n───────────────\nTOTAL: ${total}€`;
}

// ── RUN TOOL ──────────────────────────────────────────────

async function runTool(name, input, userId) {
  switch (name) {
    case "analyze_business":  return await analyzeBusiness(input);
    case "search_web":        return await searchWeb(input.query, 5);
    case "search_businesses": {
      // 1. Google Places si está disponible (estructurado), sino Brave
      let results;
      const placesResult = await searchPlaces(input.query);
      if (placesResult) {
        results = `RESULTADOS GOOGLE MAPS:\n${placesResult}`;
      } else {
        const sector = input.sector ? input.sector + " " : "";
        results = await searchWeb(`${sector}${input.query} Instagram contacto email web`, 10);
      }
      // 2. Anti-duplicados: avisar de los que ya están en CRM
      const clients = await loadClients();
      const inCRM = Object.values(clients).map(c => `${c.name} [${c.status}]`);
      const crmNote = inCRM.length
        ? `\n\n⚠️ YA EN TU CRM (no volver a proponer):\n${inCRM.map(n => `• ${n}`).join("\n")}`
        : "\n\nCRM: vacío todavía.";
      return results + crmNote;
    }
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
    case "get_templates":     return await toolGetTemplates(input.sector, input.language);
    case "calculate_budget":  return await toolCalculateBudget(input);
    case "save_memory": {
      const memory = await loadMemory();
      const existing = memory[input.key] ? memory[input.key] + "\n" : "";
      memory[input.key] = existing + `[${new Date().toLocaleDateString("es-ES")}] ${input.value}`;
      await saveMemory(memory);
      return `Guardado: ${input.value}`;
    }
    case "save_prospect_list": {
      const items = (input.prospects || []).filter(p => p.name);
      prospectQueues.set(userId, { items, index: 0 });
      return `Cola guardada con ${items.length} prospectos. Índice actual: 0. Di "empieza" para analizar el primero.`;
    }
    default:
      return "Herramienta no reconocida.";
  }
}

// ── CLAUDE LOOP ───────────────────────────────────────────

async function buildSystemPrompt(userMessage = "") {
  const msg = userMessage.toLowerCase();
  let extra = "";

  // Memoria: siempre (suele ser pequeña)
  const memory = await loadMemory();
  if (Object.keys(memory).length > 0) {
    extra += "\n\n## MEMORIA\n";
    extra += Object.entries(memory).map(([k, v]) => `${k}: ${v}`).join("\n");
  }

  // Precios: siempre (solo 7 líneas)
  const prices = await loadPrices();
  extra += "\n\n## PRECIOS\n";
  extra += Object.values(prices).map(v => `${v.label}: ${v.price}€`).join(" | ");

  // CRM: solo si el mensaje es relevante o no hay mensaje (comandos)
  const crmKeywords = ["cliente", "crm", "contacto", "seguimiento", "pipeline",
    "prospecto", "interesado", "negociando", "email a", "enviar a", "manda"];
  const needsCRM = !userMessage || crmKeywords.some(k => msg.includes(k));
  if (needsCRM) {
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
      extra += `\n\n## CRM\n`;
      extra += `Total: ${list.length} | ` +
        Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(" | ");
      if (needFollowup.length > 0) {
        extra += `\nSeguimientos urgentes: ${needFollowup.map(c => c.name).join(", ")}`;
      }
    }
  }

  return SYSTEM_PROMPT + extra;
}

// Elimina tool_results huérfanos (sin su tool_use correspondiente) para evitar el error 400
function sanitizeMessages(messages) {
  if (!messages.length) return [];

  // Recopilar todos los tool_use IDs presentes
  const toolUseIds = new Set();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id);
      }
    }
  }

  // Filtrar tool_results sin pareja y mensajes vacíos
  const cleaned = messages.map(m => {
    if (m.role === "user" && Array.isArray(m.content)) {
      const filtered = m.content.filter(b =>
        b.type !== "tool_result" || toolUseIds.has(b.tool_use_id)
      );
      if (filtered.length === 0) return null;
      return { ...m, content: filtered };
    }
    return m;
  }).filter(Boolean);

  // Debe empezar por un mensaje de usuario
  while (cleaned.length > 0 && cleaned[0].role !== "user") cleaned.shift();

  // Fusionar mensajes consecutivos del mismo rol (no debería pasar, pero por si acaso)
  const result = [];
  for (const m of cleaned) {
    const prev = result[result.length - 1];
    if (prev && prev.role === m.role) {
      const prevContent  = typeof prev.content  === "string" ? [{ type: "text", text: prev.content  }] : [...prev.content];
      const currContent  = typeof m.content     === "string" ? [{ type: "text", text: m.content     }] : [...m.content];
      result[result.length - 1] = { ...prev, content: [...prevContent, ...currContent] };
    } else {
      result.push(m);
    }
  }
  return result;
}

function compressHistory(messages) {
  // Mantener los últimos 10 turnos intactos para no perder emails y datos recientes
  if (messages.length <= 20) return messages;
  return messages.map((m, i) => {
    if (i >= messages.length - 20) return m;
    if (Array.isArray(m.content)) {
      const compressed = m.content.map(b => {
        if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 600) {
          return { ...b, content: b.content.slice(0, 600) + "…[recortado]" };
        }
        return b;
      });
      return { ...m, content: compressed };
    }
    return m;
  });
}

async function askClaude(messages, userId) {
  let current = sanitizeMessages(compressHistory([...messages]));
  // Extraer el último mensaje del usuario para inyección condicional
  const lastUserContent = messages.filter(m => m.role === "user").at(-1)?.content;
  const lastUserText = typeof lastUserContent === "string" ? lastUserContent : "";
  const systemPrompt = await buildSystemPrompt(lastUserText);

  while (true) {
    const response = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: current
    }, { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } });

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      current.push({ role: "assistant", content: response.content });
      return { text: text || "Sin respuesta.", messages: current };
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
    `• Al analizar un negocio → puntos débiles + propuesta de servicios XORA\n\n` +

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
    await bot.sendMessage(msg.chat.id,
      `✅ Email enviado a ${pending.business_name} (${pending.to})` +
      (pdfBuffer ? "\n📎 Propuesta PDF adjunta" : "") +
      `\n📋 Guardado en CRM como "contactado".`
    );

    // ── AUTO-ADVANCE prospect queue ────────────────────────
    const queue = prospectQueues.get(msg.from.id);
    if (!queue) return;

    queue.index++;
    if (queue.index >= queue.items.length) {
      prospectQueues.delete(msg.from.id);
      await bot.sendMessage(msg.chat.id, "🎉 Has completado todas las empresas de la lista.");
      return;
    }

    prospectQueues.set(msg.from.id, queue);
    const next = queue.items[queue.index];
    await bot.sendMessage(msg.chat.id,
      `➡️ Siguiente (${queue.index + 1}/${queue.items.length}): *${next.name}*. Analizando...`,
      { parse_mode: "Markdown" }
    );
    await bot.sendChatAction(msg.chat.id, "typing");

    const userHistory = await getHistory(msg.from.id);
    userHistory.push({
      role: "user",
      content: `Analiza ahora la siguiente empresa de la cola: "${next.name}"${next.website ? `, web: ${next.website}` : ""}${next.sector ? `, sector: ${next.sector}` : ""}. Muéstrame el email en español y el DM de Instagram con el @handle.`
    });
    const { text, messages } = await askClaude(userHistory, msg.from.id);
    await persistHistory(msg.from.id, messages);

    sendLong(msg.chat.id, text);

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

bot.onText(/\/saltar/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  pendingEmails.delete(msg.from.id);
  const queue = prospectQueues.get(msg.from.id);
  if (!queue) { bot.sendMessage(msg.chat.id, "No hay ninguna cola activa."); return; }

  queue.index++;
  if (queue.index >= queue.items.length) {
    prospectQueues.delete(msg.from.id);
    await bot.sendMessage(msg.chat.id, "Lista completada.");
    return;
  }

  prospectQueues.set(msg.from.id, queue);
  const next = queue.items[queue.index];
  await bot.sendMessage(msg.chat.id,
    `⏭️ Saltada. Siguiente (${queue.index + 1}/${queue.items.length}): *${next.name}*. Analizando...`,
    { parse_mode: "Markdown" }
  );
  await bot.sendChatAction(msg.chat.id, "typing");

  const userHistory = await getHistory(msg.from.id);
  userHistory.push({
    role: "user",
    content: `Analiza ahora la siguiente empresa de la cola: "${next.name}"${next.website ? `, web: ${next.website}` : ""}${next.sector ? `, sector: ${next.sector}` : ""}. Muéstrame el email en español y el DM de Instagram con el @handle.`
  });
  const { text, messages } = await askClaude(userHistory, msg.from.id);
  await persistHistory(msg.from.id, messages);

  sendLong(msg.chat.id, text);
});

// ── VOICE MESSAGES ────────────────────────────────────────

bot.on("voice", async (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  if (!openai) {
    bot.sendMessage(msg.chat.id, "Añade OPENAI_API_KEY en Railway para activar los mensajes de voz.");
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
    if (reply) sendLong(msg.chat.id, reply);
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

    sendLong(chatId, text);
  } catch (err) {
    console.error("Error:", err.message);
    const errMsg = err.message?.includes("overloaded") ? "Claude está saturado, espera unos segundos e inténtalo de nuevo."
      : err.message?.includes("context") || err.message?.includes("length") ? "Conversación demasiado larga. Usa /reset para empezar de nuevo."
      : `Error: ${err.message}`;
    bot.sendMessage(chatId, errMsg);
  }
});

console.log(`Bot XORA iniciado — voz ${openai ? "✓" : "(sin Whisper)"} | visión ✓ | PDF ✓ | CRM ✓ | precios ✓ | plantillas ✓ | presupuestos ✓`);
