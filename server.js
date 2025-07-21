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

// === SISTEMA DE CACHE ULTRA INTELIGENTE ===
// Cache separado por tipo - NUNCA afeta dados críticos do quiz
const staticCache = new Map();     // Para assets estáticos (CSS, JS, imagens)
const apiCache = new Map();        // Para APIs não-críticas
const htmlCache = new Map();       // Para HTML não-dinâmico

// TTLs diferenciados por importância
const STATIC_TTL = 60 * 60 * 1000;     // 1 hora para assets
const API_TTL = 30 * 1000;             // 30 segundos para APIs
const HTML_TTL = 2 * 60 * 1000;        // 2 minutos para HTML

// ROTAS CRÍTICAS DO QUIZ - NUNCA CACHEAR
const CRITICAL_QUIZ_PATHS = new Set([
    '/api/set-selected-choice',
    '/api/captured-text',
    '/pt/witch-power/wpGoal',
    '/pt/witch-power/trialChoice',
    '/pt/witch-power/date',
    '/pt/witch-power/goalInfo'
]);

// Blacklist otimizada para source maps
const SOURCE_MAP_BLACKLIST = new Set([
    'webpack-9ea6f8e4303b980f.js.map',
    'framework-539e802e8ad6dc46.js.map',
    'main-26483a53561eea0f.js.map',
    'pages/_app-b172266ab9529c0b.js.map',
    '441.afceb13c3457e915.js.map',
    '3877-e3989dc0aafc7891.js.map',
    '952.cb8a9c3196ee1ba5.js.map',
    '1213-6a006800accf3eb8.js.map',
    '8093-0f207c0f0a66eb24.js.map',
    '9273-e74aebc5d0f6de5f.js.map',
    '580-edb42352b0e48dc0.js.map',
    '7006-afe77ea44f8e386b.js.map',
    '1042-eb59b799cf1f0a44.js.map',
    '1192.f192ca309350aaec.js.map',
    '8388.68ca0ef4e73fbb0b.js.map',
    'e7b68a54.18796a59da6d408d.js.map',
    '5238.92789ea0e4e4659b.js.map'
]);

// === MIDDLEWARE DE COMPRESSÃO AVANÇADA ===
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    },
    level: 6,
    threshold: 1024,
    memLevel: 8
}));

// === BLOQUEIO INTELIGENTE DE SOURCE MAPS ===
app.use((req, res, next) => {
    const filename = path.basename(req.url);
    if (filename.endsWith('.js.map') && SOURCE_MAP_BLACKLIST.has(filename)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(404).end();
    }
    next();
});

// === HEADERS DE PERFORMANCE OTIMIZADOS ===
app.use((req, res, next) => {
    const url = req.url;
    
    // Assets estáticos - cache agressivo
    if (url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('ETag', `"${Date.now()}"`);
        res.setHeader('Vary', 'Accept-Encoding');
    }
    // HTML e dados dinâmicos - sem cache
    else if (url.includes('witch-power') || url.includes('api')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    // Outros recursos - cache moderado
    else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    
    // Headers de segurança e performance
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    next();
});

// === VARIÁVEIS DO QUIZ - PROTEGIDAS ===
let capturedBoldText = 'identificar seu arquétipo de bruxa';
let lastCaptureTime = Date.now();
let isCapturing = false;

// === HTTPS AGENT ULTRA OTIMIZADO ===
const agent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
    maxFreeSockets: 50,
    timeout: 12000,
    freeSocketTimeout: 15000,
    socketActiveTTL: 60000
});

// === CONFIGURAÇÃO DE UPLOAD OTIMIZADA ===
app.use(fileUpload({
    limits: { 
        fileSize: 50 * 1024 * 1024,
        files: 5,
        fields: 20 
    },
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true,
    useTempFiles: true,
    tempFileDir: '/tmp/',
    uploadTimeout: 30000,
    debug: false
}));

