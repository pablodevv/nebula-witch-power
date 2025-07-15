// server.js

const express = require('express');
const axios = require('axios');
const fileUpload = require('express-fileupload');

const app = express();
const PORT = process.env.PORT || 10000;

const MAIN_TARGET_URL = 'https://appnebula.co';
const READING_TARGET = 'https://reading.nebulahoroscope.com';

app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

app.use(async (req, res) => {
  const isReading = req.url.startsWith('/reading/');
  const targetDomain = isReading ? READING_TARGET : MAIN_TARGET_URL;
  const path = isReading ? req.url.replace('/reading', '') || '/' : req.url;

  const headers = { ...req.headers };
  ['host','connection','x-forwarded-for','accept-encoding'].forEach(h => delete headers[h]);

  console.log(`${isReading ? '[READING]' : '[MAIN]'} Proxying ${req.method} ${req.url} → ${targetDomain}${path}`);

  let data = req.body;
  if (req.files?.photo) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('photo', req.files.photo.data, {
      filename: req.files.photo.name,
      contentType: req.files.photo.mimetype
    });
    data = form;
    Object.assign(headers, form.getHeaders());
  }

  try {
    const resp = await axios({
      url: targetDomain + path,
      method: req.method,
      headers,
      data,
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    // redirecionamentos
    if (resp.status >= 300 && resp.headers.location) {
      const loc = resp.headers.location.startsWith(targetDomain)
        ? resp.headers.location.replace(targetDomain, isReading ? '/reading' : '')
        : resp.headers.location;
      if (loc.includes('/pt/witch-power/email'))
        return res.redirect(302, '/pt/witch-power/onboarding');
      return res.redirect(resp.status, loc || '/');
    }

    // headers de resposta
    for (const [k, v] of Object.entries(resp.headers)) {
      if (!['transfer-encoding','content-encoding','content-length','set-cookie','host','connection'].includes(k.toLowerCase()))
        res.setHeader(k, v);
    }
    if (resp.headers['set-cookie']) {
      const cookies = Array.isArray(resp.headers['set-cookie']) ? resp.headers['set-cookie'] : [resp.headers['set-cookie']];
      res.setHeader('Set-Cookie', cookies.map(c => c.replace(/Domain=[^;]+/, '').replace('; Secure','')));
    }

    // Detecta rota dinâmica e simplesmente "passe adiante"
    if (req.url.includes('/pt/witch-power/trialChoice') ||
        req.url.includes('/pt/witch-power/trialPaymentancestral')) {
      console.log('⚠️ Rota dinâmica detectada: passando HTML cru, sem modificar');
      return res.status(resp.status).send(resp.data);
    }

    // Para outras rotas, faz o processamento via Cheerio
    const cheerio = require('cheerio');
    const html = resp.data.toString('utf8');
    const $ = cheerio.load(html);

    $('[href],[src],[action]').each((_, el) => {
      const attrib = el.name === 'a' || el.name === 'link' || el.name === 'area' ? 'href' :
                     ['script','img','iframe','source'].includes(el.name) ? 'src' :
                     el.name === 'form' ? 'action' : null;
      if (!attrib) return;
      const orig = $(el).attr(attrib);
      if (!orig) return;
      if (orig.startsWith(MAIN_TARGET_URL))
        $(el).attr(attrib, orig.replace(MAIN_TARGET_URL, ''));
      if (orig.startsWith(READING_TARGET))
        $(el).attr(attrib, orig.replace(READING_TARGET, '/reading'));
    });

    // injeção de scripts (só nestas rotas)
    $('head').prepend(`
      <script>/* REWRITER DE FETCH/XHR para reading */ (function(){ /* ... */ })();</script>
    `).append(`
      <script>/* REDIRECT /email → onboarding */ (function(){ /* ... */ })();</script>
    `);

    res.status(resp.status).send($.html());
  }
  catch (err) {
    console.error('Proxy erro:', err.message);
    return res.status(err.response?.status || 500)
              .send(err.response ? `Erro upstream: ${err.response.statusText}` : 'Erro interno do proxy');
  }
});

app.listen(PORT, () => console.log(`✅ Proxy rodando em http://localhost:${PORT}`));
