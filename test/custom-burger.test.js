const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');
const { createPool } = require('../src/db');

test('Modo Chef: normalizeOrderCart procesa y calcula correctamente el precio del servidor para hamburguesas personalizadas', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    const rawCart = [
      {
        id: 'custom_1763567890999',
        title: '👨‍🍳 Mi Doble Carne Especial',
        price: 1000, // Intento de manipulación de precio por el cliente (enviando $1.000)
        quantity: 1,
        notes: 'Bien asada',
        adiciones: [
          { id: 'base_brioche', title: 'Pan Brioche Dorado', price: 4500, quantity: 1 },
          { id: 'prot_res_120', title: 'Carne Artesanal 120g', price: 7000, quantity: 2 }, // 2x 7000 = 14000
          { id: 'cheese_cheddar', title: 'Queso Cheddar Fundido', price: 3000, quantity: 1 }, // 1x 3000 = 3000
          { id: 'top_tocineta', title: 'Tocineta Ahumada Crocante', price: 4000, quantity: 1 }, // 1x 4000 = 4000
          { id: 'sauce_lena', title: 'Salsa Distric Leña', price: 1500, quantity: 1 }, // 1x 1500 = 1500
        ],
      },
    ];

    const normalized = await app.normalizeOrderCart(client, rawCart, { activeOnly: false });

    assert.equal(normalized.cart.length, 1);
    const item = normalized.cart[0];

    // 1. Debe asignar el producto maestro del sistema
    assert.equal(item.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(item.is_custom, true);
    assert.equal(item.category, 'Modo Chef');

    // 2. El servidor debe calcular el precio autoritativo (4500 + 14000 + 3000 + 4000 + 1500 = 27000)
    // ignorando el precio manipulado de $1.000 enviado por el cliente
    assert.equal(item.price, 27000);
    assert.equal(normalized.total, 27000);

    // 3. Modificadores y receta validados
    assert.equal(item.modifiers.length, 4); // 4 adiciones además de la base
    assert.ok(item.notes.includes('Bien asada'));
    assert.ok(item.notes.includes('Pan Brioche Dorado'));
    assert.ok(item.notes.includes('Carne Artesanal 120g'));

    // 4. Recipe details estructurado
    assert.ok(item.recipe_details);
    assert.equal(item.recipe_details.server_calculated_price, 27000);
    assert.equal(item.recipe_details.base.name, 'Pan Brioche Dorado');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Modo Chef: rechaza cantidades inválidas en productos personalizados', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    const rawCartInvalid = [
      {
        id: 'custom_99999',
        title: 'Hamburguesa Invalida',
        quantity: -2,
        adiciones: [{ id: 'base_brioche', quantity: 1 }],
      },
    ];

    await assert.rejects(
      async () => {
        await app.normalizeOrderCart(client, rawCartInvalid, { activeOnly: false });
      },
      { statusCode: 400 }
    );
  } finally {
    client.release();
    await pool.end();
  }
});