// === ARQUIVOS ESTÁTICOS ULTRA OTIMIZADOS ===
app.use(express.static(path.join(__dirname, 'dist'), {
    maxAge: '1y',
    etag: true,
    lastModified: true,
    immutable: true,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// === CORS OTIMIZADO ===
app.use(cors({
    origin: true,
    credentials: true,
    optionsSuccessStatus: 200,
    preflightContinue: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// === BODY PARSING ULTRA EFICIENTE ===
app.use((req, res, next) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        express.json({ 
            limit: '2mb',
            strict: true,
            type: 'application/json'
        })(req, res, () => {
            express.urlencoded({ 
                extended: true, 
                limit: '2mb',
                parameterLimit: 100
            })(req, res, next);
        });
    } else {
        next();
    }
});

// === FUNÇÃO DE CACHE INTELIGENTE ===
function shouldCache(url, method) {
    // NUNCA cachear rotas críticas do quiz
    for (const criticalPath of CRITICAL_QUIZ_PATHS) {
        if (url.includes(criticalPath)) return false;
    }
    
    // NUNCA cachear POSTs
    if (method !== 'GET') return false;
    
    // Cachear apenas assets e APIs específicas
    return url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/) || 
           url.includes('/_next/static/') ||
           url.includes('/api/v1/user/locale');
}

function getFromCache(url, cacheType) {
    const cache = cacheType === 'static' ? staticCache : 
                  cacheType === 'api' ? apiCache : htmlCache;
    
    const cached = cache.get(url);
    if (!cached) return null;
    
    const ttl = cacheType === 'static' ? STATIC_TTL :
                cacheType === 'api' ? API_TTL : HTML_TTL;
    
    if (Date.now() - cached.timestamp > ttl) {
        cache.delete(url);
        return null;
    }
    
    return cached;
}

function setCache(url, data, cacheType) {
    const cache = cacheType === 'static' ? staticCache : 
                  cacheType === 'api' ? apiCache : htmlCache;
    
    cache.set(url, {
        ...data,
        timestamp: Date.now()
    });
    
    // Limitar tamanho do cache
    if (cache.size > 1000) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }
}

// === API ENDPOINTS PROTEGIDOS ===
app.get('/api/captured-text', async (req, res) => {
    console.log('📡 API /api/captured-text chamada - DADOS CRÍTICOS DO QUIZ');

    // NUNCA cachear dados críticos do quiz
    if (!capturedBoldText || capturedBoldText === 'identificar seu arquétipo de bruxa' || (Date.now() - lastCaptureTime > 3600000 && !isCapturing)) {
        console.log('🔄 Texto capturado ausente/antigo. Tentando recapturar do site original...');
        await captureTextDirectly();
    }

    console.log('📝 Texto atual na variável:', `"${capturedBoldText}"`);
    console.log('🕐 Último tempo de captura:', new Date(lastCaptureTime).toISOString());
    console.log('🔄 Está capturando:', isCapturing);

    const responseData = {
        capturedText: capturedBoldText,
        lastCaptureTime: lastCaptureTime,
        isCapturing: isCapturing,
        timestamp: Date.now()
    };

    res.json(responseData);
});

// === ENDPOINT CRÍTICO PARA BOTÕES INVISÍVEIS ===
app.post('/api/set-selected-choice', (req, res) => {
    const { selectedText } = req.body;
    
    console.log('🎯 DADOS CRÍTICOS DO QUIZ RECEBIDOS:', selectedText);
    
    if (selectedText) {
        capturedBoldText = selectedText;
        lastCaptureTime = Date.now();
        
        console.log(`✅ Texto selecionado pelo usuário recebido e atualizado: "${capturedBoldText}"`);
        console.log('🔒 DADOS PROTEGIDOS - Não serão cacheados ou perdidos');
        
        res.status(200).json({ 
            message: 'Texto atualizado com sucesso.', 
            capturedText: capturedBoldText,
            timestamp: Date.now()
        });
    } else {
        res.status(400).json({ message: 'Nenhum texto fornecido.' });
    }
});

// === FUNÇÕES DE CAPTURA - MANTIDAS 100% INTACTAS ===
function extractTextFromHTML(html) {
    console.log('\n🔍 EXTRAINDO TEXTO DO HTML');

    try {
        const $ = cheerio.load(html);

        // ESTRATÉGIA 1: Procurar pelo padrão específico no texto completo
        const startPhrase = 'Ajudamos milhões de pessoas a ';
        const endPhrase = ', e queremos ajudar você também.';

        const fullText = $('body').text();
        console.log('📄 Tamanho do texto completo:', fullText.length);

        if (fullText.includes(startPhrase) && fullText.includes(endPhrase)) {
            const startIndex = fullText.indexOf(startPhrase) + startPhrase.length;
            const endIndex = fullText.indexOf(endPhrase);

            if (startIndex < endIndex) {
                const extractedContent = fullText.substring(startIndex, endIndex).trim();

                if (extractedContent.length > 5) {
                    console.log('✅ ESTRATÉGIA 1: Texto extraído do HTML completo:', `"${extractedContent}"`);
                    return extractedContent;
                }
            }
        }

        // ESTRATÉGIA 2: Procurar em elementos específicos
        const patterns = [
            'p:contains("Ajudamos milhões") b',
            'b:contains("identificar")',
            'b:contains("arquétipo")',
            'b:contains("bruxa")',
            'b:contains("explorar")',
            'b:contains("desvendar")',
            'b:contains("descobrir")',
            'b:contains("revelar")'
        ];

        for (const pattern of patterns) {
            const element = $(pattern).first();
            if (element.length > 0) {
                const text = element.text().trim();
                if (text.length > 10 &&
                    !text.includes('$') &&
                    !text.includes('SATISFAÇÃO') &&
                    !text.includes('ECONOMIA')) {
                    console.log(`✅ ESTRATÉGIA 2: Texto encontrado com padrão "${pattern}":`, `"${text}"`);
                    return text;
                }
            }
        }

        // ESTRATÉGIA 3: Buscar todos os <b> relevantes
        const boldElements = $('b');
        const relevantTexts = [];

        boldElements.each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 10 &&
                !text.includes('$') &&
                !text.includes('€') &&
                !text.includes('R$') &&
                !text.includes('SATISFAÇÃO') &&
                !text.includes('ECONOMIA') &&
                (text.includes('identificar') ||
                 text.includes('arquétipo') ||
                 text.includes('bruxa') ||
                 text.includes('explorar') ||
                 text.includes('desvendar') ||
                 text.includes('descobrir') ||
                 text.includes('revelar'))) {
                relevantTexts.push(text);
            }
        });

        console.log('📝 Todos os <b> relevantes encontrados:', relevantTexts);

        if (relevantTexts.length > 0) {
            console.log('✅ ESTRATÉGIA 3: Usando primeiro <b> relevante:', `"${relevantTexts[0]}"`);
            return relevantTexts[0];
        }

        // ESTRATÉGIA 4: Regex para encontrar o padrão no HTML bruto
        const regexPattern = /Ajudamos milhões de pessoas a\s*<b[^>]*>([^<]+)<\/b>\s*,\s*e queremos ajudar você também/gi;
        const match = html.match(regexPattern);

        if (match && match[0]) {
            const boldMatch = match[0].match(/<b[^>]*>([^<]+)<\/b>/i);
            if (boldMatch && boldMatch[1]) {
                const text = boldMatch[1].trim();
                console.log('✅ ESTRATÉGIA 4: Texto extraído via regex:', `"${text}"`);
                return text;
            }
        }

        console.log('❌ Nenhuma estratégia funcionou');
        return null;

    } catch (error) {
        console.log('❌ Erro ao extrair texto do HTML:', error.message);
        return null;
    }
}

