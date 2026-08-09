const FIELD_DEFINITIONS = Object.freeze({
  status: { sql: 'contact.status', type: 'text' },
  source: { sql: 'contact.source', type: 'text' },
  assigned_user_id: { sql: 'contact.assigned_user_id', type: 'number' },
  orders_count: { sql: 'contact.orders_count', type: 'number' },
  total_spent: { sql: 'contact.total_spent', type: 'number' },
  average_ticket: { sql: 'contact.average_ticket', type: 'number' },
  last_purchase_at: { sql: 'contact.last_purchase_at', type: 'date' },
  first_contact_at: { sql: 'contact.first_contact_at', type: 'date' },
  last_contact_at: { sql: 'contact.last_contact_at', type: 'date' },
  marketing_opt_in: { sql: 'contact.marketing_opt_in', type: 'boolean' },
  marketing_opt_out: { sql: 'contact.marketing_opt_out', type: 'boolean' },
  no_contact: { sql: 'contact.no_contact', type: 'boolean' },
  barrio: { sql: 'contact.barrio', type: 'text' },
  email: { sql: 'contact.email', type: 'text' },
  tag: { type: 'tag' },
});

const ALLOWED_OPERATORS = new Set([
  'eq', 'neq', 'contains', 'gte', 'lte', 'before_days', 'within_days',
  'is_true', 'is_false', 'in',
]);

function segmentError(message) {
  const error = new Error(message);
  error.code = 'SEGMENT_INVALID';
  error.statusCode = 400;
  return error;
}

function validateSegmentDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw segmentError('La definición del segmento debe ser un objeto.');
  }
  const combinator = String(definition.combinator || 'AND').toUpperCase();
  if (!['AND', 'OR'].includes(combinator)) throw segmentError('El combinador debe ser AND u OR.');
  if (!Array.isArray(definition.rules) || definition.rules.length < 1 || definition.rules.length > 20) {
    throw segmentError('El segmento debe contener entre 1 y 20 reglas.');
  }
  const rules = definition.rules.map((rule) => {
    const field = String(rule?.field || '');
    const operator = String(rule?.operator || '');
    if (!FIELD_DEFINITIONS[field]) throw segmentError(`Campo de segmento no permitido: ${field || '(vacío)'}.`);
    if (!ALLOWED_OPERATORS.has(operator)) throw segmentError(`Operador de segmento no permitido: ${operator || '(vacío)'}.`);
    if (!['is_true', 'is_false'].includes(operator) && (rule.value === undefined || rule.value === null || rule.value === '')) {
      throw segmentError(`La regla ${field} requiere un valor.`);
    }
    return { field, operator, value: rule.value };
  });
  return { combinator, rules };
}

function compileSegment(definition, { startAt = 1 } = {}) {
  const normalized = validateSegmentDefinition(definition);
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${startAt + params.length - 1}`;
  };
  const clauses = normalized.rules.map((rule) => {
    const meta = FIELD_DEFINITIONS[rule.field];
    if (meta.type === 'tag') {
      if (!['eq', 'neq', 'contains'].includes(rule.operator)) throw segmentError('La etiqueta solo permite igual, diferente o contiene.');
      const comparison = rule.operator === 'contains' ? `tag.name ILIKE ${bind(`%${rule.value}%`)}` : `LOWER(tag.name)=LOWER(${bind(String(rule.value))})`;
      const exists = `EXISTS (SELECT 1 FROM pedidos_app_crm_contact_tags contact_tag JOIN pedidos_app_crm_tags tag ON tag.id=contact_tag.tag_id WHERE contact_tag.contact_id=contact.id AND ${comparison})`;
      return rule.operator === 'neq' ? `NOT (${exists})` : exists;
    }
    if (rule.operator === 'is_true') return `${meta.sql} IS TRUE`;
    if (rule.operator === 'is_false') return `${meta.sql} IS FALSE`;
    if (rule.operator === 'contains') return `COALESCE(${meta.sql}::text,'') ILIKE ${bind(`%${rule.value}%`)}`;
    if (rule.operator === 'in') {
      const values = Array.isArray(rule.value) ? rule.value : String(rule.value).split(',').map((item) => item.trim()).filter(Boolean);
      if (!values.length || values.length > 30) throw segmentError('La lista debe contener entre 1 y 30 valores.');
      return `${meta.sql}::text = ANY(${bind(values)}::text[])`;
    }
    if (rule.operator === 'before_days' || rule.operator === 'within_days') {
      const days = Number(rule.value);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw segmentError('Los días deben estar entre 0 y 3650.');
      const interval = `${bind(days)} * INTERVAL '1 day'`;
      return rule.operator === 'before_days'
        ? `${meta.sql} < NOW() - ${interval}`
        : `${meta.sql} >= NOW() - ${interval}`;
    }
    let value = rule.value;
    if (meta.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) throw segmentError(`El campo ${rule.field} requiere un número.`);
    }
    const placeholder = bind(value);
    if (rule.operator === 'eq') return `${meta.sql} = ${placeholder}`;
    if (rule.operator === 'neq') return `${meta.sql} IS DISTINCT FROM ${placeholder}`;
    if (rule.operator === 'gte') return `${meta.sql} >= ${placeholder}`;
    if (rule.operator === 'lte') return `${meta.sql} <= ${placeholder}`;
    throw segmentError('Operador no implementado.');
  });
  return { sql: `(${clauses.join(` ${normalized.combinator} `)})`, params, definition: normalized };
}

module.exports = { FIELD_DEFINITIONS, compileSegment, segmentError, validateSegmentDefinition };
