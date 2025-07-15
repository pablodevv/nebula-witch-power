// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload');
const FormData = require('form-data'); // Importar FormData para manipulação de arquivos

const app = express();
const PORT = process.env.PORT || 10000;

// URLs de destino - AGORA ABANDONAMOS MAIN_TARGET_URL e READING_SUBDOMAIN_TARGET
// e usamos um mapa para todas as URLS que queremos proxear!
const TARGET_MAP = {
    '/': 'https://appnebula.co', // Default para o domínio principal (main_target_url)
    '/reading': 'https://reading.nebulahoroscope.com', // Subdomínio de leitura
    '/api': 'https://api.appnebula.co', // API principal
    '/logs': 'https://logs.asknebula.com', // Logs
    '/tempo': 'https://prod-tempo-web.nebulahoroscope.com' // Outro subdomínio que aparece nos logs de erro
};

// Configurações para Modificação de Conteúdo
const USD_TO_BRL_RATE = 5.00;

// Usa express-fileupload para lidar com uploads de arquivos (multipart/form-data)
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Limite de 50MB
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true
}));

// Middleware Principal do Proxy Reverso
app.use(async (req, res) => {
    let targetBaseUrl = TARGET_MAP['/']; // Padrão para o domínio principal
    let requestPath = req.url; // Caminho da URL recebida pelo proxy

    // Lógica para determinar o domínio de destino e reescrever o requestPath
    let proxyPrefix = '';
    for (const prefix in TARGET_MAP) {
        // Ignora o prefixo padrão '/' para evitar conflitos na correspondência inicial
        if (prefix !== '/' && req.url.startsWith(prefix)) {
            targetBaseUrl = TARGET_MAP[prefix];
            requestPath = req.url.substring(prefix.length); // Remove o prefixo do caminho para a API real
            if (requestPath === '') requestPath = '/'; // Garante que /prefix se torne /
            proxyPrefix = prefix;
            break; // Sai do loop assim que encontrar o primeiro prefixo correspondente
        }
    }
    // Se nenhum prefixo específico foi encontrado, a requisição é para o domínio principal
    if (!proxyPrefix) {
        targetBaseUrl = TARGET_MAP['/'];
        // requestPath já é req.url completo neste caso
    }


    console.log(`[PROXY ROUTING] Requisição original: ${req.url}`);
    console.log(`[PROXY ROUTING] Prefixo do Proxy: ${proxyPrefix === '' ? '/' : proxyPrefix}`);
    console.log(`[PROXY ROUTING] Domínio de Destino: ${targetBaseUrl}`);
    console.log(`[PROXY ROUTING] Caminho para o Destino: ${requestPath}`);
    console.log(`[PROXY ROUTING] Método: ${req.method}`);


    // Remove headers que podem causar problemas em proxies ou loops
    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding'];
    // IMPORTANTE: Remover o 'origin' header para algumas APIs que podem ter regras estritas de CORS e não esperar ele.
    // Isso é especialmente útil em cenários de proxy reverso.
    delete requestHeaders['origin'];

    const targetUrl = `${targetBaseUrl}${requestPath}`;

    let requestData = req.body;
    let requestConfig = {};

    if (req.files && Object.keys(req.files).length > 0) {
        // Se houver arquivos, construímos um FormData
        const formData = new FormData();
        for (const key in req.files) {
            const file = req.files[key];
            formData.append(key, file.data, { filename: file.name, contentType: file.mimetype });
        }
        // Adicione outros campos de texto do req.body ao form-data se existirem
        if (req.body && Object.keys(req.body).length > 0) {
            for (const key in req.body) {
                formData.append(key, req.body[key]);
            }
        }
        requestData = formData;
        // Axios se encarrega de definir o Content-Type correto para FormData se você passar a instância de FormData
        // Mas se precisar forçar, seria algo como: requestConfig.headers = { ...requestHeaders, ...formData.getHeaders() };
    } else if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        // Se o tipo de conteúdo original for JSON, precisamos parsear o body
        // O express.json() não está em uso, então req.body pode ser um Buffer
        requestData = JSON.parse(req.body.toString());
    } else if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
        // Se for URL-encoded, express.urlencoded() não está em uso, entao req.body seria um Buffer
        requestData = req.body.toString(); // Deixa como string, Axios lidará com isso
    }


    try {
        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: requestHeaders,
            data: requestData,
            responseType: 'arraybuffer', // Para lidar com qualquer tipo de resposta (HTML, imagem, JSON)
            maxRedirects: 0, // Desabilita redirecionamentos automáticos para que possamos interceptá-los
            validateStatus: function (status) {
                return status >= 200 && status < 400; // Permite 2xx e 3xx para lidar com redirecionamentos
            },
        });

        // Lógica de Interceptação de Redirecionamento (Status 3xx)
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    // Tenta construir a URL completa usando a URL de destino da requisição como base
                    fullRedirectUrl = new URL(redirectLocation, targetBaseUrl).href;
                } catch (e) {
                    console.error("Erro ao parsear URL de redirecionamento:", redirectLocation, e.message);
                    fullRedirectUrl = redirectLocation; // Cai de volta para a URL original se houver erro
                }

                // Lógica de redirecionamento específica para /email (mantida)
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento do servidor de destino para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                // Reescreve o redirecionamento para o seu próprio domínio do proxy
                let proxiedRedirectPath = fullRedirectUrl;
                let foundMatch = false;
                for (const prefix in TARGET_MAP) {
                    const originalTarget = TARGET_MAP[prefix];
                    if (proxiedRedirectPath.startsWith(originalTarget)) {
                        if (prefix === '/') {
                             proxiedRedirectPath = proxiedRedirectPath.replace(originalTarget, '');
                        } else {
                            proxiedRedirectPath = proxiedRedirectPath.replace(originalTarget, prefix);
                        }
                        foundMatch = true;
                        break; // Sai do loop assim que encontrar o target correspondente
                    }
                }
                // Se não encontrou um TARGET_MAP correspondente (ex: redirecionamento para domínio externo não mapeado)
                if (!foundMatch) {
                    console.warn(`Redirecionamento para URL não mapeada: ${fullRedirectUrl}. Tentando redirecionar diretamente.`);
                    // Apenas redireciona para a URL original, o que pode causar CORS se for para outro domínio.
                    // Para cenários mais avançados, poderíamos tentar proxear isso também, mas requer mais lógica.
                    return res.redirect(response.status, fullRedirectUrl);
                }

                // Garante que / vira / e não ''
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // Repassa Cabeçalhos da Resposta do Destino para o Cliente
        Object.keys(response.headers).forEach(header => {
            // Ignora headers que podem causar problemas ou são manipulados por este proxy
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // Lida com o cabeçalho 'Set-Cookie': reescreve o domínio do cookie para o seu domínio
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                // Remove Domain e Secure, reescreve o Path para a raiz do seu proxy
                return cookie
                    .replace(/Domain=[^;]+/, '') // Remove qualquer domínio existente
                    .replace(/; Secure/, '')       // Remove o atributo Secure
                    .replace(/; Path=[^;]+/, `; Path=/`); // Define o Path para a raiz do seu proxy
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // Lógica de Modificação de Conteúdo (Apenas para HTML)
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

            // Reescrever todas as URLs relativas e absolutas nos atributos href, src, action
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
                        for (const prefix in TARGET_MAP) {
                            const targetOriginal = TARGET_MAP[prefix];
                            if (originalUrl.startsWith(targetOriginal)) {
                                if (prefix === '/') {
                                    element.attr(attrName, originalUrl.replace(targetOriginal, ''));
                                } else {
                                    element.attr(attrName, originalUrl.replace(targetOriginal, prefix));
                                }
                                return; // Sai do loop para este elemento assim que encontrar uma correspondência
                            }
                        }
                    }
                }
            });

            // Script para reescrever URLs de API dinâmicas no JavaScript (MANTIDO E APRIMORADO)
            // Isso injeta um script que intercepta fetch, XMLHttpRequest e WebSocket para reescrever URLs no lado do cliente
            $('head').prepend(`
                <script>
                    (function() {
                        const targetMap = ${JSON.stringify(TARGET_MAP)}; // Passa o mapa para o cliente
                        // Função de reescrita de URL genérica
                        function rewriteUrl(originalUrl) {
                            if (typeof originalUrl !== 'string') return originalUrl;

                            for (const proxyPrefix in targetMap) {
                                const targetUrlBase = targetMap[proxyPrefix];
                                if (originalUrl.startsWith(targetUrlBase)) {
                                    let rewrittenUrl = originalUrl.replace(targetUrlBase, proxyPrefix);
                                    // Ajuste para o caso do prefixo padrão (raiz)
                                    if (proxyPrefix === '/') {
                                        rewrittenUrl = originalUrl.replace(targetUrlBase, '');
                                    }
                                    console.log('PROXY SHIM (toProxy):', originalUrl, '->', rewrittenUrl);
                                    return rewrittenUrl;
                                }
                            }
                            return originalUrl; // Retorna a URL original se não houver correspondência
                        }

                        // Intercepta fetch
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

                        // Intercepta XMLHttpRequest
                        const originalXHRopen = XMLHttpRequest.prototype.open;
                        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                            const modifiedUrl = rewriteUrl(url);
                            originalXHRopen.call(this, method, modifiedUrl, async, user, password);
                        };

                        // Intercepta e reescreve WebSocket URLs (se necessário)
                        const originalWebSocket = window.WebSocket;
                        window.WebSocket = function(url, protocols) {
                            const modifiedUrl = rewriteUrl(url);
                            console.log('PROXY SHIM: REWRITE WebSocket URL:', url, '->', modifiedUrl);
                            return new originalWebSocket(modifiedUrl, protocols);
                        };
                    })();
                </script>
            `);

            // ---
            // REDIRECIONAMENTO CLIENT-SIDE MAIS AGRESSIVO PARA /pt/witch-power/email (MANTIDO)
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
                    window.addEventListener('popstate', handleEmailRedirect); // Para navegação via histórico
                    redirectCheckInterval = setInterval(handleEmailRedirect, 100); // Verifica rapidamente em intervalos curtos
                    window.addEventListener('beforeunload', () => { // Limpa o intervalo ao sair da página
                        if (redirectCheckInterval) {
                            clearInterval(redirectCheckInterval);
                        }
                    });
                    handleEmailRedirect(); // Executa uma vez na inicialização
                </script>
            `);
            // ---

            // ---
            // MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialChoice (AGORA RESOLVIDO COMO PEDIDO!)
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (texto do custo e botões, MANTENDO A LÓGICA DE NAVEGAÇÃO ORIGINAL).');

                // 1. GARANTIR O TEXTO DA TAG <P>
                // Procurar a tag <p> com a classe específica e restaurar/garantir o texto.
                let $p = $('p.sc-edafe909-6.pLaXn'); // Seletor exato da classe que você mencionou
                if ($p.length === 0) {
                    // Se a classe mudar ou não for encontrada, tenta um seletor mais genérico que contenha parte do texto
                    $p = $('p:contains("custo real ser de")');
                }

                // Texto já com R$ 68,35 (13.67 * 5.00)
                const newCostText = `Apesar do nosso custo real ser de R$ 68,35*, por favor selecione um valor que você considere justo.`;
                if ($p.length > 0) {
                    $p.text(newCostText); // Define o texto explicitamente
                    console.log(`[trialChoice] Texto da tag <p> restaurado: "${newCostText}"`);
                } else {
                    // Se não encontrou nenhuma p tag existente, injeta uma nova no body como fallback.
                    $('body').append(`<p class="sc-edafe909-6 pLaXn">${newCostText}</p>`);
                    console.log(`[trialChoice] Tag <p> injetada no body com texto: "${newCostText}"`);
                }

                // 2. MODIFICAR O TEXTO DOS BOTÕES - MANTENDO OS LINKS ORIGINAIS
                // Itera sobre todos os elementos 'a', 'button' e inputs de botão/submit
                $('a, button, input[type="submit"], input[type="button"]').each((i, el) => {
                    const $el = $(el);
                    let originalContent = '';

                    // Pega o texto para tags <a> e <button>, e o valor para <input>
                    if ($el.is('input')) {
                        originalContent = $el.val();
                    } else {
                        originalContent = $el.text();
                    }

                    if (originalContent && typeof originalContent === 'string') {
                        // Expressão regular para encontrar "$XX.XX" ou "$XX"
                        const priceRegex = /\$(\d+(\.\d{2})?)/g;
                        if (originalContent.match(priceRegex)) {
                            const newContent = originalContent.replace(priceRegex, (match, p1) => {
                                const usdValue = parseFloat(p1);
                                if (!isNaN(usdValue)) {
                                    const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                                    return `R$ ${brlValue}`; // Converte e formata para BRL
                                }
                                return match; // Retorna o match original se a conversão falhar
                            });
                            // Define o novo conteúdo de volta
                            if ($el.is('input')) {
                                $el.val(newContent);
                            } else {
                                $el.text(newContent);
                            }
                            console.log(`[trialChoice] Conteúdo do elemento (original: "${originalContent}") modificado para: "${newContent}"`);
                        }
                    }
                });
            }
            // ---

            // MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral (MANTIDO)
            if (req.url.includes('/pt/witch-power/trialPaymentancestral')) {
                console.log('Modificando conteúdo para /trialPaymentancestral (preços e links de botões).');
                // Modificação dos preços em qualquer lugar do body
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
                // Modificação dos links dos botões
                $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                console.log('[trialPaymentancestral] Botão #buyButtonAncestral modificado.');

                $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                console.log('[trialPaymentancestral] Botões .cta-button-trial modificados.');

                // Seletor para o link "Comprar Agora" (CUIDADO: ":contains" não é robusto, mas mantido)
                $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');
                console.log('[trialPaymentancestral] Links "Comprar Agora" modificados.');

                // Modificação do título
                $('h1:contains("Trial Payment Ancestral")').text('Pagamento da Prova Ancestral (Preços e Links Atualizados)');
                console.log('[trialPaymentancestral] Título modificado.');
            }

            res.status(response.status).send($.html()); // Envia o HTML modificado
        } else {
            // Se não for HTML, apenas repassa a resposta binária/textual
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('Erro no proxy:', error.message);
        if (error.response) {
            console.error('Status da resposta de erro:', error.response.status);
            // Loga uma parte dos dados da resposta de erro para depuração
            console.error('Dados da resposta de erro (parcial):', error.response.data ? error.response.data.toString('utf8').substring(0, 500) : 'N/A');
            if (error.response.status === 508) {
                res.status(508).send('Erro ao carregar o conteúdo do site externo: Loop Detectado. Por favor, verifique a configuração do proxy ou redirecionamentos.');
            } else {
                res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'}`);
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