async function captureTextDirectly() {
    if (isCapturing) {
        console.log('⏳ Captura já em andamento...');
        return capturedBoldText;
    }

    isCapturing = true;

    try {
        console.log('\n🎯 FAZENDO REQUISIÇÃO DIRETA PARA CAPTURAR TEXTO');
        console.log('🌐 URL:', `${MAIN_TARGET_URL}/pt/witch-power/trialChoice`);

        const response = await axios.get(`${MAIN_TARGET_URL}/pt/witch-power/trialChoice`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            responseType: 'arraybuffer',
            timeout: 15000,
            httpsAgent: agent,
        });

        console.log('✅ Resposta recebida! Status:', response.status);

        let responseData = response.data;
        const contentEncoding = response.headers['content-encoding'];
        if (contentEncoding === 'gzip') {
            console.log('📦 Descomprimindo resposta gzip...');
            responseData = zlib.gunzipSync(responseData);
        } else if (contentEncoding === 'deflate') {
            console.log('📦 Descomprimindo resposta deflate...');
            responseData = zlib.inflateSync(responseData);
        } else if (contentEncoding === 'br') {
            console.log('📦 Descomprimindo resposta brotli...');
            responseData = zlib.brotliDecompressSync(responseData);
        }

        const html = responseData.toString('utf8');
        console.log('📊 Tamanho do HTML (após descompressão):', html.length);

        if (html.includes('Ajudamos milhões de pessoas a')) {
            console.log('🎉 HTML contém o padrão "Ajudamos milhões de pessoas a"!');

            const extractedText = extractTextFromHTML(html);

            if (extractedText && extractedText.length > 5) {
                capturedBoldText = extractedText;
                lastCaptureTime = Date.now();
                console.log('🎉 SUCESSO! Texto capturado:', `"${capturedBoldText}"`);
                return capturedBoldText;
            } else {
                console.log('⚠️ Padrão encontrado mas não conseguiu extrair texto');
            }
        } else {
            console.log('⚠️ HTML não contém o padrão esperado');
            console.log('📝 Primeiros 500 caracteres do HTML:');
            console.log(html.substring(0, 500));
        }

        console.log('❌ Não foi possível capturar o texto');

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
                capturedBoldText = text;
                lastCaptureTime = Date.now();
                console.log('✅ Texto encontrado no HTML:', `"${capturedBoldText}"`);
                return capturedBoldText;
            }
        }

        capturedBoldText = 'identificar seu arquétipo de bruxa';
        lastCaptureTime = Date.now();
        console.log('⚠️ Usando fallback:', `"${capturedBoldText}"`);

        return capturedBoldText;

    } catch (error) {
        console.error('❌ ERRO na requisição direta:', error.message);

        capturedBoldText = 'identificar seu arquétipo de bruxa';
        lastCaptureTime = Date.now();
        console.log('⚠️ Usando fallback de erro:', `"${capturedBoldText}"`);

        return capturedBoldText;
    } finally {
        isCapturing = false;
        console.log('🏁 Captura finalizada\n');
    }
}

// === ROTAS ESPECÍFICAS - 100% INTACTAS ===
app.get('/pt/witch-power/trialChoice', async (req, res) => {
    console.log('\n=== INTERCEPTANDO TRIALCHOICE ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('URL acessada:', req.url);

    try {
        console.log('✅ Servindo página React customizada (trialChoice)...\n');
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));

    } catch (error) {
        console.error('\n❌ ERRO CRÍTICO ao servir trialChoice:', error.message);
        res.status(500).send('Erro ao carregar a página customizada.');
    }
});

app.get('/pt/witch-power/date', async (req, res) => {
    console.log('\n=== INTERCEPTANDO DATE ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('URL acessada:', req.url);

    try {
        console.log('✅ Servindo página React customizada (Date)...\n');
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));

    } catch (error) {
        console.error('\n❌ ERRO CRÍTICO ao servir date:', error.message);
        res.status(500).send('Erro ao carregar a página de data.');
    }
});

