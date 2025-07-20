const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const https = require('https');
const FormData = require('form-data');
const zlib = require('zlib');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 10000;

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_SUBDOMAIN_TARGET = 'https://reading.nebulahoroscope.com';

// Configurações para Modificação de Conteúdo
const USD_TO_BRL_RATE = 5.00;
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

// Cache para melhorar performance
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Variáveis para captura de texto (simplificadas)
let capturedBoldText = 'identificar seu arquétipo de bruxa';
let lastCaptureTime = Date.now();
let isCapturing = false;

// HTTPS Agent otimizado
const agent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 50
});

// MIDDLEWARE DE COMPRESSÃO (primeiro)
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// MIDDLEWARE DE CACHE HEADERS
app.use((req, res, next) => {
    // Cache para assets estáticos
    if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
    }
    next();
});

// FileUpload otimizado
app.use(fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // Reduzido para 10MB
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true,
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// Servir arquivos estáticos com cache
app.use(express.static(path.join(__dirname, 'dist'), {
    maxAge: '1d',
    etag: true
}));

// CORS otimizado
app.use(cors({
    origin: true,
    credentials: true,
    optionsSuccessStatus: 200
}));

// Body parsing condicional (otimizado)
app.use((req, res, next) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        express.json({ limit: '1mb' })(req, res, () => {
            express.urlencoded({ extended: true, limit: '1mb' })(req, res, next);
        });
    } else {
        next();
    }
});

// === ENDPOINTS DE API (simplificados) ===

// API endpoint para obter o texto capturado (com cache)
app.get('/api/captured-text', async (req, res) => {
    const cacheKey = 'captured-text';
    const cached = responseCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return res.json(cached.data);
    }

    if (!capturedBoldText || capturedBoldText === 'identificar seu arquétipo de bruxa' || (Date.now() - lastCaptureTime > 3600000 && !isCapturing)) {
        await captureTextDirectly();
    }

    const responseData = {
        capturedText: capturedBoldText,
        lastCaptureTime: lastCaptureTime,
        isCapturing: isCapturing,
        timestamp: Date.now()
    };

    responseCache.set(cacheKey, {
        data: responseData,
        timestamp: Date.now()
    });

    res.json(responseData);
});

// Endpoint para receber escolha do usuário
app.post('/api/set-selected-choice', (req, res) => {
    const { selectedText } = req.body;
    if (selectedText) {
        capturedBoldText = selectedText;
        lastCaptureTime = Date.now();
        // Limpar cache quando texto é atualizado
        responseCache.delete('captured-text');
        res.status(200).json({ message: 'Texto atualizado com sucesso.', capturedText: capturedBoldText });
    } else {
        res.status(400).json({ message: 'Nenhum texto fornecido.' });
    }
});

// === FUNÇÕES DE CAPTURA (otimizadas) ===

