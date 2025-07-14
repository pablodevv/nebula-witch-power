
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// URL base do seu site de destino (Next.js)
const TARGET_URL = 'https://appnebula.co';

// Configuração do proxy
const proxyOptions = {
  target: TARGET_URL,
  changeOrigin: true, // Necessário para que o host de destino seja appnebula.co
  secure: true, // Use HTTPS
  ws: true, // Habilita suporte a WebSockets, se necessário
  selfHandleResponse: true, // Permite manipular a resposta para reescrever URLs
  // logs: true, // Habilita logs detalhados do proxy para depuração
  
  onProxyReq: (proxyReq, req, res) => {
    // Adiciona o header 'Accept-Encoding' para garantir que as respostas sejam descompactadas pelo proxy
    // Isso evita problemas com reescrita de URLs em conteúdo compactado
    proxyReq.setHeader('Accept-Encoding', 'identity');

    // Logs para depuração
    console.log(`Requisição recebida: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },

  onProxyRes: (proxyRes, req, res) => {
    // Se for uma requisição para a imagem de upload, manipulamos o redirecionamento
    if (req.url.startsWith('/_next/image')) {
      const redirectLocation = proxyRes.headers.location;
      if (redirectLocation && redirectLocation.startsWith('https://appnebula.co/')) {
        const newLocation = redirectLocation.replace('https://appnebula.co', '');
        proxyRes.headers.location = newLocation;
        console.log(`Redirecionamento do destino: ${redirectLocation} -> Reescrevendo para: ${newLocation}`);
      }
    }

    // Capture a resposta para reescrever URLs no HTML ou CSS/JS
    const originalEnd = res.end;
    const chunks = [];

    proxyRes.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proxyRes.on('end', () => {
      const buffer = Buffer.concat(chunks);
      let data = buffer.toString('utf8');

      // Se o content-type for HTML, CSS ou JavaScript, tentamos reescrever as URLs
      const contentType = proxyRes.headers['content-type'];

      if (contentType && (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('application/javascript'))) {
        // Rewrite all occurrences of the target URL to the proxy URL
        data = data.replace(new RegExp(TARGET_URL.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '');
        
        // Trata caminhos absolutos do Next.js que podem ser "/_next/..."
        // Esta parte pode precisar de ajuste fino dependendo de como o Next.js renderiza os paths
        data = data.replace(/\/pt\/witch-power\/\_next\/static/g, '/_next/static');
      }

      res.setHeader('Content-Length', Buffer.byteLength(data));
      originalEnd.call(res, data);
    });
  },

  onError: (err, req, res) => {
    console.error(`Erro no proxy para ${req.url}: ${err.message}`);
    // Se o erro for 404 e a resposta já tiver começado, não tente enviar um novo status.
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Something went wrong. And we are reporting a custom error message.');
    }
  },
};

// Crie a instância do proxy
const apiProxy = createProxyMiddleware(proxyOptions);

// **Importante:** A ordem das rotas importa!

// 1. Regra para todas as requisições que começam com /_next/static/
// Esta regra deve vir antes das outras para garantir que os assets do Next.js sejam proxyficados corretamente.
app.use('/_next/static/', apiProxy);

// 2. Regra para /pt/witch-power/prelanding e outras rotas dentro de /pt/witch-power/
// Esta regra irá reescrever /pt/witch-power/X para /X no servidor de destino.
app.use('/pt/witch-power/', createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    secure: true,
    ws: true,
    selfHandleResponse: true,
    onProxyReq: (proxyReq, req, res) => {
        // Remove o prefixo '/pt/witch-power' da URL antes de enviar para o destino
        let newPath = req.url.replace('/pt/witch-power', '');
        if (newPath === '') newPath = '/'; // Se for '/pt/witch-power' vira '/'
        
        proxyReq.path = newPath;
        proxyReq.setHeader('Accept-Encoding', 'identity'); // Descompactar para manipular
        console.log(`Requisição recebida: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
    },
    onProxyRes: (proxyRes, req, res) => {
        const originalEnd = res.end;
        const chunks = [];

        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
        });

        proxyRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            let data = buffer.toString('utf8');
            const contentType = proxyRes.headers['content-type'];

            if (contentType && (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('application/javascript'))) {
                // Reescreve as URLs absolutas do servidor de origem para o seu proxy
                // ex: "/_next/static" vira "/_next/static"
                // ex: "/pt/witch-power" vira "/pt/witch-power"
                data = data.replace(new RegExp(TARGET_URL.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '');
                
                // Esta é a parte crucial: Se o conteúdo tiver paths como "/_next/static",
                // precisamos garantir que eles sejam prefixados com "/pt/witch-power"
                // para que a primeira regra do proxy os capture corretamente.
                // Isso é um pouco contraintuitivo: o servidor de origem pode não saber do "/pt/witch-power"
                // mas seu proxy sabe e precisa reescrever para si mesmo.
                // O ideal é que o Next.js no servidor de origem já gerasse caminhos completos para os assets.
                // Se ele está gerando apenas /_next/static, então a primeira regra do proxy é suficiente.
                // Mas se ele gera links internos para "/pt/witch-power/outra-pagina",
                // você precisaria de regras mais complexas aqui.
                // Por agora, vou focar em garantir que o HTML e JS chamem o /_next/static corretamente.
                
                // Se a URL original no req.url for /pt/witch-power/prelanding, o proxyReq.path será /prelanding.
                // O HTML retornado do appnebula.co/prelanding pode ter links para /_next/static/...
                // E o proxy precisa interceptar isso no nível mais alto.
                // A ordem das regras já deve ajudar nisso.
            }

            res.setHeader('Content-Length', Buffer.byteLength(data));
            originalEnd.call(res, data);
        });
    },
    onError: (err, req, res) => {
        console.error(`Erro no proxy para ${req.url}: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Something went wrong. And we are reporting a custom error message.');
        }
    },
}));


// 3. Regra para a rota raiz (/) e outras rotas que não são específicas de funil
// Essa regra deve vir por último para não interceptar as regras mais específicas.
app.use('/', apiProxy);


app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
