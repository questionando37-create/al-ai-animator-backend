const express = require('express');
const { generate } = require('../controllers/generation.controller');

const router = express.Router();

// Rota POST para gerar variações de vídeo
router.post('/generate', generate);

module.exports = router;