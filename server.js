// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url'); // Importa o construtor URL
const fileUpload = require('express-fileupload');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 10000;

// --- Configurações de URLs de Destino ---
// Todos os TARGET_MAP devem terminar com uma barra para facilitar a concatenação com new URL().
const TARGET_MAP = {
    '/api': 'https://api.appnebula.co/', // Adicionado barra final
    '/reading': 'https://reading.nebulahoroscope.com/', // Adicionado barra final
    '/logs': 'https://logs.asknebula.com/', // Adicionado barra final
    '/tempo': 'https://prod-tempo-web.nebulahoroscope.com/', // Adicionado barra final
    '/': 'https://appnebula.co/' // Já tinha a barra final, mantido
};

// --- Configurações de Valores e Taxas ---
const USD_TO_BRL_RATE = 5.00;
const FIXED_P_COST_BRL = '68,35';

// --- Middleware para Upload de Arquivos ---
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 },
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true
}));

// --- Middleware Principal do Proxy Reverso ---
app.use(async (req, res) => {
    let targetBaseUrl = TARGET_MAP['/'];
    let requestPath = req.url;
    let proxyPrefixFound = '';

    const sortedPrefixes = Object.keys(TARGET_MAP).sort((a, b) => b.length - a.length);

    for (const prefix of sortedPrefixes) {
        if (req.url.startsWith(prefix)) {
            targetBaseUrl = TARGET_MAP[prefix];
            // CORREÇÃO CRÍTICA AQUI:
            // O requestPath deve ser o que vem DEPOIS do prefixo do proxy,
            // e deve ser tratado para não ter barra inicial se o targetBaseUrl já tiver.
            // O construtor URL() lida bem com isso, então o ideal é que requestPath seja relativo.
            requestPath = req.url.substring(prefix.length);
            if (requestPath.startsWith('/')) { // Se o que sobrou começar com '/', remove.
                requestPath = requestPath.substring(1);
            }
            if (requestPath === '') { // Se o caminho for vazio após remover o prefixo (ex: /logs -> ""),
                                      // tratamos como a raiz do targetBaseUrl.
                requestPath = '/';
            }
            
            proxyPrefixFound = prefix;
            break;
        }
    }

    console.log(`[PROXY ROUTING] Requisição original: ${req.url}`);
    console.log(`[PROXY ROUTING] Prefixo do Proxy Local (Matched): ${proxyPrefixFound === '' ? '/' : proxyPrefixFound}`);
    console.log(`[PROXY ROUTING] Domínio de Destino Real: ${targetBaseUrl}`);
    console.log(`[PROXY ROUTING] Caminho para o Destino Real (processado): ${requestPath}`); // Loga o caminho processado
    console.log(`[PROXY ROUTING] Método HTTP: ${req.method}`);
    console.log(`[PROXY ROUTING] Content-Type da Requisição: ${req.headers['content-type'] || 'N/A'}`);

    // --- Tratamento de Cabeçalhos da Requisição ---
    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding'];
    delete requestHeaders['origin'];

    // --- Tratamento do Corpo da Requisição (Dados) ---
    let requestData = undefined;
    if (req.files && Object.keys(req.files).length > 0) {
        const formData = new FormData();
        for (const key in req.files) {
            const file = req.files[key];
            formData.append(key, file.data, { filename: file.name, contentType: file.mimetype });
        }
        if (req.body && Object.keys(req.body).length > 0) {
            for (const key in req.body) {
                if (typeof req.body[key] === 'object' && req.body[key] !== null) {
                    formData.append(key, JSON.stringify(req.body[key]), { contentType: 'application/json' });
                } else {
                    formData.append(key, req.body[key]);
                }
            }
        }
        requestData = formData;
    } else if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
            try {
                requestData = JSON.parse(req.body.toString('utf8'));
            } catch (e) {
                console.error("Erro ao parsear JSON do corpo da requisição:", e);
                requestData = req.body;
            }
        } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            requestData = req.body;
        }
    } else if (req.body && (Buffer.isBuffer(req.body) && req.body.length > 0 || typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
        requestData = req.body;
    }

    // CORREÇÃO FINAL NA MONTAGEM DA URL:
    // O construtor URL() é a forma mais segura. Ele resolve 'path' contra 'base'.
    // Se 'path' for vazio, ele retorna 'base'. Se 'path' começar com '/', ele é absoluto.
    // Se 'base' termina em '/', e 'path' não começa, ele concatena.
    // Nosso objetivo é que 'requestPath' seja o caminho relativo ao 'targetBaseUrl'.
    const targetUrl = new URL(requestPath, targetBaseUrl).href;

    console.log(`[PROXY REQUEST] Requisição para URL de destino: ${targetUrl}`); // Loga a URL final que será requisitada

    try {
        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: requestData instanceof FormData ? { ...requestHeaders, ...requestData.getHeaders() } : requestHeaders,
            data: requestData,
            responseType: 'arraybuffer',
            maxRedirects: 0,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            },
        });

        // --- Lógica de Interceptação de Redirecionamento (Status 3xx) ---
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    fullRedirectUrl = new URL(redirectLocation, targetBaseUrl).href;
                } catch (e) {
                    console.error("Erro ao parsear URL de redirecionamento:", redirectLocation, e.message);
                    fullRedirectUrl = redirectLocation;
                }

                // Redirecionamento Específico: /pt/witch-power/email -> /pt/witch-power/onboarding
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento do servidor de destino para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                // Reescreve a URL de redirecionamento para apontar para o seu proxy novamente
                let proxiedRedirectPath = fullRedirectUrl;
                let foundMatchForRedirect = false;
                for (const prefix in TARGET_MAP) {
                    const originalTarget = TARGET_MAP[prefix];
                    // Remove a barra final do originalTarget para comparação mais robusta
                    const cleanedOriginalTarget = originalTarget.endsWith('/') ? originalTarget.slice(0, -1) : originalTarget;
                    
                    // Verifica se a URL de redirecionamento começa com o target original (limpo)
                    if (proxiedRedirectPath.startsWith(cleanedOriginalTarget)) {
                        // Substitui o target original (limpo) pelo prefixo do proxy
                        proxiedRedirectPath = proxiedRedirectPath.replace(cleanedOriginalTarget, prefix);
                        foundMatchForRedirect = true;
                        break;
                    }
                }
                
                // Garante que o caminho reescrito comece com '/'
                if (!proxiedRedirectPath.startsWith('/')) {
                    proxiedRedirectPath = '/' + proxiedRedirectPath;
                }
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para o Proxy: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // --- Repassando Cabeçalhos da Resposta do Destino para o Cliente ---
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                return cookie
                    .replace(/Domain=[^;]+/, '')
                    .replace(/; Secure/, '')
                    .replace(/; Path=[^;]+/, `; Path=/`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // --- Lógica de Modificação de Conteúdo (Apenas para HTML) ---
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

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
                        for (const proxyPrefix in TARGET_MAP) {
                            const targetOriginal = TARGET_MAP[proxyPrefix];
                            // CORREÇÃO: Usar a URL original completa aqui, sem limpar a barra final,
                            // porque o `startsWith` funciona melhor assim com a URL real.
                            if (originalUrl.startsWith(targetOriginal)) {
                                if (proxyPrefix === '/') {
                                    element.attr(attrName, originalUrl.replace(targetOriginal, '/')); // Substitui por '/' para a raiz
                                } else {
                                    // Remove o targetOriginal e adiciona o prefixo do proxy
                                    element.attr(attrName, proxyPrefix + originalUrl.substring(targetOriginal.length));
                                }
                                return;
                            }
                        }
                    }
                }
            });

            // --- Injeta Script Cliente-Side para Reescrever URLs de APIs (Fetch, XHR, WebSocket) ---
            // Modificado para usar o targetMap com barras finais nos domínios.
            $('head').prepend(`
                <script>
                    (function() {
                        // O mapa agora tem todas as URLs de destino com barra final
                        const targetMap = ${JSON.stringify(TARGET_MAP)}; 

                        function rewriteUrl(originalUrl) {
                            if (typeof originalUrl !== 'string') return originalUrl;

                            const sortedPrefixes = Object.keys(targetMap).sort((a, b) => b.length - a.length);

                            for (const proxyPrefix of sortedPrefixes) {
                                const targetUrlBase = targetMap[proxyPrefix];
                                if (originalUrl.startsWith(targetUrlBase)) {
                                    let rewrittenUrl = proxyPrefix + originalUrl.substring(targetUrlBase.length);
                                    // Se o prefixo do proxy for '/', garante que o caminho seja '/' se vazio
                                    if (proxyPrefix === '/' && rewrittenUrl === '/') {
                                        // Nada a fazer, já está correto.
                                    } else if (proxyPrefix === '/' && rewrittenUrl.startsWith('//')) {
                                        // Remove barras duplas se o proxyPrefix for '/'
                                        rewrittenUrl = rewrittenUrl.substring(1);
                                    }
                                    
                                    console.log('PROXY SHIM (toProxy):', originalUrl, '->', rewrittenUrl);
                                    return rewrittenUrl;
                                }
                            }
                            return originalUrl;
                        }

                        const originalFetch = window.fetch;
                        window.fetch = function(input, init) {
                            let url = input;
                            if (typeof input === 'string') {
                                url = rewriteUrl(input);
                            } else if (input instanceof Request) {
                                url = new Request(rewriteUrl(input.url), {
                                    method: input.method,
                                    headers: input.headers,
                                    body: input.body,
                                    mode: input.mode,
                                    credentials: input.credentials,
                                    cache: input.cache,
                                    redirect: input.redirect,
                                    referrer: input.referrer,
                                    integrity: input.integrity,
                                    keepalive: input.keepalive
                                });
                            }
                            return originalFetch.call(this, url, init);
                        };

                        const originalXHRopen = XMLHttpRequest.prototype.open;
                        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                            const modifiedUrl = rewriteUrl(url);
                            originalXHRopen.call(this, method, modifiedUrl, async, user, password);
                        };

                        const originalWebSocket = window.WebSocket;
                        window.WebSocket = function(url, protocols) {
                            const modifiedUrl = rewriteUrl(url);
                            console.log('PROXY SHIM: REWRITE WebSocket URL:', url, '->', modifiedUrl);
                            return new originalWebSocket(modifiedUrl, protocols);
                        };
                    })();
                </script>
            `);

            // --- Redirecionamento CLIENT-SIDE Agressivo ---
            $('head').append(`
                <script>
                    console.log('CLIENT-SIDE REDIRECT SCRIPT: Initializing.');
                    let redirectCheckInterval;

                    function handleEmailRedirect() {
                        const currentPath = window.location.pathname;
                        if (currentPath.startsWith('/pt/witch-power/email')) {
                            console.log('CLIENT-SIDE REDIRECT: URL /pt/witch-power/email detectada. Forçando redirecionamento para /pt/witch-power/onboarding');
                            if (redirectCheckInterval) {
                                clearInterval(redirectCheckInterval);
                            }
                            window.location.replace('/pt/witch-power/onboarding');
                        }
                    }

                    document.addEventListener('DOMContentLoaded', handleEmailRedirect);
                    window.addEventListener('popstate', handleEmailRedirect);
                    redirectCheckInterval = setInterval(handleEmailRedirect, 100);
                    window.addEventListener('beforeunload', () => {
                        if (redirectCheckInterval) {
                            clearInterval(redirectCheckInterval);
                        }
                    });
                    handleEmailRedirect();
                </script>
            `);

            // --- MODIFICAÇÕES DE CONTEÚDO ESPECÍFICAS para /pt/witch-power/trialChoice ---
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (texto do custo e botões de preço).');

                let $p = $('p.sc-edafe909-6.pLaXn');
                if ($p.length === 0) {
                    $p = $('p:contains("custo real ser de")');
                }

                const newCostText = `Apesar do nosso custo real ser de R$ ${FIXED_P_COST_BRL}*, por favor selecione um valor que você considere justo.`;
                if ($p.length > 0) {
                    $p.text(newCostText);
                    console.log(`[trialChoice] Texto da tag <p> atualizado: "${newCostText}"`);
                } else {
                    $('body').append(`<p class="sc-edafe909-6 pLaXn">${newCostText}</p>`);
                    console.log(`[trialChoice] Tag <p> injetada no body com texto: "${newCostText}"`);
                }

                $('a, button, input[type="submit"], input[type="button"]').each((i, el) => {
                    const $el = $(el);
                    let originalContent = '';

                    if ($el.is('input')) {
                        originalContent = $el.val();
                    } else {
                        originalContent = $el.text();
                    }

                    if (originalContent && typeof originalContent === 'string') {
                        const priceRegex = /\$(\d+(?:[.,]\d{2})?)/g;
                        if (originalContent.match(priceRegex)) {
                            const newContent = originalContent.replace(priceRegex, (match, p1) => {
                                const usdValueStr = p1.replace(/,/g, '');
                                const usdValue = parseFloat(usdValueStr);

                                if (!isNaN(usdValue)) {
                                    const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                                    return `R$ ${brlValue}`;
                                }
                                return match;
                            });
                            if ($el.is('input')) {
                                $el.val(newContent);
                            } else {
                                $el.text(newContent);
                            }
                            console.log(`[trialChoice] Conteúdo do botão/link (original: "${originalContent}") modificado para: "${newContent}"`);
                        }
                    }
                });
            }

            // --- MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral ---
            if (req.url.includes('/pt/witch-power/trialPaymentancestral')) {
                console.log('Modificando conteúdo para /trialPaymentancestral (preços e links de botões).');
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(/\$(\d+(\.\d{2})?)/g, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        if (!isNaN(usdValue)) {
                            const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                            return `R$ ${brlValue}`;
                        }
                        return match;
                    });
                });
                $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                console.log('[trialPaymentancestral] Botão #buyButtonAncestral modificado.');

                $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                console.log('[trialPaymentancestral] Botões .cta-button-trial modificados.');

                $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');
                console.log('[trialPaymentancestral] Links "Comprar Agora" modificados.');

                $('h1:contains("Trial Payment Ancestral")').text('Pagamento da Prova Ancestral (Preços e Links Atualizados)');
                console.log('[trialPaymentancestral] Título modificado.');
            }

            res.status(response.status).send($.html());
        } else {
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('--- ERRO NO PROXY ---');
        console.error('Mensagem de Erro:', error.message);
        if (error.response) {
            console.error('Status da Resposta de Erro:', error.response.status);
            console.error('URL da Requisição de Erro:', targetUrl);
            if (error.response.data) {
                try {
                    console.error('Dados da Resposta de Erro (parcial):', error.response.data.toString('utf8').substring(0, 500));
                } catch (e) {
                    console.error('Dados da Resposta de Erro (não-texto ou muito grandes):', 'N/A');
                }
            }
            if (error.response.status === 508) {
                res.status(508).send('Erro ao carregar o conteúdo do site externo: Loop Detectado. Por favor, verifique a configuração do proxy ou redirecionamentos.');
            } else {
                res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'}. URL: ${targetUrl}`);
            }
        } else {
            res.status(500).send('Erro interno do servidor proxy: ' + error.message);
        }
    }
});

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
