// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Mapeamento de domínios originais para URLs base que nosso proxy vai lidar
// Isso é crucial para proxyficar subdomínios como 'reading.nebulahoroscope.com'
const PROXY_TARGETS = {
    // Principal site
    '/pt/witch-power': 'https://appnebula.co',
    // API de reconhecimento de mão
    '/api/v1/palmistry': 'https://reading.nebulahoroscope.com',
    // Outros serviços que você listou e que podem precisar de proxy
    // Importante: estes caminhos proxyPathPrefix devem ser únicos e não devem conflitar com rotas do site principal.
    // Adaptei alguns prefixos para garantir isso.
    '/clarity-collect': 'https://q.clarity.ms', // Renomeado para evitar conflitos com '/collect'
    '/web-analytics-proxy': 'https://web-analytics-proxy.obrio.net',
    '/sentry-envelope': 'https://sentry.obrio.net', // Renomeado
    '/zendesk-events': 'https://osupporto-help.zendesk.com', // Renomeado
    '/tempo-traces': 'https://prod-tempo-web.nebulahoroscope.com', // Renomeado
    '/asknebula-logs': 'https://logs.asknebula.com', // Renomeado
    '/growthbook-sdk': 'https://growthbook.nebulahoroscope.com', // Renomeado
    // Este `cdn-cgi` parece ser do Cloudflare do Render. Pode ou não precisar de proxy.
    // Se der erro, adicione um mapeamento aqui. Por enquanto, pode ser ignorado ou testado sem.
    // '/cdn-cgi/rum': 'https://onebulaapp-witch-power.onrender.com', 
};

// Configurações para Modificação de Conteúdo
const USD_TO_BRL_RATE = 5.00;
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

// Middleware para parsear o corpo das requisições
// **CRÍTICO para multipart/form-data e outros tipos de upload:**
// Não usaremos `express.json()` ou `express.urlencoded()` diretamente para *todas* as requisições
// para não interferir com `multipart/form-data`.
// Em vez disso, usaremos um middleware customizado para obter o raw body se necessário.
app.use(async (req, res, next) => {
    // Se o Content-Type for multipart/form-data ou imagem, pegamos o buffer bruto
    const contentType = req.headers['content-type'];
    if (contentType && (contentType.includes('multipart/form-data') || contentType.includes('image/'))) {
        let rawBody = [];
        req.on('data', chunk => {
            rawBody.push(chunk);
        });
        req.on('end', () => {
            req.rawBody = Buffer.concat(rawBody);
            next();
        });
    } else {
        // Para outros Content-Types (JSON, URL-encoded), usamos os parsers do Express
        // Ou simplesmente passamos o controle para o próximo middleware se não for POST/PUT.
        // Se for JSON, o 'express.json()' vai parsear.
        // Se for URL-encoded, 'express.urlencoded()' vai parsear.
        express.json({ limit: '50mb' })(req, res, () => {
            express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
        });
    }
});


