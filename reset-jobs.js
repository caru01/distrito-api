require('dotenv').config(); 
require('./src/db.js').createPool().query("UPDATE pedidos_app_crm_message_jobs SET status='RETRY', locked_at=NULL, locked_by=NULL WHERE status='PROCESSING'").then(r => console.log('Reset:', r.rowCount)).finally(()=>process.exit(0));
