// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload'); // Middleware para lidar com uploads de arquivos
const FormData = require('form-data'); // Para construir corpos de requisição multipart/form-data

const app = express();
const PORT = process.env.PORT || 10000;

// --- Configurações de URLs de Destino ---
// Mapeamento de prefixos de URL no seu proxy para as URLs de destino reais.
// Importante: A ordem das chaves importa para correspondências mais específicas primeiro.
// O prefixo '/' deve ser o último ou o padrão.
const TARGET_MAP = {
    '/api': 'https://api.appnebula.co', // API principal
    '/reading': 'https://reading.nebulahoroscope.com', // Subdomínio para a leitura de mão
    '/logs': 'https://logs.asknebula.com', // Logs (sentry, grafana, etc.)
    '/tempo': 'https://prod-tempo-web.nebulahoroscope.com', // Outro endpoint de telemetria
    // O domínio principal DEVE terminar com uma barra se você quiser que caminhos sejam adicionados diretamente
    '/': 'https://appnebula.co/' // *** CORREÇÃO AQUI: Adicionado barra final para garantir concatenação correta ***
};

// --- Configurações de Valores e Taxas ---
const USD_TO_BRL_RATE = 5.00; // Taxa de conversão do dólar para o real
const FIXED_P_COST_BRL = '68,35'; // Valor fixo em real para o texto do <p>

// --- Middleware para Upload de Arquivos (necessário para a leitura de mão) ---
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Limite de 50MB por arquivo
    createParentPath: true, // Cria pastas pai se não existirem
    uriDecodeFileNames: true, // Decodifica nomes de arquivos na URI
    preserveExtension: true // Preserva a extensão original do arquivo
}));