// === PROXY DA API ULTRA OTIMIZADO ===
app.use('/api-proxy', async (req, res) => {
    const apiTargetUrl = `https://api.appnebula.co${req.url.replace('/api-proxy', '')}`;
    
    // Cache inteligente apenas para GETs não-críticos
    if (shouldCache(req.url, req.method)) {
        const cached = getFromCache(req.url, 'api');
        if (cached) {
            return res.status(cached.status).set(cached.headers).send(cached.data);
        }
    }
    
    console.log(`[API PROXY] Requisição: ${req.url} -> Proxy para: ${apiTargetUrl}`);

    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding'];

    try {
        const response = await axios({
            method: req.method,
            url: apiTargetUrl,
            headers: requestHeaders,
            data: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined,
            responseType: 'arraybuffer',
            maxRedirects: 0,
            timeout: 12000,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            },
            httpsAgent: agent,
        });

        // Headers de resposta
        const responseHeaders = {};
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                responseHeaders[header] = response.headers[header];
                res.setHeader(header, response.headers[header]);
            }
        });

        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                return cookie
                    .replace(/Domain=[^;]+/, '')
                    .replace(/; Secure/, '')
                    .replace(/; Path=\//, `; Path=/api-proxy${req.baseUrl || '/'}`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // Cache apenas para requests seguros
        if (shouldCache(req.url, req.method)) {
            setCache(req.url, {
                status: response.status,
                headers: responseHeaders,
                data: response.data
            }, 'api');
        }

        res.status(response.status).send(response.data);

    } catch (error) {
        console.error('[API PROXY] Erro na requisição da API:', error.message);
        if (error.response) {
            console.error('[API PROXY] Status da API:', error.response.status);
            res.status(error.response.status).send(error.response.data);
        } else {
            res.status(500).send('Erro ao proxy a API.');
        }
    }
});

