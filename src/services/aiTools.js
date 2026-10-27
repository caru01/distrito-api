/**
 * aiTools.js - Registro central de herramientas deterministas para Bony (Distric House)
 * Incluye esquemas de función para Gemini y manejadores autorizados.
 */

const { Type } = require('@google/genai');

const TOOL_DECLARATIONS = [
  {
    name: 'get_sales_analytics',
    description: 'Obtiene métricas deterministas de ventas de Distric House para un rango de fechas. Discrimina pedidos entregados (efectivamente cobrados), pendientes de pago y cancelados (excluidos). Detalla fletes, venta de alimentos y ticket promedio.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: { type: Type.STRING, description: 'Fecha de inicio en formato YYYY-MM-DD (ej: 2026-10-22)' },
        endDate: { type: Type.STRING, description: 'Fecha de fin en formato YYYY-MM-DD (ej: 2026-10-27)' }
      }
    }
  },
  {
    name: 'get_top_selling_products',
    description: 'Obtiene el ranking de productos más vendidos en Distric House en un rango de fechas, con cantidades vendidas e ingresos totales generados.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: { type: Type.STRING, description: 'Fecha inicio YYYY-MM-DD' },
        endDate: { type: Type.STRING, description: 'Fecha fin YYYY-MM-DD' },
        limit: { type: Type.INTEGER, description: 'Número máximo de productos (por defecto 10)' }
      }
    }
  },
  {
    name: 'get_financial_summary',
    description: 'Calcula el estado financiero determinista auditado: ventas registradas, dinero efectivamente cobrado, pagos pendientes, fletes de terceros, costo de recetas (COGS), utilidad bruta, gastos operativos por categoría, resultado antes y después de nómina, y gastos fijos pendientes de registrar.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        startDate: { type: Type.STRING, description: 'Fecha inicio YYYY-MM-DD' },
        endDate: { type: Type.STRING, description: 'Fecha fin YYYY-MM-DD' }
      }
    }
  },
  {
    name: 'get_inventory_status',
    description: 'Consulta las existencias actuales de insumos en el inventario. Permite filtrar por insumos críticos o con stock bajo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        lowStockOnly: { type: Type.BOOLEAN, description: 'True para ver solo insumos por debajo o igual al stock mínimo' },
        category: { type: Type.STRING, description: 'Categoría opcional (Materia Prima, Bebidas, Desechables, etc.)' }
      }
    }
  },
  {
    name: 'get_ingredient_details',
    description: 'Consulta los datos reales de un insumo o ingrediente en el inventario: unidad de medida oficial, costo de compra, existencias, compras recientes y productos cuyas recetas lo consumen. Si el ingrediente NO existe en la base de datos (ej: tomate, cebolla), indica claramente que no está registrado y solicita el dato requerido sin inventar precios.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ingredientName: { type: Type.STRING, description: 'Nombre del insumo a buscar (ej: queso, carne, papa, tomate, cebolla)' }
      },
      required: ['ingredientName']
    }
  },
  {
    name: 'get_recipe_details',
    description: 'Consulta los ingredientes, cantidades configuradas, unidades de medida y costo real de las recetas de los productos (ej: Combo Distric Burger 2, Distric Salchi, Distric Basic). Identifica costos faltantes, costo de materia prima y no aplica merma arbitraria salvo que se especifique.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        productName: { type: Type.STRING, description: 'Nombre parcial o completo del producto a consultar' },
        wastePercentage: { type: Type.NUMBER, description: 'Porcentaje opcional de merma por cocción o preparación (ej: 10 para 10%). Por defecto es 0%.' }
      }
    }
  },
  {
    name: 'estimate_production_needs',
    description: 'Calcula y estima la materia prima necesaria para los próximos días según el historial reciente de ventas y recetas.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        daysAhead: { type: Type.INTEGER, description: 'Días hacia adelante a proyectar (ej: 3 para el fin de semana)' }
      }
    }
  },
  {
    name: 'get_active_orders_summary',
    description: 'Consulta el estado actual en tiempo real de los pedidos activos en cocina, preparación, despacho o pendientes de pago.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'get_crm_metrics',
    description: 'Consulta métricas agregadas y anonimizadas de clientes y CRM (total de contactos, activos, VIPs, ticket promedio de clientes).',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'propose_action',
    description: 'Genera una propuesta formal de acción de escritura (compra sugerida, ajuste de inventario, alerta operativa). Requiere confirmación y aprobación explícita del usuario en el panel.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        actionType: { type: Type.STRING, description: 'Tipo de acción: PURCHASE_PROPOSAL, INVENTORY_ADJUSTMENT, OPERATIONAL_ALERT' },
        title: { type: Type.STRING, description: 'Título claro de la acción propuesta' },
        explanation: { type: Type.STRING, description: 'Justificación del por qué se recomienda esta acción' },
        details: { type: Type.OBJECT, description: 'Datos específicos de la propuesta (insumos, cantidades sugeridas, costos estimados)' }
      },
      required: ['actionType', 'title', 'explanation', 'details']
    }
  }
];

