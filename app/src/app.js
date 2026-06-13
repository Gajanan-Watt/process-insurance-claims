const express = require('express');
const app = express();

app.use(express.json());

app.use('/members', require('./api/routes/members'));
app.use('/policies', require('./api/routes/policies'));
app.use('/claims', require('./api/routes/claims'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(require('./api/middleware/error-handler'));

module.exports = app;
