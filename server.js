// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url'); // Módulo nativo para manipulação de URLs

const app = express();
const PORT = process.env.PORT || 10000;

// URLs de destino
const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_SUBDOMAIN_TARGET = 'https://reading.nebulahoroscope.com'; // O subdomínio da API da mão

// --- Configurações para Modificação de Conteúdo ---
const USD_TO_BRL_RATE = 5.00;
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Middleware Principal do Proxy Reverso ---
app.use(async (req, res) => {
    let targetDomain = MAIN_TARGET_URL; // Domínio padrão de destino
    let requestPath = req.url; // Caminho da requisição no seu proxy

    // NOVO: 1. Lógica para Proxeamento do Subdomínio de Leitura (Mão)
    // Se a requisição recebida no seu proxy começa com '/reading/'
    // (Este é um prefixo que você vai usar para sinalizar requisições para esse subdomínio)
    if (req.url.startsWith('/reading/')) {
        targetDomain = READING_SUBDOMAIN_TARGET;
        // Remove o prefixo '/reading' para que a URL original vá para o destino
        requestPath = req.url.substring('/reading'.length);
        if (requestPath === '') requestPath = '/'; // Garante que /reading/ vá para a raiz do subdomínio
        console.log(`[READING PROXY] Requisição: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
    } 
    // 2. Outras requisições (assets, funil, raiz) vão para o domínio principal (MAIN_TARGET_URL)
    else {
        console.log(`[MAIN PROXY] Requisição: ${req.url} -> Proxy para: ${targetDomain}${requestPath}`);
    }
    
    const targetUrl = `${targetDomain}${requestPath}`;

    try {
        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers: {
                'User-Agent': req.headers['user-agent'],
                'Accept-Encoding': 'identity', // Crucial para manipular o conteúdo
                'Accept': req.headers['accept'],
                // Importante: Passar o Host original do cliente pode causar problemas de certificado no destino
                // É melhor deixar o Axios/Node.js definir o Host para o targetDomain
                // 'Host': req.headers['host'], // Removido ou comentado
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
                // Se o redirecionamento veio do subdomínio de leitura, resolve em relação a ele.
                const redirectBase = targetDomain; // Usa o domínio que foi o target original da requisição

                const fullRedirectUrl = new URL(redirectLocation, redirectBase).href;

                // **REDIRECIONAMENTO ESPECÍFICO: /pt/witch-power/email para /pt/witch-power/onboarding**
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento para /email. Redirecionando para /onboarding.');
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                // Reescreve a URL de redirecionamento para apontar para o nosso proxy
                let proxiedRedirectPath = fullRedirectUrl;
                // Substitui o domínio principal ou o subdomínio pelo prefixo do proxy
                if (proxiedRedirectPath.startsWith(MAIN_TARGET_URL)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(MAIN_TARGET_URL, '');
                } else if (proxiedRedirectPath.startsWith(READING_SUBDOMAIN_TARGET)) {
                    proxiedRedirectPath = proxiedRedirectPath.replace(READING_SUBDOMAIN_TARGET, '/reading'); // Adiciona o prefixo /reading/
                }
                 // Se for apenas '/', ou seja, raiz do proxy, garante que não fique vazio
                if (proxiedRedirectPath === '') proxiedRedirectPath = '/';

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

        // --- Lógica de Modificação de Conteúdo (Apenas para HTML) ---
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf8');
            const $ = cheerio.load(html);

            // 1. Reescrever todas as URLs relativas e absolutas
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
                        // Se a URL for absoluta e apontar para o site de destino (appnebula.co)
                        if (originalUrl.startsWith(MAIN_TARGET_URL)) {
                            element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        }
                        // NOVO: Se a URL for absoluta e apontar para o subdomínio da API (reading.nebulahoroscope.com)
                        else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) {
                            element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                        }
                        // URLs relativas (ex: /_next/static/...) já funcionam, pois o proxy está no root.
                        // Mas se houver URLs como //sub.domain.com/path, elas podem precisar de tratamento,
                        // embora 'changeOrigin: true' no http-proxy-middleware (se estivéssemos usando) ajudaria.
                        // Com a sua abordagem, a URL precisa ser reescrita explicitamente.
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

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site "clonado" em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
