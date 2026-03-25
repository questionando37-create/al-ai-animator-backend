// Mock mode: simula geração de vídeo sem chamar a API da Runway
// Útil para desenvolvimento, testes de frontend e integração com pagamento

async function generateVideoVariations(imageUrl, prompt, aspectRatio = '1:1') {
  console.log(`[MOCK] Simulando geração para: "${prompt}" | Imagem: ${imageUrl}`);

  // Simula tempo de processamento realista
  await new Promise(resolve => setTimeout(resolve, 800));

  // Gera 3 variações fictícias
  const variations = [];
  for (let i = 1; i <= 3; i++) {
    const seed = Math.floor(Math.random() * 1000000);
    variations.push({
      id: `mock_gen_${Date.now()}_${i}`,
      seed,
      status: 'completed',
      videoUrl: `https://example.com/mock/video-${i}.mp4`, // URL fictícia
      thumbnailUrl: `https://example.com/mock/thumb-${i}.jpg`
    });
  }

  return variations;
}

module.exports = { generateVideoVariations };