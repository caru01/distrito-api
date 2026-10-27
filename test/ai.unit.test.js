/**
 * ai.unit.test.js - Pruebas unitarias para el servicio de Bony (Google Gemini API & AI Tools)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiService } = require('../src/services/geminiService');
const { executeTool, TOOL_DECLARATIONS } = require('../src/services/aiTools');

test('GeminiService - Falla de forma segura cuando falta GEMINI_API_KEY', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const service = new GeminiService();
  await assert.rejects(
    async () => {
      await service.chat({ message: 'Hola Bony' });
    },
    (err) => {
      assert.equal(err.code, 'MISSING_API_KEY');
      assert.ok(err.message.includes('GEMINI_API_KEY no está configurada'));
      return true;
    }
  );

  process.env.GEMINI_API_KEY = originalKey;
});

test('GeminiService - Rechaza mensajes vacíos o de solo espacios', async () => {
  process.env.GEMINI_API_KEY = 'test_dummy_key';
  const service = new GeminiService();

  await assert.rejects(
    async () => {
      await service.chat({ message: '   ' });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('El mensaje no puede estar vacío'));
      return true;
    }
  );
});

test('GeminiService - Rechaza mensajes que excedan el límite de caracteres', async () => {
  process.env.GEMINI_API_KEY = 'test_dummy_key';
  const service = new GeminiService();
  const oversizedMessage = 'A'.repeat(1500);

  await assert.rejects(
    async () => {
      await service.chat({ message: oversizedMessage });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('supera el límite'));
      return true;
    }
  );
});

test('GeminiService - Mapea errores de cuota (429) a mensajes comprensibles', () => {
  const service = new GeminiService();
  const quotaError = new Error('RESOURCE_EXHAUSTED: quota exceeded');
  quotaError.status = 429;

  assert.throws(
    () => service.handleApiError(quotaError),
    (err) => {
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, 'RATE_LIMIT_EXCEEDED');
      assert.ok(err.message.includes('límite de solicitudes'));
      return true;
    }
  );
});

test('GeminiService - Mapea saldo/créditos prepagos agotados (402) a CREDITS_DEPLETED', () => {
  const service = new GeminiService();
  const creditError = new Error('{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio","status":"RESOURCE_EXHAUSTED"}}');
  creditError.status = 402;

  assert.throws(
    () => service.handleApiError(creditError),
    (err) => {
      assert.equal(err.statusCode, 402);
      assert.equal(err.code, 'CREDITS_DEPLETED');
      assert.ok(err.message.includes('créditos prepagados'));
      return true;
    }
  );
});

test('GeminiService - Mapea errores de timeout a código 504', () => {
  const service = new GeminiService();
  const timeoutError = new Error('The operation was aborted');
  timeoutError.name = 'AbortError';

  assert.throws(
    () => service.handleApiError(timeoutError),
    (err) => {
      assert.equal(err.statusCode, 504);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );
});

test('aiTools - Declaraciones de herramientas contienen nombres y tipos válidos', () => {
  assert.ok(Array.isArray(TOOL_DECLARATIONS));
  assert.ok(TOOL_DECLARATIONS.length >= 8);

  const salesTool = TOOL_DECLARATIONS.find(t => t.name === 'get_sales_analytics');
  assert.ok(salesTool, 'Herramienta get_sales_analytics debe existir');
  assert.equal(salesTool.parameters.type, 'OBJECT');

  const actionTool = TOOL_DECLARATIONS.find(t => t.name === 'propose_action');
  assert.ok(actionTool, 'Herramienta propose_action debe existir');
  assert.deepEqual(actionTool.parameters.required, ['actionType', 'title', 'explanation', 'details']);
});

test('aiTools - get_sales_analytics ejecuta consultas deterministas con discriminación de estados', async () => {
  const mockPool = {
    query: async (sql, params) => {
      return {
        rows: [{
          total_pedidos: '35',
          entregados: '30',
          pendientes_pago: '4',
          cancelados: '1',
          dinero_cobrado_efectivo: '1000000',
          total_pendiente_pago: '80000',
          total_cancelado_excluido: '30000',
          fletes_domicilio_cobrados: '100000',
          venta_neta_comida_cobrada: '900000',
          costo_materia_prima_cogs: '450000'
        }]
      };
    }
  };

  const result = await executeTool('get_sales_analytics', { startDate: '2026-10-22', endDate: '2026-10-25' }, { pool: mockPool });
  assert.equal(result.conteo_pedidos.entregados_incluidos, 30);
  assert.equal(result.conteo_pedidos.pendientes_pago_excluidos_de_caja, 4);
  assert.equal(result.conteo_pedidos.cancelados_excluidos, 1);
  assert.equal(result.ventas_y_flujo_caja.dinero_efectivamente_cobrado, 1000000);
  assert.equal(result.ventas_y_flujo_caja.pagos_pendientes_por_cobrar, 80000);
  assert.equal(result.ventas_y_flujo_caja.venta_neta_de_alimentos_cobrada, 900000);
  assert.equal(result.costos_y_margen.costo_materia_prima_cogs, 450000);
  assert.equal(result.costos_y_margen.utilidad_bruta_alimentos, 450000);
  assert.equal(result.costos_y_margen.margen_bruto_porcentaje, 50);
});

test('aiTools - get_financial_summary calcula resultado antes/después de nómina y advierte gastos no registrados', async () => {
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('pedidos_app_orders')) {
        return {
          rows: [{
            total_pedidos: '35',
            entregados: '30',
            pendientes_pago: '4',
            cancelados: '1',
            dinero_cobrado: '1000000',
            total_pendiente: '80000',
            total_cancelado: '30000',
            fletes_domicilio: '100000',
            venta_neta_comida: '900000',
            costo_recetas: '450000'
          }]
        };
      }
      if (sql.includes('pedidos_app_expenses')) {
        return {
          rows: [
            { category: 'Publicidad / Marketing', description: 'Facebook Ads', amount: '50000', total_gastado: '50000' }
          ]
        };
      }
      if (sql.includes('pedidos_app_employee_attendance')) {
        return {
          rows: [
            { turnos_trabajados: '4', total_nomina: '200000' }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const result = await executeTool('get_financial_summary', { startDate: '2026-10-22', endDate: '2026-10-25' }, { pool: mockPool });
  assert.equal(result['1_ingresos_y_ventas'].dinero_efectivamente_cobrado, 1000000);
  assert.equal(result['1_ingresos_y_ventas'].venta_neta_comida, 900000);
  assert.equal(result['2_costos_de_productos_vendidos_cogs'].utilidad_bruta_alimentos, 450000);
  assert.equal(result['4_resultado_operativo'].resultado_antes_de_nomina, 400000); // 450000 - 50000
  assert.equal(result['4_resultado_operativo'].nomina_cocina_registrada, 200000);
  assert.equal(result['4_resultado_operativo'].resultado_despues_de_nomina, 200000); // 400000 - 200000
  assert.ok(result['5_gastos_pendientes_de_registrar_alerta'].advertencia.includes('NO es la utilidad neta contable definitiva'));
  assert.ok(result['5_gastos_pendientes_de_registrar_alerta'].conceptos_no_registrados_en_db.length >= 4);
});

test('aiTools - propose_action genera una propuesta con estado pending_confirmation', async () => {
  const mockPool = {
    query: async (sql, params) => ({ rows: [] })
  };

  const result = await executeTool('propose_action', {
    actionType: 'PURCHASE_PROPOSAL',
    title: 'Comprar 10kg de Queso Mozzarella',
    explanation: 'El stock actual es de 2kg y el consumo promedio del fin de semana es de 8kg.',
    details: { insumo: 'QUESO MOZZARELLA', cantidad: 10, unidad: 'kg', costoEstimado: 250000 }
  }, { pool: mockPool, user: { id: 1 } });

  assert.equal(result.propuesta_creada, true);
  assert.equal(result.estado, 'pending_confirmation');
  assert.equal(result.tipo, 'PURCHASE_PROPOSAL');
  assert.ok(result.action_id.startsWith('act_'));
});

test('aiTools - Rechaza invocación de herramienta no autorizada', async () => {
  const mockPool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    async () => {
      await executeTool('drop_database_table', {}, { pool: mockPool });
    },
    (err) => {
      assert.ok(err.message.includes('Herramienta no autorizada'));
      return true;
    }
  );
});

test('aiTools - get_ingredient_details devuelve ficha técnica real, unidad de medida y compras sin inventar precios', async () => {
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM pedidos_app_inventory') && sql.includes('WHERE name ILIKE')) {
        return {
          rows: [{
            id: 'uuid-carne-123',
            name: 'CARNE MOLIDA PARA HAMBURGUESA',
            unit: 'gramos',
            purchase_unit: null,
            consumption_unit: null,
            conversion_factor: '1.0000',
            stock: '13395.0000',
            min_stock: '2000.0000',
            max_stock: '30000.0000',
            unit_cost: '27.0000',
            average_cost: '23.1506',
            supplier: 'Granero Freddy',
            status: 'active'
          }]
        };
      }
      if (sql.includes('FROM pedidos_app_inventory_purchases')) {
        return {
          rows: [{
            id: 43,
            quantity: '5105.0000',
            unit_cost: '27.0000',
            total_cost: '137835.00',
            supplier: 'Granero Freddy',
            fecha_compra: '2026-10-21'
          }]
        };
      }
      if (sql.includes('FROM pedidos_app_product_recipes')) {
        return {
          rows: [{
            producto: 'Distric Burger',
            categoria: 'Hamburguesas',
            cantidad_en_receta: '150.0000',
            costo_consumido_en_receta: '4050.00'
          }]
        };
      }
      return { rows: [] };
    }
  };

  const result = await executeTool('get_ingredient_details', { ingredientName: 'carne' }, { pool: mockPool });
  assert.equal(result.total_coincidencias, 1);
  const insumo = result.insumos[0];
  assert.equal(insumo.encontrado, true);
  assert.equal(insumo.insumo_oficial, 'CARNE MOLIDA PARA HAMBURGUESA');
  assert.equal(insumo.unidad_medida_registrada, 'gramos');
  assert.equal(insumo.costo_unitario_real, 27);
  assert.equal(insumo.stock_actual, 13395);
  assert.ok(insumo.guia_unidades.includes('Costo registrado por GRAMO'));
  assert.equal(insumo.ultimas_compras_registradas.length, 1);
  assert.equal(insumo.ultimas_compras_registradas[0].fecha_compra, '2026-10-21');
  assert.equal(insumo.recetas_donde_se_utiliza[0].costo_consumido_en_receta, '4050.00');
});

test('aiTools - get_ingredient_details identifica insumo faltante (ej: tomate) como NO_REGISTRADO y solicita dato requerido', async () => {
  const mockPool = {
    query: async (sql, params) => {
      // Simula que el insumo no existe en inventario
      return { rows: [] };
    }
  };

  const result = await executeTool('get_ingredient_details', { ingredientName: 'tomate' }, { pool: mockPool });
  assert.equal(result.encontrado, false);
  assert.equal(result.estado_en_db, 'NO_REGISTRADO');
  assert.equal(result.insumo_consultado, 'tomate');
  assert.ok(result.mensaje.includes('no se encuentra registrado'));
  assert.equal(result.datos_faltantes.costo_compra, 'No registrado');
  assert.ok(result.solicitud_dato_requerido.includes('proporcionar el precio de compra'));
  assert.ok(result.advertencia_calculo.includes('PROHIBIDO inventar precios'));
});

test('aiTools - get_recipe_details calcula costos con datos reales, respeta unidades y no aplica merma arbitraria', async () => {
  const mockPool = {
    query: async (sql, params) => {
      return {
        rows: [{
          id: 'prod-1',
          producto: 'Combo Distric Burger 2',
          precio_venta: '24000',
          categoria: 'Combos',
          ingredientes: [
            {
              insumo: 'PAN DE HAMBURGUESA 75 GR LISO TIPO MOGOLLA',
              cantidad_receta: '2.0000',
              unidad_registrada: 'unidad',
              costo_unitario_real: '1200.0000',
              costo_promedio_real: '1200.0000',
              costo_linea: '2400.00',
              costo_registrado: true,
              stock_actual: '126.0000'
            },
            {
              insumo: 'QUESO MOZZARELLA TAJADO ORIANA',
              cantidad_receta: '2.0000',
              unidad_registrada: 'unidad',
              costo_unitario_real: '309.0000',
              costo_promedio_real: '309.0000',
              costo_linea: '618.00',
              costo_registrado: true,
              stock_actual: '357.0000'
            },
            {
              insumo: 'PAPAS A LA FRANCESA 2.5 KG',
              cantidad_receta: '100.0000',
              unidad_registrada: 'gramos',
              costo_unitario_real: '5.4000',
              costo_promedio_real: '5.5019',
              costo_linea: '540.00',
              costo_registrado: true,
              stock_actual: '11300.0000'
            }
          ],
          costo_total_receta: '3558.00',
          ingredientes_sin_costo: '0'
        }]
      };
    }
  };

  // Sin merma (0% por defecto)
  const resSinMerma = await executeTool('get_recipe_details', { productName: 'Combo Distric Burger 2' }, { pool: mockPool });
  assert.equal(resSinMerma.recetas.length, 1);
  const r1 = resSinMerma.recetas[0];
  assert.equal(r1.costo_materia_prima_directo, 3558);
  assert.equal(r1.merma_aplicada_porcentaje, 0);
  assert.equal(r1.costo_receta_final, 3558);
  assert.ok(r1.advertencia_merma.includes('sin merma'));
  assert.equal(r1.datos_faltantes, null);

  // Con merma solicitada por usuario (ej: 10%)
  const resConMerma = await executeTool('get_recipe_details', { productName: 'Combo Distric Burger 2', wastePercentage: 10 }, { pool: mockPool });
  const r2 = resConMerma.recetas[0];
  assert.equal(r2.merma_aplicada_porcentaje, 10);
  assert.equal(r2.costo_receta_final, Math.round(3558 * 1.10)); // 3914
  assert.ok(r2.advertencia_merma.includes('Se aplicó un 10% de merma'));
});

test('aiTools - get_recipe_details detecta ingredientes sin costo y genera advertencia de datos faltantes', async () => {
  const mockPool = {
    query: async (sql, params) => {
      return {
        rows: [{
          id: 'prod-2',
          producto: 'Hamburguesa Especial',
          precio_venta: '28000',
          categoria: 'Hamburguesas',
          ingredientes: [
            {
              insumo: 'Salsa Secreta',
              cantidad_receta: '30.0000',
              unidad_registrada: 'gramos',
              costo_unitario_real: null,
              costo_linea: null,
              costo_registrado: false,
              stock_actual: '500.0000'
            }
          ],
          costo_total_receta: '0',
          ingredientes_sin_costo: '1'
        }]
      };
    }
  };

  const res = await executeTool('get_recipe_details', { productName: 'Hamburguesa Especial' }, { pool: mockPool });
  const r = res.recetas[0];
  assert.ok(r.datos_faltantes !== null);
  assert.equal(r.datos_faltantes.requiere_costo, true);
  assert.ok(r.datos_faltantes.alerta.includes('1 ingrediente(s) sin costo unitario registrado'));
});

test('GeminiService - tryDeterministicFallback responde consultas de insumos y recetas sin fallar por créditos', async () => {
  const service = new GeminiService();
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM pedidos_app_inventory') && sql.includes('WHERE name ILIKE')) {
        return {
          rows: [{
            id: 'uuid-1',
            name: 'QUESO MOZZARELLA TAJADO ORIANA',
            unit: 'unidad',
            stock: '357.0000',
            min_stock: '20.0000',
            unit_cost: '309.0000',
            average_cost: '309.0000'
          }]
        };
      }
      return { rows: [] };
    }
  };

  const fallback = await service.tryDeterministicFallback('¿Cuánto cuesta el queso?', { pool: mockPool }, { status: 402 });
  assert.ok(fallback !== null);
  assert.equal(fallback.model, 'deterministic-sql-fallback');
  assert.ok(fallback.response.includes('QUESO MOZZARELLA TAJADO ORIANA'));
  assert.ok(fallback.response.includes('$309 COP'));
  assert.ok(fallback.response.includes('unidad'));
});

// ============================================================================
// PRUEBAS DE FLUJO DE FINALIZACIÓN E HISTORIAL DE CONVERSACIONES (ai_api.js)
// ============================================================================
const express = require('express');
const request = require('supertest');
const aiApi = require('../src/ai_api');

function createTestApp({ currentUser, mockPool }) {
  const app = express();
  app.use(express.json());

  const authenticateToken = (req, res, next) => {
    req.user = currentUser;
    next();
  };

  const requirePermission = () => (req, res, next) => next();

  aiApi(app, {
    pool: mockPool,
    authenticateToken,
    requirePermission
  });

  return app;
}

test('Conversations - Finalizar conversación activa marca COMPLETED y timestamp atómicamente', async () => {
  const convId = 'conv-uuid-100';
  const mockDb = {
    conversations: [
      { id: convId, user_id: 'user-1', title: 'Consulta de Ventas', status: 'ACTIVE', completed_at: null, deleted_at: null }
    ]
  };

  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id, user_id, title, COALESCE(status')) {
        const found = mockDb.conversations.find(c => c.id === params[0] && !c.deleted_at);
        return { rows: found ? [found] : [] };
      }
      if (sql.includes('UPDATE pedidos_app_ai_conversations') && sql.includes("SET status = 'COMPLETED'")) {
        const c = mockDb.conversations.find(c => c.id === params[0] && c.user_id === params[1]);
        if (c) {
          c.status = 'COMPLETED';
          c.completed_at = new Date().toISOString();
          c.updated_at = new Date().toISOString();
          return { rows: [c] };
        }
      }
      return { rows: [] };
    }
  };

  const app = createTestApp({
    currentUser: { id: 'user-1', name: 'Admin', role: 'Administrador' },
    mockPool
  });

  const res = await request(app)
    .post(`/api/pedidos/admin/ai/conversations/${convId}/complete`)
    .expect(200);

  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.conversation.status, 'COMPLETED');
  assert.ok(res.body.conversation.completed_at);
});

test('Conversations - Finalizar conversación es idempotente si ya estaba COMPLETED', async () => {
  const convId = 'conv-uuid-already-done';
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id, user_id, title, COALESCE(status')) {
        return {
          rows: [{
            id: convId,
            user_id: 'user-1',
            title: 'Conversación Anterior',
            status: 'COMPLETED',
            completed_at: '2026-10-27T10:00:00Z',
            deleted_at: null
          }]
        };
      }
      return { rows: [] };
    }
  };

  const app = createTestApp({
    currentUser: { id: 'user-1', name: 'Admin', role: 'Administrador' },
    mockPool
  });

  const res = await request(app)
    .post(`/api/pedidos/admin/ai/conversations/${convId}/complete`)
    .expect(200);

  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.message.includes('previamente'));
  assert.equal(res.body.conversation.status, 'COMPLETED');
});

test('Conversations - Aislamiento de usuario: impide que un usuario finalice la conversación de otro', async () => {
  const convId = 'conv-user-1-private';
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id, user_id, title, COALESCE(status')) {
        return {
          rows: [{
            id: convId,
            user_id: 'user-owner-1',
            title: 'Conversación de Propietario',
            status: 'ACTIVE',
            completed_at: null,
            deleted_at: null
          }]
        };
      }
      return { rows: [] };
    }
  };

  // Usuario intruso (no Super Administrador)
  const app = createTestApp({
    currentUser: { id: 'user-intruder-99', name: 'Intruso', role: 'Cajero' },
    mockPool
  });

  const res = await request(app)
    .post(`/api/pedidos/admin/ai/conversations/${convId}/complete`)
    .expect(403);

  assert.equal(res.body.code, 'FORBIDDEN');
  assert.ok(res.body.error.includes('No tienes permiso'));
});

test('Conversations - Chat rechaza con HTTP 409 nuevos mensajes en una conversación COMPLETED', async () => {
  const convId = 'conv-completed-123';
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id, user_id, COALESCE(status, \'ACTIVE\') as status')) {
        return {
          rows: [{
            id: convId,
            user_id: 'user-1',
            status: 'COMPLETED',
            deleted_at: null
          }]
        };
      }
      return { rows: [] };
    }
  };

  const app = createTestApp({
    currentUser: { id: 'user-1', name: 'Admin', role: 'Administrador' },
    mockPool
  });

  const res = await request(app)
    .post('/api/pedidos/admin/ai/chat')
    .send({
      message: '¿Puedes darme más datos de esa venta?',
      conversationId: convId
    })
    .expect(409);

  assert.equal(res.body.code, 'CONVERSATION_COMPLETED');
  assert.ok(res.body.error.includes('solo lectura'));
});

test('Conversations - POST /conversations crea una nueva conversación limpia activa', async () => {
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO pedidos_app_ai_conversations')) {
        return {
          rows: [{
            id: 'conv-new-fresh-1',
            user_id: params[0],
            title: params[1],
            status: 'ACTIVE',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }]
        };
      }
      return { rows: [] };
    }
  };

  const app = createTestApp({
    currentUser: { id: 'user-1', name: 'Admin', role: 'Administrador' },
    mockPool
  });

  const res = await request(app)
    .post('/api/pedidos/admin/ai/conversations')
    .send({ title: 'Nueva auditoría de costos' })
    .expect(201);

  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.conversation.id, 'conv-new-fresh-1');
  assert.equal(res.body.conversation.status, 'ACTIVE');
  assert.equal(res.body.conversation.title, 'Nueva auditoría de costos');
});
