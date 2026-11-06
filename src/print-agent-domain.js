'use strict';

/**
 * Distric House Print Agent — reglas de dominio (sin dependencias de base de datos).
 *
 * Estados honestos por impresora:
 *  pending              → creado, esperando al agente
 *  claimed              → el agente lo recogió (lease temporal)
 *  spooled              → Windows aceptó el trabajo en su cola
 *  completed_by_driver  → salió de la cola sin error según el controlador
 *  unverifiable         → Windows lo procesó, pero no hay forma de confirmar la salida física
 *  failed               → Windows o la impresora reportaron error
 *  expired              → venció sin imprimirse (queda para reimpresión manual)
 *  handled_by_browser   → se imprimió mediante el respaldo del navegador; el agente nunca lo tomará
 */

const crypto = require('crypto');

const PRINTER_MODES = new Set(['browser', 'agent_single', 'agent_dual']);
const PAPER_WIDTHS = new Set([58, 80]);
const JOB_KINDS = new Set(['comanda', 'reprint', 'test']);
const PRINTER_ROLES = new Set(['primary', 'secondary']);

const TERMINAL_STATUSES = new Set(['completed_by_driver', 'unverifiable', 'failed', 'expired', 'handled_by_browser']);

// Transiciones que el agente puede reportar.
// 'expired' se acepta solo si el claim_token coincide: el agente alcanzó a enviarlo a Windows
// justo cuando vencía el lease, y su resultado real debe quedar registrado.
const AGENT_TRANSITIONS = {
  claimed: new Set(['spooled', 'completed_by_driver', 'unverifiable', 'failed']),
  spooled: new Set(['completed_by_driver', 'unverifiable', 'failed']),
  expired: new Set(['spooled', 'completed_by_driver', 'unverifiable', 'failed']),
};

// Columnas de impresora en pedidos_app_settings: solo se modifican por el endpoint validado
// /admin/print-settings. El PUT general de ajustes las ignora.
const PRINTER_SETTINGS_FIELDS = new Set([
  'printer_mode', 'printer_primary_name', 'printer_secondary_name',
  'printer_paper_width', 'print_agent_id', 'print_job_expiry_minutes',
]);

const AGENT_ONLINE_WINDOW_SECONDS = 30;
const CLAIM_LEASE_SECONDS = 60;
const MAX_CLAIM_ATTEMPTS = 3;
const MAX_HTML_BYTES = 512000;
const TEST_JOB_EXPIRY_MINUTES = 3;
const AGENT_TOKEN_PREFIX = 'dhpa_';

// Estados que Windows reporta en Win32_Printer / Get-Printer y que impiden imprimir.
const BLOCKING_PRINTER_STATES = [
  'offline', 'error', 'paperout', 'paper out', 'paperjam', 'paper jam', 'notavailable',
  'not available', 'doorOpen'.toLowerCase(), 'door open', 'nottoner', 'userintervention',
];

function canAgentTransition(from, to) {
  return Boolean(AGENT_TRANSITIONS[from]?.has(to));
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function generateAgentToken() {
  return AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function looksLikeAgentToken(token) {
  return typeof token === 'string'
    && token.startsWith(AGENT_TOKEN_PREFIX)
    && token.length >= AGENT_TOKEN_PREFIX.length + 40
    && token.length <= 200;
}

function isValidIdempotencyKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9:_\-.]{8,160}$/.test(key);
}

function cleanText(value, max = 255) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** Normaliza el listado de impresoras reportado por el agente (datos no confiables). */
function normalizeReportedPrinters(printers) {
  if (!Array.isArray(printers)) return [];
  return printers.slice(0, 50).map((printer) => ({
    name: cleanText(printer?.name, 255),
    driver: cleanText(printer?.driver, 255),
    port: cleanText(printer?.port, 255),
    status: cleanText(printer?.status, 100) || 'Desconocido',
    detected_error_state: cleanText(printer?.detected_error_state, 100),
    work_offline: Boolean(printer?.work_offline),
    is_default: Boolean(printer?.is_default),
    is_virtual: Boolean(printer?.is_virtual),
  })).filter((printer) => printer.name);
}

function printerAvailability(printer) {
  if (!printer) return { available: false, reason: 'La impresora no está instalada en el equipo del agente.' };
  if (!printer.driver) return { available: false, reason: `"${printer.name}" no tiene un controlador instalado.` };
  if (printer.is_virtual) return { available: false, reason: `"${printer.name}" es una impresora virtual, no una impresora física.` };
  if (printer.work_offline) return { available: false, reason: `"${printer.name}" está configurada como "Usar impresora sin conexión" en Windows.` };
  const states = [printer.status, printer.detected_error_state].filter(Boolean).map((s) => s.toLowerCase());
  const blocking = states.find((state) => BLOCKING_PRINTER_STATES.some((b) => state.replace(/\s+/g, '') === b.replace(/\s+/g, '')));
  if (blocking) return { available: false, reason: `"${printer.name}" reporta el estado "${blocking}" en Windows.` };
  return { available: true, reason: null };
}

