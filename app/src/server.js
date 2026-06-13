require('dotenv').config();
const app = require('./app');
const { connect } = require('./config/database');

const PORT = process.env.PORT || 3000;

connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