/**
 * Ejecutores deterministas de herramientas
 */
async function executeTool(toolName, args = {}, context = {}) {
  const { pool, user } = context;
  if (!pool) throw new Error('Conexión a base de datos no disponible');

  switch (toolName) {
    case 'get_sales_analytics': {
      const start = args.startDate || '2026-10-22';
      const end = args.endDate ? `${args.endDate} 23:59:59` : 'NOW()';
      
      const res = await pool.query(`
        SELECT 
          COUNT(*) as total_pedidos,
          COUNT(*) FILTER (WHERE status IN ('Entregado', 'Completado')) as entregados,
          COUNT(*) FILTER (WHERE status = 'Pendiente Pago') as pendientes_pago,
          COUNT(*) FILTER (WHERE status = 'Cancelado') as cancelados,
          COALESCE(SUM(total) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as dinero_cobrado_efectivo,
          COALESCE(SUM(total) FILTER (WHERE status = 'Pendiente Pago'), 0) as total_pendiente_pago,
          COALESCE(SUM(total) FILTER (WHERE status = 'Cancelado'), 0) as total_cancelado_excluido,
          COALESCE(SUM(delivery_fee) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as fletes_domicilio_cobrados,
          COALESCE(SUM(total - COALESCE(delivery_fee, 0)) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as venta_neta_comida_cobrada,
          COALESCE(SUM(total_cogs) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as costo_recetas_cogs
        FROM pedidos_app_orders
        WHERE created_at >= $1::timestamptz 
          AND (CASE WHEN $2 = 'NOW()' THEN created_at <= NOW() ELSE created_at <= $2::timestamptz END)
      `, [start, end]);

      const data = res.rows[0];
      const cobrado = Number(data.dinero_cobrado_efectivo || 0);
      const fletes = Number(data.fletes_domicilio_cobrados || 0);
      const netaComida = Number(data.venta_neta_comida_cobrada || 0);
      const cogs = Number(data.costo_materia_prima_cogs || 0);
      const entregados = Number(data.entregados || 0);
      const pendientes = Number(data.pendientes_pago || 0);
      const montoPendiente = Number(data.total_pendiente_pago || 0);
      const cancelados = Number(data.cancelados || 0);
      const montoCancelado = Number(data.total_cancelado_excluido || 0);

      return {
        periodo_analizado: { fecha_inicio: start, fecha_fin: args.endDate || 'Hoy' },
        conteo_pedidos: {
          total_pedidos_en_base: Number(data.total_pedidos),
          entregados_incluidos: entregados,
          pendientes_pago_excluidos_de_caja: pendientes,
          cancelados_excluidos: cancelados
        },
        ventas_y_flujo_caja: {
          ventas_registradas_totales: cobrado + montoPendiente,
          dinero_efectivamente_cobrado: cobrado,
          pagos_pendientes_por_cobrar: montoPendiente,
          pedidos_cancelados_anulados: montoCancelado,
          fletes_domicilio: {
            monto_cobrado_a_clientes: fletes,
            naturaleza_contable: 'Valores cobrados para terceros (100% transferidos a repartidores). No constituyen ingreso del restaurante.'
          },
          venta_neta_de_alimentos_cobrada: netaComida
        },
        costos_y_margen: {
          costo_materia_prima_cogs: cogs,
          utilidad_bruta_alimentos: netaComida - cogs,
          margen_bruto_porcentaje: netaComida > 0 ? Number(((netaComida - cogs) / netaComida * 100).toFixed(1)) : 0,
          ticket_promedio_comida: entregados > 0 ? Math.round(netaComida / entregados) : 0
        },
        formulas_aplicadas: {
          venta_neta_comida: 'Dinero efectivamente cobrado (Entregados) - Fletes de domicilio',
          utilidad_bruta: 'Venta neta de comida cobrada - Costo de recetas (COGS)',
          margen_bruto: '(Utilidad bruta / Venta neta de comida cobrada) * 100'
        }
      };
    }

    case 'get_top_selling_products': {
      const start = args.startDate || '2026-10-22';
      const end = args.endDate ? `${args.endDate} 23:59:59` : 'NOW()';
      const limit = Math.min(Math.max(Number(args.limit || 10), 1), 30);

      const res = await pool.query(`
        SELECT id, cart_json, total, status
        FROM pedidos_app_orders
        WHERE created_at >= $1::timestamptz 
          AND (CASE WHEN $2 = 'NOW()' THEN created_at <= NOW() ELSE created_at <= $2::timestamptz END)
          AND status IN ('Entregado', 'Completado')
      `, [start, end]);

      const stats = {};
      for (const order of res.rows) {
        const items = Array.isArray(order.cart_json) ? order.cart_json : [];
        for (const item of items) {
          const name = item.title || item.name || 'Producto';
          const qty = Number(item.quantity || item.qty || 1);
          const price = Number(item.price || 0);
          if (!stats[name]) stats[name] = { producto: name, cantidad_vendida: 0, ingresos_totales: 0 };
          stats[name].cantidad_vendida += qty;
          stats[name].ingresos_totales += (price * qty);
        }
      }

      const ranking = Object.values(stats)
        .sort((a, b) => b.cantidad_vendida - a.cantidad_vendida)
        .slice(0, limit);

      return {
        rango: { desde: start, hasta: args.endDate || 'Hoy' },
        total_productos_distintos_vendidos: Object.keys(stats).length,
        ranking
      };
    }

    case 'get_financial_summary': {
      const start = args.startDate || '2026-10-22';
      const end = args.endDate ? `${args.endDate} 23:59:59` : 'NOW()';

      // 1. Pedidos entregados vs pendientes vs cancelados
      const ordersRes = await pool.query(`
        SELECT 
          COUNT(*) as total_pedidos,
          COUNT(*) FILTER (WHERE status IN ('Entregado', 'Completado')) as entregados,
          COUNT(*) FILTER (WHERE status = 'Pendiente Pago') as pendientes_pago,
          COUNT(*) FILTER (WHERE status = 'Cancelado') as cancelados,
          COALESCE(SUM(total) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as dinero_cobrado,
          COALESCE(SUM(total) FILTER (WHERE status = 'Pendiente Pago'), 0) as total_pendiente,
          COALESCE(SUM(total) FILTER (WHERE status = 'Cancelado'), 0) as total_cancelado,
          COALESCE(SUM(delivery_fee) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as fletes_domicilio,
          COALESCE(SUM(total - COALESCE(delivery_fee, 0)) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as venta_neta_comida,
          COALESCE(SUM(total_cogs) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as costo_recetas
        FROM pedidos_app_orders
        WHERE created_at >= $1::timestamptz 
          AND (CASE WHEN $2 = 'NOW()' THEN created_at <= NOW() ELSE created_at <= $2::timestamptz END)
      `, [start, end]);

      // 2. Gastos registrados discriminados por categoría y descripción
      const expensesRes = await pool.query(`
        SELECT 
          id,
          category,
          description,
          amount
        FROM pedidos_app_expenses
        WHERE expense_date >= $1::date 
          AND (CASE WHEN $2 = 'NOW()' THEN expense_date <= CURRENT_DATE ELSE expense_date <= $2::date END)
      `, [start, end]);

      // 3. Nómina de cocina según asistencia registrada
      const attendanceRes = await pool.query(`
        SELECT 
          COUNT(*) as turnos_trabajados,
          COALESCE(SUM(e.daily_rate), 0) as total_nomina
        FROM pedidos_app_employee_attendance a
        JOIN pedidos_app_employees e ON a.employee_id = e.id
        WHERE a.attendance_date >= $1::date 
          AND (CASE WHEN $2 = 'NOW()' THEN a.attendance_date <= CURRENT_DATE ELSE a.attendance_date <= $2::date END)
          AND a.status = 'Trabajó'
      `, [start, end]);

      const o = ordersRes.rows[0];
      const cobrado = Number(o.dinero_cobrado || 0);
      const fletes = Number(o.fletes_domicilio || 0);
      const netaComida = Number(o.venta_neta_comida || 0);
      const cogs = Number(o.costo_recetas || 0);
      const pendientePago = Number(o.total_pendiente || 0);
      const canceladoMonto = Number(o.total_cancelado || 0);

      const nominaCocina = Number(attendanceRes.rows[0]?.total_nomina || 0);
      const turnosCocina = Number(attendanceRes.rows[0]?.turnos_trabajados || 0);

      let gastoMarketing = 0;
      let gastoServiciosArriendo = 0;
      let comprasInsumos = 0;
      let otrosGastosOp = 0;

      for (const row of expensesRes.rows) {
        const text = (String(row.category || '') + ' ' + String(row.description || '')).toLowerCase();
        const amt = Number(row.amount ?? row.total_gastado ?? 0);
        if (text.includes('publicidad') || text.includes('marketing') || text.includes('facebk') || text.includes('facebook')) {
          gastoMarketing += amt;
        } else if (text.includes('servicio') || text.includes('arriendo') || text.includes('luz') || text.includes('gas') || text.includes('agua')) {
          gastoServiciosArriendo += amt;
        } else if (text.includes('queso') || text.includes('lechuga') || text.includes('salsamentaria') || text.includes('gaseosa') || text.includes('insumo') || text.includes('materia prima') || text.includes('carne') || text.includes('pan')) {
          comprasInsumos += amt;
        } else {
          otrosGastosOp += amt;
        }
      }

      // Cálculos contables paso a paso
      const utilidadBruta = netaComida - cogs;
      const gastosOperativosSinNomina = gastoMarketing + gastoServiciosArriendo + otrosGastosOp;
      const resultadoAntesDeNomina = utilidadBruta - gastosOperativosSinNomina;
      const resultadoDespuesDeNomina = resultadoAntesDeNomina - nominaCocina;

      return {
        periodo_analizado: { desde: start, hasta: args.endDate || 'Hoy' },
        resumen_pedidos: {
          total_pedidos: Number(o.total_pedidos),
          entregados_incluidos: Number(o.entregados),
          pendientes_pago_no_cobrados: Number(o.pendientes_pago),
          cancelados_excluidos: Number(o.cancelados)
        },
        '1_ingresos_y_ventas': {
          ventas_totales_registradas: cobrado + pendientePago,
          dinero_efectivamente_cobrado: cobrado,
          pagos_pendientes: pendientePago,
          pedidos_cancelados_anulados: canceladoMonto,
          fletes_domiciliarios_terceros: fletes,
          venta_neta_comida: netaComida,
          nota_fletes: 'Los fletes cobrados a clientes ($' + fletes.toLocaleString('es-CO') + ' COP) se transfirieron 1:1 a los repartidores, por lo que no son ingresos del negocio.'
        },
        '2_costos_de_productos_vendidos_cogs': {
          costo_materia_prima_recetas: cogs,
          utilidad_bruta_alimentos: utilidadBruta,
          margen_bruto_pct: netaComida > 0 ? Number(((utilidadBruta / netaComida) * 100).toFixed(1)) : 0
        },
        '3_gastos_operativos_registrados': {
          publicidad_marketing: gastoMarketing,
          servicios_y_arriendo_registrados: gastoServiciosArriendo,
          otros_gastos_operativos: otrosGastosOp,
          total_gastos_operativos_sin_nomina: gastosOperativosSinNomina,
          compras_insumos_en_gastos: comprasInsumos
        },
        '4_resultado_operativo': {
          resultado_antes_de_nomina: resultadoAntesDeNomina,
          nomina_cocina_registrada: nominaCocina,
          turnos_cocina_trabajados: turnosCocina,
          resultado_despues_de_nomina: resultadoDespuesDeNomina,
          margen_operativo_neto_pct: netaComida > 0 ? Number(((resultadoDespuesDeNomina / netaComida) * 100).toFixed(1)) : 0
        },
        '5_gastos_pendientes_de_registrar_alerta': {
          advertencia: 'IMPORTANTE: Este resultado operativo NO es la utilidad neta contable definitiva.',
          conceptos_no_registrados_en_db: [
            'Arriendo del local comercial (no registrado en pedidos_app_expenses)',
            'Servicios públicos: Energía eléctrica, gas natural, agua e internet (no registrados)',
            'Comisiones bancarias o pasarelas de pago (Nequi / Bancolombia / datáfono)',
            'Empaques o bolsas no asociadas directamente al costo de receta',
            'Impuestos y retenciones tributarias locales'
          ]
        },
        '6_formulas_aplicadas': {
          venta_neta_comida: 'Dinero efectivamente cobrado (Entregados) - Fletes domiciliarios',
          utilidad_bruta: 'Venta neta comida - Costo recetas (COGS)',
          resultado_antes_de_nomina: 'Utilidad bruta - Gastos operativos registrados',
          resultado_despues_de_nomina: 'Resultado antes de nómina - Nómina de cocina'
        }
      };
    }

    case 'get_inventory_status': {
      let query = `
        SELECT 
          id, name, type, category, unit, purchase_unit, consumption_unit, conversion_factor,
          stock, min_stock, unit_cost, average_cost, status
        FROM pedidos_app_inventory
        WHERE 1=1
      `;
      const params = [];
      if (args.lowStockOnly) {
        query += ` AND stock <= min_stock`;
      }
      if (args.category) {
        params.push(`%${args.category}%`);
        query += ` AND category ILIKE $${params.length}`;
      }
      query += ` ORDER BY (stock <= min_stock) DESC, stock ASC LIMIT 40`;

      const res = await pool.query(query, params);
      const criticos = res.rows.filter(i => Number(i.stock) <= Number(i.min_stock));

      return {
        total_items_consultados: res.rows.length,
        items_en_nivel_critico: criticos.length,
        insumos: res.rows.map(r => ({
          nombre: r.name,
          categoria: r.category,
          stock_actual: Number(r.stock),
          stock_minimo: Number(r.min_stock),
          unidad: r.unit,
          presentacion_compra: r.purchase_unit || r.unit,
          unidad_consumo: r.consumption_unit || r.unit,
          factor_conversion: Number(r.conversion_factor || 1),
          costo_unitario: Number(r.unit_cost),
          costo_promedio: Number(r.average_cost || r.unit_cost),
          alerta_critica: Number(r.stock) <= Number(r.min_stock)
        }))
      };
    }

    case 'get_ingredient_details': {
      const term = (args.ingredientName || '').trim();
      if (!term) {
        return { error: 'Debes proporcionar el nombre del ingrediente a consultar.' };
      }

      // Buscar en el inventario real (pedidos_app_inventory)
      const invRes = await pool.query(`
        SELECT 
          id, name, unit, purchase_unit, consumption_unit, conversion_factor,
          stock, min_stock, max_stock, unit_cost, average_cost, supplier, status
        FROM pedidos_app_inventory
        WHERE name ILIKE $1
        ORDER BY name ASC
      `, [`%${term}%`]);

      if (invRes.rows.length === 0) {
        const availableItemsRes = await pool.query(`
          SELECT name, unit, unit_cost FROM pedidos_app_inventory ORDER BY name ASC LIMIT 8
        `).catch(() => ({ rows: [] }));

        return {
          encontrado: false,
          insumo_consultado: term,
          estado_en_db: 'NO_REGISTRADO',
          mensaje: `El ingrediente "${term}" no se encuentra registrado en el inventario ni en las recetas de Distric House.`,
          datos_faltantes: {
            costo_compra: 'No registrado',
            unidad_medida: 'No registrada',
            existencias: 'No registradas'
          },
          solicitud_dato_requerido: `Para calcular costos reales o incluir "${term}" en una receta, se debe registrar el insumo en el inventario o proporcionar el precio de compra, la unidad (ej: kg, g o unidad) y la cantidad.`,
          advertencia_calculo: 'PROHIBIDO inventar precios. Si se realiza un cálculo para responder al usuario, debe etiquetarse expresamente como EJEMPLO HIPOTÉTICO.',
          insumos_registrados_similares: availableItemsRes.rows.map(r => ({ insumo: r.name, unidad: r.unit, costo_unitario: Number(r.unit_cost) }))
        };
      }

      const items = [];
      for (const inv of invRes.rows) {
        // Consultar últimas 3 compras reales
        const purchasesRes = await pool.query(`
          SELECT 
            ip.id, ip.quantity, ip.unit_cost, ip.total_cost, ip.supplier, 
            TO_CHAR(ip.purchase_date, 'YYYY-MM-DD') as fecha_compra
          FROM pedidos_app_inventory_purchases ip
          WHERE ip.inventory_id = $1
          ORDER BY ip.purchase_date DESC
          LIMIT 3
        `, [inv.id]).catch(() => ({ rows: [] }));

        // Consultar productos cuyas recetas usan este insumo
        const recipesRes = await pool.query(`
          SELECT 
            p.title as producto, p.category as categoria, pr.quantity as cantidad_en_receta,
            ROUND((pr.quantity * $2)::numeric, 2) as costo_consumido_en_receta
          FROM pedidos_app_product_recipes pr
          JOIN pedidos_app_products p ON pr.product_id = p.id
          WHERE pr.inventory_id = $1
          ORDER BY p.title ASC
        `, [inv.id, inv.unit_cost || 0]).catch(() => ({ rows: [] }));

        const uCost = Number(inv.unit_cost || 0);
        const avgCost = Number(inv.average_cost || 0);
        const stockActual = Number(inv.stock || 0);

        items.push({
          encontrado: true,
          insumo_oficial: inv.name,
          unidad_medida_registrada: inv.unit,
          presentacion_compra: inv.purchase_unit || inv.unit,
          unidad_consumo: inv.consumption_unit || inv.unit,
          factor_conversion: Number(inv.conversion_factor || 1),
          costo_unitario_real: uCost,
          costo_promedio_ponderado: avgCost,
          fuente_del_dato: purchasesRes.rows.length > 0 && purchasesRes.rows[0].fecha_compra
            ? `Última compra registrada el ${purchasesRes.rows[0].fecha_compra} a proveedor ${purchasesRes.rows[0].supplier || 'Proveedor registrado'}`
            : 'Ficha de inventario activa (pedidos_app_inventory)',
          stock_actual: stockActual,
          stock_minimo: Number(inv.min_stock || 0),
          estado_stock: stockActual <= Number(inv.min_stock || 0) ? 'CRITICO' : 'NORMAL',
          ultimas_compras_registradas: purchasesRes.rows,
          recetas_donde_se_utiliza: recipesRes.rows,
          guia_unidades: inv.unit === 'gramos'
            ? `Costo registrado por GRAMO ($${uCost.toLocaleString('es-CO')} COP/g). 1 Kilogramo equivale a $${(uCost * 1000).toLocaleString('es-CO')} COP.`
            : inv.unit === 'unidad'
              ? `Costo registrado por UNIDAD/TAJADA ($${uCost.toLocaleString('es-CO')} COP/und). Las recetas descuentan por unidades individuales.`
              : `Costo registrado por ${inv.unit}.`
        });
      }

      return {
        encontrado: true,
        insumo_consultado: term,
        total_coincidencias: items.length,
        insumos: items
      };
    }

    case 'get_recipe_details': {
      let query = `
        SELECT 
          p.id, p.title as producto, p.price as precio_venta, p.category as categoria,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'insumo', inv.name,
                'cantidad_receta', pr.quantity,
                'unidad_registrada', inv.unit,
                'costo_unitario_real', inv.unit_cost,
                'costo_promedio_real', inv.average_cost,
                'costo_linea', CASE 
                  WHEN inv.unit_cost IS NOT NULL THEN ROUND((pr.quantity * inv.unit_cost)::numeric, 2)
                  ELSE NULL 
                END,
                'costo_registrado', (inv.unit_cost IS NOT NULL AND inv.unit_cost > 0),
                'stock_actual', inv.stock
              )
            ) FILTER (WHERE inv.id IS NOT NULL), '[]'::json
          ) as ingredientes,
          COALESCE(SUM(pr.quantity * inv.unit_cost), 0) as costo_total_receta,
          COUNT(CASE WHEN inv.id IS NOT NULL AND (inv.unit_cost IS NULL OR inv.unit_cost = 0) THEN 1 END) as ingredientes_sin_costo
        FROM pedidos_app_products p
        LEFT JOIN pedidos_app_product_recipes pr ON p.id = pr.product_id
        LEFT JOIN pedidos_app_inventory inv ON pr.inventory_id = inv.id
        WHERE p.is_active = true
      `;
      const params = [];
      if (args.productName) {
        params.push(`%${args.productName}%`);
        query += ` AND p.title ILIKE $1`;
      }
      query += ` GROUP BY p.id, p.title, p.price, p.category ORDER BY p.category, p.title`;

      const res = await pool.query(query, params);
      const wastePct = typeof args.wastePercentage === 'number' ? Math.max(0, Math.min(args.wastePercentage, 100)) : 0;

      return {
        recetas: res.rows.map(r => {
          const precio = Number(r.precio_venta || 0);
          const costoNeto = Number(r.costo_total_receta || 0);
          const costoConMerma = wastePct > 0 
            ? Math.round(costoNeto * (1 + wastePct / 100)) 
            : Math.round(costoNeto);
          const ganancia = precio - costoConMerma;
          const ingredientesSinCosto = Number(r.ingredientes_sin_costo || 0);

          return {
            producto: r.producto,
            categoria: r.categoria,
            precio_venta: precio,
            costo_materia_prima_directo: Math.round(costoNeto),
            merma_aplicada_porcentaje: wastePct,
            costo_receta_final: costoConMerma,
            ganancia_bruta: Math.round(ganancia),
            margen_bruto_pct: precio > 0 ? Number(((ganancia / precio) * 100).toFixed(1)) : 0,
            ingredientes: r.ingredientes,
            datos_faltantes: ingredientesSinCosto > 0 ? {
              alerta: `Hay ${ingredientesSinCosto} ingrediente(s) sin costo unitario registrado en la base de datos. El costo total puede estar incompleto.`,
              requiere_costo: true
            } : null,
            advertencia_merma: wastePct === 0
              ? 'Este costo corresponde al 100% de materia prima directa neta sin merma. No hay merma arbitraria aplicada.'
              : `Se aplicó un ${wastePct}% de merma solicitado expresamente por el usuario.`
          };
        })
      };
    }

    case 'estimate_production_needs': {
      const days = Math.min(Math.max(Number(args.daysAhead || 3), 1), 7);
      
      const res = await pool.query(`
        WITH recent_consumptions AS (
          SELECT 
            inv.name as insumo,
            inv.unit as unidad,
            inv.stock as stock_actual,
            inv.unit_cost as costo_unitario,
            SUM(pr.quantity) as consumo_total
          FROM pedidos_app_orders o
          JOIN pedidos_app_products p ON TRUE
          JOIN pedidos_app_product_recipes pr ON pr.product_id = p.id
          JOIN pedidos_app_inventory inv ON pr.inventory_id = inv.id
          WHERE o.created_at >= NOW() - INTERVAL '7 days'
            AND o.status IN ('Entregado', 'Completado')
            AND o.cart_json::text ILIKE '%' || p.title || '%'
          GROUP BY inv.name, inv.unit, inv.stock, inv.unit_cost
        )
        SELECT 
          insumo, unidad, stock_actual, costo_unitario,
          ROUND((consumo_total / 7.0 * $1)::numeric, 2) as necesidad_estimada
        FROM recent_consumptions
        ORDER BY necesidad_estimada DESC
        LIMIT 15
      `, [days]).catch(() => ({ rows: [] }));

      return {
        dias_proyectados: days,
        estimaciones: res.rows.map(r => ({
          insumo: r.insumo,
          unidad: r.unidad,
          stock_actual: Number(r.stock_actual),
          consumo_proyectado: Number(r.necesidad_estimada),
          sugerencia_compra: Math.max(0, Math.round(Number(r.necesidad_estimada) - Number(r.stock_actual))),
          costo_estimado: Math.round(Math.max(0, Number(r.necesidad_estimada) - Number(r.stock_actual)) * Number(r.costo_unitario || 0))
        }))
      };
    }

    case 'get_active_orders_summary': {
      const res = await pool.query(`
        SELECT 
          status,
          COUNT(*) as count,
          COALESCE(SUM(total), 0) as total_monto
        FROM pedidos_app_orders
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY status
        ORDER BY count DESC
      `);

      const delays = await pool.query(`
        SELECT 
          id, customer_name, status, delivery_type, total,
          EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutos_espera
        FROM pedidos_app_orders
        WHERE status IN ('Nuevo', 'En preparación')
          AND created_at >= NOW() - INTERVAL '12 hours'
        ORDER BY created_at ASC
        LIMIT 5
      `);

      return {
        resumen_estados_ultimas_24h: res.rows,
        pedidos_en_espera_o_retrasados: delays.rows.map(d => ({
          pedido_id: d.id,
          cliente: d.customer_name,
          estado: d.status,
          tipo: d.delivery_type,
          minutos_transcurridos: Math.round(Number(d.minutos_espera))
        }))
      };
    }

    case 'get_crm_metrics': {
      const res = await pool.query(`
        SELECT 
          COUNT(*) as total_contactos,
          COUNT(*) FILTER (WHERE status = 'VIP') as vips,
          COUNT(*) FILTER (WHERE status = 'CLIENTE_ACTIVO' OR status = 'VIP') as activos,
          COUNT(*) FILTER (WHERE status = 'INACTIVO') as inactivos,
          COUNT(*) FILTER (WHERE status = 'PROSPECTO' OR status = 'NUEVO_CONTACTO') as prospectos,
          COALESCE(AVG(average_ticket::numeric) FILTER (WHERE average_ticket::numeric > 0), 0) as ticket_promedio_historico
        FROM pedidos_app_crm_contacts
      `).catch(() => ({ rows: [{ total_contactos: 0, vips: 0, activos: 0, inactivos: 0, prospectos: 0, ticket_promedio_historico: 0 }] }));

      const c = res.rows[0];
      return {
        total_clientes_en_base: Number(c.total_contactos),
        clientes_vips: Number(c.vips),
        clientes_activos: Number(c.activos),
        clientes_inactivos: Number(c.inactivos),
        prospectos: Number(c.prospectos),
        ticket_promedio_general: Math.round(Number(c.ticket_promedio_historico))
      };
    }

    case 'propose_action': {
      const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const { actionType, title, explanation, details } = args;

      try {
        await pool.query(`
          INSERT INTO pedidos_app_ai_actions 
            (id, user_id, tool_name, action_type, parameters, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'pending_confirmation', NOW(), NOW())
        `, [
          actionId,
          user?.id || null,
          'propose_action',
          actionType || 'GENERIC_ACTION',
          JSON.stringify({ title, explanation, details })
        ]);
      } catch (err) {
        console.warn('Nota: No se pudo guardar la acción en pedidos_app_ai_actions (tabla aún no migrada):', err.message);
      }

      return {
        propuesta_creada: true,
        action_id: actionId,
        estado: 'pending_confirmation',
        titulo: title,
        tipo: actionType,
        justificacion: explanation,
        detalles: details,
        mensaje_para_usuario: 'He generado una propuesta formal con estos datos. Para aplicarla con seguridad, pulsa el botón "Aprobar y Ejecutar" en el panel.'
      };
    }

    default:
      throw new Error(`Herramienta no autorizada o no implementada: ${toolName}`);
  }
}

module.exports = {
  TOOL_DECLARATIONS,
  executeTool
};
