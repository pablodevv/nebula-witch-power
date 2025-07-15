// server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const fileUpload = require('express-fileupload');

const app = express();
const PORT = process.env.PORT || 10000;

const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_SUBDOMAIN_TARGET = 'https://reading.nebulahoroscope.com';
const USD_TO_BRL_RATE = 5.00;
const CONVERSION_PATTERN = /\$(\d+(\.\d{2})?)/g;

app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 },
    createParentPath: true,
    uriDecodeFileNames: true,
    preserveExtension: true
}));

app.use(async (req, res) => {
    let targetDomain = MAIN_TARGET_URL;
    let requestPath = req.url;

    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['connection'];
    delete requestHeaders['x-forwarded-for'];
    delete requestHeaders['accept-encoding'];

    if (req.url.startsWith('/reading/')) {
        targetDomain = READING_SUBDOMAIN_TARGET;
        requestPath = req.url.substring('/reading'.length);
        if (requestPath === '') requestPath = '/';
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
            validateStatus: status => status >= 200 && status < 400,
        });

        if (response.status >= 300 && response.status < 400) {
            const redirectLocation = response.headers.location;
            if (redirectLocation) {
                let fullRedirectUrl;
                try {
                    fullRedirectUrl = new URL(redirectLocation, targetDomain).href;
                } catch (e) {
                    fullRedirectUrl = redirectLocation;
                }

                if (fullRedirectUrl.includes('/pt/witch-power/email')) {
                    return res.redirect(302, '/pt/witch-power/onboarding');
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

        Object.keys(response.headers).forEach(header => {
            if (!['transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'host', 'connection'].includes(header.toLowerCase())) {
                res.setHeader(header, response.headers[header]);
            }
        });

        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
            const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
            const modifiedCookies = cookies.map(cookie => {
                return cookie.replace(/Domain=[^;]+/, '').replace(/; Secure/, '').replace(/; Path=\//, `; Path=${req.baseUrl || '/'}`);
            });
            res.setHeader('Set-Cookie', modifiedCookies);
        }

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
                        if (originalUrl.startsWith(MAIN_TARGET_URL)) {
                            element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        } else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) {
                            element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                        }
                    }
                }
            });

            $('head').prepend(`<script>(function(){const r='${READING_SUBDOMAIN_TARGET}',p='/reading',f=window.fetch;window.fetch=function(u,i){let a=u;if(typeof u==='string'&&u.startsWith(r))a=u.replace(r,p);else if(u instanceof Request&&u.url.startsWith(r))a=new Request(u.url.replace(r,p),u);return f.call(this,a,i)};const x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,a,s,c){let l=u;if(typeof u==='string'&&u.startsWith(r))l=u.replace(r,p);x.call(this,m,l,a,s,c)}})();</script>`);

            $('head').append(`<script>let i;function h(){const p=window.location.pathname;if(p.startsWith('/pt/witch-power/email')){if(i)clearInterval(i);window.location.replace('/pt/witch-power/onboarding')}}document.addEventListener('DOMContentLoaded',h);window.addEventListener('popstate',h);i=setInterval(h,100);window.addEventListener('beforeunload',()=>{if(i)clearInterval(i)});h();</script>`);

            if (req.url.includes('/pt/witch-power/trialChoice') || req.url.includes('/pt/witch-power/trialPaymentancestral')) {
                $('*').each((i, el) => {
                    const element = $(el);
                    if (element.children().length === 0) {
                        const text = element.text();
                        const convertedText = text.replace(CONVERSION_PATTERN, (match, p1) => {
                            const usdValue = parseFloat(p1);
                            const brlValue = (usdValue * USD_TO_BRL_RATE).toFixed(2).replace('.', ',');
                            return `R$ ${brlValue}`;
                        });
                        if (text !== convertedText) {
                            element.text(convertedText);
                        }
                    }
                });

                if (req.url.includes('trialChoice')) {
                    $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                    $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                    $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');
                    $('h2:contains("Trial Choice")').text('Escolha sua Prova Gratuita (Preços em Reais)');
                    $('p:contains("Selecione sua opção de teste")').text('Agora com preços adaptados para o Brasil!');
                } else if (req.url.includes('trialPaymentancestral')) {
                    $('#buyButtonAncestral').attr('href', 'https://seusite.com/link-de-compra-ancestral-em-reais');
                    $('.cta-button-trial').attr('href', 'https://seusite.com/novo-link-de-compra-geral');
                    $('a:contains("Comprar Agora")').attr('href', 'https://seusite.com/meu-novo-link-de-compra-agora');
                    $('h1:contains("Trial Payment Ancestral")').text('Pagamento da Prova Ancestral (Preços e Links Atualizados)');
                }
            }

            res.status(response.status).send($.html());
        } else {
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        if (error.response) {
            if (error.response.status === 508) {
                res.status(508).send('Erro ao carregar o site externo: Loop Detectado.');
            } else {
                res.status(error.response.status).send(`Erro ao carregar o site externo: ${error.response.statusText || 'Erro desconhecido'}`);
            }
        } else {
            res.status(500).send('Erro interno do servidor proxy.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
    console.log(`Acesse o site clonado em http://localhost:${PORT}/pt/witch-power/prelanding`);
});