// --- Middleware Principal do Proxy Reverso ---
app.use(async (req, res) => {
    let targetBaseUrl = '';
    let requestPath = req.url;

    // Tenta encontrar qual TARGET_BASE_URL corresponde ao req.url
    for (const [proxyPathPrefix, targetUrl] of Object.entries(PROXY_TARGETS)) {
        if (req.url.startsWith(proxyPathPrefix)) {
            targetBaseUrl = targetUrl;
            // Ajusta o requestPath para ser relativo ao targetBaseUrl, removendo o prefixo do proxy
            requestPath = req.url.substring(proxyPathPrefix.length);
            break;
        }
    }

    if (!targetBaseUrl) {
        // Se a URL não corresponder a nenhum dos PROXY_TARGETS, assume o appnebula.co principal
        targetBaseUrl = 'https://appnebula.co';
    }

    const targetUrl = `${targetBaseUrl}${requestPath}`;
    console.log(`Requisição recebida: ${req.url} -> Proxy para: ${targetUrl}`);

    try {
        const axiosConfig = {
            method: req.method,
            url: targetUrl,
            headers: {
                'User-Agent': req.headers['user-agent'],
                // Passa o Content-Type original, CRÍTICO para multipart/form-data
                'Content-Type': req.headers['content-type'] || undefined,
                'Accept-Encoding': 'identity', // Evita compressão que dificulta a manipulação
                'Accept': req.headers['accept'],
                'Cookie': req.headers['cookie'] || '',
                // CRÍTICO: Reescreve o cabeçalho 'Origin' e 'Referer' para o domínio de destino
                // Isso pode enganar as verificações de CORS e Referer do servidor original.
                'Origin': targetBaseUrl,
                'Referer': targetUrl,
                // Remova 'Host' para evitar problemas com Axios reescrevendo-o
                // delete req.headers['host']; // Isso não é necessário se você está usando axios
            },
            // Se tivermos o rawBody (para uploads), usamos ele. Senão, usamos req.body (para JSON/URL-encoded)
            data: req.rawBody || req.body,
            responseType: 'arraybuffer',
            maxRedirects: 0,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            },
        };

        const response = await axios(axiosConfig);

        // --- Lógica de Interceptação de Redirecionamento (Status 3xx) ---
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                const fullRedirectUrl = new URL(redirectLocation, targetBaseUrl).href;

                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                const proxiedRedirectPath = fullRedirectUrl.replace(targetBaseUrl, '');
                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // --- Repassa Cabeçalhos da Resposta do Destino para o Cliente ---
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // Lida com o cabeçalho 'Set-Cookie': reescreve o domínio do cookie para o seu domínio
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                // Remove o atributo 'Domain' para que o navegador defina o domínio atual (o seu)
                // E ajusta o 'Path' para o caminho base do seu proxy, se aplicável
                return cookie.replace(/Domain=[^;]+/, '').replace(/; Path=\//, `; Path=${req.baseUrl || '/'}`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

            // Reescrever URLs relativas e absolutas que apontam para os TARGET_BASE_URLs
            $('[href], [src], [action]').each((i, el) => {
                const element = $(el);
                let attrName = '';
                if (element.is('link') || element.is('a') || element.is('area')) {
                    attrName = 'href';
                } else if (element.is('script') || element.is('img') || element.is('source') || element.is('iframe')) {
                    attrName = 'src';
                } else if (element.is('form')) {
                    attrName = 'action';
                }

                if (attrName) {
                    let originalUrl = element.attr(attrName);
                    if (originalUrl) {
                        let replaced = false;
                        for (const [proxyPathPrefix, targetUrl] of Object.entries(PROXY_TARGETS)) {
                             // Se a URL original começa com o URL completo do destino, a reescrevemos
                             if (originalUrl.startsWith(targetUrl)) {
                                 // Ex: https://reading.nebulahoroscope.com/api/v1/palmistry/detect -> /api/v1/palmistry/detect
                                 element.attr(attrName, proxyPathPrefix + originalUrl.substring(targetUrl.length));
                                 replaced = true;
                                 break;
                             }
                        }
                        // Se não foi substituída e é uma URL relativa que começa com '/', garantir que funcione do root
                        if (!replaced && originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                            // Já está ok, pois nosso proxy está no root '/' do seu domínio.
                            // Não precisa de prefixo adicional como `/meu-proxy${originalUrl}`.
                        }
                    }
                }
            });

            // Redirecionamento Frontend para /email (fallback)
            if (req.url.includes('/pt/witch-power/email')) {
                console.log('Detectada slug /email no frontend. Injetando script de redirecionamento.');
                $('head').append(`
                    <script>
                        window.location.replace('/pt/witch-power/onboarding');
                    </script>
                `);
            }

            // Modificações específicas para /trialChoice
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (preços e textos).');
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(CONVERSION_PATTERN, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                        return `R$ ${brlValue}`;
                    });
                });
                $('h2:contains("Trial Choice")').text('Escolha sua Prova Gratuita (Modificado)');
                $('p:contains("Selecione sua opção de teste")').text('Agora com preços adaptados para o Brasil!');
            }

            // Modificações específicas para /trialPaymentancestral
            if (req.url.includes('/pt/witch-power/trialPaymentancestral')) {
                console.log('Modificando conteúdo para /trialPaymentancestral (preços e links de botões).');
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(CONVERSION_PATTERN, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                        return `R$ ${brlValue}`;
                    });
                });
                $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');
                $('h1:contains("Trial Payment Ancestral")').text('Pagamento da Prova Ancestral (Preços e Links Atualizados)');
            }

            res.send($.html());
        } else {
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('Erro no proxy para', req.url, ':', error.message);
        if (error.response) {
            console.error('Status:', error.response.status, 'Headers:', error.response.headers, 'Data:', error.response.data ? error.response.data.toString('utf8').substring(0, 500) : '');
            res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'} (Status: ${error.response.status})`);
        } else {
            res.status(500).send('Erro interno do servidor proxy ou de conexão com o destino.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
