import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
  ? parseInt(process.env.ALLOWED_USER_ID)
  : null;

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Faltan TELEGRAM_TOKEN o ANTHROPIC_API_KEY en el .env");
  process.exit(1);
}

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const SYSTEM_PROMPT = `Eres el asistente personal de Marcos, fundador de XORA, una agencia de contenido con IA especializada en creación de fotos y vídeos para marcas.

## Sobre XORA
- **Qué hace**: Crea contenido visual (fotos y vídeos) con IA de calidad profesional para marcas y negocios.
- **Diferencial**: Tienen a Enzo, su influencer IA (modelo masculino), para contenido de lifestyle, moda y producto.
- **Segundo servicio**: Transforman imágenes existentes del cliente elevándolas con IA.
- **Email de contacto**: xorastudio@outlook.com

## Tarifas de XORA
### Vídeos
- 1 vídeo: desde 200€
- Pack 3 vídeos: desde 400€
- Pack 5 vídeos: desde 600€

### Fotos
- Pack 3 fotos: 120€
- Pack 5 fotos: 190€
- Pack 8 fotos: 300€

### Extras y derechos de uso
- Derechos para anuncios pagados: +30–50% sobre tarifa
- Material sin editar (raw): +50% sobre tarifa
- Lista blanca (whitelist): 20–40% al mes
- Uso 30 días: +20% tarifa base
- Uso 3 o 6 meses: +30% tarifa base/mes
- Uso libre (ilimitado): 250€ fijo

## Tu rol
Eres el asistente personal de Marcos. Puedes ayudarle con:
- Gestión y operativa de la agencia (presupuestos, seguimiento de clientes, ideas)
- Redacción de emails, propuestas y contratos para clientes
- Estrategia de contenido y marketing
- Respuestas a clientes (borradores de mensajes)
- Ideas creativas para servicios o campañas
- Cualquier otra tarea que Marcos necesite

Responde siempre en español, de forma clara, directa y profesional. Eres proactivo: si ves oportunidades de mejora o ideas útiles, las propones.`;

// Historial de conversación por usuario
const history = new Map();
const MAX_HISTORY = 20;

function isAuthorized(userId) {
  if (!ALLOWED_USER_ID) return true;
  return userId === ALLOWED_USER_ID;
}

function getHistory(userId) {
  if (!history.has(userId)) history.set(userId, []);
  return history.get(userId);
}

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(
    msg.chat.id,
    "Hola Marcos! Soy tu asistente de XORA. ¿En qué te puedo ayudar hoy?\n\nPuedo ayudarte con presupuestos, emails a clientes, estrategia, ideas creativas... lo que necesites."
  );
});

bot.onText(/\/reset/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  history.set(msg.from.id, []);
  bot.sendMessage(msg.chat.id, "Conversación reiniciada. ¿En qué te ayudo?");
});

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

  // Limitar historial
  if (userHistory.length > MAX_HISTORY) {
    userHistory.splice(0, userHistory.length - MAX_HISTORY);
  }

  bot.sendChatAction(chatId, "typing");

  try {
    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: userHistory,
    });

    const reply = response.content[0].text;
    userHistory.push({ role: "assistant", content: reply });

    // Telegram límite 4096 chars
    if (reply.length > 4096) {
      for (let i = 0; i < reply.length; i += 4096) {
        await bot.sendMessage(chatId, reply.slice(i, i + 4096));
      }
    } else {
      bot.sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Error Claude:", err.message);
    bot.sendMessage(chatId, "Hubo un error. Inténtalo de nuevo.");
  }
});

console.log("Bot XORA iniciado...");
