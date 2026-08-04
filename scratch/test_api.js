require('dotenv').config();
const jwt = require('jsonwebtoken');

const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET || 'distrito_bg_secreto_super_seguro_2024', { expiresIn: '1h' });

fetch('http://localhost:3001/api/pedidos/admin/orders', {
  headers: { 'Authorization': `Bearer ${token}` }
}).then(res => res.json()).then(data => console.log(data)).catch(console.error);
