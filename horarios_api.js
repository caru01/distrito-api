module.exports = function(app, pool, authenticateToken) {
  const DEFAULT_TIMEZONE = 'America/Bogota';
  const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  const zonedParts = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      weekday: 'short',
    }).formatToParts(date).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
    const utcDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      dayName: DAYS[utcDate.getUTCDay()],
      minutes: hour * 60 + Number(parts.minute),
      time: `${String(hour).padStart(2, '0')}:${parts.minute}`,
      utcDate,
    };
  };

  const parseTime = (value) => {
    const [hours, minutes] = String(value || '00:00').split(':').map(Number);
    return hours * 60 + minutes;
  };

  const dateKey = (date) => date.toISOString().slice(0, 10);

  const scheduleForDate = async (date, dayName) => {
    const exception = await pool.query(
      'SELECT * FROM pedidos_app_horarios_exceptions WHERE exception_date = $1',
      [date]
    );
    if (exception.rows.length) {
      const row = exception.rows[0];
      return row.is_closed ? null : { ...row, is_active: true, is_exception: true };
    }
    const weekly = await pool.query(
      'SELECT * FROM pedidos_app_horarios WHERE day_of_week = $1',
      [dayName]
    );
    return weekly.rows[0] || null;
  };

  const getHorariosStatus = async () => {
    try {
      const configRes = await pool.query('SELECT * FROM pedidos_app_horarios_config LIMIT 1');
      const config = configRes.rows[0] || { pre_open_minutes: 0, auto_close_minutes: 0, prep_time_minutes: 30, timezone: DEFAULT_TIMEZONE };
      const timezone = config.timezone || DEFAULT_TIMEZONE;
      const now = new Date();
      const local = zonedParts(now, timezone);
      const previousUtcDate = new Date(local.utcDate);
      previousUtcDate.setUTCDate(previousUtcDate.getUTCDate() - 1);
      const previousDate = dateKey(previousUtcDate);
      const previousDayName = DAYS[previousUtcDate.getUTCDay()];
      const [todaySchedule, previousSchedule] = await Promise.all([
        scheduleForDate(local.date, local.dayName),
        scheduleForDate(previousDate, previousDayName),
      ]);

      const preOpen = Math.max(0, Number(config.pre_open_minutes) || 0);
      const autoClose = Math.max(0, Number(config.auto_close_minutes) || 0);
      const candidates = [
        { schedule: todaySchedule, offset: 0, scheduleDate: local.date },
        { schedule: previousSchedule, offset: -1440, scheduleDate: previousDate },
      ];
      let activeSchedule = null;
      for (const candidate of candidates) {
        const schedule = candidate.schedule;
        if (!schedule?.is_active || !schedule.open_time || !schedule.close_time) continue;
        const open = parseTime(schedule.open_time) + candidate.offset;
        let close = parseTime(schedule.close_time) + candidate.offset;
        if (close <= open) close += 1440;
        const startTakingOrders = open - preOpen;
        const stopTakingOrders = close - autoClose;
        if (local.minutes >= startTakingOrders && local.minutes < stopTakingOrders) {
          activeSchedule = { ...schedule, schedule_date: candidate.scheduleDate };
          break;
        }
      }

      return {
        status: 'ok',
        isOpen: Boolean(activeSchedule),
        statusText: activeSchedule ? 'Abierto y recibiendo pedidos' : 'Cerrado (fuera del horario de pedidos)',
        currentSchedule: activeSchedule || todaySchedule,
        config: { ...config, timezone },
        localNow: `${local.date}T${local.time}:00`,
        timezone,
      };
    } catch(err) {
      console.error('Error in getHorariosStatus:', err);
      return { status: 'error', isOpen: false, statusText: 'Horario no disponible', currentSchedule: null, config: { timezone: DEFAULT_TIMEZONE }, timezone: DEFAULT_TIMEZONE };
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
    const client = await pool.connect();
    try {
      const { horarios } = req.body;
      if (!Array.isArray(horarios)) return res.status(400).json({ error: 'Horarios inválidos' });
      await client.query('BEGIN');
      for (const h of horarios) {
        await client.query(
          'UPDATE pedidos_app_horarios SET is_active=$1, open_time=$2, close_time=$3 WHERE day_of_week=$4',
          [h.is_active, h.open_time, h.close_time, h.day_of_week]
        );
      }
      await client.query('COMMIT');
      res.json({ status: 'ok' });
    } catch(err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/pedidos/admin/horarios/config', authenticateToken, async (req, res) => {
    try {
      const { pre_open_minutes, auto_close_minutes, prep_time_minutes } = req.body;
      const values = [pre_open_minutes, auto_close_minutes, prep_time_minutes].map(Number);
      if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 360)) {
        return res.status(400).json({ error: 'Los minutos configurados deben estar entre 0 y 360' });
      }
      await pool.query(
        'UPDATE pedidos_app_horarios_config SET pre_open_minutes=$1, auto_close_minutes=$2, prep_time_minutes=$3, timezone=$4',
        [pre_open_minutes, auto_close_minutes, prep_time_minutes, DEFAULT_TIMEZONE]
      );
      res.json({ status: 'ok' });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pedidos/admin/horarios/exceptions', authenticateToken, async (req, res) => {
    try {
      const { exception_date, description, is_closed, open_time, close_time } = req.body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(exception_date || ''))) return res.status(400).json({ error: 'Fecha inválida' });
      if (!is_closed && (!open_time || !close_time)) return res.status(400).json({ error: 'La excepción abierta requiere hora de apertura y cierre' });
      const { rows } = await pool.query(
        `INSERT INTO pedidos_app_horarios_exceptions (exception_date, description, is_closed, open_time, close_time)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (exception_date) DO UPDATE SET description=EXCLUDED.description,
           is_closed=EXCLUDED.is_closed, open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time
         RETURNING *`,
        [exception_date, description, is_closed, open_time, close_time]
      );
      res.json({ status: 'ok', exception: rows[0] });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/pedidos/admin/horarios/exceptions/:id', authenticateToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM pedidos_app_horarios_exceptions WHERE id = $1', [req.params.id]);
      res.json({ status: 'ok' });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { getHorariosStatus };
};