// === MIDDLEWARE PRINCIPAL ULTRA OTIMIZADO ===
app.use(async (req, res) => {
    let targetDomain = MAIN_TARGET_URL;
    let requestPath = req.url;
    const currentProxyHost = req.protocol + '://' + req.get('host');

    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    
    if (!req.files || Object.keys(req.files).length === 0) {
        delete requestHeaders['accept-encoding'];
    }

    // Lógica para Proxeamento do Subdomínio de Leitura - MANTIDA INTACTA
    if (req.url.startsWith('/reading/')) {
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
    
    // Cache inteligente para assets estáticos
    if (shouldCache(req.url, req.method)) {
        const cacheType = req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/) ? 'static' : 'html';
        const cached = getFromCache(req.url, cacheType);
        if (cached) {
            Object.keys(cached.headers || {}).forEach(header => {
                res.setHeader(header, cached.headers[header]);
            });
            return res.status(cached.status || 200).send(cached.data);
        }
    }

    try {
        let requestData = req.body;

        // Lógica de upload - MANTIDA 100% INTACTA
        if (req.files && Object.keys(req.files).length > 0) {
            const photoFile = req.files.photo;
            if (photoFile) {
                console.log('[UPLOAD] Processando upload de arquivo:', photoFile.name);
                const formData = new FormData();
                formData.append('photo', photoFile.data, {
                    filename: photoFile.name,
                    contentType: photoFile.mimetype,
                });
                requestData = formData;
                delete requestHeaders['content-type'];
                delete requestHeaders['content-length'];
                Object.assign(requestHeaders, formData.getHeaders());
                console.log('[UPLOAD] FormData configurado com headers:', formData.getHeaders());
            }
        }

        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: requestHeaders,
            data: requestData,
            responseType: 'arraybuffer',
            timeout: 15000,
            maxRedirects: 0,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            },
            httpsAgent: agent,
        });

        // Descompressão - MANTIDA INTACTA
        let responseData = response.data;
        const contentEncoding = response.headers['content-encoding'];
        let htmlContent = null;

        if (contentEncoding === 'gzip') {
            console.log('SERVER: Descomprimindo resposta gzip do destino...');
            responseData = zlib.gunzipSync(responseData);
        } else if (contentEncoding === 'deflate') {
            console.log('SERVER: Descomprimindo resposta deflate do destino...');
            responseData = zlib.inflateSync(responseData);
        } else if (contentEncoding === 'br') {
            console.log('SERVER: Descomprimindo resposta brotli do destino...');
            responseData = zlib.brotliDecompressSync(responseData);
        }

        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            htmlContent = responseData.toString('utf8');
            console.log(`SERVER: Conteúdo HTML recebido do destino. Tamanho: ${htmlContent.length}`);
        } else {
            console.log(`SERVER: Conteúdo não é HTML. Tipo: ${contentType}`);
        }

        // Redirecionamentos - MANTIDOS 100% INTACTOS
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

                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('SERVER: Interceptando redirecionamento do servidor de destino para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }
                if (fullRedirectUrl.includes('/pt/witch-power/wpGoal')) {
                    console.log('SERVER: Interceptando redirecionamento para /wpGoal. Redirecionando para /pt/witch-power/trialChoice.');
                    return res.redirect(302, '/pt/witch-power/trialChoice');
                }
                if (fullRedirectUrl.includes('/pt/witch-power/date')) {
                    console.log('SERVER: Interceptando redirecionamento para /date. Redirecionando para /pt/witch-power/date.');
                    return res.redirect(302, '/pt/witch-power/date');
                }

                let proxiedRedirectPath = fullRedirectUrl;
                if (proxiedRedirectPath.startsWith(MAIN_TARGET_URL)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(MAIN_TARGET_URL, '');
                } else if (proxiedRedirectPath.startsWith(READING_SUBDOMAIN_TARGET)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(READING_SUBDOMAIN_TARGET, '/reading');
                }
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

                console.log(`SERVER: Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // Headers de resposta
        const responseHeaders = {};
        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                responseHeaders[header] = response.headers[header];
                res.setHeader(header, response.headers[header]);
            }
        });

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

        // Cache para assets estáticos APENAS
        if (shouldCache(req.url, req.method)) {
            const cacheType = req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/) ? 'static' : 'html';
            setCache(req.url, {
                status: response.status,
                headers: responseHeaders,
                data: responseData
            }, cacheType);
        }

        // Modificação de HTML - MANTIDA 100% INTACTA
        if (htmlContent) {
            let html = htmlContent;

            if (html.includes('Ajudamos milhões de pessoas a') && !isCapturing && !capturedBoldText) {
                console.log('SERVER: INTERCEPTANDO HTML NO MIDDLEWARE para pré-popular capturedBoldText!');
                const extractedText = extractTextFromHTML(html);
                if (extractedText && extractedText.length > 5) {
                    capturedBoldText = extractedText;
                    lastCaptureTime = Date.now();
                    console.log('SERVER: SUCESSO! Texto capturado via middleware:', `"${capturedBoldText}"`);
                }
            }

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
                        if (originalUrl.startsWith('/')) {
                            // URLs relativas já são tratadas pelo proxy
                        } else if (originalUrl.startsWith(MAIN_TARGET_URL)) {
                            element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        } else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) {
                            element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                        }
                    }
                }
            });

            // === CÓDIGOS DE PIXEL - MANTIDOS 100% INTACTOS ===
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
                <!-- End Meta Pixel Code -->

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
                fbq('init', '1770667103479094');
                fbq('track', 'PageView');
                </script>
                <!-- End Meta Pixel Code -->

                <script>
                window.pixelId = "67f4b913c96cba3bbf63bc84";
                var a = document.createElement("script");
                a.setAttribute("async", "");
                a.setAttribute("defer", "");
                a.setAttribute("src", "https://cdn.utmify.com.br/scripts/pixel/pixel.js");
                document.head.appendChild(a);
                </script>

                <script
                src="https://cdn.utmify.com.br/scripts/utms/latest.js"
                data-utmify-prevent-xcod-sck
                data-utmify-prevent-subids
                async
                defer
                ></script>

                <script src="https://curtinaz.github.io/keep-params/keep-params.js"></script>
            `;

            $('head').prepend(pixelCodes);

            // === NOSCRIPT - MANTIDOS 100% INTACTOS ===
            const noscriptCodes = `
                <noscript><img height="1" width="1" style="display:none"
                src="https://www.facebook.com/tr?id=1162364828302806&ev=PageView&noscript=1"
                /></noscript>
                
                <noscript><img height="1" width="1" style="display:none"
                src="https://www.facebook.com/tr?id=1770667103479094&ev=PageView&noscript=1"
                /></noscript>
            `;

            $('body').prepend(noscriptCodes);

            // === SCRIPTS CLIENT-SIDE - MANTIDOS 100% INTACTOS ===
            const clientScript =
                '<script>' +
                '(function() {' +
                'if (window.proxyScriptLoaded) return;' +
                'window.proxyScriptLoaded = true;' +
                'console.log(\'CLIENT: INJECTED SCRIPT: Script started execution.\');' +
                'const readingSubdomainTarget = \'' + READING_SUBDOMAIN_TARGET + '\';' +
                'const mainTargetOrigin = \'' + MAIN_TARGET_URL + '\';' +
                'const proxyReadingPrefix = \'/reading\';' +
                'const proxyApiPrefix = \'' + currentProxyHost + '/api-proxy\';' +
                'const currentProxyHost = \'' + currentProxyHost + '\';' +
                'const targetPagePath = \'/pt/witch-power/wpGoal\';' +

                'const originalFetch = window.fetch;' +
                'window.fetch = function(input, init) {' +
                'let url = input;' +
                'if (typeof input === \'string\') {' +
                'if (input.startsWith(readingSubdomainTarget)) { url = input.replace(readingSubdomainTarget, proxyReadingPrefix); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH URL (Reading): \', input, \'->\', url); }' +
                'else if (input.startsWith(\'https://api.appnebula.co\')) { url = input.replace(\'https://api.appnebula.co\', proxyApiPrefix); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH URL (API): \', input, \'->\', url); }' +
                'else if (input.startsWith(mainTargetOrigin)) { url = input.replace(mainTargetOrigin, currentProxyHost); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH URL (Main): \', input, \'->\', url); }' +
                '} else if (input instanceof Request) {' +
                'if (input.url.startsWith(readingSubdomainTarget)) { url = new Request(input.url.replace(readingSubdomainTarget, proxyReadingPrefix), input); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH Request Object URL (Reading): \', input.url, \'->\', url.url); }' +
                'else if (input.url.startsWith(\'https://api.appnebula.co\')) { url = new Request(input.url.replace(\'https://api.appnebula.co\', proxyApiPrefix), input); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH Request Object URL (API): \', input.url, \'->\', url.url); }' +
                'else if (input.url.startsWith(mainTargetOrigin)) { url = new Request(input.url.replace(mainTargetOrigin, currentProxyHost), input); console.log(\'CLIENT: PROXY SHIM: REWRITE FETCH Request Object URL (Main): \', input.url, \'->\', url.url); }' +
                '}' +
                'return originalFetch.call(this, url, init);' +
                '};' +
                'const originalXHRopen = XMLHttpRequest.prototype.open;' +
                'XMLHttpRequest.prototype.open = function(method, url, async, user, password) {' +
                'let modifiedUrl = url;' +
                'if (typeof url === \'string\') {' +
                'if (url.startsWith(readingSubdomainTarget)) { modifiedUrl = url.replace(readingSubdomainTarget, proxyReadingPrefix); console.log(\'CLIENT: PROXY SHIM: REWRITE XHR URL (Reading): \', url, \'->\', modifiedUrl); }' +
                'else if (url.startsWith(\'https://api.appnebula.co\')) { modifiedUrl = url.replace(\'https://api.appnebula.co\', proxyApiPrefix); console.log(\'CLIENT: PROXY SHIM: REWRITE XHR URL (API): \', url, \'->\', modifiedUrl); }' +
                'else if (url.startsWith(mainTargetOrigin)) { modifiedUrl = url.replace(mainTargetOrigin, currentProxyHost); console.log(\'CLIENT: PROXY SHIM: REWRITE XHR URL (Main): \', url, \'->\', modifiedUrl); }' +
                '}' +
                'originalXHRopen.call(this, method, modifiedUrl, async, user, password);' +
                '};\n' +
                'const originalPostMessage = window.postMessage;' +
                'window.postMessage = function(message, targetOrigin, transfer) {' +
                'let modifiedTargetOrigin = targetOrigin;' +
                'if (typeof targetOrigin === \'string\' && targetOrigin.startsWith(mainTargetOrigin)) { modifiedTargetOrigin = currentProxyHost; console.log(\'CLIENT: PROXY SHIM: REWRITE PostMessage TargetOrigin: \', targetOrigin, \'->\', modifiedTargetOrigin); }' +
                'originalPostMessage.call(this, message, modifiedTargetOrigin, transfer);' +
                '};\n' +

                // === BOTÕES INVISÍVEIS - MANTIDOS 100% INTACTOS ===
                'let buttonsInjected = false;' +
                'const invisibleButtonsConfig = [' +
                '{ id: \'btn-choice-1\', top: \'207px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'descobrir seus poderes ocultos\' },' +
                '{ id: \'btn-choice-2\', top: \'292px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'identificar seu arquétipo de bruxa\' },' +
                '{ id: \'btn-choice-3\', top: \'377px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'explorar suas vidas passadas\' },' +
                '{ id: \'btn-choice-4\', top: \'460px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'revelar sua aura de bruxa\' },' +
                '{ id: \'btn-choice-5\', top: \'543px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'desvendar seu destino e propósito\' },' +
                '{ id: \'btn-choice-6\', top: \'628px\', left: \'50px\', width: \'330px\', height: \'66px\', text: \'encontrar marcas, símbolos que os guiem\' }' +
                '];' +

                'function manageInvisibleButtons() {' +
                'const currentPagePath = window.location.pathname;' +
                'const isTargetPage = currentPagePath === targetPagePath;' +
                'console.log(\'[Monitor] URL atual: \' + currentPagePath + \'. Página alvo: \' + targetPagePath + \'. É a página alvo? \' + isTargetPage);' +

                'if (isTargetPage && !buttonsInjected) {' +
                'console.log(\'Página wpGoal detectada! Injetando botões invisíveis...\');' +
                
                'invisibleButtonsConfig.forEach(config => {' +
                'const button = document.createElement(\'div\');' +
                'button.id = config.id;' +
                'button.style.position = \'absolute\';' +
                'button.style.top = config.top;' + 
                'button.style.left = config.left;' + 
                'button.style.width = config.width;' + 
                'button.style.height = config.height;' + 
                'button.style.zIndex = \'9999999\';' + 
                'button.style.cursor = \'pointer\';' + 
                'button.style.opacity = \'0\';' + 
                'button.style.pointerEvents = \'auto\';' + 
                'document.body.appendChild(button);' +
                'console.log(\'✅ Botão invisível \\\'\' + config.id + \'\\\' injetado na página wpGoal!\');' +

                'button.addEventListener(\'click\', (event) => {' +
                'console.log(\'🎉 Botão invisível \\\'\' + config.id + \'\\\' clicado na wpGoal!\');' +
                'button.style.pointerEvents = \'none\';' + 
                'const rect = button.getBoundingClientRect();' +
                'const x = rect.left + rect.width / 2;' +
                'const y = rect.top + rect.height / 2;' +
                'const targetElement = document.elementFromPoint(x, y);' +

                'if (targetElement) {' +
                'console.log(\'Simulando clique no elemento original:\', targetElement);' +
                'const clickEvent = new MouseEvent(\'click\', {' +
                'view: window,' +
                'bubbles: true,' +
                'cancelable: true,' +
                'clientX: x,' +
                'clientY: y' +
                '});' +
                'targetElement.dispatchEvent(clickEvent);' +
                'console.log(\'Cliques simulados em:\', targetElement);' +

                'try {' +
                'fetch(\'/api/set-selected-choice\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify({ selectedText: config.text }) });' +
                'console.log(`CLIENT: INJECTED SCRIPT: Escolha \'${config.text}\' enviada para o servidor.`);' +
                '} catch (error) { console.error(\'CLIENT: INJECTED SCRIPT: Erro ao enviar escolha para o servidor:\', error); }' +

                'window.postMessage({' +
                'type: \'QUIZ_CHOICE_SELECTED\',' +
                'text: config.text' +
                '}, window.location.origin);' + 
                'console.log(\'Dados enviados para o React: \\\'\' + config.text + \'\\\'\');' +
                '} else {' +
                'console.warn(\'Nenhum elemento encontrado para simular clique nas coordenadas. O botão original não foi detectado.\');' +
                '}' +
                'button.remove();' + 
                'console.log(\'🗑️ Botão invisível \\\'\' + config.id + \'\\\' removido após simulação de clique.\');' +
                'buttonsInjected = false;' + 
                '});' +
                '});' +
                'buttonsInjected = true;' + 
                '} else if (!isTargetPage && buttonsInjected) {' +
                'console.log(\'Saindo da página wpGoal. Removendo botões invisíveis...\');' +
                'invisibleButtonsConfig.forEach(config => {' +
                'const buttonElement = document.getElementById(config.id);' +
                'if (buttonElement) {' +
                'buttonElement.remove();' +
                'console.log(\'🗑️ Botão invisível \\\'\' + config.id + \'\\\' removido.\');' +
                '}' +
                '});' +
                'buttonsInjected = false;' + 
                '}' +
                '}' +

                'document.addEventListener(\'DOMContentLoaded\', function() {' +
                'console.log(\'Script de injeção de proxy carregado no cliente.\');' +
                'manageInvisibleButtons();' +
                'setInterval(manageInvisibleButtons, 500);' + 
                '});' +
                '})();' +
                '</script>';

            $('head').prepend(clientScript);

            // === REDIRECIONAMENTOS CLIENT-SIDE - MANTIDOS 100% INTACTOS ===
            $('head').append(
                '<script>' +
                'console.log(\'CLIENT-SIDE REDIRECT SCRIPT: Initializing.\');' +
                'let redirectCheckInterval;' +
                'function handleEmailRedirect() {' +
                'const currentPath = window.location.pathname;' +
                'if (currentPath.startsWith(\'/pt/witch-power/email\')) {' +
                'console.log(\'CLIENT-SIDE REDIRECT: URL /pt/witch-power/email detectada. Forçando redirecionamento para /pt/witch-power/onboarding\');' +
                'if (redirectCheckInterval) {' +
                'clearInterval(redirectCheckInterval);' +
                '}' +
                'window.location.replace(\'/pt/witch-power/onboarding\');' +
                '}' +
                '}' +
                'document.addEventListener(\'DOMContentLoaded\', handleEmailRedirect);' +
                'window.addEventListener(\'popstate\', handleEmailRedirect);' +
                'redirectCheckInterval = setInterval(handleEmailRedirect, 100);' +
                'window.addEventListener(\'beforeunload\', () => {' +
                'if (redirectCheckInterval) {' +
                'clearInterval(redirectCheckInterval);' +
                '}' +
                '});' +
                'handleEmailRedirect();' +
                '</script>'
            );

            $('head').append(
                '<script>' +
                'console.log(\'CLIENT-SIDE TRIALCHOICE REDIRECT SCRIPT: Initializing.\');' +
                'let trialChoiceRedirectInterval;' +
                'function handleTrialChoiceRedirect() {' +
                'const currentPagePath = window.location.pathname;' +
                'if (currentPath === \'/pt/witch-power/trialChoice\') {' +
                'console.log(\'CLIENT-SIDE REDIRECT: URL /pt/witch-power/trialChoice detectada. Forçando reload para interceptação do servidor.\');' +
                'if (trialChoiceRedirectInterval) {' +
                'clearInterval(trialChoiceRedirectInterval);' +
                '}' +
                'window.location.reload();' +
                '}' +
                '}' +
                'document.addEventListener(\'DOMContentLoaded\', handleTrialChoiceRedirect);' +
                'window.addEventListener(\'popstate\', handleTrialChoiceRedirect);' +
                'trialChoiceRedirectInterval = setInterval(handleTrialChoiceRedirect, 200);' +
                'if (window.MutationObserver && document.body) {' +
                'const observer = new MutationObserver(function(mutations) {' +
                'mutations.forEach(function(mutation) {' +
                'if (mutation.type === \'childList\' && mutation.addedNodes.length > 0) {' +
                'setTimeout(handleTrialChoiceRedirect, 50);' +
                '}' +
                '});' +
                '});' +
                'observer.observe(document.body, {' +
                'childList: true,' +
                'subtree: true' +
                '});' +
                '}' +
                'window.addEventListener(\'beforeunload\', () => {' +
                'if (trialChoiceRedirectInterval) {' +
                'clearInterval(trialChoiceRedirectInterval);' +
                '}' +
                '});' +
                'handleTrialChoiceRedirect();' +
                '</script>'
            );

            $('head').append(
                '<script>' +
                'console.log(\'CLIENT-SIDE DATE REDIRECT SCRIPT: Initializing.\');' +
                'let dateRedirectInterval;' +
                'function handleDateRedirect() {' +
                'const currentPath = window.location.pathname;' +
                'if (currentPath === \'/pt/witch-power/date\') {' +
                'console.log(\'CLIENT-SIDE REDIRECT: URL /pt/witch-power/date detectada. Forçando reload para interceptação do servidor.\');' +
                'if (dateRedirectInterval) {' +
                'clearInterval(dateRedirectInterval);' +
                '}' +
                'window.location.reload();' +
                '}' +
                '}' +
                'document.addEventListener(\'DOMContentLoaded\', handleDateRedirect);' +
                'window.addEventListener(\'popstate\', handleDateRedirect);' +
                'dateRedirectInterval = setInterval(handleDateRedirect, 200);' +
                'if (window.MutationObserver && document.body) {' +
                'const observer = new MutationObserver(function(mutations) {' +
                'mutations.forEach(function(mutation) {' +
                'if (mutation.type === \'childList\' && mutation.addedNodes.length > 0) {' +
                'setTimeout(handleDateRedirect, 50);' +
                '}' +
                '});' +
                '});' +
                'observer.observe(document.body, {' +
                'childList: true,' +
                'subtree: true' +
                '});' +
                '}' +
                'window.addEventListener(\'beforeunload\', () => {' +
                'if (dateRedirectInterval) {' +
                'clearInterval(dateRedirectInterval);' +
                '}' +
                '});' +
                'handleDateRedirect();' +
                '</script>'
            );

            console.log('SERVER: Script de cliente injetado no <head>.');

            // Conversão de moeda - MANTIDA INTACTA
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
        console.error(`❌ SERVER: ERRO no proxy para ${targetUrl}:`, error.message);
        if (error.response) {
            console.error('SERVER: Status do destino:', error.response.status);
            res.status(error.response.status).send(error.response.data || 'Erro ao processar a requisição de proxy.');
        } else {
            res.status(500).send('Erro ao processar a requisição de proxy.');
        }
    }
});

