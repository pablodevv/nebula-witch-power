const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000; // Mudei para 10000, pois seu log indica que está rodando nessa porta

// URL base do seu site de destino (Next.js)
const TARGET_URL = 'https://appnebula.co';

// Opções de proxy base para reuso
const baseProxyOptions = {
  target: TARGET_URL,
  changeOrigin: true, // Necessário para que o host de destino seja appnebula.co
  secure: true, // Use HTTPS
  ws: true, // Habilita suporte a WebSockets, se necessário
  selfHandleResponse: true, // Permite manipular a resposta para reescrever URLs
  // debug: true, // Descomente para logs detalhados do http-proxy-middleware

  onProxyReq: (proxyReq, req, res) => {
    // Adiciona o header 'Accept-Encoding' para garantir que as respostas sejam descompactadas pelo proxy
    // Isso é crucial para que possamos manipular o conteúdo como texto.
    proxyReq.setHeader('Accept-Encoding', 'identity');
    console.log(`Requisição recebida: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
  },

  onProxyRes: (proxyRes, req, res) => {
    // Primeiro, copie todos os cabeçalhos da resposta original para a resposta do cliente
    Object.keys(proxyRes.headers).forEach(key => {
      const headerValue = proxyRes.headers[key];
      // Exclua Content-Encoding se o corpo for modificado, para evitar problemas de descompressão do navegador
      if (key.toLowerCase() === 'content-encoding' && proxyRes.statusCode !== 301 && proxyRes.statusCode !== 302) {
          // Não copiaremos o Content-Encoding se estivermos alterando o conteúdo
          // e se não for um redirecionamento (que não tem corpo para manipular)
          return;
      }
      res.setHeader(key, headerValue);
    });

    const originalEnd = res.end;
    const chunks = [];

    proxyRes.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proxyRes.on('end', () => {
      const buffer = Buffer.concat(chunks);
      let data = buffer.toString('utf8');

      const contentType = proxyRes.headers['content-type'];

      // Apenas tente reescrever se for HTML, CSS ou JavaScript
      if (contentType && (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('application/javascript'))) {
        // Remove a URL do TARGET_URL do corpo da resposta, tornando os links relativos.
        // Isso é geralmente a maneira mais segura para Next.js quando o proxy está no root.
        data = data.replace(new RegExp(TARGET_URL.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '');

        // Trate caminhos absolutos do Next.js que podem ser "/_next/..." se o Next.js os gerar assim
        // Esta parte pode ser sensível. Se o Next.js já gera paths relativos, pode não ser necessário.
        // O proxy já está configurado para lidar com '/_next/static/', então os paths devem funcionar.
        // No entanto, se houver links *dentro* do HTML para "/pt/witch-power/...", eles precisarão ser mantidos.
        // A regra de proxy para /pt/witch-power/ já deveria reescrever isso.
      }
      
      // Defina o Content-Length com base na string final que será enviada
      res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
      
      // Finaliza a resposta com os dados modificados
      originalEnd.call(res, data);
    });
  },

  onError: (err, req, res) => {
    console.error(`Erro no proxy para ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Something went wrong. Please check proxy logs for details.');
    }
  },
};

// Crie a instância do proxy para a regra padrão (que é modificada para assets e funil)
const apiProxy = createProxyMiddleware(baseProxyOptions);

// **Ordem das regras é CRUCIAL**

// 1. Regra para todas as requisições que começam com /_next/static/
// Esta regra deve vir antes das outras para garantir que os assets do Next.js sejam proxyficados corretamente.
// Para esses assets, não precisamos de manipulação complexa do path, apenas proxy direto.
app.use('/_next/static/', apiProxy);

// 2. Regra para /pt/witch-power/ e suas sub-rotas
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
        console.log(`Requisição de funil recebida: ${req.url} -> Proxy para: ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
    },
    onProxyRes: (proxyRes, req, res) => {
        // Copia todos os cabeçalhos da resposta original
        Object.keys(proxyRes.headers).forEach(key => {
            const headerValue = proxyRes.headers[key];
            if (key.toLowerCase() === 'content-encoding' && proxyRes.statusCode !== 301 && proxyRes.statusCode !== 302) {
                return;
            }
            res.setHeader(key, headerValue);
        });

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
                // Remove a URL do TARGET_URL do corpo da resposta
                data = data.replace(new RegExp(TARGET_URL.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '');
                
                // IMPORTANT: Aqui, se a página do Next.js tem links internos como "/alguma-outra-pagina",
                // e eles devem ser acessíveis via proxy em "/pt/witch-power/alguma-outra-pagina",
                // você precisaria reescrever esses links relativos.
                // Mas para assets, a primeira regra do proxy já lida.
            }

            res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
            originalEnd.call(res, data);
        });
    },
    onError: (err, req, res) => {
        console.error(`Erro no proxy do funil para ${req.url}: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Something went wrong with the funnle proxy. Please check logs.');
        }
    },
}));


// 3. Regra catch-all para a rota raiz (/) e outras rotas que não são específicas de funil
app.use('/', apiProxy);


app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