function extractTextFromHTML(html) {
    try {
        const $ = cheerio.load(html);
        const startPhrase = 'Ajudamos milhões de pessoas a ';
        const endPhrase = ', e queremos ajudar você também.';
        const fullText = $('body').text();

        if (fullText.includes(startPhrase) && fullText.includes(endPhrase)) {
            const startIndex = fullText.indexOf(startPhrase) + startPhrase.length;
            const endIndex = fullText.indexOf(endPhrase);

            if (startIndex < endIndex) {
                const extractedContent = fullText.substring(startIndex, endIndex).trim();
                if (extractedContent.length > 5) {
                    return extractedContent;
                }
            }
        }

        // Fallback para textos conhecidos
        const knownTexts = [
            'identificar seu arquétipo de bruxa',
            'explorar origens de vidas passadas',
            'desvendar seu destino e propósito',
            'descobrir seus poderes ocultos',
            'encontrar marcas e símbolos que as guiam',
            'revelar seus dons espirituais'
        ];

        const htmlLower = html.toLowerCase();
        for (const text of knownTexts) {
            if (htmlLower.includes(text.toLowerCase())) {
                return text;
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}

async function captureTextDirectly() {
    if (isCapturing) return capturedBoldText;
    
    isCapturing = true;

    try {
        const response = await axios.get(`${MAIN_TARGET_URL}/pt/witch-power/trialChoice`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache'
            },
            responseType: 'arraybuffer',
            timeout: 15000, // Reduzido timeout
            httpsAgent: agent,
        });

        let responseData = response.data;
        const contentEncoding = response.headers['content-encoding'];
        
        if (contentEncoding === 'gzip') {
            responseData = zlib.gunzipSync(responseData);
        } else if (contentEncoding === 'deflate') {
            responseData = zlib.inflateSync(responseData);
        } else if (contentEncoding === 'br') {
            responseData = zlib.brotliDecompressSync(responseData);
        }

        const html = responseData.toString('utf8');
        const extractedText = extractTextFromHTML(html);

        if (extractedText && extractedText.length > 5) {
            capturedBoldText = extractedText;
            lastCaptureTime = Date.now();
            return capturedBoldText;
        }

        // Fallback
        capturedBoldText = 'identificar seu arquétipo de bruxa';
        lastCaptureTime = Date.now();
        return capturedBoldText;

    } catch (error) {
        capturedBoldText = 'identificar seu arquétipo de bruxa';
        lastCaptureTime = Date.now();
        return capturedBoldText;
    } finally {
        isCapturing = false;
    }
}

// === ROTAS ESPECÍFICAS ===

app.get('/pt/witch-power/trialChoice', async (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.get('/pt/witch-power/date', async (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// === PROXY DA API (otimizado) ===
app.use('/api-proxy', async (req, res) => {
    const cacheKey = `api-${req.method}-${req.url}`;
    const cached = responseCache.get(cacheKey);
    
    // Cache apenas para GET requests
    if (req.method === 'GET' && cached && (Date.now() - cached.timestamp < 30000)) {
        return res.status(cached.status).set(cached.headers).send(cached.data);
    }

    const apiTargetUrl = `https://api.appnebula.co${req.url.replace('/api-proxy', '')}`;
    const requestHeaders = { ...req.headers };
    
    // Remover headers problemáticos
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];

    try {
        const response = await axios({
            method: req.method,
            url: apiTargetUrl,
            headers: requestHeaders,
            data: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined,
            responseType: 'arraybuffer',
            maxRedirects: 0,
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 400,
            httpsAgent: agent,
        });

        // Definir headers de resposta
        const responseHeaders = {};
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                responseHeaders[header] = response.headers[header];
                res.setHeader(header, response.headers[header]);
            }
        });

        // Cache para GET requests
        if (req.method === 'GET') {
            responseCache.set(cacheKey, {
                status: response.status,
                headers: responseHeaders,
                data: response.data,
                timestamp: Date.now()
            });
        }

        res.status(response.status).send(response.data);

    } catch (error) {
        if (error.response) {
            res.status(error.response.status).send(error.response.data);
        } else {
            res.status(500).send('Erro ao proxy a API.');
        }
    }
});

// === MIDDLEWARE PRINCIPAL (altamente otimizado) ===
app.use(async (req, res) => {
    let targetDomain = MAIN_TARGET_URL;
    let requestPath = req.url;
    const currentProxyHost = req.protocol + '://' + req.get('host');

    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];

    // Lógica para Reading subdomain
    if (req.url.startsWith('/reading/')) {
        targetDomain = READING_SUBDOMAIN_TARGET;
        requestPath = req.url.substring('/reading'.length);
        if (requestPath === '') requestPath = '/';
    }

    const targetUrl = `${targetDomain}${requestPath}`;

    try {
        let requestData = req.body;

        // Upload de arquivos (otimizado)
        if (req.files && Object.keys(req.files).length > 0) {
            const photoFile = req.files.photo;
            if (photoFile) {
                const formData = new FormData();
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
            timeout: 20000,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            httpsAgent: agent,
        });

        // Descompressão otimizada
        let responseData = response.data;
        const contentEncoding = response.headers['content-encoding'];
        
        if (contentEncoding === 'gzip') {
            responseData = zlib.gunzipSync(responseData);
        } else if (contentEncoding === 'deflate') {
            responseData = zlib.inflateSync(responseData);
        } else if (contentEncoding === 'br') {
            responseData = zlib.brotliDecompressSync(responseData);
        }

        const contentType = response.headers['content-type'] || '';
        let htmlContent = null;
        
        if (contentType.includes('text/html')) {
            htmlContent = responseData.toString('utf8');
        }

        // Tratamento de redirecionamentos
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    fullRedirectUrl = new URL(redirectLocation, targetDomain).href;
                } catch (e) {
                    fullRedirectUrl = redirectLocation;
                }

                // Interceptações específicas
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }
                if (fullRedirectUrl.includes('/pt/witch-power/wpGoal')) {
                    return res.redirect(302, '/pt/witch-power/trialChoice');
                }
                if (fullRedirectUrl.includes('/pt/witch-power/date')) {
                    return res.redirect(302, '/pt/witch-power/date');
                }

                let proxiedRedirectPath = fullRedirectUrl;
                if (proxiedRedirectPath.startsWith(MAIN_TARGET_URL)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(MAIN_TARGET_URL, '');
                } else if (proxiedRedirectPath.startsWith(READING_SUBDOMAIN_TARGET)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(READING_SUBDOMAIN_TARGET, '/reading');
                }
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // Headers de resposta
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        // Modificação de HTML (otimizada)
        if (htmlContent) {
            let html = htmlContent;

            const $ = cheerio.load(html);

            // Reescrever URLs
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
                        if (originalUrl.startsWith(MAIN_TARGET_URL)) {
                            element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        } else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) {
                            element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                        }
                    }
                }
            });

            // === INJEÇÃO OTIMIZADA DE SCRIPTS ===
            const pixelCodes = `
                <!-- Meta Pixel Code -->
                <script>
                !function(f,b,e,v,n,t,s)
                {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
                n.callMethod.apply(n,arguments):n.queue.push(arguments)};
                if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
                n.queue=[];t=b.createElement(e);t.async=!0;
                t.src=v;s=b.getElementsByTagName(e)[0];
                s.parentNode.insertBefore(t,s)}(window, document,'script',
                'https://connect.facebook.net/en_US/fbevents.js');
                fbq('init', '1162364828302806');
                fbq('track', 'PageView');
                </script>
                
                <script>
                window.pixelId = "67f4b913c96cba3bbf63bc84";
                var a = document.createElement("script");
                a.setAttribute("async", "");
                a.setAttribute("defer", "");
                a.setAttribute("src", "https://cdn.utmify.com.br/scripts/pixel/pixel.js");
                document.head.appendChild(a);
                </script>

                <script src="https://cdn.utmify.com.br/scripts/utms/latest.js" data-utmify-prevent-xcod-sck data-utmify-prevent-subids async defer></script>
                <script src="https://curtinaz.github.io/keep-params/keep-params.js" async defer></script>
            `;

            $('head').prepend(pixelCodes);

            // Noscript otimizado
            const noscriptCodes = `
                <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1162364828302806&ev=PageView&noscript=1" /></noscript>
            `;
            $('body').prepend(noscriptCodes);

            // === SCRIPT CLIENT-SIDE OTIMIZADO ===
            const clientScript = `
                <script>
                (function() {
                    if (window.proxyScriptLoaded) return;
                    window.proxyScriptLoaded = true;
                    
                    const readingSubdomainTarget = '${READING_SUBDOMAIN_TARGET}';
                    const mainTargetOrigin = '${MAIN_TARGET_URL}';
                    const proxyReadingPrefix = '/reading';
                    const proxyApiPrefix = '${currentProxyHost}/api-proxy';
                    const currentProxyHost = '${currentProxyHost}';
                    const targetPagePath = '/pt/witch-power/wpGoal';

                    // Proxy otimizado para fetch
                    const originalFetch = window.fetch;
                    window.fetch = function(input, init) {
                        let url = input;
                        if (typeof input === 'string') {
                            if (input.startsWith(readingSubdomainTarget)) {
                                url = input.replace(readingSubdomainTarget, proxyReadingPrefix);
                            } else if (input.startsWith('https://api.appnebula.co')) {
                                url = input.replace('https://api.appnebula.co', proxyApiPrefix);
                            } else if (input.startsWith(mainTargetOrigin)) {
                                url = input.replace(mainTargetOrigin, currentProxyHost);
                            }
                        }
                        return originalFetch.call(this, url, init);
                    };

                    // Gerenciamento otimizado de botões invisíveis
                    let buttonsInjected = false;
                    let monitorInterval;
                    
                    const invisibleButtonsConfig = [
                        { id: 'btn-choice-1', top: '207px', left: '50px', width: '330px', height: '66px', text: 'descobrir seus poderes ocultos' },
                        { id: 'btn-choice-2', top: '292px', left: '50px', width: '330px', height: '66px', text: 'identificar seu arquétipo de bruxa' },
                        { id: 'btn-choice-3', top: '377px', left: '50px', width: '330px', height: '66px', text: 'explorar suas vidas passadas' },
                        { id: 'btn-choice-4', top: '460px', left: '50px', width: '330px', height: '66px', text: 'revelar sua aura de bruxa' },
                        { id: 'btn-choice-5', top: '543px', left: '50px', width: '330px', height: '66px', text: 'desvendar seu destino e propósito' },
                        { id: 'btn-choice-6', top: '628px', left: '50px', width: '330px', height: '66px', text: 'encontrar marcas, símbolos que os guiem' }
                    ];

                    function manageInvisibleButtons() {
                        const currentPagePath = window.location.pathname;
                        const isTargetPage = currentPagePath === targetPagePath;

                        if (isTargetPage && !buttonsInjected) {
                            invisibleButtonsConfig.forEach(config => {
                                const button = document.createElement('div');
                                button.id = config.id;
                                button.style.cssText = \`position:absolute;top:\${config.top};left:\${config.left};width:\${config.width};height:\${config.height};z-index:9999999;cursor:pointer;opacity:0;pointer-events:auto\`;
                                document.body.appendChild(button);

                                button.addEventListener('click', (event) => {
                                    event.preventDefault();
                                    button.style.pointerEvents = 'none';
                                    
                                    const rect = button.getBoundingClientRect();
                                    const x = rect.left + rect.width / 2;
                                    const y = rect.top + rect.height / 2;
                                    const targetElement = document.elementFromPoint(x, y);

                                    if (targetElement) {
                                        const clickEvent = new MouseEvent('click', {
                                            view: window,
                                            bubbles: true,
                                            cancelable: true,
                                            clientX: x,
                                            clientY: y
                                        });
                                        targetElement.dispatchEvent(clickEvent);

                                        fetch('/api/set-selected-choice', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ selectedText: config.text })
                                        }).catch(() => {});
                                    }
                                    
                                    button.remove();
                                });
                            });
                            buttonsInjected = true;
                        } else if (!isTargetPage && buttonsInjected) {
                            invisibleButtonsConfig.forEach(config => {
                                const buttonElement = document.getElementById(config.id);
                                if (buttonElement) buttonElement.remove();
                            });
                            buttonsInjected = false;
                        }
                    }

                    // Redirecionamentos otimizados
                    function handleRedirects() {
                        const currentPath = window.location.pathname;
                        if (currentPath.startsWith('/pt/witch-power/email')) {
                            window.location.replace('/pt/witch-power/onboarding');
                        }
                    }

                    // Event listeners otimizados
                    document.addEventListener('DOMContentLoaded', () => {
                        manageInvisibleButtons();
                        handleRedirects();
                        monitorInterval = setInterval(() => {
                            manageInvisibleButtons();
                            handleRedirects();
                        }, 1000); // Reduzido de 500ms para 1000ms
                    });

                    window.addEventListener('beforeunload', () => {
                        if (monitorInterval) clearInterval(monitorInterval);
                    });
                })();
                </script>
            `;

            $('head').append(clientScript);

            // Conversão de moeda
            html = $.html().replace(CONVERSION_PATTERN, (match, p1) => {
                const usdValue = parseFloat(p1);
                const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2);
                return `R$${brlValue.replace('.', ',')}`;
            });

            res.status(response.status).send(html);
        } else {
            res.status(response.status).send(responseData);
        }

    } catch (error) {
        if (error.response) {
            res.status(error.response.status).send(error.response.data || 'Erro ao processar a requisição de proxy.');
        } else {
            res.status(500).send('Erro ao processar a requisição de proxy.');
        }
    }
});

// Limpar cache periodicamente
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            responseCache.delete(key);
        }
    }
}, 60000); // Limpar a cada minuto

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor proxy otimizado rodando na porta ${PORT}`);
});