// === LIMPEZA INTELIGENTE DE CACHE ===
// Limpa apenas caches antigos, NUNCA dados críticos do quiz
setInterval(() => {
    const now = Date.now();
    
    // Limpar cache de estáticos antigos
    for (const [key, value] of staticCache.entries()) {
        if (now - value.timestamp > STATIC_TTL) {
            staticCache.delete(key);
        }
    }
    
    // Limpar cache de API antigos
    for (const [key, value] of apiCache.entries()) {
        if (now - value.timestamp > API_TTL) {
            apiCache.delete(key);
        }
    }
    
    // Limpar cache de HTML antigos
    for (const [key, value] of htmlCache.entries()) {
        if (now - value.timestamp > HTML_TTL) {
            htmlCache.delete(key);
        }
    }
    
    console.log(`🧹 Cache cleanup: Static=${staticCache.size}, API=${apiCache.size}, HTML=${htmlCache.size}`);
}, 5 * 60 * 1000); // Limpar a cada 5 minutos

// === MONITORAMENTO DE PERFORMANCE ===
let requestCount = 0;
let startTime = Date.now();

app.use((req, res, next) => {
    requestCount++;
    const reqStart = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - reqStart;
        if (duration > 2000) {
            console.log(`⚠️ Requisição lenta: ${req.url} - ${duration}ms`);
        }
    });
    
    next();
});

// === INICIAR SERVIDOR ULTRA OTIMIZADO ===
app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ULTRA OTIMIZADO rodando na porta ${PORT}`);
    console.log(`📊 Acessível em: http://localhost:${PORT}`);
    console.log(`🛡️ DADOS DO QUIZ 100% PROTEGIDOS`);
    console.log(`⚡ Cache inteligente ativo`);
    console.log(`🔥 Performance máxima habilitada`);
    
    // Log de performance a cada 10 minutos
    setInterval(() => {
        const uptime = Date.now() - startTime;
        const requestsPerMinute = Math.round((requestCount / uptime) * 60000);
        console.log(`📊 Performance: ${requestCount} requests, ${requestsPerMinute}/min, uptime ${Math.round(uptime/60000)}min`);
    }, 10 * 60 * 1000);
});
