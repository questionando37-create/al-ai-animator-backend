const { generateVideoVariations } = require('../services/runway.service');

// Controller para gerar 3 variações de vídeo
async function generate(req, res) {
  try {
    const { imageUrl, prompt, aspectRatio = '1:1' } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'Campo "imageUrl" é obrigatório' });
    }

    if (!prompt) {
      return res.status(400).json({ error: 'Campo "prompt" é obrigatório' });
    }

    console.log(`Iniciando geração: ${prompt} | Aspect ratio: ${aspectRatio}`);

    const variations = await generateVideoVariations(imageUrl, prompt, aspectRatio);

    res.status(200).json({
      success: true,
      message: 'Gerações iniciadas com sucesso',
      variations: variations.map(v => ({ id: v.id, seed: v.seed })),
      estimated_time: '60-120 segundos'
    });

  } catch (error) {
    console.error('Erro no controller:', error.message);
    res.status(500).json({
  success: false,
  error: 'Falha ao iniciar geração',
  details: error.message
});
  }
}

module.exports = { generate };