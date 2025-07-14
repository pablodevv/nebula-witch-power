const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000; // Garantindo que a porta esteja correta para o Render

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const API_TARGET_URL = 'https://reading.nebulahoroscope.com'; // Novo destino para a API

// --- Regras de Proxy ---

// 1. **Regra para API do Subdomínio:**
// Se o seu frontend proxyficado tenta acessar /api/v1/palmistry/detect
// e você quer que isso seja proxyficado para reading.nebulahoroscope.com
// Esta é a regra mais específica e deve vir primeiro.
app.use('/api/', createProxyMiddleware({
  target: API_TARGET_URL,
  changeOrigin: true, // Necessário para mudar o cabeçalho Host para o domínio da API
  secure: true,       // Permite conexões HTTPS
  ws: true,           // Habilita proxy para WebSockets
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
// Esta regra DEVE vir antes das outras para interceptar os assets de qualquer página.
// Ela simplesmente repassa a requisição para o MAIN_TARGET_URL, mantendo o caminho completo.
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

// 3. Regra para as rotas que começam com `/pt/witch-power/` (seu funil)
// Esta é a lógica de proxy que reescreve a URL.
app.use('/pt/witch-power/', createProxyMiddleware({
  target: MAIN_TARGET_URL,
  changeOrigin: true,
  secure: true,
  ws: true,
  pathRewrite: {
    '^/pt/witch-power': '', // Remove "/pt/witch-power" do início do caminho
  },
  onProxyReq: (proxyReq, req, res) => {
    // Se o caminho reescrito for vazio, use '/' para a raiz
    if (proxyReq.path === '') {
      proxyReq.path = '/';
    }
    console.log(`[FUNIL] Requisição: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
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
// Esta regra vai pegar tudo que não foi pego pelas regras acima,
// enviando diretamente para o MAIN_TARGET_URL (appnebula.co).
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
