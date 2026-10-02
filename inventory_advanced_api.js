/**
 * inventory_advanced_api.js
 * Distrito BG - Módulo Avanzado de Inventario
 * 
 * Funcionalidades:
 * 1. Directorio & Gestión de Proveedores (CRUD + historial de compras + métricas).
 * 2. Sub-recetas & Lotes de Producción Interna (elaboraciones de cocina: salsas, carnes, aderezos).
 * 3. Recetas de Modificadores / Adiciones (deducción automática de tocineta extra, salsas, etc.).
 * 4. Auditoría y Conciliación Rápida de Inventario Físico (conteos de cierre de semana).
 * 5. Reporte de Valoración Total y KPIs Macroeconómicos del Inventario.
 * 6. Generador Inteligente de Pedidos a Proveedores vía WhatsApp.
 */

module.exports = function(app, { pool, authenticateToken }) {

  // ==========================================
  // 1. GESTIÓN DE PROVEEDORES
  // ==========================================

  // Listar proveedores con estadísticas de compras
  app.get('/api/pedidos/admin/suppliers', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          s.id,
          s.name,
          s.contact_name,
          s.phone,
          s.email,
          s.nit,
          s.address,
          s.category,
          s.payment_terms,
          s.notes,
          s.is_active,
          s.created_at,
          s.updated_at,
          COUNT(p.id)::int AS purchases_count,
          COALESCE(SUM(p.total_cost), 0)::numeric(14,2) AS total_spent,
          MAX(p.purchase_date) AS last_purchase_date
        FROM pedidos_app_suppliers s
        LEFT JOIN pedidos_app_inventory_purchases p 
          ON p.supplier_id = s.id OR (p.supplier = s.name AND p.supplier_id IS NULL)
        GROUP BY s.id
        ORDER BY s.is_active DESC, s.name ASC
      `);
      res.json({ status: 'ok', suppliers: rows });
    } catch (error) {
      console.error('Error al listar proveedores:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Crear proveedor
  app.post('/api/pedidos/admin/suppliers', authenticateToken, async (req, res) => {
    try {
      const { name, contact_name, phone, email, nit, address, category, payment_terms, notes } = req.body;
      if (!name?.trim()) {
        return res.status(400).json({ status: 'error', error: 'El nombre del proveedor es obligatorio' });
      }

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_suppliers 
          (name, contact_name, phone, email, nit, address, category, payment_terms, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (name) DO UPDATE 
          SET contact_name = COALESCE(EXCLUDED.contact_name, pedidos_app_suppliers.contact_name),
              phone = COALESCE(EXCLUDED.phone, pedidos_app_suppliers.phone),
              email = COALESCE(EXCLUDED.email, pedidos_app_suppliers.email),
              nit = COALESCE(EXCLUDED.nit, pedidos_app_suppliers.nit),
              address = COALESCE(EXCLUDED.address, pedidos_app_suppliers.address),
              category = COALESCE(EXCLUDED.category, pedidos_app_suppliers.category),
              payment_terms = COALESCE(EXCLUDED.payment_terms, pedidos_app_suppliers.payment_terms),
              notes = COALESCE(EXCLUDED.notes, pedidos_app_suppliers.notes),
              is_active = TRUE,
              updated_at = NOW()
        RETURNING *
      `, [
        name.trim(),
        contact_name?.trim() || null,
        phone?.trim() || null,
        email?.trim() || null,
        nit?.trim() || null,
        address?.trim() || null,
        category?.trim() || 'General',
        payment_terms?.trim() || 'Contado',
        notes?.trim() || null
      ]);

      res.json({ status: 'ok', supplier: rows[0] });
    } catch (error) {
      console.error('Error al crear proveedor:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Editar proveedor
  app.put('/api/pedidos/admin/suppliers/:id', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, contact_name, phone, email, nit, address, category, payment_terms, notes, is_active } = req.body;

      const { rows } = await pool.query(`
        UPDATE pedidos_app_suppliers
        SET name = COALESCE($1, name),
            contact_name = COALESCE($2, contact_name),
            phone = COALESCE($3, phone),
            email = COALESCE($4, email),
            nit = COALESCE($5, nit),
            address = COALESCE($6, address),
            category = COALESCE($7, category),
            payment_terms = COALESCE($8, payment_terms),
            notes = COALESCE($9, notes),
            is_active = COALESCE($10, is_active),
            updated_at = NOW()
        WHERE id = $11
        RETURNING *
      `, [
        name?.trim() || null,
        contact_name?.trim() || null,
        phone?.trim() || null,
        email?.trim() || null,
        nit?.trim() || null,
        address?.trim() || null,
        category?.trim() || null,
        payment_terms?.trim() || null,
        notes?.trim() || null,
        typeof is_active === 'boolean' ? is_active : null,
        id
      ]);

      if (!rows.length) {
        return res.status(404).json({ status: 'error', error: 'Proveedor no encontrado' });
      }

      res.json({ status: 'ok', supplier: rows[0] });
    } catch (error) {
      console.error('Error al actualizar proveedor:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Eliminar o desactivar proveedor
  app.delete('/api/pedidos/admin/suppliers/:id', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      // Verificar si tiene compras asociadas
      const { rows: pRows } = await pool.query(
        'SELECT id FROM pedidos_app_inventory_purchases WHERE supplier_id = $1 LIMIT 1',
        [id]
      );
      if (pRows.length > 0) {
        // En lugar de borrarlo físicamente, desactivarlo para mantener integridad contable
        await pool.query('UPDATE pedidos_app_suppliers SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
        return res.json({ status: 'ok', message: 'Proveedor desactivado (posee compras en el historial)' });
      }

      await pool.query('DELETE FROM pedidos_app_suppliers WHERE id = $1', [id]);
      res.json({ status: 'ok', message: 'Proveedor eliminado correctamente' });
    } catch (error) {
      console.error('Error al eliminar proveedor:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });


  // ==========================================
  // 2. SUB-RECETAS & PRODUCCIÓN INTERNA
  // ==========================================

  // Obtener sub-recetas (insumos preparados y sus ingredientes base)
  app.get('/api/pedidos/admin/subrecipes', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          sr.id,
          sr.target_inventory_id,
          sr.ingredient_inventory_id,
          sr.quantity::numeric(14,4) AS quantity,
          sr.notes,
          sr.created_at,
          sr.updated_at,
          target.name AS target_name,
          target.unit AS target_unit,
          target.stock AS target_stock,
          COALESCE(target.average_cost, 0)::numeric(14,2) AS target_cost,
          ing.name AS ingredient_name,
          ing.unit AS ingredient_unit,
          ing.stock AS ingredient_stock,
          COALESCE(ing.average_cost, ing.unit_cost, 0)::numeric(14,4) AS ingredient_cost,
          (sr.quantity * COALESCE(ing.average_cost, ing.unit_cost, 0))::numeric(14,2) AS ingredient_subtotal
        FROM pedidos_app_subrecipes sr
        JOIN pedidos_app_inventory target ON sr.target_inventory_id = target.id
        JOIN pedidos_app_inventory ing ON sr.ingredient_inventory_id = ing.id
        ORDER BY target.name ASC, ing.name ASC
      `);

      // Agrupar por producto preparado (target)
      const grouped = {};
      for (const row of rows) {
        const key = row.target_inventory_id;
        if (!grouped[key]) {
          grouped[key] = {
            target_inventory_id: row.target_inventory_id,
            target_name: row.target_name,
            target_unit: row.target_unit,
            target_stock: Number(row.target_stock) || 0,
            target_cost: Number(row.target_cost) || 0,
            ingredients: [],
            theoretical_unit_cost: 0
          };
        }
        grouped[key].ingredients.push({
          id: row.id,
          ingredient_inventory_id: row.ingredient_inventory_id,
          ingredient_name: row.ingredient_name,
          ingredient_unit: row.ingredient_unit,
          ingredient_stock: Number(row.ingredient_stock) || 0,
          quantity: Number(row.quantity),
          ingredient_cost: Number(row.ingredient_cost),
          ingredient_subtotal: Number(row.ingredient_subtotal),
          notes: row.notes
        });
        grouped[key].theoretical_unit_cost += Number(row.ingredient_subtotal);
      }

      res.json({ 
        status: 'ok', 
        subrecipes: rows, 
        grouped: Object.values(grouped) 
      });
    } catch (error) {
      console.error('Error al listar subrecetas:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Guardar / asociar ingrediente a sub-receta
  app.post('/api/pedidos/admin/subrecipes', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const { target_inventory_id, ingredient_inventory_id, quantity, notes } = req.body;
      const qty = Number(quantity);

      if (!target_inventory_id || !ingredient_inventory_id) {
        return res.status(400).json({ status: 'error', error: 'Se requiere insumo preparado e ingrediente' });
      }
      if (target_inventory_id === ingredient_inventory_id) {
        return res.status(400).json({ status: 'error', error: 'Un insumo no puede ser ingrediente de sí mismo' });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', error: 'La cantidad debe ser mayor a 0' });
      }

      await client.query('BEGIN');

      // Marcar insumo destino como preparado
      await client.query(
        'UPDATE pedidos_app_inventory SET is_prepared = TRUE, updated_at = NOW() WHERE id = $1',
        [target_inventory_id]
      );

      const { rows } = await client.query(`
        INSERT INTO pedidos_app_subrecipes 
          (target_inventory_id, ingredient_inventory_id, quantity, notes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (target_inventory_id, ingredient_inventory_id) 
        DO UPDATE SET quantity = $3, notes = $4, updated_at = NOW()
        RETURNING *
      `, [target_inventory_id, ingredient_inventory_id, qty, notes || null]);

      await client.query('COMMIT');
      res.json({ status: 'ok', subrecipe: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error al guardar ingrediente en subreceta:', error);
      res.status(400).json({ status: 'error', error: error.message });
    } finally {
      client.release();
    }
  });

  // Eliminar ingrediente de sub-receta
  app.delete('/api/pedidos/admin/subrecipes/:id', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM pedidos_app_subrecipes WHERE id = $1', [id]);
      res.json({ status: 'ok', message: 'Ingrediente eliminado de la subreceta' });
    } catch (error) {
      console.error('Error al eliminar de subreceta:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Ejecutar Lote de Producción (Cocina elabora salsa, carne, etc. -> Descuenta materias primas y suma preparado)
  app.post('/api/pedidos/admin/production/produce', authenticateToken, async (req, res) => {
    const { target_inventory_id, quantity_produced, notes, produced_by } = req.body;
    const qtyProduced = Number(quantity_produced);

    if (!target_inventory_id) {
      return res.status(400).json({ status: 'error', error: 'Debes seleccionar el insumo preparado a producir' });
    }
    if (!Number.isFinite(qtyProduced) || qtyProduced <= 0) {
      return res.status(400).json({ status: 'error', error: 'La cantidad producida debe ser mayor a 0' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener detalles del insumo preparado
      const { rows: targetRows } = await client.query(
        'SELECT id, name, unit, stock, average_cost FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE',
        [target_inventory_id]
      );
      if (!targetRows.length) throw new Error('El insumo preparado no existe');
      const targetItem = targetRows[0];

      // 2. Obtener fórmula de sub-receta
      const { rows: ingredients } = await client.query(`
        SELECT 
          sr.ingredient_inventory_id,
          sr.quantity AS formula_qty,
          inv.name AS ingredient_name,
          inv.unit AS ingredient_unit,
          COALESCE(inv.stock, 0) AS current_stock,
          COALESCE(inv.average_cost, inv.unit_cost, 0) AS unit_cost
        FROM pedidos_app_subrecipes sr
        JOIN pedidos_app_inventory inv ON sr.ingredient_inventory_id = inv.id
        WHERE sr.target_inventory_id = $1
        FOR UPDATE OF inv
      `, [target_inventory_id]);

      if (!ingredients.length) {
        throw new Error(`El insumo "${targetItem.name}" no tiene ingredientes configurados en su sub-receta técnica.`);
      }

      // 3. Crear el registro del Lote de Producción
      const { rows: batchRows } = await client.query(`
        INSERT INTO pedidos_app_production_batches
          (target_inventory_id, quantity_produced, produced_by, notes)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [
        target_inventory_id,
        qtyProduced,
        produced_by?.trim() || req.user?.username || 'Cocina',
        notes?.trim() || `Producción de ${qtyProduced} ${targetItem.unit}`
      ]);
      const batchId = batchRows[0].id;

      let totalBatchCost = 0;
      const consumedDetails = [];

      // 4. Descontar cada materia prima y registrar movimiento de kardex
      for (const ing of ingredients) {
        const qtyToDeduct = Number(ing.formula_qty) * qtyProduced;
        const currentStock = Number(ing.current_stock);
        const newStock = currentStock - qtyToDeduct; // Puede quedar temporalmente negativo si cocinaron sin registrar compra previa
        const unitCost = Number(ing.unit_cost) || 0;
        const subtotalCost = qtyToDeduct * unitCost;
        totalBatchCost += subtotalCost;

        // Actualizar stock de materia prima
        await client.query(
          'UPDATE pedidos_app_inventory SET stock = $1, updated_at = NOW() WHERE id = $2',
          [newStock, ing.ingredient_inventory_id]
        );

        // Registrar en Kardex
        await client.query(`
          INSERT INTO pedidos_app_product_stock_movements
            (inventory_id, movement_type, quantity, balance_after, unit_cost, total_cost, batch_id, reason, created_by)
          VALUES ($1, 'PRODUCCION_CONSUMO', $2, $3, $4, $5, $6, $7, $8)
        `, [
          ing.ingredient_inventory_id,
          -qtyToDeduct,
          newStock,
          unitCost,
          subtotalCost,
          batchId,
          `Consumo para producción lote #${batchId}: ${targetItem.name} (${qtyProduced} ${targetItem.unit})`,
          req.user?.username || 'Cocina'
        ]);

        consumedDetails.push({
          ingredient: ing.ingredient_name,
          deducted: qtyToDeduct,
          unit: ing.ingredient_unit,
          newStock
        });
      }

      // 5. Calcular nuevo costo unitario promedio del preparado
      const unitCostProduced = qtyProduced > 0 ? (totalBatchCost / qtyProduced) : 0;
      const prevTargetStock = Math.max(0, Number(targetItem.stock) || 0);
      const prevTargetCost = Number(targetItem.average_cost) || 0;
      const newTargetStock = prevTargetStock + qtyProduced;
      
      // Costo promedio ponderado del producto elaborado
      let newAverageCost = unitCostProduced;
      if (newTargetStock > 0 && prevTargetStock > 0) {
        newAverageCost = ((prevTargetStock * prevTargetCost) + totalBatchCost) / newTargetStock;
      }

      // 6. Actualizar stock y costo promedio del insumo preparado
      await client.query(`
        UPDATE pedidos_app_inventory
        SET stock = $1,
            average_cost = $2,
            unit_cost = $2,
            is_prepared = TRUE,
            updated_at = NOW()
        WHERE id = $3
      `, [newTargetStock, newAverageCost, target_inventory_id]);

      // 7. Actualizar el lote con los costos finales calculados
      await client.query(`
        UPDATE pedidos_app_production_batches
        SET total_cost = $1, unit_cost = $2
        WHERE id = $3
      `, [totalBatchCost, unitCostProduced, batchId]);

      // 8. Registrar entrada en Kardex del insumo elaborado
      await client.query(`
        INSERT INTO pedidos_app_product_stock_movements
          (inventory_id, movement_type, quantity, balance_after, unit_cost, total_cost, batch_id, reason, created_by)
        VALUES ($1, 'PRODUCCION_ENTRADA', $2, $3, $4, $5, $6, $7, $8)
      `, [
        target_inventory_id,
        qtyProduced,
        newTargetStock,
        unitCostProduced,
        totalBatchCost,
        batchId,
        `Entrada por producción interna lote #${batchId} (+${qtyProduced} ${targetItem.unit})`,
        req.user?.username || 'Cocina'
      ]);

      await client.query('COMMIT');

      res.json({
        status: 'ok',
        batch_id: batchId,
        target_item: targetItem.name,
        quantity_produced: qtyProduced,
        unit: targetItem.unit,
        new_stock: newTargetStock,
        unit_cost: unitCostProduced,
        total_cost: totalBatchCost,
        consumed: consumedDetails
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error al procesar lote de producción:', error);
      res.status(400).json({ status: 'error', error: error.message });
    } finally {
      client.release();
    }
  });

  // Historial de lotes de producción
  app.get('/api/pedidos/admin/production/batches', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          pb.id,
          pb.target_inventory_id,
          pb.quantity_produced::numeric(14,4) AS quantity_produced,
          pb.total_cost::numeric(14,2) AS total_cost,
          pb.unit_cost::numeric(14,4) AS unit_cost,
          pb.produced_by,
          pb.notes,
          pb.created_at,
          inv.name AS target_name,
          inv.unit AS target_unit
        FROM pedidos_app_production_batches pb
        JOIN pedidos_app_inventory inv ON pb.target_inventory_id = inv.id
        ORDER BY pb.created_at DESC
        LIMIT 100
      `);
      res.json({ status: 'ok', batches: rows });
    } catch (error) {
      console.error('Error al listar lotes de producción:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });


  // ==========================================
  // 3. RECETAS DE MODIFICADORES / ADICIONES
  // ==========================================

  // Listar recetas de modificadores
  app.get('/api/pedidos/admin/modifier-recipes', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          mr.id,
          mr.modifier_name,
          mr.inventory_id,
          mr.quantity::numeric(14,4) AS quantity,
          mr.is_controlled,
          mr.created_at,
          mr.updated_at,
          inv.name AS inventory_name,
          inv.unit AS inventory_unit,
          COALESCE(inv.average_cost, inv.unit_cost, 0)::numeric(14,4) AS unit_cost,
          (mr.quantity * COALESCE(inv.average_cost, inv.unit_cost, 0))::numeric(14,2) AS modifier_cost
        FROM pedidos_app_modifier_recipes mr
        JOIN pedidos_app_inventory inv ON mr.inventory_id = inv.id
        ORDER BY mr.modifier_name ASC, inv.name ASC
      `);
      res.json({ status: 'ok', modifiers: rows });
    } catch (error) {
      console.error('Error al listar recetas de modificadores:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Guardar receta de modificador (ej: 'Tocineta Extra' -> 2 lonjas de Tocineta)
  app.post('/api/pedidos/admin/modifier-recipes', authenticateToken, async (req, res) => {
    try {
      const { modifier_name, inventory_id, quantity, is_controlled } = req.body;
      const qty = Number(quantity);

      if (!modifier_name?.trim() || !inventory_id) {
        return res.status(400).json({ status: 'error', error: 'Nombre del modificador e insumo son requeridos' });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', error: 'La cantidad debe ser mayor a 0' });
      }

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_modifier_recipes
          (modifier_name, inventory_id, quantity, is_controlled)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (modifier_name, inventory_id)
        DO UPDATE SET quantity = $3, is_controlled = $4, updated_at = NOW()
        RETURNING *
      `, [
        modifier_name.trim(),
        inventory_id,
        qty,
        is_controlled !== false
      ]);

      res.json({ status: 'ok', modifier_recipe: rows[0] });
    } catch (error) {
      console.error('Error al guardar receta de modificador:', error);
      res.status(400).json({ status: 'error', error: error.message });
    }
  });

  // Eliminar receta de modificador
  app.delete('/api/pedidos/admin/modifier-recipes/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM pedidos_app_modifier_recipes WHERE id = $1', [req.params.id]);
      res.json({ status: 'ok', message: 'Receta de modificador eliminada' });
    } catch (error) {
      console.error('Error al eliminar modificador:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });


  // ==========================================
  // 4. AUDITORÍA & CONCILIACIÓN DE CONTEO FÍSICO
  // ==========================================

  // Ejecutar conciliación masiva tras conteo físico
  app.post('/api/pedidos/admin/inventory/audit-reconcile', authenticateToken, async (req, res) => {
    const { audited_by, notes, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'error', error: 'Debe incluir al menos un insumo contado para auditar' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Crear cabecera de auditoría
      const { rows: auditRows } = await client.query(`
        INSERT INTO pedidos_app_inventory_audits (audited_by, notes)
        VALUES ($1, $2)
        RETURNING id
      `, [audited_by?.trim() || req.user?.username || 'Administrador', notes?.trim() || null]);
      const auditId = auditRows[0].id;

      let totalDiscrepancyCost = 0;
      let auditedCount = 0;
      const results = [];

      for (const item of items) {
        const countedStock = Number(item.counted_stock);
        if (!item.inventory_id || !Number.isFinite(countedStock)) continue;

        // Bloquear fila del insumo
        const { rows: invRows } = await client.query(`
          SELECT id, name, unit, stock, COALESCE(average_cost, unit_cost, 0) AS unit_cost
          FROM pedidos_app_inventory
          WHERE id = $1
          FOR UPDATE
        `, [item.inventory_id]);

        if (!invRows.length) continue;
        const inv = invRows[0];
        const systemStock = Number(inv.stock) || 0;
        const difference = countedStock - systemStock;
        const unitCost = Number(inv.unit_cost) || 0;
        const costDifference = Math.abs(difference) * unitCost;

        if (difference !== 0) {
          totalDiscrepancyCost += costDifference;

          // Actualizar stock exacto al contado físicamente
          await client.query(
            'UPDATE pedidos_app_inventory SET stock = $1, updated_at = NOW() WHERE id = $2',
            [countedStock, inv.id]
          );

          // Registrar en Kardex con tipo específico de auditoría
          const movementType = difference < 0 ? 'FALTANTE_AUDITORIA' : 'SOBRANTE_AUDITORIA';
          const reasonText = `Ajuste Auditoría #${auditId}: Sistema tenía ${systemStock} ${inv.unit}, Conteo real: ${countedStock} ${inv.unit} (${difference > 0 ? '+' : ''}${difference} ${inv.unit})`;

          await client.query(`
            INSERT INTO pedidos_app_product_stock_movements
              (inventory_id, movement_type, quantity, balance_after, unit_cost, total_cost, audit_id, reason, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
            inv.id,
            movementType,
            difference,
            countedStock,
            unitCost,
            costDifference,
            auditId,
            reasonText,
            req.user?.username || 'Auditor'
          ]);
        }

        // Registrar item en la auditoría
        await client.query(`
          INSERT INTO pedidos_app_inventory_audit_items
            (audit_id, inventory_id, system_stock, counted_stock, difference, unit_cost, cost_difference)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          auditId,
          inv.id,
          systemStock,
          countedStock,
          difference,
          unitCost,
          costDifference
        ]);

        auditedCount++;
        results.push({
          name: inv.name,
          unit: inv.unit,
          systemStock,
          countedStock,
          difference,
          costDifference
        });
      }

      // Actualizar cabecera con totales
      await client.query(`
        UPDATE pedidos_app_inventory_audits
        SET items_count = $1, total_discrepancy_cost = $2
        WHERE id = $3
      `, [auditedCount, totalDiscrepancyCost, auditId]);

      await client.query('COMMIT');

      res.json({
        status: 'ok',
        audit_id: auditId,
        items_audited: auditedCount,
        total_discrepancy_cost: totalDiscrepancyCost,
        details: results
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error al conciliar auditoría:', error);
      res.status(400).json({ status: 'error', error: error.message });
    } finally {
      client.release();
    }
  });

  // Historial de auditorías
  app.get('/api/pedidos/admin/inventory/audits', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          a.id,
          a.audit_date,
          a.audited_by,
          a.notes,
          a.items_count,
          a.total_discrepancy_cost::numeric(14,2) AS total_discrepancy_cost,
          a.created_at
        FROM pedidos_app_inventory_audits a
        ORDER BY a.audit_date DESC
        LIMIT 50
      `);
      res.json({ status: 'ok', audits: rows });
    } catch (error) {
      console.error('Error al listar auditorías:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Detalle de una auditoría
  app.get('/api/pedidos/admin/inventory/audits/:id', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { rows: auditRows } = await pool.query(
        'SELECT * FROM pedidos_app_inventory_audits WHERE id = $1',
        [id]
      );
      if (!auditRows.length) return res.status(404).json({ status: 'error', error: 'Auditoría no encontrada' });

      const { rows: itemRows } = await pool.query(`
        SELECT 
          ai.*,
          inv.name AS inventory_name,
          inv.unit AS inventory_unit
        FROM pedidos_app_inventory_audit_items ai
        JOIN pedidos_app_inventory inv ON ai.inventory_id = inv.id
        WHERE ai.audit_id = $1
        ORDER BY ABS(ai.difference) DESC
      `, [id]);

      res.json({ status: 'ok', audit: auditRows[0], items: itemRows });
    } catch (error) {
      console.error('Error al obtener detalle de auditoría:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });


  // ==========================================
  // 5. VALORACIÓN TOTAL Y KPIS MACRO
  // ==========================================

  app.get('/api/pedidos/admin/inventory/valuation', authenticateToken, async (req, res) => {
    try {
      // 1. Resumen general
      const { rows: summary } = await pool.query(`
        SELECT 
          COUNT(*)::int AS total_items,
          COALESCE(SUM(CASE WHEN stock > 0 THEN stock * COALESCE(average_cost, unit_cost, 0) ELSE 0 END), 0)::numeric(14,2) AS total_valuation,
          COUNT(CASE WHEN stock <= min_stock AND track_stock = true THEN 1 END)::int AS low_stock_count,
          COUNT(CASE WHEN stock <= 0 AND track_stock = true THEN 1 END)::int AS out_of_stock_count,
          COUNT(CASE WHEN is_prepared = true THEN 1 END)::int AS prepared_items_count
        FROM pedidos_app_inventory
      `);

      // 2. Mermas y desperdicios del mes actual
      const { rows: wasteMonth } = await pool.query(`
        SELECT 
          COALESCE(SUM(ABS(quantity)), 0)::numeric(14,2) AS total_waste_units,
          COALESCE(SUM(ABS(COALESCE(total_cost, quantity * unit_cost))), 0)::numeric(14,2) AS total_waste_cost
        FROM pedidos_app_product_stock_movements
        WHERE movement_type IN ('MERMA', 'VENCIDO', 'DAÑO', 'PERDIDA', 'FALTANTE_AUDITORIA')
          AND created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
      `);

      // 3. Desglose por categoría
      const { rows: byCategory } = await pool.query(`
        SELECT 
          COALESCE(category, 'General') AS category,
          COUNT(*)::int AS items_count,
          COALESCE(SUM(CASE WHEN stock > 0 THEN stock * COALESCE(average_cost, unit_cost, 0) ELSE 0 END), 0)::numeric(14,2) AS valuation
        FROM pedidos_app_inventory
        GROUP BY category
        ORDER BY valuation DESC
      `);

      // 4. Top 10 insumos de mayor valor almacenado en bodega
      const { rows: topValued } = await pool.query(`
        SELECT 
          id,
          name,
          unit,
          stock,
          COALESCE(average_cost, unit_cost, 0)::numeric(14,2) AS unit_cost,
          (stock * COALESCE(average_cost, unit_cost, 0))::numeric(14,2) AS total_value
        FROM pedidos_app_inventory
        WHERE stock > 0
        ORDER BY total_value DESC
        LIMIT 10
      `);

      res.json({
        status: 'ok',
        summary: summary[0],
        waste_this_month: wasteMonth[0],
        by_category: byCategory,
        top_valued: topValued
      });
    } catch (error) {
      console.error('Error al calcular valoración de inventario:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });


  // ==========================================
  // 6. SUGERENCIAS DE COMPRA Y WHATSAPP GENERATOR
  // ==========================================

  app.get('/api/pedidos/admin/inventory/purchase-suggestions', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          inv.id,
          inv.name,
          inv.unit,
          inv.stock,
          inv.min_stock,
          inv.purchase_unit,
          COALESCE(inv.conversion_factor, 1)::numeric(12,4) AS conversion_factor,
          COALESCE(inv.average_cost, inv.unit_cost, 0)::numeric(14,2) AS unit_cost,
          (
            SELECT s.name 
            FROM pedidos_app_inventory_purchases pur
            LEFT JOIN pedidos_app_suppliers s ON pur.supplier_id = s.id
            WHERE pur.inventory_id = inv.id
            ORDER BY pur.purchase_date DESC
            LIMIT 1
          ) AS last_supplier,
          (
            SELECT s.phone 
            FROM pedidos_app_inventory_purchases pur
            LEFT JOIN pedidos_app_suppliers s ON pur.supplier_id = s.id
            WHERE pur.inventory_id = inv.id
            ORDER BY pur.purchase_date DESC
            LIMIT 1
          ) AS supplier_phone
        FROM pedidos_app_inventory inv
        WHERE inv.track_stock = true 
          AND inv.stock <= inv.min_stock
          AND COALESCE(inv.is_prepared, false) = false
        ORDER BY (inv.min_stock - inv.stock) DESC
      `);

      // Calcular cantidad sugerida para alcanzar el doble del mínimo de seguridad
      const suggestions = rows.map((item) => {
        const stock = Number(item.stock) || 0;
        const minStock = Number(item.min_stock) || 0;
        const targetStock = minStock * 2;
        const deficitBase = Math.max(0, targetStock - stock);
        const factor = Number(item.conversion_factor) || 1;
        const suggestedPurchaseUnits = factor > 0 ? Math.ceil(deficitBase / factor) : Math.ceil(deficitBase);
        const estimatedCost = deficitBase * Number(item.unit_cost);

        return {
          ...item,
          deficit_base: deficitBase,
          suggested_purchase_units: suggestedPurchaseUnits,
          purchase_unit_display: item.purchase_unit || item.unit,
          estimated_cost: estimatedCost
        };
      });

      res.json({ status: 'ok', suggestions });
    } catch (error) {
      console.error('Error al generar sugerencias de compras:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

};