// --- Middleware Principal do Proxy Reverso ---
app.use(async (req, res) => {
    let targetBaseUrl = TARGET_MAP['/']; // Padrão inicial para o domínio principal
    let requestPath = req.url; // O caminho da URL que o cliente solicitou ao proxy
    let proxyPrefixFound = ''; // O prefixo do TARGET_MAP que correspondeu

    // Lógica para determinar o domínio de destino e reescrever o requestPath.
    // Iteramos sobre os prefixos do TARGET_MAP em ordem decrescente de comprimento
    // para garantir que prefixos mais específicos (ex: /api/v1) sejam correspondidos antes de /api.
    const sortedPrefixes = Object.keys(TARGET_MAP).sort((a, b) => b.length - a.length);

    for (const prefix of sortedPrefixes) {
        // CORREÇÃO: Usar req.url.startsWith() é correto para determinar o prefixo.
        if (req.url.startsWith(prefix)) {
            targetBaseUrl = TARGET_MAP[prefix];
            // CORREÇÃO: AQUI ESTAVA O PROBLEMA!
            // Para garantir que o requestPath seja sempre relativo ao domínio de destino,
            // e não cause 'appnebula.cofavicon.ico', removemos a barra inicial se existir.
            requestPath = req.url.substring(prefix.length).trimStart('/');
            if (requestPath === '') requestPath = '/'; // Garante que '/prefixo' se torne '/' no destino
            else requestPath = `/${requestPath}`; // Adiciona a barra de volta se não for vazio

            proxyPrefixFound = prefix;
            break; // Encontrou o prefixo mais específico, pode sair do loop
        }
    }

    // Logs para depuração do roteamento
    console.log(`[PROXY ROUTING] Requisição original: ${req.url}`);
    console.log(`[PROXY ROUTING] Prefixo do Proxy Local (Matched): ${proxyPrefixFound === '' ? '/' : proxyPrefixFound}`);
    console.log(`[PROXY ROUTING] Domínio de Destino Real: ${targetBaseUrl}`);
    console.log(`[PROXY ROUTING] Caminho para o Destino Real: ${requestPath}`);
    console.log(`[PROXY ROUTING] Método HTTP: ${req.method}`);
    console.log(`[PROXY ROUTING] Content-Type da Requisição: ${req.headers['content-type'] || 'N/A'}`);

    // --- Tratamento de Cabeçalhos da Requisição ---
    const requestHeaders = { ...req.headers }; // Copia todos os cabeçalhos originais
    // Remove cabeçalhos que podem causar problemas em proxies ou que são recriados pelo Axios
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding']; // Importante para evitar compressão indesejada no proxy
    delete requestHeaders['origin']; // Remover o 'origin' header pode resolver problemas de CORS com algumas APIs

    // --- Tratamento do Corpo da Requisição (Dados) ---
    let requestData = undefined; // Inicializa como undefined

    // 1. Lida com requisições que contêm uploads de arquivos (multipart/form-data)
    if (req.files && Object.keys(req.files).length > 0) {
        const formData = new FormData();
        // Anexa cada arquivo ao FormData
        for (const key in req.files) {
            const file = req.files[key];
            // 'file.data' é o buffer do arquivo, 'file.name' o nome original, 'file.mimetype' o tipo
            formData.append(key, file.data, { filename: file.name, contentType: file.mimetype });
        }
        // Anexa também todos os campos de texto do req.body (se houver)
        if (req.body && Object.keys(req.body).length > 0) {
            for (const key in req.body) {
                // Se for um objeto, stringify para JSON, caso contrário, anexa diretamente
                if (typeof req.body[key] === 'object' && req.body[key] !== null) {
                    formData.append(key, JSON.stringify(req.body[key]), { contentType: 'application/json' });
                } else {
                    formData.append(key, req.body[key]);
                }
            }
        }
        requestData = formData; // O corpo da requisição será o objeto FormData
        // Axios cuidará dos cabeçalhos específicos do FormData (como Content-Type e boundary) automaticamente.
    }
    // 2. Lida com requisições com corpo JSON (se não forem multipart)
    else if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        // Verifica se req.body é um Buffer e não está vazio
        if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
            try {
                requestData = JSON.parse(req.body.toString('utf8')); // Tenta parsear o Buffer para JSON
            } catch (e) {
                console.error("Erro ao parsear JSON do corpo da requisição:", e);
                requestData = req.body; // Se falhar, usa o Buffer original
            }
        } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            // Se req.body já for um objeto (pode ocorrer dependendo do middleware)
            requestData = req.body;
        }
        // Se req.body for undefined ou vazio para JSON, requestData permanece undefined
    }
    // 3. Lida com outros tipos de corpo (ex: text/plain, application/x-www-form-urlencoded)
    else if (req.body && (Buffer.isBuffer(req.body) && req.body.length > 0 || typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
        requestData = req.body; // Usa o req.body como está (Buffer ou objeto)
    }
    // Se nenhuma das condições acima for atendida, requestData permanece undefined (correto para GET, ou POST/PUT sem corpo)

    // CORREÇÃO: Montagem da URL de destino mais robusta
    const targetUrl = new URL(requestPath, targetBaseUrl).href; // Usa o construtor URL para garantir a URL correta

    try {
        const response = await axios({
            method: req.method, // Método HTTP da requisição original (GET, POST, PUT, DELETE, etc.)
            url: targetUrl, // URL para a qual o proxy fará a requisição
            headers: requestData instanceof FormData ? { ...requestHeaders, ...requestData.getHeaders() } : requestHeaders, // Define os cabeçalhos. Se for FormData, Axios adiciona os próprios.
            data: requestData, // O corpo da requisição. Se requestData for undefined, Axios não envia corpo.
            responseType: 'arraybuffer', // Recebe a resposta como um buffer de bytes (útil para imagens, downloads, etc.)
            maxRedirects: 0, // Não seguir redirecionamentos automaticamente, lidamos com eles manualmente
            validateStatus: function (status) {
                return status >= 200 && status < 400; // Valida apenas status 2xx e 3xx como sucesso.
            },
        });

        // --- Lógica de Interceptação de Redirecionamento (Status 3xx) ---
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location; // Obtém a URL de redirecionamento
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    // Tenta criar uma URL absoluta a partir da location e da URL de destino
                    fullRedirectUrl = new URL(redirectLocation, targetBaseUrl).href;
                } catch (e) {
                    console.error("Erro ao parsear URL de redirecionamento:", redirectLocation, e.message);
                    fullRedirectUrl = redirectLocation; // Em caso de erro, usa a location original
                }

                // Redirecionamento Específico: /pt/witch-power/email -> /pt/witch-power/onboarding
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento do servidor de destino para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding'); // Redireciona para a URL do seu proxy
                }

                // Reescreve a URL de redirecionamento para apontar para o seu proxy novamente
                let proxiedRedirectPath = fullRedirectUrl;
                let foundMatchForRedirect = false;
                for (const prefix in TARGET_MAP) {
                    const originalTarget = TARGET_MAP[prefix];
                    // CORREÇÃO: A URL de destino pode terminar em '/', então é melhor remover antes de comparar
                    const cleanedOriginalTarget = originalTarget.endsWith('/') ? originalTarget.slice(0, -1) : originalTarget;
                    const cleanedProxiedRedirectPath = proxiedRedirectPath.startsWith(cleanedOriginalTarget) ? proxiedRedirectPath.replace(cleanedOriginalTarget, '') : proxiedRedirectPath;


                    if (proxiedRedirectPath.startsWith(originalTarget)) {
                        // Se o prefixo mapeado é '/', o substituto é um caminho vazio (raiz do proxy)
                        if (prefix === '/') {
                            proxiedRedirectPath = proxiedRedirectPath.replace(originalTarget, '');
                        } else {
                            // Para outros prefixos, substitua pelo prefixo do proxy
                            proxiedRedirectPath = proxiedRedirectPath.replace(originalTarget, prefix);
                        }
                        foundMatchForRedirect = true;
                        break;
                    }
                }
                if (!foundMatchForRedirect) {
                    console.warn(`Redirecionamento para URL não mapeada pelo proxy: ${fullRedirectUrl}. Tentando redirecionar diretamente.`);
                }
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/'; // Garante que a raiz seja '/'

                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para o Proxy: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath); // Envia o redirecionamento para o cliente
            }
        }

        // --- Repassando Cabeçalhos da Resposta do Destino para o Cliente ---
        Object.keys(response.headers).forEach(header => {
            // Evita cabeçalhos que são manipulados pelo Express ou Axios, ou que podem causar problemas
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // Adiciona cabeçalhos para evitar cache agressivo do navegador (muito importante durante o desenvolvimento)
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // Lida com o cabeçalho 'Set-Cookie': reescreve o domínio do cookie para o seu domínio do proxy
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                return cookie
                    .replace(/Domain=[^;]+/, '') // Remove o domínio original do cookie
                    .replace(/; Secure/, '')     // Remove o atributo Secure (pode ser problema em HTTP, mas Render é HTTPS)
                    .replace(/; Path=[^;]+/, `; Path=/`); // Define o path para a raiz do seu proxy
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // --- Lógica de Modificação de Conteúdo (Apenas para HTML) ---
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8'); // Converte o buffer HTML para string UTF-8
            const $ = cheerio.load(html); // Carrega o HTML no Cheerio para manipulação

            // Reescrever URLs em atributos (href, src, action) dentro do HTML
            // Isso garante que todos os links, scripts, imagens apontem para o seu proxy
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
                            const targetOriginal = TARGET_MAP[prefix]; // Ex: 'https://appnebula.co/'
                            if (originalUrl.startsWith(targetOriginal)) {
                                if (prefix === '/') {
                                    // Se o prefixo é '/', remove o domínio original completamente
                                    element.attr(attrName, originalUrl.replace(targetOriginal, ''));
                                } else {
                                    // Para outros prefixos, substitui o domínio original pelo prefixo do proxy
                                    element.attr(attrName, originalUrl.replace(targetOriginal, prefix));
                                }
                                return; // Encontrou e reescreveu, vai para o próximo elemento
                            }
                        }
                    }
                }
            });

            // --- Injeta Script Cliente-Side para Reescrever URLs de APIs (Fetch, XHR, WebSocket) ---
            // Isso é crucial porque muitas chamadas de API são feitas via JavaScript após o carregamento da página.
            // Este script intercepta essas chamadas e reescreve as URLs para apontar para o seu proxy.
            $('head').prepend(`
                <script>
                    (function() {
                        const targetMap = ${JSON.stringify(TARGET_MAP)}; // Passa o mapa de URLs para o script cliente

                        function rewriteUrl(originalUrl) {
                            if (typeof originalUrl !== 'string') return originalUrl;

                            // Ordena os prefixos do mais longo para o mais curto para correspondência correta
                            const sortedPrefixes = Object.keys(targetMap).sort((a, b) => b.length - a.length);

                            for (const proxyPrefix of sortedPrefixes) {
                                const targetUrlBase = targetMap[proxyPrefix];
                                if (originalUrl.startsWith(targetUrlBase)) {
                                    let rewrittenUrl = originalUrl.replace(targetUrlBase, proxyPrefix);
                                    if (proxyPrefix === '/') {
                                        rewrittenUrl = originalUrl.replace(targetUrlBase, '');
                                    }
                                    console.log('PROXY SHIM (toProxy):', originalUrl, '->', rewrittenUrl);
                                    return rewrittenUrl;
                                }
                            }
                            return originalUrl; // Retorna a URL original se não houver correspondência
                        }

                        // Intercepta window.fetch
                        const originalFetch = window.fetch;
                        window.fetch = function(input, init) {
                            let url = input;
                            if (typeof input === 'string') {
                                url = rewriteUrl(input);
                            } else if (input instanceof Request) {
                                // Se for um objeto Request, cria um novo Request com a URL reescrita
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
                            return originalFetch.call(this, url, init); // Chama o fetch original com a URL reescrita
                        };

                        // Intercepta XMLHttpRequest (para requisições AJAX mais antigas)
                        const originalXHRopen = XMLHttpRequest.prototype.open;
                        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                            const modifiedUrl = rewriteUrl(url);
                            originalXHRopen.call(this, method, modifiedUrl, async, user, password); // Chama o open original com a URL reescrita
                        };

                        // Intercepta WebSocket (se o site usar WebSockets)
                        const originalWebSocket = window.WebSocket;
                        window.WebSocket = function(url, protocols) {
                            const modifiedUrl = rewriteUrl(url);
                            console.log('PROXY SHIM: REWRITE WebSocket URL:', url, '->', modifiedUrl);
                            return new originalWebSocket(modifiedUrl, protocols); // Cria um WebSocket com a URL reescrita
                        };
                    })();
                </script>
            `);

            // --- Redirecionamento CLIENT-SIDE Agressivo para /pt/witch-power/email -> /onboarding ---
            // Este script garante que mesmo que algo no JS do site original tente redirecionar para /email,
            // o navegador será imediatamente forçado para /onboarding.
            $('head').append(`
                <script>
                    console.log('CLIENT-SIDE REDIRECT SCRIPT: Initializing.');
                    let redirectCheckInterval;

                    function handleEmailRedirect() {
                        const currentPath = window.location.pathname;
                        if (currentPath.startsWith('/pt/witch-power/email')) {
                            console.log('CLIENT-SIDE REDIRECT: URL /pt/witch-power/email detectada. Forçando redirecionamento para /pt/witch-power/onboarding');
                            if (redirectCheckInterval) {
                                clearInterval(redirectCheckInterval); // Limpa o intervalo para evitar múltiplos redirecionamentos
                            }
                            window.location.replace('/pt/witch-power/onboarding'); // Força o redirecionamento
                        }
                    }

                    // Adiciona listeners para garantir a detecção em diferentes momentos
                    document.addEventListener('DOMContentLoaded', handleEmailRedirect);
                    window.addEventListener('popstate', handleEmailRedirect); // Para navegação via histórico do navegador
                    redirectCheckInterval = setInterval(handleEmailRedirect, 100); // Verifica a cada 100ms
                    window.addEventListener('beforeunload', () => {
                        if (redirectCheckInterval) {
                            clearInterval(redirectCheckInterval); // Limpa o intervalo ao sair da página
                        }
                    });
                    handleEmailRedirect(); // Executa uma vez imediatamente
                </script>
            `);
            // ---

            // --- MODIFICAÇÕES DE CONTEÚDO ESPECÍFICAS PARA /pt/witch-power/trialChoice ---
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (texto do custo e botões de preço).');

                // 1. Modificar o texto da tag <p> que contém o custo real
                // Tentamos encontrar a tag <p> por uma classe específica, ou pelo conteúdo
                let $p = $('p.sc-edafe909-6.pLaXn');
                if ($p.length === 0) {
                    $p = $('p:contains("custo real ser de")');
                }

                const newCostText = `Apesar do nosso custo real ser de R$ ${FIXED_P_COST_BRL}*, por favor selecione um valor que você considere justo.`;
                if ($p.length > 0) {
                    $p.text(newCostText);
                    console.log(`[trialChoice] Texto da tag <p> atualizado: "${newCostText}"`);
                } else {
                    // Se a tag <p> não for encontrada, injeta uma nova no body
                    $('body').append(`<p class="sc-edafe909-6 pLaXn">${newCostText}</p>`);
                    console.log(`[trialChoice] Tag <p> injetada no body com texto: "${newCostText}"`);
                }

                // 2. Modificar o texto dos botões de preço (mantendo a lógica de clique/links originais)
                // Procura por elementos 'a', 'button', 'input[type="submit"]', 'input[type="button"]'
                $('a, button, input[type="submit"], input[type="button"]').each((i, el) => {
                    const $el = $(el);
                    let originalContent = '';

                    if ($el.is('input')) {
                        originalContent = $el.val(); // Para inputs, pega o valor do atributo 'value'
                    } else {
                        originalContent = $el.text(); // Para outros elementos, pega o texto interno
                    }

                    if (originalContent && typeof originalContent === 'string') {
                        // Regex para encontrar padrões de preço em dólar ($XX.YY ou $XX,YY)
                        const priceRegex = /\$(\d+(?:[.,]\d{2})?)/g; // Captura tanto . quanto , para centavos
                        if (originalContent.match(priceRegex)) {
                            const newContent = originalContent.replace(priceRegex, (match, p1) => {
                                // Limpa o valor para float (remove vírgulas de milhar, se houver, e muda vírgula decimal para ponto)
                                const usdValueStr = p1.replace(/,/g, ''); // Remove vírgulas (de milhar)
                                const usdValue = parseFloat(usdValueStr); // Parseia como float

                                if (!isNaN(usdValue)) {
                                    const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ','); // Converte e formata para BRL
                                    return `R$ ${brlValue}`; // Substitui o preço em dólar pelo preço em real
                                }
                                return match; // Retorna o original se a conversão falhar
                            });
                            // Aplica o novo conteúdo de volta ao elemento
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
            // --- FIM DAS MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialChoice ---

            // --- MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral ---
            // Esta parte foi deixada da sua implementação anterior, caso ainda precise dela.
            // Lembre-se de que a leitura da palma é mais sobre /reading do que paymentancestral.
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
            // --- FIM DAS MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral ---

            // Envia o HTML modificado de volta para o cliente
            res.status(response.status).send($.html());
        } else {
            // Se não for HTML, envia o buffer original da resposta diretamente
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('--- ERRO NO PROXY ---');
        console.error('Mensagem de Erro:', error.message);
        if (error.response) {
            console.error('Status da Resposta de Erro:', error.response.status);
            console.error('URL da Requisição de Erro:', targetUrl);
            // Tenta logar os dados da resposta de erro se existirem e forem buffer, para depuração
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
            // Isso captura erros como ENOTFOUND
            res.status(500).send('Erro interno do servidor proxy: ' + error.message);
        }
    }
});

// --- Inicia o Servidor ---
app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
