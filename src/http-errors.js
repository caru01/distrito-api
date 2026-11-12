/**
 * http-errors.js - Mecanismo centralizado de manejo y sanitización de errores HTTP.
 * Preserva errores funcionales 4xx y bloquea filtración de SQL, tablas, columnas o secretos en errores 5xx.
 */

const SENSITIVE_LOG_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /postgres(?:ql)?:\/\/[^\s'"]+/gi,
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;'"}\]]+/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}/g,
  /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
];

function redactSensitiveText(value) {
  let text = String(value || '');
  for (const pattern of SENSITIVE_LOG_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

class HttpDomainError extends Error {
  /**
   * Crea un error funcional/validación seguro para exponer al cliente (4xx).
   * @param {number} statusCode - Código HTTP 4xx
   * @param {string} message - Mensaje seguro para el usuario
   * @param {{ code?: string, details?: unknown }} [options]
   */
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'HttpDomainError';
    this.statusCode = statusCode;
    if (options.code) this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Construye un error HTTP controlado para validaciones o reglas de negocio (4xx).
 */
function httpError(statusCode, message, options = {}) {
  return new HttpDomainError(statusCode, message, options);
}

/**
 * Determina si el error representa un error 4xx explícito del dominio.
 */
function isClientError(error) {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * Registra detalles técnicos internos en el log del servidor, redactando secretos y credenciales.
 */
function logInternalError(component, error) {
  const safeMessage = redactSensitiveText(error?.message || error || 'Error interno desconocido');
  const safeCode = error?.code ? String(error.code) : undefined;
  const safeStack = error?.stack
    ? redactSensitiveText(String(error.stack).split('\n').slice(0, 6).join('\n'))
    : undefined;
  console.error(JSON.stringify({
    level: 'error',
    component: component || 'api',
    code: safeCode || 'INTERNAL_SERVER_ERROR',
    message: safeMessage,
    ...(safeStack ? { stack: safeStack } : {}),
  }));
}

/**
 * Envía una respuesta HTTP segura:
 * - Si error es 4xx explícito, preserva su statusCode, code y mensaje funcional.
 * - Si es un error interno (>= 500 o sin statusCode, como errores de PostgreSQL),
 *   registra el detalle internamente sin secretos y responde 500 con mensaje genérico.
 */
function sendInternalError(
  res,
  error,
  publicMessage = 'Error interno del servidor. Por favor intente nuevamente.',
  options = {},
) {
  if (isClientError(error)) {
    if (res.headersSent) return undefined;
    const body = {
      status: 'error',
      ...(error.code ? { code: error.code } : {}),
      error: error.message,
      ...(options.includeMessageField ? { message: error.message } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
    return res.status(error.statusCode).json(body);
  }

  logInternalError(options.component || 'server', error);
  if (res.headersSent) return undefined;

  const statusCode = Number.isInteger(options.statusCode) && options.statusCode >= 500
    ? options.statusCode
    : 500;

  return res.status(statusCode).json({
    status: 'error',
    ...(options.code ? { code: options.code } : {}),
    error: publicMessage,
    ...(options.includeMessageField ? { message: publicMessage } : {}),
  });
}

module.exports = {
  HttpDomainError,
  httpError,
  isClientError,
  logInternalError,
  redactSensitiveText,
  sendInternalError,
};
