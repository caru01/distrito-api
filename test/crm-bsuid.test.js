const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Importamos la funcion directamente desde crm-service vía require
// Usamos un truco: ejecutamos la migración en una transacción que revertimos al final
const { normalizePhoneE164 } = require("../src/crm/phone");

// ── Helpers ──────────────────────────────────────────────────────────────────
async function callEnsureContact(client, args) {
  const svc = require("../src/crm-service");
  return svc.__test__.ensureContact(client, args);
}

// ── Setup: limpieza de datos de prueba ───────────────────────────────────────
const TEST_PHONE = "+573000000001";
const TEST_BSUID = "CO.TEST_BSUID_9999999999";
const TEST_BSUID2 = "CO.TEST_BSUID_8888888888";
const TEST_USERNAME = "test_username_bsuid";

async function cleanup() {
  await pool.query(
    "DELETE FROM pedidos_app_crm_contacts WHERE normalized_phone=$1 OR bsuid IN ($2,$3) OR username=$4",
    [TEST_PHONE, TEST_BSUID, TEST_BSUID2, TEST_USERNAME]
  );
}

before(async () => { await cleanup(); });
after(async () => { await cleanup(); await pool.end(); });

// ── TEST 1: Contacto con teléfono (flujo original) ───────────────────────────
describe("CRM BSUID - 1: Contacto con telefono", () => {
  it("debe crear un contacto con normalized_phone y bsuid=null", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const contact = await svc.__test__.ensureContact(client, { phone: TEST_PHONE, name: "Test Telefono" });
      assert.equal(contact.normalized_phone, TEST_PHONE);
      assert.equal(contact.bsuid, null);
      assert.equal(contact.username, null);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 2: Contacto solo con BSUID ─────────────────────────────────────────
describe("CRM BSUID - 2: Contacto solo con BSUID", () => {
  it("debe crear un contacto con bsuid y normalized_phone=null", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const contact = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID, name: "Test BSUID" });
      assert.equal(contact.bsuid, TEST_BSUID);
      assert.equal(contact.normalized_phone, null);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 3: Contacto con BSUID + username ────────────────────────────────────
describe("CRM BSUID - 3: Contacto con BSUID + username", () => {
  it("debe guardar bsuid y username correctamente", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const contact = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID, username: TEST_USERNAME, name: "Test Username" });
      assert.equal(contact.bsuid, TEST_BSUID);
      assert.equal(contact.username, TEST_USERNAME);
      assert.equal(contact.normalized_phone, null);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 4: Mismo BSUID + teléfono posterior (sin duplicado) ─────────────────
describe("CRM BSUID - 4: BSUID y luego telefono — no duplica", () => {
  it("debe actualizar el contacto existente con el telefono en lugar de crear uno nuevo", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const c1 = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID, name: "Sin Telefono" });
      const c2 = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID, phone: TEST_PHONE, name: "Con Telefono" });
      assert.equal(c1.id, c2.id, "Deben ser el mismo contacto");
      const updated = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE id=$1", [c1.id]);
      assert.equal(updated.rows[0].normalized_phone, TEST_PHONE);
      assert.equal(updated.rows[0].bsuid, TEST_BSUID);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 5: BSUID duplicado — idempotencia ────────────────────────────────────
describe("CRM BSUID - 5: BSUID duplicado no crea segundo contacto", () => {
  it("debe retornar el mismo contacto en llamadas consecutivas", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const c1 = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID });
      const c2 = await svc.__test__.ensureContact(client, { bsuid: TEST_BSUID, name: "Update" });
      assert.equal(c1.id, c2.id);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 6: Mensaje INBOUND con BSUID (simulación) ───────────────────────────
describe("CRM BSUID - 6: Mensaje INBOUND con BSUID crea contacto+conversacion+mensaje", () => {
  it("debe crear contacto, conversacion y mensaje en la BD", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const fakeValue = { metadata: { phone_number_id: "1234567890" } };
      const fakeMsg = {
        id: "wamid.TEST_INBOUND_BSUID_001",
        from: "",
        fromUserId: TEST_BSUID,
        type: "text",
        text: { body: "Hola desde numero oculto" },
        timestamp: String(Math.floor(Date.now() / 1000)),
      };
      const fakeProfile = { username: TEST_USERNAME };
      const result = await svc.__test__.processInboundMessage(client, fakeValue, fakeMsg, fakeProfile);
      assert.ok(result.contactId, "Debe tener contactId");
      assert.ok(result.conversationId, "Debe tener conversationId");
      assert.ok(result.messageId, "Debe tener messageId");
      const contact = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE id=$1", [result.contactId]);
      assert.equal(contact.rows[0].bsuid, TEST_BSUID);
      assert.equal(contact.rows[0].username, TEST_USERNAME);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 7: Mensaje OUTBOUND (echo) con BSUID ────────────────────────────────
describe("CRM BSUID - 7: Echo OUTBOUND con BSUID crea contacto correctamente", () => {
  it("debe crear contacto por bsuid en toUserId", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const fakeMsg = {
        id: "ycloud.TEST_OUTBOUND_ECHO_001",
        to: "",
        toUserId: TEST_BSUID2,
        type: "text",
        text: { body: "Respuesta del negocio" },
        status: "sent",
        sendAt: new Date().toISOString(),
        customerProfile: { username: "otro_username" },
      };
      const result = await svc.__test__.processYCloudMessageUpdated(client, fakeMsg);
      assert.equal(result.ignored, false);
      assert.ok(result.createdOutbound, "Debe indicar que creo un outbound");
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 8: Conversación existente — no se duplica ───────────────────────────
describe("CRM BSUID - 8: Conversacion existente no se duplica", () => {
  it("misma conversacion se reutiliza para el mismo contacto", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const fakeValue = { metadata: { phone_number_id: "1234567890" } };
      const makeMsg = (msgId) => ({
        id: msgId, from: "", fromUserId: TEST_BSUID, type: "text",
        text: { body: "Segundo mensaje" }, timestamp: String(Math.floor(Date.now() / 1000)),
      });
      const r1 = await svc.__test__.processInboundMessage(client, fakeValue, makeMsg("wamid.TEST_CONV_001"), { username: TEST_USERNAME });
      const r2 = await svc.__test__.processInboundMessage(client, fakeValue, makeMsg("wamid.TEST_CONV_002"), { username: TEST_USERNAME });
      assert.equal(r1.conversationId, r2.conversationId, "Debe ser la misma conversacion");
      assert.equal(r1.contactId, r2.contactId, "Debe ser el mismo contacto");
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

// ── TEST 9: Usuario antiguo con teléfono — regresión ─────────────────────────
describe("CRM BSUID - 9: Usuario con telefono existente — flujo original intacto", () => {
  it("debe funcionar exactamente igual que antes sin BSUID", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const svc = require("../src/crm-service");
      const c1 = await svc.__test__.ensureContact(client, { phone: TEST_PHONE, name: "Cliente Antiguo" });
      const c2 = await svc.__test__.ensureContact(client, { phone: TEST_PHONE, name: "Update" });
      assert.equal(c1.id, c2.id, "ON CONFLICT debe retornar el mismo contacto");
      assert.equal(c1.normalized_phone, TEST_PHONE);
      assert.equal(c1.bsuid, null);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});

