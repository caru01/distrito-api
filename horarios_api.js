module.exports = function(app, pool, authenticateToken) {
  const getHorariosStatus = async () => {
    try {
      const configRes = await pool.query('SELECT * FROM pedidos_app_horarios_config LIMIT 1');
      const config = configRes.rows[0] || { pre_open_minutes: 0, auto_close_minutes: 0, prep_time_minutes: 30, timezone: 'America/Bogota' };
      
      const now = new Date();
      // Obtener hora local en la zona configurada
      const localString = now.toLocaleString('en-US', { timeZone: config.timezone, hour12: false });
      const localDateObj = new Date(localString);
      
      const yyyy = localDateObj.getFullYear();
      const mm = String(localDateObj.getMonth() + 1).padStart(2, '0');
      const dd = String(localDateObj.getDate()).padStart(2, '0');
      const todayDate = `${yyyy}-${mm}-${dd}`;
      
      const hh = String(localDateObj.getHours()).padStart(2, '0');
      const mins = String(localDateObj.getMinutes()).padStart(2, '0');
      const currentTime = `${hh}:${mins}`;
      const currentMinutes = localDateObj.getHours() * 60 + localDateObj.getMinutes();
      
      const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const todayDayName = days[localDateObj.getDay()];

      let schedule = null;
      let isException = false;
      let isClosedFullDay = false;

      // 1. Check Exceptions
      const excRes = await pool.query('SELECT * FROM pedidos_app_horarios_exceptions WHERE exception_date = ', [todayDate]);
      if (excRes.rows.length > 0) {
        const exc = excRes.rows[0];
        isException = true;
        if (exc.is_closed) {
          isClosedFullDay = true;
        } else {
          schedule = { open_time: exc.open_time, close_time: exc.close_time, is_active: true };
        }
      }

      // 2. Check regular schedule if no exception
      if (!isException) {
        const weekRes = await pool.query('SELECT * FROM pedidos_app_horarios WHERE day_of_week = ', [todayDayName]);
        if (weekRes.rows.length > 0) {
          schedule = weekRes.rows[0];
        }
      }

      if (!schedule || !schedule.is_active || isClosedFullDay) {
        return { isOpen: false, statusText: 'Cerrado', currentSchedule: null, config };
      }

      const parseTime = (t) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      };

      const openMin = parseTime(schedule.open_time);
      const closeMin = parseTime(schedule.close_time);
      const startTakingOrders = openMin - (config.pre_open_minutes || 0);
      const stopTakingOrders = closeMin - (config.auto_close_minutes || 0);

      if (currentMinutes >= startTakingOrders && currentMinutes < stopTakingOrders) {
        return { isOpen: true, statusText: 'Abierto', currentSchedule: schedule, config };
      } else {
        return { isOpen: false, statusText: 'Cerrado (Fuera de horario)', currentSchedule: schedule, config };
      }
    } catch(err) {
      console.error('Error in getHorariosStatus:', err);
      return { isOpen: true, statusText: 'Error fallback', currentSchedule: null, config: {} };
    }
  };

  app.get('/api/pedidos/horarios/status', async (req, res) => {
    const status = await getHorariosStatus();
    res.json(status);
  });

  app.get('/api/pedidos/admin/horarios', authenticateToken, async (req, res) => {
    try {
      const weekRes = await pool.query('SELECT * FROM pedidos_app_horarios ORDER BY id ASC');
      const configRes = await pool.query('SELECT * FROM pedidos_app_horarios_config LIMIT 1');
      const excRes = await pool.query('SELECT * FROM pedidos_app_horarios_exceptions ORDER BY exception_date ASC');
      const status = await getHorariosStatus();
      
      res.json({
        status: 'ok',
        horarios: weekRes.rows,
        config: configRes.rows[0],
        exceptions: excRes.rows,
        currentStatus: status
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/pedidos/admin/horarios', authenticateToken, async (req, res) => {
    try {
      const { horarios } = req.body;
      for (const h of horarios) {
        await pool.query(
          'UPDATE pedidos_app_horarios SET is_active = , open_time = , close_time =  WHERE day_of_week = ',
          [h.is_active, h.open_time, h.close_time, h.day_of_week]
        );
      }
      res.json({ status: 'ok' });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/pedidos/admin/horarios/config', authenticateToken, async (req, res) => {
    try {
      const { pre_open_minutes, auto_close_minutes, prep_time_minutes, timezone } = req.body;
      await pool.query(
        'UPDATE pedidos_app_horarios_config SET pre_open_minutes=, auto_close_minutes=, prep_time_minutes=, timezone=',
        [pre_open_minutes, auto_close_minutes, prep_time_minutes, timezone]
      );
      res.json({ status: 'ok' });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pedidos/admin/horarios/exceptions', authenticateToken, async (req, res) => {
    try {
      const { exception_date, description, is_closed, open_time, close_time } = req.body;
      const { rows } = await pool.query(
        'INSERT INTO pedidos_app_horarios_exceptions (exception_date, description, is_closed, open_time, close_time) VALUES (, , , , ) RETURNING *',
        [exception_date, description, is_closed, open_time, close_time]
      );
      res.json({ status: 'ok', exception: rows[0] });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/pedidos/admin/horarios/exceptions/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM pedidos_app_horarios_exceptions WHERE id = ', [req.params.id]);
      res.json({ status: 'ok' });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { getHorariosStatus };
};
