const { createPool } = require('../src/db');

const pool = createPool();
pool.query('SELECT title, status FROM pedidos_app_products LIMIT 5')
  .then((result) => console.log(result.rows))
  .finally(() => pool.end());