function isAgentOnline(agent, now = new Date()) {
  if (!agent || agent.revoked_at || !agent.last_seen_at) return false;
  return (now.getTime() - new Date(agent.last_seen_at).getTime()) <= AGENT_ONLINE_WINDOW_SECONDS * 1000;
}

/**
 * Valida la configuración de impresión antes de guardarla.
 * Para habilitar el modo dual exige: agente vinculado y en línea, dos impresoras distintas,
 * ambas reportadas por Windows con controlador instalado y sin estados bloqueantes.
 */
function validatePrinterSettings(next, agent, now = new Date()) {
  const errors = [];
  const mode = next.printer_mode;
  if (!PRINTER_MODES.has(mode)) errors.push('Modo de impresión no válido.');
  if (next.printer_paper_width != null && !PAPER_WIDTHS.has(Number(next.printer_paper_width))) {
    errors.push('El ancho de papel debe ser 58 u 80 mm.');
  }
  if (next.print_job_expiry_minutes != null) {
    const minutes = Number(next.print_job_expiry_minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) errors.push('El vencimiento de comandas debe estar entre 1 y 120 minutos.');
  }
  if (mode === 'browser' || !PRINTER_MODES.has(mode)) return errors;

  if (!agent || agent.revoked_at) {
    errors.push('Primero vincula el Print Agent en el computador donde están conectadas las impresoras.');
    return errors;
  }
  if (!isAgentOnline(agent, now)) errors.push('El Print Agent no está en línea. Abre el agente en el computador de las impresoras.');

  const printers = normalizeReportedPrinters(agent.printers_json);
  const byName = new Map(printers.map((printer) => [printer.name, printer]));
  const required = [['principal', next.printer_primary_name]];
  if (mode === 'agent_dual') required.push(['segunda', next.printer_secondary_name]);

  for (const [label, name] of required) {
    if (!cleanText(name)) { errors.push(`Selecciona la impresora ${label}.`); continue; }
    const availability = printerAvailability(byName.get(name));
    if (!availability.available) errors.push(`Impresora ${label}: ${availability.reason}`);
  }
  if (mode === 'agent_dual' && cleanText(next.printer_primary_name) && next.printer_primary_name === next.printer_secondary_name) {
    errors.push('En modo dual las dos impresoras deben ser distintas.');
  }
  return errors;
}

/** Destinos (impresoras) para un trabajo según la configuración vigente. */
function resolveTargets(settings, { roles } = {}) {
  const mode = settings?.printer_mode || 'browser';
  if (mode === 'browser') return [{ printer_role: 'browser', printer_name: 'Navegador (impresora predeterminada)' }];
  const all = [{ printer_role: 'primary', printer_name: settings.printer_primary_name }];
  if (mode === 'agent_dual') all.push({ printer_role: 'secondary', printer_name: settings.printer_secondary_name });
  const wanted = Array.isArray(roles) && roles.length ? new Set(roles.filter((r) => PRINTER_ROLES.has(r))) : null;
  return all.filter((target) => target.printer_name && (!wanted || wanted.has(target.printer_role)));
}

function buildTestTicketHtml({ printerName, role, paperWidth = 58, restaurantName = 'Distric House', now = new Date() }) {
  const width = Number(paperWidth) === 80 ? '72mm' : '41mm';
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = now.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'medium' });
  const roleLabel = role === 'secondary' ? 'Impresora 2' : 'Impresora 1';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { margin: 0; size: ${paperWidth}mm auto; }
body { margin: 0; padding: 2mm 0; width: ${width}; font-family: Arial, sans-serif; font-size: 12px; color: #000; }
.c { text-align: center; } .b { font-weight: 800; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
</style></head><body>
<div class="c b" style="font-size:15px">${escape(restaurantName)}</div>
<div class="c">PRUEBA DE IMPRESIÓN</div><hr>
<div>Destino: <span class="b">${escape(roleLabel)}</span></div>
<div>Impresora: <span class="b">${escape(printerName)}</span></div>
<div>Papel: <span class="b">${escape(paperWidth)} mm</span></div>
<div>Fecha: <span class="b">${escape(when)}</span></div><hr>
<div class="c">Si puedes leer este ticket,<br>la impresora está lista.</div>
</body></html>`;
}

module.exports = {
  PRINTER_MODES,
  PAPER_WIDTHS,
  JOB_KINDS,
  PRINTER_ROLES,
  PRINTER_SETTINGS_FIELDS,
  TERMINAL_STATUSES,
  AGENT_ONLINE_WINDOW_SECONDS,
  CLAIM_LEASE_SECONDS,
  MAX_CLAIM_ATTEMPTS,
  MAX_HTML_BYTES,
  TEST_JOB_EXPIRY_MINUTES,
  canAgentTransition,
  isTerminal,
  generateAgentToken,
  hashToken,
  sha256,
  looksLikeAgentToken,
  isValidIdempotencyKey,
  cleanText,
  normalizeReportedPrinters,
  printerAvailability,
  isAgentOnline,
  validatePrinterSettings,
  resolveTargets,
  buildTestTicketHtml,
};
