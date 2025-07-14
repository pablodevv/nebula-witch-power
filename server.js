// server.js

// Importa os módulos necessários
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio'); // Para manipular o HTML
const path = require('path'); // Módulo nativo do Node.js para lidar com caminhos de arquivo

// Cria uma instância do aplicativo Express
const app = express();
// Define a porta do servidor. Usa a porta do ambiente (para deploy no Render) ou 10000 por padrão (conforme seus logs do Render)
// Se você está testando localmente, pode usar 3000 ou 10000. Para o Render, process.env.PORT é o essencial.
const PORT = process.env.PORT || 10000;

// URL base do site que será "clonado" via proxy
const TARGET_BASE_URL = 'https://appnebula.co';
// Nova URL de destino para a API de leitura de mão
const API_PALMISTRY_URL = 'https://reading.nebulahoroscope.com';

// --- Configurações para Modificação de Conteúdo ---
// Taxa de câmbio para converter USD para BRL (você pode ajustar este valor)
const USD_TO_BRL_RATE = 5.00;
// Expressão regular para encontrar valores em dólar como $X.XX ou $X
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

// Middleware para parsear o corpo das requisições (se houver POSTs, PUTs, etc.)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Middleware Principal do Proxy Reverso ---
// Este middleware captura TODAS as requisições que chegam ao seu servidor
app.use(async (req, res) => {
    let targetDomain = TARGET_BASE_URL; // Domínio padrão de destino
    let requestPath = req.url; // Caminho da requisição no seu proxy

    // 1. Lógica para Proxeamento do Subdomínio da API de Quiromancia
    // Se a requisição recebida no seu proxy começa com '/api/'
    // e essa requisição deveria ir para o subdomínio da API.
    if (req.url.startsWith('/api/v1/palmistry/detect')) { // Ou apenas '/api/' se todas as APIs forem para lá
        targetDomain = API_PALMISTRY_URL;
        // O requestPath já é '/api/v1/palmistry/detect', então não precisa de pathRewrite aqui
        console.log(`[API PROXY] Requisição API: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
    } else {
        // Se não for a API, mantém o domínio principal
        console.log(`[GERAL PROXY] Requisição: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
    }
    
    const targetUrl = `${targetDomain}${requestPath}`;

    try {
        // Faz a requisição HTTP para o site de destino (appnebula.co ou reading.nebulahoroscope.com)
        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: {
                'User-Agent': req.headers['user-agent'],
                'Accept-Encoding': 'identity', // Crucial para manipular o conteúdo
                'Accept': req.headers['accept'],
                'Cookie': req.headers['cookie'] || ''
            },
            data: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined,
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
                // Determine o domínio base para resolver o redirecionamento.
                // Se o redirecionamento veio da API, resolve em relação à API_PALMISTRY_URL.
                const redirectBase = req.url.startsWith('/api/') ? API_PALMISTRY_URL : TARGET_BASE_URL;
                const fullRedirectUrl = new URL(redirectLocation, redirectBase).href;

                // **REDIRECIONAMENTO ESPECÍFICO: /pt/witch-power/email para /pt/witch-power/onboarding**
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                // Se não for o redirecionamento específico, reescreve a URL de redirecionamento
                const proxiedRedirectPath = fullRedirectUrl
                    .replace(TARGET_BASE_URL, '') // Remove o domínio principal
                    .replace(API_PALMISTRY_URL, ''); // Remove o domínio da API

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
                // Usar req.path ou '/' pode ser mais seguro aqui, dependendo da necessidade
                return cookie.replace(/Domain=[^;]+/, '').replace(/; Path=\//, `; Path=${req.baseUrl || '/'}`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

        // --- Lógica de Modificação de Conteúdo (Apenas para HTML) ---
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

            // 1. Reescrever todas as URLs relativas e absolutas que apontam para o TARGET_BASE_URL
            // Isso é CRÍTICO para que CSS, JS, imagens, links e formulários funcionem através do seu proxy
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
                        // Se a URL for absoluta e apontar para o site de destino (appnebula.co), a tornamos relativa ao nosso proxy
                        if (originalUrl.startsWith(TARGET_BASE_URL)) {
                            element.attr(attrName, originalUrl.replace(TARGET_BASE_URL, ''));
                        }
                        // Se a URL for absoluta e apontar para o subdomínio da API (reading.nebulahoroscope.com), a tornamos relativa ao nosso proxy
                        else if (originalUrl.startsWith(API_PALMISTRY_URL)) {
                            element.attr(attrName, originalUrl.replace(API_PALMISTRY_URL, ''));
                        }
                        // URLs relativas (ex: /_next/static/...) já funcionam, pois o proxy está no root.
                    }
                }
            });

            // **REDIRECIONAMENTO FRONTAL (CLIENT-SIDE) PARA /pt/witch-power/email**
            if (req.url.includes('/pt/witch-power/email')) {
                console.log('Detectada slug /email no frontend. Injetando script de redirecionamento.');
                $('head').append(`
                    <script>
                        window.location.replace('/pt/witch-power/onboarding');
                    </script>
                `);
            }

            // **MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialChoice**
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (preços e textos).');
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(CONVERSION_PATTERN, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                        return `R$ ${brlValue}`;
                    });
                });
                $('h2:contains("Trial Choice")').text('Escolha sua Prova Gratuita (Preços em Reais)');
                $('p:contains("Selecione sua opção de teste")').text('Agora com preços adaptados para o Brasil!');
            }

            // **MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral**
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

            // Envia o HTML modificado de volta para o navegador do cliente
            res.send($.html());
        } else {
            // Para outros tipos de arquivo (CSS, JS, imagens, etc.), apenas repassa o buffer de dados
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('Erro no proxy:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            // Tenta repassar o status code do erro ou um 500 para o cliente
            res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'}`);
        } else {
            // Erro de rede ou outro erro interno
            res.status(500).send('Erro interno do servidor proxy.');
        }
    }
});

// Inicia o servidor Express na porta definida
app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
