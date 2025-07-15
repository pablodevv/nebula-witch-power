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
            validateStatus: status => status >= 200 && status < 400
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
                let proxiedRedirectPath = fullRedirectUrl.replace(MAIN_TARGET_URL, '').replace(READING_SUBDOMAIN_TARGET, '/reading');
                return res.redirect(response.status, proxiedRedirectPath || '/');
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
                return cookie
                    .replace(/Domain=[^;]+/, '')
                    .replace(/; Secure/, '')
                    .replace(/; Path=\//, `; Path=${req.baseUrl || '/'}`);
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
                if (element.is('link') || element.is('a') || element.is('area')) attrName = 'href';
                else if (element.is('script') || element.is('img') || element.is('source') || element.is('iframe')) attrName = 'src';
                else if (element.is('form')) attrName = 'action';

                if (attrName) {
                    let originalUrl = element.attr(attrName);
                    if (originalUrl) {
                        if (originalUrl.startsWith(MAIN_TARGET_URL)) element.attr(attrName, originalUrl.replace(MAIN_TARGET_URL, ''));
                        else if (originalUrl.startsWith(READING_SUBDOMAIN_TARGET)) element.attr(attrName, originalUrl.replace(READING_SUBDOMAIN_TARGET, '/reading'));
                    }
                }
            });

            $('head').prepend(`
                <script>
                (function() {
                    const readingSubdomainTarget = '${READING_SUBDOMAIN_TARGET}';
                    const proxyPrefix = '/reading';
                    const asknebulaDomains = [
                        'https://logs.asknebula.com',
                        'https://api.asknebula.com',
                        'https://assets.asknebula.com'
                    ];
                    const proxyAskPrefix = '/asknebula';

                    const originalFetch = window.fetch;
                    window.fetch = function(input, init) {
                        let url = input;
                        if (typeof input === 'string') {
                            for (const domain of asknebulaDomains) {
                                if (input.startsWith(domain)) {
                                    url = input.replace(domain, proxyAskPrefix + domain.replace('https://', '/'));
                                    break;
                                }
                            }
                            if (input.startsWith(readingSubdomainTarget)) {
                                url = input.replace(readingSubdomainTarget, proxyPrefix);
                            }
                        }
                        return originalFetch.call(this, url, init);
                    };

                    const originalXHRopen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                        let modifiedUrl = url;
                        if (typeof url === 'string') {
                            for (const domain of asknebulaDomains) {
                                if (url.startsWith(domain)) {
                                    modifiedUrl = url.replace(domain, proxyAskPrefix + domain.replace('https://', '/'));
                                    break;
                                }
                            }
                            if (url.startsWith(readingSubdomainTarget)) {
                                modifiedUrl = url.replace(readingSubdomainTarget, proxyPrefix);
                            }
                        }
                        return originalXHRopen.call(this, method, modifiedUrl, async, user, password);
                    };
                })();
                </script>
            `);

            res.status(response.status).send($.html());
        } else {
            res.status(response.status).send(response.data);
        }

    } catch (error) {
        console.error('Erro no proxy:', error.message);
        if (error.response) {
            res.status(error.response.status).send(`Erro ao carregar o conteúdo do site externo: ${error.response.statusText || 'Erro desconhecido'}`);
        } else {
            res.status(500).send('Erro interno do servidor proxy.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Servidor proxy rodando em http://localhost:${PORT}`);
});
