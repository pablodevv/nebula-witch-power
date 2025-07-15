// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload');

const app = express();
const PORT = process.env.PORT || 10000;

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_SUBDOMAIN_TARGET = 'https://reading.nebulahoroscope.com';

// Usa express-fileupload para lidar com uploads de arquivos (multipart/form-data)
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Limite de 50MB, ajuste se necessário
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true
}));

// Middleware Principal do Proxy Reverso
app.use(async (req, res) => {
    let targetDomain = MAIN_TARGET_URL;
    let requestPath = req.url;

    // Remove headers que podem causar problemas em proxies ou loops
    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding'];

    // Interceptar chamadas de API externas ANTES do proxy principal
    if (req.url.startsWith('/api-nebula/')) {
        targetDomain = 'https://api.appnebula.co';
        requestPath = req.url.replace('/api-nebula', '');
        targetDomain = 'https://logs.asknebula.com';
        requestPath = req.url.replace('/logs-nebula', '');
        console.log(`[LOGS PROXY] Interceptando: ${req.url} -> ${targetDomain}${requestPath}`);
        targetDomain = 'https://growthbook.nebulahoroscope.com';
        requestPath = req.url.replace('/growthbook-nebula', '');
        console.log(`[GROWTHBOOK PROXY] Interceptando: ${req.url} -> ${targetDomain}${requestPath}`);
    } else if (req.url.startsWith('/tempo-nebula/')) {
        targetDomain = 'https://prod-tempo-web.nebulahoroscope.com';
        requestPath = req.url.replace('/tempo-nebula', '');
        console.log(`[TEMPO PROXY] Interceptando: ${req.url} -> ${targetDomain}${requestPath}`);
    }
    // Lógica para Proxeamento do Subdomínio de Leitura (Mão)
    else if (req.url.startsWith('/reading/')) {
        targetDomain = READING_SUBDOMAIN_TARGET;
        targetDomain = 'https://prod-tempo-web.nebulahoroscope.com';
        requestPath = req.url.replace('/tempo-nebula', '');
        console.log(`[TEMPO PROXY] Interceptando: ${req.url} -> ${targetDomain}${requestPath}`);
    }
    // Lógica para Proxeamento do Subdomínio de Leitura (Mão)
    else if (req.url.startsWith('/reading/')) {
        targetDomain = READING_SUBDOMAIN_TARGET;
        requestPath = req.url.substring('/reading'.length);
        if (requestPath === '') requestPath = '/';
        console.log(`[READING PROXY] Requisição: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
        console.log(`[READING PROXY] Método: ${req.method}`);

        if (req.files && Object.keys(req.files).length > 0) {
            console.log(`[READING PROXY] Arquivos recebidos: ${JSON.stringify(Object.keys(req.files))}`);
            const photoFile = req.files.photo;
            if (photoFile) {
                console.log(`[READING PROXY] Arquivo 'photo': name=${photoFile.name}, size=${photoFile.size}, mimetype=${photoFile.mimetype}`);
            }
        } else {
            console.log(`[READING PROXY] Corpo recebido (tipo): ${typeof req.body}`);
        }
    } else {
        console.log(`[MAIN PROXY] Requisição: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
    }

    const targetUrl = `${targetDomain}${requestPath}`;

    try {
        let requestData = req.body;

        if (req.files && Object.keys(req.files).length > 0) {
            const photoFile = req.files.photo;

            if (photoFile) {
                const formData = new (require('form-data'))();
                formData.append('photo', photoFile.data, {
                    filename: photoFile.name,
                    contentType: photoFile.mimetype,
                });
                requestData = formData;
                delete requestHeaders['content-type'];
                delete requestHeaders['content-length'];
                Object.assign(requestHeaders, formData.getHeaders());
            }
        }

        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: requestHeaders,
            data: requestData,
            responseType: 'arraybuffer',
            maxRedirects: 0,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            },
        });

        // Lógica de Interceptação de Redirecionamento (Status 3xx)
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    fullRedirectUrl = new URL(redirectLocation, targetDomain).href;
                } catch (e) {
                    console.error("Erro ao parsear URL de redirecionamento:", redirectLocation, e.message);
                    fullRedirectUrl = redirectLocation;
                }

                // Esta regra AINDA captura redirecionamentos do SERVIDOR DE DESTINO para /email
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento do servidor de destino para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                let proxiedRedirectPath = fullRedirectUrl;
                if (proxiedRedirectPath.startsWith(MAIN_TARGET_URL)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(MAIN_TARGET_URL, '');
                } else if (proxiedRedirectPath.startsWith(READING_SUBDOMAIN_TARGET)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(READING_SUBDOMAIN_TARGET, '/reading');
                }
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // Repassa Cabeçalhos da Resposta do Destino para o Cliente
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // Lida com o cabeçalho 'Set-Cookie': reescreve o domínio do cookie para o seu domínio
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                return cookie
                    .replace(/Domain=[^;]+/, '')
                    .replace(/; Secure/, '')
                    .replace(/; Path=\//, `; Path=${req.baseUrl || '/'}`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // Lógica de Modificação de Conteúdo (Apenas para HTML)
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

            // Reescrever todas as URLs relativas e absolutas
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
                        if (originalUrl.startsWith('/') && !originalUrl.startsWith('/reading/')) {
                            // URLs relativas para o domínio principal
                        } else if (originalUrl.startsWith('/reading/')) {
                            // URLs para o subdomínio de leitura, já estão corretas
                        } else if (originalUrl.startsWith(MAIN_TARGET_URL)) {
                            element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        } else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) {
                            element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                        }
                    }
                }
            });

            // SCRIPT DE INTERCEPTAÇÃO MELHORADO - Inserido ANTES de qualquer outro script
            const interceptScript = `
                <script>
                    console.log('🔧 PROXY INTERCEPTOR: Iniciando interceptação ANTES de qualquer outro script...');
                    
                    // Intercepta IMEDIATAMENTE XMLHttpRequest
                    const originalXHROpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                        let modifiedUrl = url;
                        
                        if (typeof url === 'string') {
                            if (url.startsWith('https://api.appnebula.co/')) {
                                modifiedUrl = url.replace('https://api.appnebula.co', '/api-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: XHR API →', url, '→', modifiedUrl);
                            } else if (url.startsWith('https://logs.asknebula.com/')) {
                                modifiedUrl = url.replace('https://logs.asknebula.com', '/logs-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: XHR LOGS →', url, '→', modifiedUrl);
                            } else if (url.startsWith('https://growthbook.nebulahoroscope.com/')) {
                                modifiedUrl = url.replace('https://growthbook.nebulahoroscope.com', '/growthbook-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: XHR GROWTHBOOK →', url, '→', modifiedUrl);
                            } else if (url.startsWith('https://prod-tempo-web.nebulahoroscope.com/')) {
                                modifiedUrl = url.replace('https://prod-tempo-web.nebulahoroscope.com', '/tempo-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: XHR TEMPO →', url, '→', modifiedUrl);
                            } else if (url.startsWith('https://reading.nebulahoroscope.com/')) {
                                modifiedUrl = url.replace('https://reading.nebulahoroscope.com', '/reading');
                                console.log('🔧 PROXY INTERCEPTOR: XHR READING →', url, '→', modifiedUrl);
                            }
                        }
                        
                        return originalXHROpen.call(this, method, modifiedUrl, async, user, password);
                    };

                    // Intercepta IMEDIATAMENTE fetch
                    const originalFetch = window.fetch;
                    window.fetch = function(input, init) {
                        let url = input;
                        
                        if (typeof input === 'string') {
                            if (input.startsWith('https://api.appnebula.co/')) {
                                url = input.replace('https://api.appnebula.co', '/api-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: FETCH API →', input, '→', url);
                            } else if (input.startsWith('https://logs.asknebula.com/')) {
                                url = input.replace('https://logs.asknebula.com', '/logs-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: FETCH LOGS →', input, '→', url);
                            } else if (input.startsWith('https://growthbook.nebulahoroscope.com/')) {
                                url = input.replace('https://growthbook.nebulahoroscope.com', '/growthbook-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: FETCH GROWTHBOOK →', input, '→', url);
                            } else if (input.startsWith('https://prod-tempo-web.nebulahoroscope.com/')) {
                                url = input.replace('https://prod-tempo-web.nebulahoroscope.com', '/tempo-nebula');
                                console.log('🔧 PROXY INTERCEPTOR: FETCH TEMPO →', input, '→', url);
                            } else if (input.startsWith('https://reading.nebulahoroscope.com/')) {
                                url = input.replace('https://reading.nebulahoroscope.com', '/reading');
                                console.log('🔧 PROXY INTERCEPTOR: FETCH READING →', input, '→', url);
                            }
                        } else if (input instanceof Request) {
                            const originalUrl = input.url;
                            if (originalUrl.startsWith('https://api.appnebula.co/')) {
                                url = new Request(originalUrl.replace('https://api.appnebula.co', '/api-nebula'), input);
                                console.log('🔧 PROXY INTERCEPTOR: FETCH REQUEST API →', originalUrl, '→', url.url);
                            } else if (originalUrl.startsWith('https://logs.asknebula.com/')) {
                                url = new Request(originalUrl.replace('https://logs.asknebula.com', '/logs-nebula'), input);
                                console.log('🔧 PROXY INTERCEPTOR: FETCH REQUEST LOGS →', originalUrl, '→', url.url);
                            } else if (originalUrl.startsWith('https://growthbook.nebulahoroscope.com/')) {
                                url = new Request(originalUrl.replace('https://growthbook.nebulahoroscope.com', '/growthbook-nebula'), input);
                                console.log('🔧 PROXY INTERCEPTOR: FETCH REQUEST GROWTHBOOK →', originalUrl, '→', url.url);
                            } else if (originalUrl.startsWith('https://prod-tempo-web.nebulahoroscope.com/')) {
                                url = new Request(originalUrl.replace('https://prod-tempo-web.nebulahoroscope.com', '/tempo-nebula'), input);
                                console.log('🔧 PROXY INTERCEPTOR: FETCH REQUEST TEMPO →', originalUrl, '→', url.url);
                            } else if (originalUrl.startsWith('https://reading.nebulahoroscope.com/')) {
                                url = new Request(originalUrl.replace('https://reading.nebulahoroscope.com', '/reading'), input);
                                console.log('🔧 PROXY INTERCEPTOR: FETCH REQUEST READING →', originalUrl, '→', url.url);
                            }
                        }
                        
                        return originalFetch.call(this, url, init);
                    };
                </script>
            `;

            $('head').prepend(interceptScript);

            $('body').append(`
                <script>
                    console.log('CLIENT-SIDE REDIRECT SCRIPT: Initializing.');

                    // Variável para armazenar o ID do intervalo, permitindo limpá-lo
                    let redirectCheckInterval;

                    function handleEmailRedirect() {
                        const currentPath = window.location.pathname;
                        // Use startsWith para pegar /email e /email?param=value
                        if (currentPath.startsWith('/pt/witch-power/email')) {
                            console.log('CLIENT-SIDE REDIRECT: URL /pt/witch-power/email detectada. Forçando redirecionamento para /pt/witch-power/onboarding');
                            // Limpa o intervalo imediatamente para evitar múltiplos redirecionamentos
                            if (redirectCheckInterval) {
                                clearInterval(redirectCheckInterval);
                            }
                            window.location.replace('/pt/witch-power/onboarding'); // Usa replace para não deixar no histórico
                        }
                    }

                    // 1. Executa no carregamento inicial da página (para quando há uma requisição HTTP direta ou client-side inicial)
                    document.addEventListener('DOMContentLoaded', handleEmailRedirect);

                    // 2. Monitora mudanças na história do navegador (para navegações via SPA - pushState/replaceState)
                    window.addEventListener('popstate', handleEmailRedirect);

                    // 3. Adiciona um verificador periódico como uma camada extra de segurança
                    // para capturar qualquer transição que os eventos não peguem
                    redirectCheckInterval = setInterval(handleEmailRedirect, 100); // Verifica a cada 100ms

                    // Limpa o intervalo se a página for descarregada para evitar vazamento de memória
                    window.addEventListener('beforeunload', () => {
                        if (redirectCheckInterval) {
                            clearInterval(redirectCheckInterval);
                        }
                    });

                    // Tenta executar imediatamente também para casos onde o script é injetado muito cedo
                    handleEmailRedirect();
                </script>
            `);

            res.status(response.status).send($.html());
        } else {
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('Erro no proxy:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            if (error.response.status === 508) {
                res.status(508).send('Erro ao carregar o conteúdo do site externo: Loop Detectado. Por favor, verifique a configuração do proxy ou redirecionamentos.');
            } else {
                res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'}`);
            }
        } else {
            res.status(500).send('Erro interno do servidor proxy.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
