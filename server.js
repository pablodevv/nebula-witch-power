const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000; // Garantindo que a porta esteja correta para o Render

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const API_TARGET_URL = 'https://reading.nebulahoroscope.com'; // Destino para a API de leitura de mão

// --- Regras de Proxy ---

// 1. **Regra para API do Subdomínio:**
// Esta regra intercepta requisições que começam com `/api/` no seu proxy
// e as encaminha para 'https://reading.nebulahoroscope.com'.
// Mantenha esta regra como a primeira e mais específica.
app.use('/api/', createProxyMiddleware({
  target: API_TARGET_URL,
  changeOrigin: true, // Muda o cabeçalho 'Host' da requisição para o do target
  secure: true,       // Permite conexões HTTPS
  ws: true,           // Habilita proxy para WebSockets (se a API usar)
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[API PROXY] Requisição: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error(`[API PROXY ERROR] Erro no proxy da API para ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro ao proxyficar a requisição da API.');
    }
  },
}));

// 2. **ESSENCIAL**: Regra para TODOS os arquivos estáticos do Next.js (`/_next/static/...`)
// Esta regra DEVE vir antes das outras para interceptar os assets (JS, CSS, imagens)
// e repassá-los para o MAIN_TARGET_URL, mantendo o caminho completo.
app.use('/_next/static/', createProxyMiddleware({
  target: MAIN_TARGET_URL,
  changeOrigin: true,
  secure: true,
  ws: true,
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[ASSET] Requisição: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error(`[ASSET ERROR] Erro no proxy para ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro ao carregar asset.');
    }
  },
}));

// 3. **Regra para as rotas do funil (`/pt/witch-power/`) - SEM REESCRITA DE CAMINHO**
// Esta é a mudança chave. Agora, a URL será encaminhada como está.
// Ou seja, https://onebulaapp-witch-power.onrender.com/pt/witch-power/prelanding
// será proxyficada para https://appnebula.co/pt/witch-power/prelanding
app.use('/pt/witch-power/', createProxyMiddleware({
  target: MAIN_TARGET_URL,
  changeOrigin: true,
  secure: true,
  ws: true,
  // REMOVIDO: pathRewrite: { '^/pt/witch-power': '' },
  onProxyReq: (proxyReq, req, res) => {
    // Não há reescrita de caminho aqui. O proxyReq.path já virá com /pt/witch-power/prelanding
    console.log(`[FUNIL - SEM REESCRITA] Requisição: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error(`[FUNIL ERROR] Erro no proxy do funil para ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro ao carregar página do funil.');
    }
  },
}));

// 4. Regra genérica para todas as outras requisições (ex: "/")
// Captura tudo o que não foi pego pelas regras acima e envia para MAIN_TARGET_URL.
app.use('/', createProxyMiddleware({
  target: MAIN_TARGET_URL,
  changeOrigin: true,
  secure: true,
  ws: true,
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[GERAL] Requisição: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error(`[GERAL ERROR] Erro no proxy geral para ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Erro geral no proxy.');
    }
  },
}));

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
