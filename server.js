// server.js

// Importa os módulos necessários
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio'); // Para manipular o HTML
const path = require('path'); // Módulo nativo do Node.js para lidar com caminhos de arquivo

// Cria uma instância do aplicativo Express
const app = express();
// Define a porta do servidor. Usa a porta do ambiente (para deploy) ou 3000 por padrão (para desenvolvimento local)
const PORT = process.env.PORT || 3000;
// URL base do site que será "clonado" via proxy
const TARGET_BASE_URL = 'https://appnebula.co';

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
    // Constrói a URL de destino no site original (appnebula.co)
    // req.url contém o caminho completo da requisição (ex: /pt/witch-power/prelanding)
    const targetPath = `${TARGET_BASE_URL}${req.url}`;
    console.log(`Requisição recebida: ${req.url} -> Proxy para: ${targetPath}`);

    try {
        // Faz a requisição HTTP para o site de destino (appnebula.co)
        const response = await axios({
            method: req.method, // Usa o mesmo método da requisição original (GET, POST, etc.)
            url: targetPath, // A URL completa para o site de destino
            headers: {
                // Passa alguns cabeçalhos importantes do cliente para o servidor de destino
                'User-Agent': req.headers['user-agent'], // Identifica o navegador do usuário
                'Accept-Encoding': 'identity', // Importante para evitar compressão (gzip) que pode dificultar a modificação do conteúdo
                'Accept': req.headers['accept'], // Tipos de conteúdo aceitos pelo cliente
                'Cookie': req.headers['cookie'] || '' // Passa os cookies do cliente para o site de destino
            },
            // Se a requisição original tiver um corpo (ex: POST), passa-o para o destino
            data: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined,
            responseType: 'arraybuffer', // Recebe a resposta como um buffer para lidar com todos os tipos de arquivo (HTML, CSS, JS, imagens)
            maxRedirects: 0, // Não seguir redirecionamentos automaticamente; vamos lidar com eles manualmente
            validateStatus: function (status) {
                // Aceita status 2xx (sucesso) e 3xx (redirecionamento) para que possamos processá-los
                return status >= 200 && status < 400;
            },
        });

        // --- Lógica de Interceptação de Redirecionamento (Status 3xx) ---
        // Se o servidor de destino (appnebula.co) enviar um redirecionamento
        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location; // Obtém a URL para a qual o destino está redirecionando
            if (redirectLocation) {
                // Resolve a URL de redirecionamento completa, caso seja relativa
                const fullRedirectUrl = new URL(redirectLocation, TARGET_BASE_URL).href;

                // **REDIRECIONAMENTO ESPECÍFICO: /pt/witch-power/email para /pt/witch-power/onboarding**
                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    console.log('Interceptando redirecionamento para /email. Redirecionando para /onboarding.');
                    // Redireciona o navegador do usuário para a versão proxy de /onboarding
                    return res.redirect(302, '/pt/witch-power/onboarding');
                }

                // Se não for o redirecionamento específico, reescreve a URL de redirecionamento
                // para que ela aponte para o nosso próprio proxy
                const proxiedRedirectPath = fullRedirectUrl.replace(TARGET_BASE_URL, '');
                console.log(`Redirecionamento do destino: ${fullRedirectUrl} -> Reescrevendo para: ${proxiedRedirectPath}`);
                return res.redirect(response.status, proxiedRedirectPath);
            }
        }

        // --- Repassa Cabeçalhos da Resposta do Destino para o Cliente ---
        Object.keys(response.headers).forEach(header => {
            // Remove cabeçalhos que podem causar problemas após modificação ou proxy (ex: tamanho do conteúdo, tipo de codificação)
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
            let html = response.data.toString('utf8'); // Converte o buffer de resposta para string HTML

            const $ = cheerio.load(html); // Carrega o HTML no Cheerio para manipulação

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
                        // Se a URL for absoluta e apontar para o site de destino, a tornamos relativa ao nosso proxy
                        if (originalUrl.startsWith(TARGET_BASE_URL)) {
                            element.attr(attrName, originalUrl.replace(TARGET_BASE_URL, ''));
                        }
                        // Se a URL for relativa (começa com /), ela já estará correta para o nosso root
                        // Ex: /pt/witch-power/assets/image.png já funciona se o proxy está no root
                        // Se o proxy estivesse em um subcaminho como /meu-proxy/, precisaríamos adicionar esse prefixo
                        // Mas como estamos usando o root do seu domínio, não é necessário prefixar URLs relativas.
                    }
                }
            });

            // **REDIRECIONAMENTO FRONTAL (CLIENT-SIDE) PARA /pt/witch-power/email**
            // Este é um fallback caso o redirecionamento do backend não seja acionado (ex: se o site de destino usar roteamento client-side)
            if (req.url.includes('/pt/witch-power/email')) {
                console.log('Detectada slug /email no frontend. Injetando script de redirecionamento.');
                $('head').append(`
                    <script>
                        // Este script é injetado no HTML e executa no navegador do cliente
                        // Ele redireciona para a página de onboarding no seu proxy
                        window.location.replace('/pt/witch-power/onboarding');
                    </script>
                `);
            }

            // **MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialChoice**
            if (req.url.includes('/pt/witch-power/trialChoice')) {
                console.log('Modificando conteúdo para /trialChoice (preços e textos).');
                // Substitui valores em dólar por reais em todo o corpo do HTML
                // Isso é uma substituição genérica de texto. Pode ser necessário refinar com seletores CSS mais específicos
                // se você quiser alterar apenas textos dentro de elementos específicos.
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(CONVERSION_PATTERN, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                        return `R$ ${brlValue}`;
                    });
                });

                // Exemplo: Modificar um texto de título específico (ajuste o seletor conforme o HTML real)
                $('h2:contains("Trial Choice")').text('Escolha sua Prova Gratuita (Preços em Reais)');
                // Exemplo: Modificar um parágrafo específico
                $('p:contains("Selecione sua opção de teste")').text('Agora com preços adaptados para o Brasil!');
            }

            // **MODIFICAÇÕES ESPECÍFICAS PARA /pt/witch-power/trialPaymentancestral**
            if (req.url.includes('/pt/witch-power/trialPaymentancestral')) {
                console.log('Modificando conteúdo para /trialPaymentancestral (preços e links de botões).');
                // Substitui valores em dólar por reais em todo o corpo do HTML
                $('body').html(function(i, originalHtml) {
                    return originalHtml.replace(CONVERSION_PATTERN, (match, p1) => {
                        const usdValue = parseFloat(p1);
                        const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                        return `R$ ${brlValue}`;
                    });
                });

                // Exemplo: Modificar links de botões específicos
                // Você precisará inspecionar o HTML real para encontrar os seletores corretos (IDs, classes, ou texto)
                // Exemplo 1: Botão com ID
                $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                // Exemplo 2: Botão com classe
                $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                // Exemplo 3: Botão que contém um texto específico (menos robusto se o texto mudar)
                $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');

                // Exemplo: Modificar um título ou descrição
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